import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

// MIK-268: a reassignment stops the old owner's run and admits the new
// assignee's wake in the same request. When admission lands in the few ms
// before the stopped run's process and lease are gone, the wake is parked on
// the ownership blocker. Cleanup of the stopped run must re-admit it.
const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("reassignment handoff re-admission after cleanup", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("reassignment-handoff-readmit-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(parkedAs: "deferred_issue_execution" | "skipped", recoveryActionId: string | null = null) {
    const companyId = randomUUID(), oldOwner = randomUUID(), newOwner = randomUUID(), issueId = randomUUID();
    const stoppedRunId = randomUUID(), commentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: `H${companyId.slice(0, 5).toUpperCase()}`, defaultResponsibleUserId: "owner" });
    await db.insert(agents).values([oldOwner, newOwner].map((id, i) => ({ id, companyId, name: `Agent ${i}`, role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Handoff task", status: "in_progress", assigneeAgentId: newOwner, responsibleUserId: "owner" });
    const [stoppedRun] = await db.insert(heartbeatRuns).values({ id: stoppedRunId, companyId, agentId: oldOwner, status: "cancelled",
      runtimeMode: "legacy", errorCode: "issue_reassigned", invocationSource: "assignment", responsibleUserId: "owner",
      contextSnapshot: { issueId }, finishedAt: new Date() }).returning();
    const [parked] = await db.insert(agentWakeupRequests).values({ companyId, agentId: newOwner, source: "assignment", triggerDetail: "system",
      reason: parkedAs === "skipped" ? "execution_reconciliation_required" : "issue_assigned", status: parkedAs,
      requestedByActorType: "agent", requestedByActorId: oldOwner,
      payload: { issueId, mutation: "update", ...(parkedAs === "deferred_issue_execution" ? { commentId } : {}), interruptedRunId: stoppedRunId,
        executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved.", recoveryActionId } },
    }).returning();
    return { companyId, newOwner, issueId, stoppedRun, parked };
  }

  it.each(["deferred_issue_execution", "skipped"] as const)("re-admits a %s handoff for the new assignee", async (parkedAs) => {
    execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, summary: "Completed" });
    const { newOwner, issueId, stoppedRun, parked } = await seed(parkedAs);
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.readmitReassignmentHandoff(stoppedRun);
      expect(run?.agentId).toBe(newOwner);
      expect(run?.contextSnapshot).toMatchObject({ issueId, wakeReason: "issue_assigned", interruptedRunId: stoppedRun.id });
      // A second cleanup pass finds the delivered run and does nothing.
      expect(await heartbeat.readmitReassignmentHandoff(stoppedRun)).toBeNull();
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked.id));
      if (parkedAs === "deferred_issue_execution") expect(wake).toMatchObject({ status: "coalesced", runId: run!.id });
      else expect(wake.status).toBe("skipped");
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);

  it("re-admits the parked handoff when the reassignment-stopped run finishes cleanup", async () => {
    const { companyId, newOwner, issueId, stoppedRun } = await seed("skipped");
    const oldOwner = stoppedRun.agentId;
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, stoppedRun.id));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, newOwner));
    await db.update(issues).set({ assigneeAgentId: oldOwner }).where(eq(issues.id, issueId));
    execute.mockImplementation(async (context: { runId: string; agent: { id: string } }) => {
      if (context.agent.id === oldOwner) {
        // The reassignment cancels this run and parks the new assignee's wake
        // while this executor still holds its process and lease.
        await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, context.runId));
        await db.update(issues).set({ assigneeAgentId: newOwner }).where(eq(issues.id, issueId));
        await db.insert(agentWakeupRequests).values({ companyId, agentId: newOwner, source: "assignment", triggerDetail: "system",
          reason: "execution_reconciliation_required", status: "skipped",
          payload: { issueId, mutation: "update", interruptedRunId: context.runId,
            executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery.", recoveryActionId: null } } });
      }
      return { exitCode: 0, signal: null, timedOut: false, summary: "Completed" };
    });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.invoke(oldOwner, "assignment", { issueId }, "system");
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
    const handoffRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, newOwner));
    const handoffs = handoffRuns.filter(r => r.contextSnapshot?.wakeReason === "issue_assigned");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ invocationSource: "assignment", contextSnapshot: { issueId } });
  }, 30_000);

  it("leaves a wake held by a real recovery action parked", async () => {
    const { stoppedRun, parked } = await seed("deferred_issue_execution", randomUUID());
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.readmitReassignmentHandoff(stoppedRun)).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, parked.id));
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
  });
});
