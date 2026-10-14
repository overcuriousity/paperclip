import { describe, expect, it } from "vitest";
import { isParkedReassignmentHandoff, reassignmentHandoffWakeup } from "./reassignment-handoff.js";

// Fixtures are the two incident rows: MIK-234 (deferred) and MIK-255 (skipped).
const MIK234 = "74b5c89f-fbe2-4b1b-868a-b1eec9c37ce7";
const COO_RUN = "5c305b33-8296-47f9-a0df-9fe8fa37d966";
const COMMENT = "21995863-8e4f-4c7c-8c3e-c575cc0ab718";
// The handoff wake with a comment, parked 41 ms before the stopped run's lease was released.
const deferred234 = () => ({
  id: "2bb369ce-85ae-4316-b5f8-1225018c8636",
  status: "deferred_issue_execution", runId: null as string | null,
  source: "assignment", triggerDetail: "system", reason: "issue_assigned",
  requestedByActorType: "agent", requestedByActorId: "92f74a97-0400-45d3-bdf8-8e36ba1a1547",
  payload: {
    issueId: MIK234, mutation: "update", commentId: COMMENT,
    executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved.", recoveryActionId: null } as Record<string, unknown>,
    interruptedRunId: COO_RUN,
    _paperclipWakeContext: {
      source: "issue.update", taskId: MIK234, issueId: MIK234, taskKey: MIK234,
      commentId: COMMENT, wakeReason: "issue_assigned", wakeSource: "assignment",
      wakeCommentId: COMMENT, wakeCommentIds: [COMMENT],
      interruptedRunId: COO_RUN, wakeTriggerDetail: "system",
    },
  } as Record<string, unknown>,
});

const MIK255 = "190f46d5-ef55-4610-bbc0-4ff0f54299fc";
const ENG_RUN = "b25ef22a-040c-4a41-847e-a41811b192ca";
// The handoff wake with no comment: admission wrote a skipped execution-wait receipt.
const skipped255 = () => ({
  id: "84d4522b-4ca8-48a3-8e40-05f796922122",
  status: "skipped", runId: null as string | null,
  source: "assignment", triggerDetail: "system", reason: "execution_reconciliation_required",
  requestedByActorType: "agent", requestedByActorId: "1dcf17f6-a5f4-42f5-ae89-021b418882ae",
  payload: {
    issueId: MIK255, mutation: "update",
    executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved.", recoveryActionId: null, requestedIdempotencyKey: null },
    interruptedRunId: ENG_RUN,
  } as Record<string, unknown>,
});

describe("isParkedReassignmentHandoff", () => {
  it("selects the deferred handoff and the skipped handoff", () => {
    expect(isParkedReassignmentHandoff(deferred234(), COO_RUN)).toBe(true);
    expect(isParkedReassignmentHandoff(skipped255(), ENG_RUN)).toBe(true);
  });

  it("ignores a wake for another stopped run", () => {
    expect(isParkedReassignmentHandoff(deferred234(), ENG_RUN)).toBe(false);
    expect(isParkedReassignmentHandoff(deferred234(), null)).toBe(false);
  });

  it("keeps a real recovery hold parked", () => {
    const w = deferred234();
    (w.payload.executionWait as Record<string, unknown>).recoveryActionId = "0c0ffee0-0000-4000-8000-000000000000";
    expect(isParkedReassignmentHandoff(w, COO_RUN)).toBe(false);
  });

  it("ignores waits that are not the ownership blocker", () => {
    const paused = deferred234();
    paused.payload.executionWait = { reason: "issue_tree_hold_active", message: "This task is paused." };
    expect(isParkedReassignmentHandoff(paused, COO_RUN)).toBe(false);
    const noKey = deferred234();
    delete (noKey.payload.executionWait as Record<string, unknown>).recoveryActionId;
    expect(isParkedReassignmentHandoff(noKey, COO_RUN)).toBe(false);
    const blockedDeps = skipped255();
    blockedDeps.reason = "issue_dependencies_blocked";
    expect(isParkedReassignmentHandoff(blockedDeps, ENG_RUN)).toBe(false);
  });

  it("ignores a wake that already has a run or is no longer parked", () => {
    expect(isParkedReassignmentHandoff({ ...deferred234(), runId: COO_RUN }, COO_RUN)).toBe(false);
    expect(isParkedReassignmentHandoff({ ...deferred234(), status: "coalesced" }, COO_RUN)).toBe(false);
    expect(isParkedReassignmentHandoff({ ...deferred234(), status: "queued" }, COO_RUN)).toBe(false);
  });
});

describe("reassignmentHandoffWakeup", () => {
  it("rebuilds the deferred wake from its saved context", () => {
    const w = reassignmentHandoffWakeup(deferred234(), MIK234);
    expect(w.source).toBe("assignment");
    expect(w.reason).toBe("issue_assigned");
    expect(w.requestedByActorType).toBe("agent");
    expect(w.requestedByActorId).toBe("92f74a97-0400-45d3-bdf8-8e36ba1a1547");
    // The stale wait marker must not be re-sent; admission rebuilds the context key itself.
    expect(w.payload.executionWait).toBeUndefined();
    expect(w.payload._paperclipWakeContext).toBeUndefined();
    expect(w.payload.interruptedRunId).toBe(COO_RUN);
    expect(w.contextSnapshot.wakeCommentId).toBe(COMMENT);
    expect(w.contextSnapshot.source).toBe("issue.update");
  });

  it("rebuilds the skipped wake as an assignment, not as its skip reason", () => {
    const w = reassignmentHandoffWakeup(skipped255(), MIK255);
    expect(w.reason).toBe("issue_assigned");
    expect(w.contextSnapshot).toEqual({
      issueId: MIK255, taskId: MIK255, wakeReason: "issue_assigned", source: "issue.update", interruptedRunId: ENG_RUN,
    });
    expect(w.payload.issueId).toBe(MIK255);
  });

  it("rebuilds a skipped review-gate wake with its stage reason", () => {
    const r = skipped255();
    r.payload.executionStage = { wakeRole: "reviewer", stageType: "review", allowedActions: ["approve", "request_changes"] };
    const w = reassignmentHandoffWakeup(r, MIK255);
    expect(w.reason).toBe("execution_review_requested");
    expect(w.contextSnapshot.source).toBe("issue.execution_stage");
    expect(w.contextSnapshot.executionStage).toEqual(r.payload.executionStage);
    const back = skipped255();
    back.payload.executionStage = { wakeRole: "executor" };
    expect(reassignmentHandoffWakeup(back, MIK255).reason).toBe("execution_changes_requested");
  });
});
