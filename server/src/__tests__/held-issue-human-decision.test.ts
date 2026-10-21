// MIK-859 (mikoshi): an owner's answer to a card on an issue with a replay hold
// must wake the assignee the same way an owner comment does. On hermes the
// owner accepted card 87354f73 on MIK-767 at 2026-10-21 06:35:30Z. The wake
// (456f1cdb) had a user actor but no comment id, so
// admitExplicitNativeContinuation() refused it and it stayed
// deferred_issue_execution with no run. The fixture uses a hold that an owner
// comment can pass (a legacy run with a recorded, stopped process), so the
// only difference between the two is the card.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions,
  issueThreadInteractions, issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { buildExecutionContinuation } from "../services/execution-continuation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const stoppedAt = new Date("2026-10-21T06:20:00.000Z");

(support.supported ? describe : describe.skip)("a human card answer passes a replay hold like a comment (MIK-859)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("held-human-decision-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "MIK-767 fixture", issuePrefix: `H${companyId.slice(0, 6)}`, defaultResponsibleUserId: "board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Head", role: "ceo", status: "idle", adapterType: "claude_local",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review wake", status: "in_review",
      assigneeAgentId: agentId, responsibleUserId: "board" });
    // A legacy run that stopped with a recorded pid that no longer exists.
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, invocationSource: "automation",
      status: "failed", runtimeMode: "legacy", startedAt: new Date("2026-10-21T06:10:00.000Z"), finishedAt: stoppedAt,
      processPid: 999999999, contextSnapshot: { issueId } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId, status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery stopped.", evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked" } } });
    // Occupy the only slot: admission is real, but no provider launches.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy" });
    return { companyId, agentId, issueId, sourceRunId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function card(f: Fixture, values: Partial<typeof issueThreadInteractions.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({ id, companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "accepted", continuationPolicy: "wake_assignee", createdByAgentId: f.agentId,
      resolvedByUserId: "board", resolvedAt: new Date("2026-10-21T06:35:30.529Z"),
      payload: { version: 1, prompt: "Run it?" }, result: { version: 1, outcome: "accepted" }, ...values });
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id));
    return row;
  }

  // Same options as routes/issues.ts queueResolvedInteractionContinuationWakeup()
  // (wake 456f1cdb) and question-response-delivery.ts for ask_user_questions.
  async function cardWake(f: Fixture, interaction: typeof issueThreadInteractions.$inferSelect,
    actor: { type: string; id: string } = { type: "user", id: "board" }) {
    const sourceCommentId = interaction.sourceCommentId ?? null;
    const commentIds = sourceCommentId ? { wakeCommentId: sourceCommentId, wakeCommentIds: [sourceCommentId] } : {};
    const fields = { interactionId: interaction.id, interactionKind: interaction.kind, interactionStatus: interaction.status,
      sourceCommentId, sourceRunId: interaction.sourceRunId ?? null };
    return heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, ...fields, ...commentIds, mutation: "interaction" },
      idempotencyKey: `interaction:${interaction.id}:${interaction.status}`,
      requestedByActorType: actor.type as "user", requestedByActorId: actor.id,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, ...fields, ...commentIds,
        wakeReason: "issue_commented", source: "issue.interaction.accept" },
    });
  }

  async function wakes(f: Fixture) {
    return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`));
  }

  async function issueRuns(f: Fixture) {
    return db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, eq(heartbeatRuns.status, "queued")));
  }

  async function expectAdmitted(f: Fixture, interactionId: string) {
    const all = await wakes(f);
    expect(all.filter(w => w.status === "deferred_issue_execution")).toEqual([]);
    const runs = await issueRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.sourceRunId,
      explicitUserContinuation: { previousRunId: f.sourceRunId, interactionId } });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toMatchObject({ actorId: "board", interactionId, runId: runs[0].id });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // Dispatch re-proves the receipt before the adapter starts.
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      runId: runs[0].id, context: runs[0].contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope).toMatchObject({ interruptedRunId: f.sourceRunId, trigger: { interactionId } });
    return runs[0];
  }

  async function expectHeld(f: Fixture, waitReason?: string) {
    expect(await issueRuns(f)).toEqual([]);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(action.evidence.explicitUserContinuation).toBeUndefined();
    const all = await wakes(f);
    expect(all.some(w => w.runId)).toBe(false);
    if (waitReason) expect(all.map(w => (w.payload as Record<string, any>)?.executionWait?.reason)).toEqual([waitReason]);
    return all;
  }

  // (a) The MIK-767 case. A "no" is a decision too, so rejection wakes as well.
  it.each(["accepted", "rejected"] as const)("wakes the assignee for a %s request_confirmation (a)", async status => {
    const f = await fixture();
    const interaction = await card(f, { status, result: { version: 1, outcome: status } });
    await cardWake(f, interaction);
    await expectAdmitted(f, interaction.id);
  });

  // (b) The question form's source comment is the agent's own, written by the
  // stopped run. It cannot authorize anything; the answer does.
  it("wakes the assignee for an answered ask_user_questions with an agent source comment (b)", async () => {
    const f = await fixture();
    const sourceCommentId = randomUUID();
    await db.insert(issueComments).values({ id: sourceCommentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "agent", authorAgentId: f.agentId, createdByRunId: f.sourceRunId, body: "Which option?",
      createdAt: new Date("2026-10-21T06:15:00.000Z") });
    const interaction = await card(f, { kind: "ask_user_questions", status: "answered", sourceCommentId,
      sourceRunId: f.sourceRunId, payload: { version: 1, questions: [] }, result: { version: 1, answers: [] } });
    await cardWake(f, interaction);
    const run = await expectAdmitted(f, interaction.id);
    expect(run.contextSnapshot).toMatchObject({ wakeCommentId: sourceCommentId });
  });

  // (c) Machine wakes stay held, including one that carries the answered card.
  it.each(["automation", "card_by_system", "card_by_agent"])("keeps a non-user wake held (c: %s)", async kind => {
    const f = await fixture();
    const interaction = await card(f);
    if (kind === "automation") await heartbeatService(db).wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_children_completed",
      payload: { issueId: f.issueId, mutation: "children" }, requestedByActorType: "system",
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_children_completed" },
    });
    else await cardWake(f, interaction, kind === "card_by_agent"
      ? { type: "agent", id: f.agentId } : { type: "system", id: "system" });
    await expectHeld(f);
  });

  // (d) Only a human resolver, acting as the wake's actor, counts.
  it.each([
    ["resolved_by_agent", { resolvedByUserId: null, resolvedByAgentId: "agent" }],
    ["resolved_by_run", { resolvedByRunId: "run" }],
    ["other_user", { resolvedByUserId: "someone-else" }],
    ["pending", { status: "pending", resolvedAt: null }],
    ["foreign_issue", { issueId: "foreign" }],
  ] as const)("keeps a card wake held when the card is not a human decision on this issue (d: %s)", async (_name, patch) => {
    const f = await fixture();
    const values: Partial<typeof issueThreadInteractions.$inferInsert> = { ...patch };
    if ("resolvedByAgentId" in values) values.resolvedByAgentId = f.agentId;
    if ("resolvedByRunId" in values) values.resolvedByRunId = f.sourceRunId;
    let otherIssueId: string | null = null;
    if ("issueId" in values) {
      otherIssueId = randomUUID();
      await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Other", status: "todo" });
      values.issueId = otherIssueId;
    }
    const interaction = await card(f, values);
    // The wake names this issue even when the card belongs to another one.
    await cardWake(f, otherIssueId ? { ...interaction, issueId: f.issueId } : interaction);
    await expectHeld(f);
  });

  // (e) A decision made before the run stopped cannot authorize a turn after it.
  it("keeps a card resolved before the recorded stop held (e)", async () => {
    const f = await fixture();
    const interaction = await card(f, { resolvedAt: new Date(stoppedAt.getTime() - 60_000) });
    await cardWake(f, interaction);
    await expectHeld(f, "message_predates_stop");
  });

  it("refuses dispatch when the card's resolver changes after admission", async () => {
    const f = await fixture();
    const interaction = await card(f);
    await cardWake(f, interaction);
    const run = await expectAdmitted(f, interaction.id);
    await db.update(issueThreadInteractions).set({ resolvedByUserId: "someone-else" })
      .where(eq(issueThreadInteractions.id, interaction.id));
    await expect(buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      runId: run.id, context: run.contextSnapshot!, summary: null, exposeLowTrustRaw: false }))
      .rejects.toThrow("continuation_user_authorization_missing");
  });
});
