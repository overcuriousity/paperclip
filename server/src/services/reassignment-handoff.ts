// Re-admit a reassignment handoff wake that lost the race with the stopped
// run's cleanup (mikoshi MIK-268).
//
// PATCH /issues/:id with a new assignee stops the old owner's run
// (cancelled / issue_reassigned) and admits the new assignee's wake in the same
// request. cancelRun returns once the row is cancelled; the provider process
// and its environment lease go away a few ms later. If admission reads the
// ownership blocker (getConversationOwnershipBlocker) inside that window, the
// wake is parked: `deferred_issue_execution` when the update carried a
// comment, or a `skipped` execution-wait receipt when it did not. Both carry
// `executionWait.recoveryActionId: null`. Nothing re-admits them: the cleanup
// promotion only looks at the stopped run's own agent, and the stranded-queue
// sweep only at runs of the wake's agent, which has none on a fresh handoff.
// These helpers are pure so the selection and the rebuilt wake can be tested
// without a database.
import type { agentWakeupRequests } from "@paperclipai/db";

type WakeRow = typeof agentWakeupRequests.$inferSelect;

export type ParkedHandoffWake = Pick<WakeRow, "status" | "runId" | "reason" | "payload"> &
  Partial<Pick<WakeRow, "source" | "triggerDetail" | "requestedByActorType" | "requestedByActorId">>;

export interface ReassignmentHandoffWakeup {
  source: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail: "manual" | "ping" | "callback" | "system";
  reason: string;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string;
}

const WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const STAGE_WAKE_REASONS: Record<string, string> = {
  reviewer: "execution_review_requested",
  approver: "execution_approval_requested",
  executor: "execution_changes_requested",
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * True only for the handoff wake of `stoppedRunId` that was parked on the
 * ownership blocker. A wake held by a real recovery action (non-null
 * recoveryActionId), or parked or skipped for any other reason, is left alone.
 */
export function isParkedReassignmentHandoff(
  wake: ParkedHandoffWake | null | undefined,
  stoppedRunId: string | null | undefined,
): boolean {
  if (!wake || !stoppedRunId || wake.runId) return false;
  const payload = record(wake.payload);
  const wait = record(payload.executionWait);
  if (payload.interruptedRunId !== stoppedRunId) return false;
  if (wait.reason !== "execution_recovery" || !("recoveryActionId" in wait) || wait.recoveryActionId !== null) {
    return false;
  }
  if (wake.status === "deferred_issue_execution") return true;
  return wake.status === "skipped" && wake.reason === "execution_reconciliation_required";
}

/**
 * Rebuilds the enqueueWakeup options of the original handoff. A skipped
 * receipt stores `execution_reconciliation_required` as its reason, so the
 * original reason comes from the saved wake context, the execution stage, or
 * the plain assignment default, in that order.
 */
export function reassignmentHandoffWakeup(wake: ParkedHandoffWake, issueId: string): ReassignmentHandoffWakeup {
  const payload = { ...record(wake.payload) };
  const context = record(payload[WAKE_CONTEXT_KEY]);
  delete payload.executionWait;
  delete payload[WAKE_CONTEXT_KEY];
  const stage = record(payload.executionStage);
  const reason =
    nonEmpty(context.wakeReason) ??
    (wake.status === "deferred_issue_execution" ? nonEmpty(wake.reason) : null) ??
    STAGE_WAKE_REASONS[String(stage.wakeRole)] ??
    "issue_assigned";
  const commentId = nonEmpty(payload.commentId);
  const contextSnapshot = Object.keys(context).length > 0 ? { ...context } : {
    issueId,
    taskId: issueId,
    wakeReason: reason,
    source: payload.executionStage ? "issue.execution_stage" : "issue.update",
    ...(payload.executionStage ? { executionStage: payload.executionStage } : {}),
    ...(commentId ? { commentId, wakeCommentId: commentId } : {}),
    interruptedRunId: payload.interruptedRunId,
  };
  return {
    source: (nonEmpty(wake.source) ?? "assignment") as ReassignmentHandoffWakeup["source"],
    triggerDetail: (nonEmpty(wake.triggerDetail) ?? "system") as ReassignmentHandoffWakeup["triggerDetail"],
    reason,
    payload: { ...payload, issueId },
    contextSnapshot,
    requestedByActorType: (wake.requestedByActorType ?? undefined) as ReassignmentHandoffWakeup["requestedByActorType"],
    requestedByActorId: wake.requestedByActorId ?? undefined,
  };
}
