// MIK-684 (mikoshi): a disposition-repair run that Paperclip's own dispatch
// gate cancels before the adapter is called must not leave a board-only
// replay hold. On hermes, run 78f38052 (Head, MIK-574, 2026-10-19 11:46:37Z)
// was such a run. Its hold 68b6ec16 swallowed every later wake on the issue:
// an accepted plan card (failure 1) and a board comment after the issue was
// reassigned to the CTO (failure 2). Both stayed `deferred_issue_execution`
// with no run. The fixture copies those rows.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions,
  issueThreadInteractions, issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("suppressed disposition repair leaves no reconciliation hold (MIK-684)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("suppressed-repair-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), headId = randomUUID(), ctoId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), repairRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "MIK-574 fixture", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: "board" });
    for (const [id, name] of [[headId, "Head"], [ctoId, "CTO"]] as const)
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "idle", adapterType: "claude_local",
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Assess scanner signals", status: "in_review",
      assigneeAgentId: headId, responsibleUserId: "board" });
    // 7eced101: Head's turn that recorded its disposition and succeeded.
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: headId, invocationSource: "automation",
      status: "succeeded", runtimeMode: "legacy", startedAt: new Date("2026-10-19T11:39:59.572Z"),
      finishedAt: new Date("2026-10-19T11:44:52.568Z"), processPid: 293370,
      contextSnapshot: { issueId, wakeReason: "issue_commented" } });
    // 78f38052: the repair retry, claimed (startedAt set) but stopped by the
    // dispatch gate before adapter.execute, so it has no pid.
    const [repair] = await db.insert(heartbeatRuns).values({ id: repairRunId, companyId, agentId: headId, invocationSource: "automation",
      status: "running", runtimeMode: "legacy", startedAt: new Date("2026-10-19T11:46:37.253Z"), processPid: null,
      contextSnapshot: { issueId, wakeReason: "issue_disposition_repair", retryOfRunId: sourceRunId,
        dispositionRepairSourceRunId: sourceRunId, legacyDispositionEpisode: { id: sourceRunId, attempt: 1, maxAttempts: 2 } } }).returning();
    return { companyId, headId, ctoId, issueId, sourceRunId, repair };
  }

  // heartbeat.ts dispatch gate: legacyRepairDispatchBlock() returned
  // "recorded_disposition", so setRunStatusIfRunning(run, "cancelled", ...) ran.
  // setRunStatusFromLive() asks the hold predicate and terminalizes through
  // terminalizeLegacyExecution() when it says yes. Same calls, same order.
  async function stopAtDispatchGate(run: typeof heartbeatRuns.$inferSelect) {
    const patch = { finishedAt: new Date("2026-10-19T11:46:37.972Z"), errorCode: "legacy_disposition_repair_suppressed",
      error: "Disposition repair suppressed: recorded_disposition" };
    if (await legacyExecutionNeedsReconciliationWithEvidence(db, { ...run, status: "cancelled", ...patch }))
      await terminalizeLegacyExecution({ db, run, status: "cancelled", patch, fromStatuses: ["running"] });
    else
      await db.update(heartbeatRuns).set({ status: "cancelled", ...patch }).where(eq(heartbeatRuns.id, run.id));
  }

  // 19:17:05Z: the board reassigned MIK-574 from Head to the CTO. The CTO's slot
  // is occupied so the admitted run stays queued and no provider launches.
  async function reassignToCto(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(issues).set({ assigneeAgentId: f.ctoId }).where(eq(issues.id, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.ctoId, status: "running", runtimeMode: "legacy" });
  }

  async function ctoWakes(f: Awaited<ReturnType<typeof fixture>>) {
    return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.agentId, f.ctoId), sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`));
  }

  async function ctoIssueRuns(f: Awaited<ReturnType<typeof fixture>>) {
    return db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.agentId, f.ctoId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
  }

  it("records no hold for a repair run the dispatch gate cancelled", async () => {
    const f = await fixture();
    await stopAtDispatchGate(f.repair);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.repair.id));
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", processPid: null });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  // Failure 1: card a5c95b2f accepted by the board at 19:47:32Z. The wake has no
  // comment id, so admitExplicitNativeContinuation() refused it and enqueueWakeup
  // deferred it behind the hold (row 6eb94a30, never claimed).
  it("admits the assignee's wake for an accepted plan card (failure 1, wake 6eb94a30)", async () => {
    const f = await fixture();
    await stopAtDispatchGate(f.repair);
    await reassignToCto(f);
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "accepted", continuationPolicy: "wake_assignee",
      createdByAgentId: f.headId, resolvedByUserId: "board", resolvedAt: new Date(),
      payload: { version: 1, prompt: "Accept the plan?" }, result: { version: 1, outcome: "accepted" } });
    // Same options as routes/issues.ts queueResolvedInteractionContinuationWakeup().
    await heartbeatService(db).wakeup(f.ctoId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, interactionId, interactionKind: "request_confirmation", interactionStatus: "accepted",
        sourceCommentId: null, sourceRunId: null, mutation: "interaction" },
      idempotencyKey: `interaction:${interactionId}:accepted`,
      requestedByActorType: "user", requestedByActorId: "board",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, interactionId, interactionKind: "request_confirmation",
        interactionStatus: "accepted", sourceCommentId: null, sourceRunId: null,
        wakeReason: "issue_commented", source: "issue.interaction.accept", forceFreshSession: true },
    });
    const wakes = await ctoWakes(f);
    expect(wakes.filter(w => w.status === "deferred_issue_execution")).toEqual([]);
    expect(wakes.some(w => w.runId)).toBe(true);
    expect((await ctoIssueRuns(f)).map(r => r.status)).toEqual(["queued"]);
  });

  // Failure 2: the board's "progress?" comment at 2026-10-20 09:45:22Z, after the
  // reassignment. Admission refused it with source_unavailable because the hold's
  // run belongs to Head, and it stayed deferred (row bd4ac6c5, never claimed).
  it("admits the new assignee's wake for a board comment after reassignment (failure 2, wake bd4ac6c5)", async () => {
    const f = await fixture();
    await stopAtDispatchGate(f.repair);
    await reassignToCto(f);
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "progress?" });
    // Same options as the comment route's assignee wake (row bd4ac6c5).
    await heartbeatService(db).wakeup(f.ctoId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId, mutation: "comment" },
      requestedByActorType: "user", requestedByActorId: "board",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId, wakeCommentId: commentId,
        wakeReason: "issue_commented", source: "issue.comment" },
    });
    const wakes = await ctoWakes(f);
    expect(wakes.filter(w => w.status === "deferred_issue_execution")).toEqual([]);
    expect(wakes.some(w => w.runId)).toBe(true);
    const runs = await ctoIssueRuns(f);
    expect(runs.map(r => r.status)).toEqual(["queued"]);
    expect(runs[0].contextSnapshot).toMatchObject({ wakeCommentId: commentId });
  });
});
