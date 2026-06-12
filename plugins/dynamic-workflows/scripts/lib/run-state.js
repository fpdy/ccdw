import fs from "node:fs";
import path from "node:path";
import {
  EVENT_LOG_FILE,
  RUN_STATE_FILE,
  SCHEMA_VERSION,
  TERMINAL_RUN_STATUSES,
  WORKFLOW_FILE,
  WorkflowError,
} from "./constants.js";
import { hashBytes, nowIso, readJson, writeJson } from "./util.js";
import {
  requireArray,
  requireNonNegativeInteger,
  requireObject,
  requireString,
  validateWorkflowSpec,
} from "./spec.js";
import { synthesizeWorkerSchema, validateValueAgainstSchema } from "./output-schema.js";

export function readWorkflowSpec(runDir) {
  return readJson(path.join(runDir, WORKFLOW_FILE));
}

export function readVerifiedWorkflowSpec(runDir, state, action = "read") {
  const specPath = path.join(runDir, WORKFLOW_FILE);
  const bytes = fs.readFileSync(specPath);
  const currentHash = hashBytes(bytes);
  if (typeof state?.spec_hash === "string" && state.spec_hash !== currentHash) {
    throw new WorkflowError("Workflow spec changed since plan; refusing to continue.", {
      action,
      planned_hash: state.spec_hash,
      current_hash: currentHash,
    });
  }
  const workflow = JSON.parse(bytes.toString("utf8"));
  if (workflow?.schema_version !== SCHEMA_VERSION) {
    throw new WorkflowError("unsupported schema_version; re-plan required.", {
      action,
      found: workflow?.schema_version ?? null,
      expected: SCHEMA_VERSION,
    });
  }
  return workflow;
}

export function readRunState(runDir) {
  return readJson(path.join(runDir, RUN_STATE_FILE));
}

export function validateRunState(state) {
  const errors = [];
  requireString(state, "schema_version", errors);
  if (typeof state?.schema_version === "string" && state.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `unsupported schema_version: ${state.schema_version} (expected ${SCHEMA_VERSION}); re-plan required`,
    );
  }
  requireString(state, "run_id", errors);
  requireString(state, "status", errors);
  requireString(state, "created_at", errors);
  requireString(state, "updated_at", errors);
  requireObject(state, "tasks", errors);
  requireObject(state, "attempts", errors);
  requireArray(state, "expanded_tasks", errors);
  requireArray(state, "artifacts", errors);
  requireObject(state, "locks", errors);
  requireObject(state, "budget_usage", errors);
  requireNonNegativeInteger(state, "event_log_offset", errors);
  const validStatuses = new Set([
    "planned",
    "awaiting_approval",
    "approved",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]);
  if (!validStatuses.has(state.status)) {
    errors.push(`invalid run status: ${state.status}`);
  }
  return errors;
}

export function validateWorkerResult(result, task = null) {
  // Typed envelope (output_schema tasks): the slim form is validated entirely
  // against the synthesized schema, including result.output.
  if (task?.output_schema != null) {
    return validateValueAgainstSchema(
      result,
      synthesizeWorkerSchema(task, { includeIdentity: true }),
      "worker_result",
    ).errors;
  }
  const errors = [];
  requireString(result, "task_id", errors, "worker_result");
  requireString(result, "attempt_id", errors, "worker_result");
  requireString(result, "status", errors, "worker_result");
  requireString(result, "summary", errors, "worker_result");
  for (const field of ["findings", "errors", "evidence", "modified_files", "commands_run", "artifacts"]) {
    requireArray(result, field, errors, "worker_result");
  }
  if (!["succeeded", "failed"].includes(result.status)) {
    errors.push(`invalid worker result status: ${result.status}`);
  }
  // Route tasks (F4, spec §2.2): the envelope carries the resolution value,
  // constrained to the declared enum. Typed-form tasks are covered by the
  // synthesized-schema branch above.
  if (task?.route != null) {
    const values = Array.isArray(task.route.values) ? task.route.values : [];
    if (typeof result.route !== "string" || !values.includes(result.route)) {
      errors.push(`worker_result.route must be one of: ${values.join(", ")}`);
    }
  }
  for (const finding of result.findings ?? []) {
    requireString(finding, "claim", errors, "finding");
    requireArray(finding, "evidence", errors, "finding");
    requireArray(finding, "source_files", errors, "finding");
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
      errors.push("finding.confidence must be between 0 and 1");
    }
    requireString(finding, "severity", errors, "finding");
    requireString(finding, "verification_status", errors, "finding");
    if (typeof finding.verifier_notes !== "string") {
      errors.push("finding.verifier_notes must be a string");
    }
    if (finding.rejection_reason !== null && typeof finding.rejection_reason !== "string") {
      errors.push("finding.rejection_reason must be a string or null");
    }
    if (!["unverified", "verified", "rejected", "unresolved"].includes(finding.verification_status)) {
      errors.push(`invalid finding verification_status: ${finding.verification_status}`);
    }
  }
  return errors;
}

