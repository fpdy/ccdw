// Re-exporting facade over the dynamic-workflows engine modules.
//
// The CLI (scripts/dynamic-workflows.js), the MCP server
// (scripts/dynamic-workflows-mcp.js), and the tests import exclusively from
// this module; the export surface below is the stable public API and must not
// change shape during refactors.
//
// Module dependency direction (one-way):
//   constants -> util -> spec -> run-state -> (approval, lock-control)
//     -> scheduler -> commands

export {
  ADVISORY_SPEC_FIELDS,
  CCDW_HOME_ENV,
  DEFAULT_CCDW_HOME,
  DEFAULT_RUN_ROOT,
  RUN_ID_PATTERN,
  SCHEMA_VERSION,
  SPEC_ID_PATTERN,
  TERMINAL_RUN_STATUSES,
  WorkflowError,
} from "./constants.js";

export { resolveExecutorKind } from "./util.js";

export { applySpecDefaults, validateWorkflowSpec } from "./spec.js";

export {
  readRunState,
  readVerifiedWorkflowSpec,
  readWorkflowSpec,
  validateRunState,
  validateWorkerResult,
} from "./run-state.js";

export { readLiveLock } from "./lock-control.js";

export {
  approveWorkflow,
  cancelWorkflow,
  detachWorkflowRun,
  listWorkflowRuns,
  planWorkflow,
  readWorkflowEvents,
  resumeWorkflow,
  runWorkflow,
  statusWorkflow,
  validatePluginLayout,
  validateRunDirectory,
} from "./commands.js";
