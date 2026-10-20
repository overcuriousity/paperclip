import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });


it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});


it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});


it("recognizes only an unclaimed pre-dispatch review wait receipt", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 },
    { processStartedAt: new Date() }, { nativeSessionId: "provider-session" }, { nativeIssueId: "native-task" },
    { sessionIdAfter: "provider-session" }, { runtimeModeResolvedAt: new Date() },
    { controllerBootId: "live-controller" }, { controllerLeaseExpiresAt: new Date() }, { executionStage: "preparing" },
    { errorCode: "operator_interrupted" }, { resultJson: {} },
    { resultJson: { ...run.resultJson, stopReason: "cancelled" } },
    { resultJson: { ...run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } },
  ]) expect(isPreDispatchReviewWait({ ...run, ...patch })).toBe(false);
});

it("does not hold a run the claim-time gate cancelled before it started (MIK-30)", () => {
  const gated = { runtimeMode: "legacy", status: "cancelled", errorCode: "execution_reconciliation_required", startedAt: null,
    resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
      executionWait: { reason: "execution_recovery" } } };
  expect(legacyExecutionNeedsReconciliation(gated)).toBe(false);
  // A run the gate stopped after it started may have reached the provider.
  expect(legacyExecutionNeedsReconciliation({ ...gated, startedAt: new Date() })).toBe(true);
  // Since MIK-288 any never-started gate cancel is exempt; other cancellations
  // from other sources keep their hold.
  expect(legacyExecutionNeedsReconciliation({ ...gated, errorCode: "cancelled" })).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...gated, errorCode: "cancelled", resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...gated, resultJson: { stopReason: "execution_reconciliation_required" } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...gated, status: "failed" })).toBe(true);
});

// Run 80de193d (MIK-252): cancelled 30 ms after queueing on reassignment, never
// started, then picked by the recovery sweep as the review participant's latest run.
const mik252 = () => ({
  runtimeMode: "legacy", status: "cancelled", errorCode: "issue_assignee_changed", startedAt: null, processPid: null,
  resultJson: { stopReason: "issue_assignee_changed", timeoutFired: false, timeoutSource: "stale_queued_run_gate",
    timeoutConfigured: false, effectiveTimeoutSec: 0 },
});

it("does not hold a never-started run cancelled on reassignment (MIK-288, run of MIK-252)", () => {
  expect(legacyExecutionNeedsReconciliation(mik252())).toBe(false);
});

it.each(["issue_dependencies_blocked", "issue_terminal_status"])("does not hold a never-started run cancelled with %s (MIK-288)", (errorCode) => {
  expect(legacyExecutionNeedsReconciliation({ ...mik252(), errorCode, resultJson: {} })).toBe(false);
});

it("does not hold any never-started run the stale queued-run gate cancelled (MIK-288)", () => {
  expect(legacyExecutionNeedsReconciliation({ ...mik252(), errorCode: "something_new" })).toBe(false);
});

it("holds a cancelled run that started (MIK-288)", () => {
  const started = { ...mik252(), startedAt: new Date("2026-10-14T08:00:00Z"), processPid: 4242 };
  expect(legacyExecutionNeedsReconciliation(started)).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...started, processPid: null })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...mik252(), processPid: 4242 })).toBe(true);
});

it("holds a never-started cancel with an unrelated code and no gate source (MIK-288)", () => {
  expect(legacyExecutionNeedsReconciliation({ ...mik252(), errorCode: "cancelled_by_operator", resultJson: {} })).toBe(true);
});

it("still exempts the MIK-30 claim-time gate cancel alongside MIK-288", () => {
  expect(legacyExecutionNeedsReconciliation({ ...mik252(), errorCode: "execution_reconciliation_required" })).toBe(false);
});

it("leaves failed runs to the existing rules (MIK-288)", () => {
  const failed = { ...mik252(), status: "failed", errorCode: "adapter_failed",
    startedAt: new Date("2026-10-14T08:00:00Z"), processPid: 4242, resultJson: {} };
  expect(legacyExecutionNeedsReconciliation(failed)).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...failed, errorCode: "issue_assignee_changed", startedAt: null, processPid: null })).toBe(true);
});

// Run 78f38052 (MIK-574, Head, 2026-10-19): a disposition repair the dispatch
// gate cancelled after the claim and before adapter.execute (MIK-684).
const mik574Repair = () => ({
  runtimeMode: "legacy", status: "cancelled", errorCode: "legacy_disposition_repair_suppressed",
  startedAt: new Date("2026-10-19T11:46:37.253Z"), processPid: null, processGroupId: null,
  resultJson: { cancellation: { reason: "Execution stopped without a recorded cancellation." } },
});

it("does not hold a disposition repair the dispatch gate suppressed (MIK-684, run of MIK-574)", () => {
  expect(legacyExecutionNeedsReconciliation(mik574Repair())).toBe(false);
});

it("holds a suppressed repair that has process evidence (MIK-684)", () => {
  expect(legacyExecutionNeedsReconciliation({ ...mik574Repair(), processPid: 4242 })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...mik574Repair(), processGroupId: 4242 })).toBe(true);
});

it("holds other started cancellations and failed repairs (MIK-684)", () => {
  expect(legacyExecutionNeedsReconciliation({ ...mik574Repair(), errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...mik574Repair(), status: "failed" })).toBe(true);
});
