import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";

// MIK-137: when this server cannot renew a run's controller lease (event-loop
// or database stall), the lease watcher aborts the adapter. That is a
// server-side process loss and must not be recorded like a user Stop.
const controllers = vi.hoisted(() => new Map<string, AbortController>());
vi.mock("../services/legacy-controller-lease.js", async () => {
  const actual = await vi.importActual<typeof import("../services/legacy-controller-lease.js")>("../services/legacy-controller-lease.js");
  return {
    ...actual,
    watchLegacyControllerLease: (db: never, run: { id: string }, controller: AbortController) => {
      controllers.set(run.id, controller);
      return actual.watchLegacyControllerLease(db, run as never, controller);
    },
  };
});
const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("legacy controller lease loss", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("controller-lease-loss-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function runAbortedWith(reason: Error) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease", issuePrefix: `L${companyId.slice(0, 5).toUpperCase()}`, defaultResponsibleUserId: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "claude_local",
      adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Lease task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "owner" });
    execute.mockImplementationOnce(async (context: { runId: string }) => {
      controllers.get(context.runId)?.abort(reason);
      return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: "Process terminated" };
    });
    execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, summary: "Completed" });
    const heartbeat = heartbeatService(db);
    let runId: string | undefined;
    try {
      runId = (await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual"))?.id;
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
    const retries = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.retryOfRunId === run.id);
    return { run, retries };
  }

  it("records a lease-loss abort as a failed run with a continuation and a retry", async () => {
    const { run, retries } = await runAbortedWith(new Error("Legacy controller lease lost"));
    expect(run).toMatchObject({ status: "failed", errorCode: "controller_lease_lost" });
    expect(run.resultJson?.conversationContinuation).toBe("continue_conversation_v1");
    expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
    expect(retries).toHaveLength(1);
  }, 30_000);

  it("still records any other abort as cancelled", async () => {
    const { run, retries } = await runAbortedWith(new Error("Stopped by user"));
    expect(run.status).toBe("cancelled");
    expect(run.errorCode).not.toBe("controller_lease_lost");
    expect(retries).toHaveLength(0);
  }, 30_000);
});
