export const SCHEMA_VERSION = "dynamic-workflows.v2";
export const CCDW_HOME_ENV = "CCDW_HOME";
export const DEFAULT_CCDW_HOME = ".ccdw";
export const DEFAULT_RUN_ROOT = ".ccdw/dynamic-workflows/runs";
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const RUN_ID_PATTERN = /^(?!\.+$)[A-Za-z0-9._-]{1,64}$/;
export const SPEC_ID_PATTERN = /^(?!\.+$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const RUN_STATE_FILE = "run.json";
export const WORKFLOW_FILE = "workflow.yaml";
export const EVENT_LOG_FILE = "events.ndjson";
export const LOCK_FILE = "orchestrator.lock";
export const CONTROL_DIR = "control";
export const CANCEL_SIGNAL_FILE = "cancel.json";
export const RUNNER_LOG_FILE = "runner.log";
export const WORKER_SCHEMA_FILE = "worker-output.schema.json";
export const CLAUDE_SETTINGS_FILE = "claude-settings.json";
export const SPEC_ID_PATTERN_DESCRIPTION = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const PARTIAL_RESULT_POLICIES = new Set(["quarantine", "accept", "discard"]);
export const GOAL_STATUS_EFFECTS = new Set(["active", "complete", "blocked"]);

export const PERMANENT_FAILURE_TASK_STATUSES = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "schema_violation",
  "gate_failed",
  "skipped",
]);
// Terminal statuses that satisfy dependencies and never fail a run (spec §5.2
// R1/R2/R4): skipped_by_route marks a task a route resolution deliberately
// deactivated, so it must not cascade skips, count as a failure, or be
// retried/resumed (R5: a route resolution is final).
export const NON_FAILURE_TERMINAL_TASK_STATUSES = new Set(["succeeded", "skipped_by_route"]);
// "expanded" (spec §6.2, F6) is a deliberately NON-terminal task status: a
// foreach parent whose expanded children are still pending. It is excluded
// from every set here so an expanded parent neither satisfies dependencies
// nor is retried/resumed; the scheduler treats it as live work (like
// queued/running) and folds it to succeeded or failed only once every
// expanded child reached a terminal status.
export const EXPANDED_TASK_STATUS = "expanded";
export const TERMINAL_TASK_STATUSES = new Set([
  ...NON_FAILURE_TERMINAL_TASK_STATUSES,
  ...PERMANENT_FAILURE_TASK_STATUSES,
]);
export const RETRYABLE_TASK_STATUSES = new Set(["failed", "timed_out", "schema_violation", "gate_failed"]);
// Resume may also requeue skipped tasks: a skip is always derived from a failed
// blocker, and the scheduler re-skips any task whose blocker is still dead.
// skipped_by_route is deliberately absent (spec §5.2 R5).
export const RESUMABLE_TASK_STATUSES = new Set([...RETRYABLE_TASK_STATUSES, "skipped"]);

// Spec fields that are recorded and surfaced to the approver but not enforced
// by the scheduler. They are listed in the approval summary so consent is
// based on what the runner actually does.
export const ADVISORY_SPEC_FIELDS = [
  "max_cost",
  "max_retries",
  "max_no_progress_iterations",
];

export class WorkflowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkflowError";
    this.details = details;
  }
}