// --- State helpers ---------------------------------------------------------

export function setPhaseStatus(runDir, state, phaseId, status, payload = {}) {
  state.current_phase = status === "running" ? phaseId : state.current_phase;
  state.phases[phaseId].status = status;
  state.phases[phaseId].updated_at = nowIso();
  recordEvent(runDir, state, "phase_status_changed", {
    phase_id: phaseId,
    status,
    ...payload,
  });
}

export function setTaskStatus(runDir, state, taskId, status, payload = {}) {
  state.tasks[taskId].status = status;
  state.tasks[taskId].updated_at = nowIso();
  recordEvent(runDir, state, "task_status_changed", {
    task_id: taskId,
    status,
    ...payload,
  });
}

export function failRun(runDir, state, summary, payload = {}) {
  if (TERMINAL_RUN_STATUSES.has(state.status) || state.status === "paused") {
    // Never clobber an externally requested terminal/paused transition.
    return;
  }
  state.status = "failed";
  state.current_phase = null;
  state.outcome = {
    status: "failed",
    summary,
  };
  recordEvent(runDir, state, "run_failed", {
    summary,
    ...payload,
  });
}

export function validateRunConsistency(workflow, state) {
  const errors = [];
  if (workflow.run_id !== state.run_id) {
    errors.push("workflow.run_id and state.run_id differ");
  }
  for (const task of workflow.tasks) {
    if (!state.tasks[task.task_id]) {
      errors.push(`run state missing task ${task.task_id}`);
    }
  }
  // Foreach children (spec §6.2) live only in run state: every state task
  // entry that is not a spec task must be backed by a persisted expanded-task
  // definition, and every expanded definition must keep its state entry.
  const specTaskIds = new Set(workflow.tasks.map((task) => task.task_id));
  const expandedTasks = Array.isArray(state.expanded_tasks) ? state.expanded_tasks : [];
  const expandedTaskIds = new Set(expandedTasks.map((child) => child?.task_id));
  for (const taskId of Object.keys(state.tasks ?? {})) {
    if (!specTaskIds.has(taskId) && !expandedTaskIds.has(taskId)) {
      errors.push(`run state task ${taskId} has no workflow or expanded task definition`);
    }
  }
  for (const child of expandedTasks) {
    if (typeof child?.task_id !== "string" || !state.tasks?.[child?.task_id]) {
      errors.push(`run state missing expanded task ${child?.task_id}`);
    }
  }
  for (const phase of workflow.phases) {
    if (!state.phases?.[phase.phase_id]) {
      errors.push(`run state missing phase ${phase.phase_id}`);
    }
  }
  return errors;
}

export function assertKnownRunState(state, workflow) {
  const errors = [
    ...validateWorkflowSpec(workflow),
    ...validateRunState(state),
    ...validateRunConsistency(workflow, state),
  ];
  if (errors.length > 0) {
    throw new WorkflowError("Run directory validation failed.", { errors });
  }
}

export function countTaskStatuses(state) {
  const counts = {};
  for (const taskState of Object.values(state.tasks ?? {})) {
    counts[taskState.status] = (counts[taskState.status] ?? 0) + 1;
  }
  return counts;
}

export function recordEvent(runDir, state, type, payload = {}) {
  const timestamp = nowIso();
  const event = {
    schema_version: SCHEMA_VERSION,
    timestamp,
    run_id: state.run_id,
    type,
    payload,
  };
  const eventPath = path.join(runDir, EVENT_LOG_FILE);
  fs.appendFileSync(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  state.updated_at = timestamp;
  state.event_count = (state.event_count ?? 0) + 1;
  state.event_log_offset = fs.statSync(eventPath).size;
  writeJson(path.join(runDir, RUN_STATE_FILE), state);
  return event;
}

export function persistRunState(runDir, state) {
  writeJson(path.join(runDir, RUN_STATE_FILE), state);
}

export function countEvents(runDir) {
  const eventPath = path.join(runDir, EVENT_LOG_FILE);
  if (!fs.existsSync(eventPath)) {
    return 0;
  }
  const content = fs.readFileSync(eventPath, "utf8").trim();
  return content ? content.split("\n").length : 0;
}
