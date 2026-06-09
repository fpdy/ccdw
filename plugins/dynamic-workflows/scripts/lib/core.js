import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "dynamic-workflows.v1";
export const CCDW_HOME_ENV = "CCDW_HOME";
export const DEFAULT_CCDW_HOME = ".ccdw";
export const DEFAULT_RUN_ROOT = ".ccdw/dynamic-workflows/runs";
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

const RUN_STATE_FILE = "run.json";
const WORKFLOW_FILE = "workflow.yaml";
const EVENT_LOG_FILE = "events.ndjson";

export class WorkflowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkflowError";
    this.details = details;
  }
}

export function planWorkflow(options = {}) {
  const objective = normalizeObjective(options.objective);
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const runRoot = resolveRunRoot(options.runRoot, workspace);
  const runId = options.runId ?? makeId("run");
  const workflowId = options.workflowId ?? makeId("wf");
  const runDir = path.join(runRoot, runId);

  if (fs.existsSync(runDir) && !options.force) {
    throw new WorkflowError("Run directory already exists.", { runDir });
  }

  ensureDir(runDir);
  ensureDir(path.join(runDir, "artifacts"));

  const createdAt = nowIso();
  const workflow = buildDefaultWorkflowSpec({
    objective,
    workspace,
    runId,
    workflowId,
    createdAt,
  });
  const workflowErrors = validateWorkflowSpec(workflow);
  if (workflowErrors.length > 0) {
    throw new WorkflowError("Generated workflow failed validation.", {
      errors: workflowErrors,
    });
  }

  const state = buildInitialRunState({
    workflow,
    goalId: options.goalId ?? null,
    createdAt,
  });
  const stateErrors = validateRunState(state);
  if (stateErrors.length > 0) {
    throw new WorkflowError("Generated run state failed validation.", {
      errors: stateErrors,
    });
  }

  writeJson(path.join(runDir, WORKFLOW_FILE), workflow);
  writeJson(path.join(runDir, RUN_STATE_FILE), state);
  recordEvent(runDir, state, "workflow_planned", {
    workflow_id: workflow.workflow_id,
    workflow_spec_path: WORKFLOW_FILE,
    approval_required: true,
  });

  return summarizeRun(runDir, readRunState(runDir), workflow);
}

export function approveWorkflow(options = {}) {
  const runDir = requireRunDir(options.runDir);
  const state = readRunState(runDir);
  const workflow = readWorkflowSpec(runDir);
  assertKnownRunState(state, workflow);

  if (state.status === "approved" || state.status === "running") {
    return summarizeRun(runDir, state, workflow);
  }
  if (state.status !== "awaiting_approval" && state.status !== "planned") {
    throw new WorkflowError("Only planned or awaiting_approval runs can be approved.", {
      status: state.status,
    });
  }

  const timestamp = nowIso();
  state.status = "approved";
  state.approval.approved_at = timestamp;
  state.approval.approved_by = options.approvedBy ?? "local-user";
  state.updated_at = timestamp;
  recordEvent(runDir, state, "approval_granted", {
    approved_by: state.approval.approved_by,
  });
  return summarizeRun(runDir, readRunState(runDir), workflow);
}

export function runWorkflow(options = {}) {
  const runDir = requireRunDir(options.runDir);
  let state = readRunState(runDir);
  const workflow = readWorkflowSpec(runDir);
  assertKnownRunState(state, workflow);

  if (state.status === "awaiting_approval" || state.status === "planned") {
    if (!options.approve) {
      throw new WorkflowError("Run is awaiting approval. Re-run with --approve or call approve first.", {
        status: state.status,
      });
    }
    approveWorkflow({ runDir, approvedBy: options.approvedBy });
    state = readRunState(runDir);
  }

  if (state.status === "completed") {
    recordEvent(runDir, state, "run_noop", { reason: "already_completed" });
    return summarizeRun(runDir, readRunState(runDir), workflow);
  }
  if (state.status === "cancelled") {
    throw new WorkflowError("Cancelled runs cannot be run.", { status: state.status });
  }
  if (state.status === "failed" && !options.resumeFailed) {
    throw new WorkflowError("Failed runs require resume with explicit recovery.", {
      status: state.status,
    });
  }
  if (state.status !== "approved" && state.status !== "paused" && state.status !== "running") {
    throw new WorkflowError("Run is not in an executable status.", { status: state.status });
  }

  state.status = "running";
  state.updated_at = nowIso();
  recordEvent(runDir, state, "run_started", {
    workflow_id: workflow.workflow_id,
  });

  const startedAt = Date.now();
  let executedTasks = 0;
  for (const phase of workflow.phases) {
    state = readRunState(runDir);
    if (state.status !== "running") {
      break;
    }
    if (!phaseDependenciesSucceeded(state, phase)) {
      setPhaseStatus(runDir, state, phase.phase_id, "blocked", {
        reason: "dependencies_not_satisfied",
      });
      continue;
    }

    setPhaseStatus(runDir, state, phase.phase_id, "running");
    for (const taskId of phase.tasks) {
      state = readRunState(runDir);
      if (state.status !== "running") {
        break;
      }
      if (options.maxTasks != null && executedTasks >= Number(options.maxTasks)) {
        state.status = "paused";
        state.outcome = {
          status: "needs_user_input",
          summary: "Run paused after the requested max task count.",
        };
        recordEvent(runDir, state, "run_paused", { reason: "max_tasks_reached" });
        return summarizeRun(runDir, readRunState(runDir), workflow);
      }

      const task = workflow.tasks.find((candidate) => candidate.task_id === taskId);
      if (!task) {
        failRun(runDir, state, "Task referenced by phase is missing.", {
          task_id: taskId,
        });
        return summarizeRun(runDir, readRunState(runDir), workflow);
      }
      const taskState = state.tasks[task.task_id];
      if (taskState.status === "succeeded") {
        continue;
      }
      if (!taskDependenciesSucceeded(state, task)) {
        setTaskStatus(runDir, state, task.task_id, "failed", {
          reason: "dependencies_not_satisfied",
        });
        failRun(runDir, state, "Task dependencies were not satisfied.", {
          task_id: task.task_id,
        });
        return summarizeRun(runDir, readRunState(runDir), workflow);
      }

      executeLocalTask(runDir, workflow, state, task);
      executedTasks += 1;
      state = readRunState(runDir);
      if (state.tasks[task.task_id].status !== "succeeded") {
        failRun(runDir, state, "Task did not succeed.", { task_id: task.task_id });
        return summarizeRun(runDir, readRunState(runDir), workflow);
      }
    }

    state = readRunState(runDir);
    const phaseSucceeded = phase.tasks.every((taskId) => state.tasks[taskId]?.status === "succeeded");
    setPhaseStatus(runDir, state, phase.phase_id, phaseSucceeded ? "succeeded" : "failed");
    if (!phaseSucceeded && phase.on_failure === "fail") {
      failRun(runDir, state, "Phase failed.", { phase_id: phase.phase_id });
      return summarizeRun(runDir, readRunState(runDir), workflow);
    }
  }

  state = readRunState(runDir);
  if (state.status === "running") {
    state.status = "completed";
    state.current_phase = null;
    state.budget_usage.duration_ms += Date.now() - startedAt;
    state.outcome = {
      status: "success",
      summary: "Workflow completed with all tasks succeeded.",
      final_response_policy: state.final_response_policy,
    };
    recordEvent(runDir, state, "run_completed", {
      executed_tasks: executedTasks,
      outcome: state.outcome.status,
    });
  }

  return summarizeRun(runDir, readRunState(runDir), workflow);
}

export function resumeWorkflow(options = {}) {
  const runDir = requireRunDir(options.runDir);
  const workflow = readWorkflowSpec(runDir);
  const state = readRunState(runDir);
  assertKnownRunState(state, workflow);

  if (TERMINAL_RUN_STATUSES.has(state.status)) {
    recordEvent(runDir, state, "resume_noop", { reason: `terminal:${state.status}` });
    return summarizeRun(runDir, readRunState(runDir), workflow);
  }

  for (const taskState of Object.values(state.tasks)) {
    if (taskState.status === "running") {
      taskState.status = "queued";
      taskState.updated_at = nowIso();
    }
  }
  state.locks = {};
  if (state.status === "paused") {
    state.status = "approved";
  }
  recordEvent(runDir, state, "resume_requested", {
    continue: options.continueRun !== false,
  });

  if (options.continueRun === false) {
    return summarizeRun(runDir, readRunState(runDir), workflow);
  }
  return runWorkflow({
    runDir,
    approve: false,
    approvedBy: options.approvedBy,
    resumeFailed: options.resumeFailed,
  });
}

export function cancelWorkflow(options = {}) {
  const runDir = requireRunDir(options.runDir);
  const workflow = readWorkflowSpec(runDir);
  const state = readRunState(runDir);
  assertKnownRunState(state, workflow);

  if (state.status === "completed") {
    throw new WorkflowError("Completed runs cannot be cancelled.", {
      status: state.status,
    });
  }
  if (state.status === "cancelled") {
    return summarizeRun(runDir, state, workflow);
  }

  state.status = "cancelled";
  state.current_phase = null;
  state.outcome = {
    status: "cancelled",
    summary: options.reason ?? "Workflow cancelled.",
  };
  recordEvent(runDir, state, "cancel_requested", {
    reason: options.reason ?? "Workflow cancelled.",
  });
  return summarizeRun(runDir, readRunState(runDir), workflow);
}

export function statusWorkflow(options = {}) {
  const runDir = requireRunDir(options.runDir);
  const workflow = readWorkflowSpec(runDir);
  const state = readRunState(runDir);
  assertKnownRunState(state, workflow);
  return summarizeRun(runDir, state, workflow);
}

export function validateRunDirectory(options = {}) {
  const runDir = requireRunDir(options.runDir);
  const workflow = readWorkflowSpec(runDir);
  const state = readRunState(runDir);
  const workflowErrors = validateWorkflowSpec(workflow);
  const stateErrors = validateRunState(state);
  const consistencyErrors = validateRunConsistency(workflow, state);
  return {
    run_dir: runDir,
    valid: workflowErrors.length === 0 && stateErrors.length === 0 && consistencyErrors.length === 0,
    errors: [...workflowErrors, ...stateErrors, ...consistencyErrors],
  };
}

export function validatePluginLayout(options = {}) {
  const pluginRoot = path.resolve(options.pluginRoot ?? path.join(path.dirname(filePathFromImportMeta(import.meta.url)), "..", ".."));
  const requiredFiles = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "skills/dynamic-workflows/SKILL.md",
    "scripts/dynamic-workflows.js",
    "scripts/dynamic-workflows-mcp.js",
    "schemas/workflow.schema.json",
    "schemas/run-state.schema.json",
    "schemas/worker-result.schema.json",
  ];
  const missing = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(pluginRoot, relativePath)));
  return {
    plugin_root: pluginRoot,
    valid: missing.length === 0,
    missing,
  };
}

export function readWorkflowSpec(runDir) {
  return readJson(path.join(runDir, WORKFLOW_FILE));
}

export function readRunState(runDir) {
  return readJson(path.join(runDir, RUN_STATE_FILE));
}

export function validateWorkflowSpec(workflow) {
  const errors = [];
  requireString(workflow, "schema_version", errors);
  requireString(workflow, "workflow_id", errors);
  requireString(workflow, "name", errors);
  requireString(workflow, "objective", errors);
  requireArray(workflow, "phases", errors);
  requireArray(workflow, "tasks", errors);
  for (const field of ["max_concurrency", "max_agents", "max_tokens", "max_duration_ms", "max_retries", "max_no_progress_iterations"]) {
    requireNonNegativeInteger(workflow, field, errors);
  }
  if (typeof workflow.max_cost !== "number" || workflow.max_cost < 0) {
    errors.push("workflow.max_cost must be a non-negative number");
  }
  requireArray(workflow, "required_capabilities", errors);
  requireObject(workflow, "workspace_policy", errors);
  requireObject(workflow, "verification_policy", errors);
  requireArray(workflow, "stop_conditions", errors);

  const phaseIds = new Set();
  const taskIds = new Set();
  for (const phase of workflow.phases ?? []) {
    requireString(phase, "phase_id", errors, "phase");
    if (phaseIds.has(phase.phase_id)) {
      errors.push(`duplicate phase_id: ${phase.phase_id}`);
    }
    phaseIds.add(phase.phase_id);
    for (const field of ["depends_on", "tasks", "outputs"]) {
      requireArray(phase, field, errors, `phase:${phase.phase_id}`);
    }
  }
  for (const task of workflow.tasks ?? []) {
    requireString(task, "task_id", errors, "task");
    requireString(task, "phase_id", errors, `task:${task.task_id}`);
    requireString(task, "kind", errors, `task:${task.task_id}`);
    requireString(task, "role", errors, `task:${task.task_id}`);
    requireString(task, "prompt_template", errors, `task:${task.task_id}`);
    requireArray(task, "depends_on", errors, `task:${task.task_id}`);
    requireObject(task, "retry_policy", errors, `task:${task.task_id}`);
    if (taskIds.has(task.task_id)) {
      errors.push(`duplicate task_id: ${task.task_id}`);
    }
    taskIds.add(task.task_id);
    if (!phaseIds.has(task.phase_id)) {
      errors.push(`task ${task.task_id} references missing phase ${task.phase_id}`);
    }
  }
  for (const phase of workflow.phases ?? []) {
    for (const taskId of phase.tasks ?? []) {
      if (!taskIds.has(taskId)) {
        errors.push(`phase ${phase.phase_id} references missing task ${taskId}`);
      }
    }
    for (const dependency of phase.depends_on ?? []) {
      if (!phaseIds.has(dependency)) {
        errors.push(`phase ${phase.phase_id} references missing dependency ${dependency}`);
      }
    }
  }
  for (const task of workflow.tasks ?? []) {
    for (const dependency of task.depends_on ?? []) {
      if (!taskIds.has(dependency)) {
        errors.push(`task ${task.task_id} references missing dependency ${dependency}`);
      }
    }
  }
  return errors;
}

export function validateRunState(state) {
  const errors = [];
  requireString(state, "schema_version", errors);
  requireString(state, "run_id", errors);
  requireString(state, "status", errors);
  requireString(state, "created_at", errors);
  requireString(state, "updated_at", errors);
  requireObject(state, "tasks", errors);
  requireObject(state, "attempts", errors);
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

export function validateWorkerResult(result) {
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
  for (const finding of result.findings ?? []) {
    requireString(finding, "claim", errors, "finding");
    requireArray(finding, "evidence", errors, "finding");
    requireArray(finding, "source_files", errors, "finding");
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
      errors.push("finding.confidence must be between 0 and 1");
    }
    requireString(finding, "severity", errors, "finding");
    requireString(finding, "verification_status", errors, "finding");
    requireString(finding, "verifier_notes", errors, "finding");
    if (!["unverified", "verified", "rejected", "unresolved"].includes(finding.verification_status)) {
      errors.push(`invalid finding verification_status: ${finding.verification_status}`);
    }
  }
  return errors;
}

function buildDefaultWorkflowSpec({ objective, workspace, runId, workflowId, createdAt }) {
  const retryPolicy = {
    retryable: false,
    max_attempts: 1,
    backoff_ms: 0,
    partial_result_policy: "quarantine",
    cleanup_required: false,
    goal_status_effect: "active",
  };
  return {
    schema_version: SCHEMA_VERSION,
    workflow_id: workflowId,
    run_id: runId,
    name: `Dynamic workflow ${runId}`,
    objective,
    created_at: createdAt,
    phases: [
      {
        phase_id: "explore",
        name: "Explore objective",
        depends_on: [],
        entry_condition: "always",
        tasks: ["explore-objective"],
        completion_condition: "all_tasks_succeeded",
        verification_required: false,
        on_failure: "fail",
        outputs: ["artifacts/explore-objective/result.json"],
      },
      {
        phase_id: "verify",
        name: "Verify findings",
        depends_on: ["explore"],
        entry_condition: "dependencies_succeeded",
        tasks: ["verify-findings"],
        completion_condition: "all_tasks_succeeded",
        verification_required: true,
        on_failure: "fail",
        outputs: ["artifacts/verify-findings/result.json"],
      },
      {
        phase_id: "synthesize",
        name: "Synthesize result",
        depends_on: ["verify"],
        entry_condition: "dependencies_succeeded",
        tasks: ["synthesize-result"],
        completion_condition: "all_tasks_succeeded",
        verification_required: false,
        on_failure: "fail",
        outputs: ["artifacts/synthesize-result/result.json", "artifacts/synthesis.md"],
      },
    ],
    tasks: [
      {
        task_id: "explore-objective",
        phase_id: "explore",
        kind: "local_analysis",
        role: "workflow-planner",
        prompt_template: "Identify the objective, constraints, and initial execution notes.",
        input_source: "objective",
        fanout_source: null,
        depends_on: [],
        condition: "always",
        expected_output_schema: "WorkerResult",
        retry_policy: retryPolicy,
        verification_required: false,
        stop_condition: "budget_or_cancelled",
        outputs: ["result.json"],
      },
      {
        task_id: "verify-findings",
        phase_id: "verify",
        kind: "local_verification",
        role: "workflow-verifier",
        prompt_template: "Verify that previous task artifacts exist and can be synthesized.",
        input_source: "artifacts/explore-objective/result.json",
        fanout_source: null,
        depends_on: ["explore-objective"],
        condition: "dependencies_succeeded",
        expected_output_schema: "WorkerResult",
        retry_policy: retryPolicy,
        verification_required: true,
        stop_condition: "budget_or_cancelled",
        outputs: ["result.json"],
      },
      {
        task_id: "synthesize-result",
        phase_id: "synthesize",
        kind: "local_synthesis",
        role: "workflow-synthesizer",
        prompt_template: "Synthesize accepted worker results into a final summary artifact.",
        input_source: "accepted_worker_results",
        fanout_source: null,
        depends_on: ["verify-findings"],
        condition: "dependencies_succeeded",
        expected_output_schema: "WorkerResult",
        retry_policy: retryPolicy,
        verification_required: false,
        stop_condition: "budget_or_cancelled",
        outputs: ["result.json", "../synthesis.md"],
      },
    ],
    max_concurrency: 1,
    max_agents: 1,
    max_tokens: 100000,
    max_cost: 0,
    max_duration_ms: 300000,
    max_retries: 0,
    max_no_progress_iterations: 3,
    required_capabilities: ["filesystem-read", "filesystem-write-run-artifacts"],
    workspace_policy: {
      workspace_root: workspace,
      write_scope: ["run_dir"],
      network: false,
      mcp_write: false,
      shell: false,
      worker_isolation: "local-artifacts",
    },
    verification_policy: {
      required: true,
      verifier_task_kinds: ["local_verification"],
      unresolved_policy: "report",
    },
    stop_conditions: ["budget_exceeded", "user_cancelled", "schema_violation"],
  };
}

function buildInitialRunState({ workflow, goalId, createdAt }) {
  const tasks = {};
  for (const task of workflow.tasks) {
    tasks[task.task_id] = {
      task_id: task.task_id,
      phase_id: task.phase_id,
      status: "queued",
      attempts: [],
      result_path: null,
      verification_required: task.verification_required,
      updated_at: createdAt,
    };
  }
  const phases = {};
  for (const phase of workflow.phases) {
    phases[phase.phase_id] = {
      phase_id: phase.phase_id,
      status: phase.depends_on.length === 0 ? "ready" : "waiting",
      updated_at: createdAt,
    };
  }
  return {
    schema_version: SCHEMA_VERSION,
    run_id: workflow.run_id,
    goal_id: goalId,
    objective: workflow.objective,
    status: "awaiting_approval",
    outcome: null,
    current_phase: null,
    created_at: createdAt,
    updated_at: createdAt,
    workflow_spec_path: WORKFLOW_FILE,
    status_mapping: {
      success: "complete",
      needs_user_input: "active",
      failed: "active",
      cancelled: "active",
    },
    completion_decider: "verified_tasks_and_synthesis",
    final_response_policy: "separate_verified_rejected_unresolved_findings",
    approval: {
      required: true,
      approved_at: null,
      approved_by: null,
      summary: {
        requested_capabilities: workflow.required_capabilities,
        write_scope: workflow.workspace_policy.write_scope,
        network: workflow.workspace_policy.network,
        mcp_write: workflow.workspace_policy.mcp_write,
        budget: {
          max_tokens: workflow.max_tokens,
          max_cost: workflow.max_cost,
          max_duration_ms: workflow.max_duration_ms,
        },
        stop_conditions: workflow.stop_conditions,
      },
    },
    phases,
    tasks,
    attempts: {},
    artifacts: [],
    locks: {},
    budget_usage: {
      tokens: 0,
      cost: 0,
      duration_ms: 0,
    },
    event_log_offset: 0,
  };
}

function executeLocalTask(runDir, workflow, state, task) {
  const attemptNumber = state.tasks[task.task_id].attempts.length + 1;
  const attemptId = `${task.task_id}-attempt-${attemptNumber}`;
  const artifactDir = path.join(runDir, "artifacts", task.task_id);
  ensureDir(artifactDir);

  state.tasks[task.task_id].status = "running";
  state.tasks[task.task_id].updated_at = nowIso();
  state.tasks[task.task_id].attempts.push(attemptId);
  state.attempts[attemptId] = {
    attempt_id: attemptId,
    task_id: task.task_id,
    status: "created",
    artifact_dir: toRunRelative(runDir, artifactDir),
    started_at: null,
    completed_at: null,
  };
  recordEvent(runDir, state, "launch_requested", {
    task_id: task.task_id,
    attempt_id: attemptId,
    prompt: task.prompt_template,
    allowed_tools: ["local-artifact-writer"],
    workspace_policy: workflow.workspace_policy,
    timeout_ms: workflow.max_duration_ms,
  });

  state = readRunState(runDir);
  state.attempts[attemptId].status = "running";
  state.attempts[attemptId].started_at = nowIso();
  recordEvent(runDir, state, "launch_started", {
    task_id: task.task_id,
    attempt_id: attemptId,
    worker_id: `local:${task.task_id}`,
    artifact_directory: toRunRelative(runDir, artifactDir),
  });

  state = readRunState(runDir);
  recordEvent(runDir, state, "progress", {
    task_id: task.task_id,
    attempt_id: attemptId,
    phase: task.phase_id,
    status: "running local deterministic executor",
    token_usage: 0,
    last_activity_at: nowIso(),
  });

  const result = buildLocalWorkerResult(runDir, workflow, task, attemptId);
  const resultErrors = validateWorkerResult(result);
  const resultPath = path.join(artifactDir, "result.json");
  writeJson(resultPath, result);

  state = readRunState(runDir);
  if (resultErrors.length > 0) {
    state.tasks[task.task_id].status = "schema_violation";
    state.attempts[attemptId].status = "quarantined";
    state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
    recordEvent(runDir, state, "result_submitted", {
      task_id: task.task_id,
      attempt_id: attemptId,
      result_path: toRunRelative(runDir, resultPath),
      validation_errors: resultErrors,
    });
    return;
  }

  state.tasks[task.task_id].status = result.status === "succeeded" ? "succeeded" : "failed";
  state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
  state.tasks[task.task_id].updated_at = nowIso();
  state.attempts[attemptId].status = result.status;
  state.attempts[attemptId].completed_at = nowIso();
  state.artifacts.push(toRunRelative(runDir, resultPath));
  for (const artifact of result.artifacts) {
    if (!state.artifacts.includes(artifact)) {
      state.artifacts.push(artifact);
    }
  }
  recordEvent(runDir, state, "result_submitted", {
    task_id: task.task_id,
    attempt_id: attemptId,
    schema_version: SCHEMA_VERSION,
    result_path: toRunRelative(runDir, resultPath),
    artifact_manifest: result.artifacts,
    token_usage: 0,
  });

  state = readRunState(runDir);
  recordEvent(runDir, state, "worker_exited", {
    task_id: task.task_id,
    attempt_id: attemptId,
    exit_status: 0,
    stop_reason: "completed",
    log_pointer: toRunRelative(runDir, resultPath),
  });
}

function buildLocalWorkerResult(runDir, workflow, task, attemptId) {
  if (task.kind === "local_analysis") {
    return {
      task_id: task.task_id,
      attempt_id: attemptId,
      status: "succeeded",
      summary: `Objective captured for workflow ${workflow.workflow_id}.`,
      findings: [
        {
          claim: `Workflow objective is ready for local orchestration: ${workflow.objective}`,
          evidence: [WORKFLOW_FILE, `workflow_id:${workflow.workflow_id}`],
          source_files: [WORKFLOW_FILE],
          confidence: 0.8,
          severity: "info",
          verification_status: "unverified",
          verifier_notes: "Generated by the local deterministic analysis task.",
          rejection_reason: null,
        },
      ],
      errors: [],
      evidence: [WORKFLOW_FILE],
      modified_files: [],
      commands_run: [],
      artifacts: [],
    };
  }

  if (task.kind === "local_verification") {
    const dependencyResults = task.depends_on.map((taskId) => path.join(runDir, "artifacts", taskId, "result.json"));
    const missing = dependencyResults.filter((candidate) => !fs.existsSync(candidate));
    return {
      task_id: task.task_id,
      attempt_id: attemptId,
      status: missing.length === 0 ? "succeeded" : "failed",
      summary: missing.length === 0 ? "Required dependency artifacts are present." : "Dependency artifacts are missing.",
      findings: [
        {
          claim: "Dependency artifacts required for synthesis are present.",
          evidence: dependencyResults.map((candidate) => toRunRelative(runDir, candidate)),
          source_files: dependencyResults.map((candidate) => toRunRelative(runDir, candidate)),
          confidence: missing.length === 0 ? 1 : 0,
          severity: missing.length === 0 ? "info" : "high",
          verification_status: missing.length === 0 ? "verified" : "rejected",
          verifier_notes: missing.length === 0 ? "All dependency result files exist." : "One or more dependency result files are missing.",
          rejection_reason: missing.length === 0 ? null : `Missing: ${missing.map((candidate) => toRunRelative(runDir, candidate)).join(", ")}`,
        },
      ],
      errors: missing.map((candidate) => `Missing dependency result: ${toRunRelative(runDir, candidate)}`),
      evidence: dependencyResults.map((candidate) => toRunRelative(runDir, candidate)),
      modified_files: [],
      commands_run: [],
      artifacts: [],
    };
  }

  if (task.kind === "local_synthesis") {
    const acceptedResults = Object.values(readRunState(runDir).tasks)
      .filter((taskState) => taskState.result_path)
      .map((taskState) => taskState.result_path);
    const synthesisPath = path.join(runDir, "artifacts", "synthesis.md");
    const synthesis = [
      "# Dynamic Workflow Synthesis",
      "",
      `Objective: ${workflow.objective}`,
      "",
      "Verified artifacts:",
      ...acceptedResults.map((resultPath) => `- ${resultPath}`),
      "",
      "Outcome: local workflow orchestration completed.",
      "",
    ].join("\n");
    fs.writeFileSync(synthesisPath, synthesis, "utf8");
    return {
      task_id: task.task_id,
      attempt_id: attemptId,
      status: "succeeded",
      summary: "Synthesis artifact created.",
      findings: [
        {
          claim: "Accepted worker results were synthesized into a final artifact.",
          evidence: [toRunRelative(runDir, synthesisPath), ...acceptedResults],
          source_files: acceptedResults,
          confidence: 0.9,
          severity: "info",
          verification_status: "verified",
          verifier_notes: "Synthesis used accepted local worker result paths.",
          rejection_reason: null,
        },
      ],
      errors: [],
      evidence: [toRunRelative(runDir, synthesisPath), ...acceptedResults],
      modified_files: [],
      commands_run: [],
      artifacts: [toRunRelative(runDir, synthesisPath)],
    };
  }

  return {
    task_id: task.task_id,
    attempt_id: attemptId,
    status: "failed",
    summary: `Unknown task kind: ${task.kind}`,
    findings: [],
    errors: [`Unknown task kind: ${task.kind}`],
    evidence: [],
    modified_files: [],
    commands_run: [],
    artifacts: [],
  };
}

function setPhaseStatus(runDir, state, phaseId, status, payload = {}) {
  state.current_phase = status === "running" ? phaseId : state.current_phase;
  state.phases[phaseId].status = status;
  state.phases[phaseId].updated_at = nowIso();
  recordEvent(runDir, state, "phase_status_changed", {
    phase_id: phaseId,
    status,
    ...payload,
  });
}

function setTaskStatus(runDir, state, taskId, status, payload = {}) {
  state.tasks[taskId].status = status;
  state.tasks[taskId].updated_at = nowIso();
  recordEvent(runDir, state, "task_status_changed", {
    task_id: taskId,
    status,
    ...payload,
  });
}

function failRun(runDir, state, summary, payload = {}) {
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

function phaseDependenciesSucceeded(state, phase) {
  return phase.depends_on.every((phaseId) => state.phases[phaseId]?.status === "succeeded");
}

function taskDependenciesSucceeded(state, task) {
  return task.depends_on.every((taskId) => state.tasks[taskId]?.status === "succeeded");
}

function validateRunConsistency(workflow, state) {
  const errors = [];
  if (workflow.run_id !== state.run_id) {
    errors.push("workflow.run_id and state.run_id differ");
  }
  for (const task of workflow.tasks) {
    if (!state.tasks[task.task_id]) {
      errors.push(`run state missing task ${task.task_id}`);
    }
  }
  for (const phase of workflow.phases) {
    if (!state.phases?.[phase.phase_id]) {
      errors.push(`run state missing phase ${phase.phase_id}`);
    }
  }
  return errors;
}

function assertKnownRunState(state, workflow) {
  const errors = [
    ...validateWorkflowSpec(workflow),
    ...validateRunState(state),
    ...validateRunConsistency(workflow, state),
  ];
  if (errors.length > 0) {
    throw new WorkflowError("Run directory validation failed.", { errors });
  }
}

function summarizeRun(runDir, state, workflow) {
  return {
    run_id: state.run_id,
    workflow_id: workflow.workflow_id,
    run_dir: path.resolve(runDir),
    status: state.status,
    objective: workflow.objective,
    current_phase: state.current_phase,
    outcome: state.outcome,
    approval: state.approval,
    tasks: state.tasks,
    phases: state.phases,
    artifacts: state.artifacts,
    paths: {
      workflow_spec: path.join(path.resolve(runDir), WORKFLOW_FILE),
      run_state: path.join(path.resolve(runDir), RUN_STATE_FILE),
      event_log: path.join(path.resolve(runDir), EVENT_LOG_FILE),
      artifacts: path.join(path.resolve(runDir), "artifacts"),
    },
    event_count: countEvents(runDir),
    event_log_offset: state.event_log_offset,
  };
}

function recordEvent(runDir, state, type, payload = {}) {
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
  state.event_log_offset = fs.statSync(eventPath).size;
  writeJson(path.join(runDir, RUN_STATE_FILE), state);
  return event;
}

function countEvents(runDir) {
  const eventPath = path.join(runDir, EVENT_LOG_FILE);
  if (!fs.existsSync(eventPath)) {
    return 0;
  }
  const content = fs.readFileSync(eventPath, "utf8").trim();
  return content ? content.split("\n").length : 0;
}

function resolveRunRoot(runRoot, workspace) {
  if (runRoot == null) {
    const configuredHome = process.env[CCDW_HOME_ENV]?.trim();
    const ccdwHome = configuredHome || DEFAULT_CCDW_HOME;
    return path.join(resolveWorkspacePath(ccdwHome, workspace), "dynamic-workflows", "runs");
  }
  return resolveWorkspacePath(runRoot, workspace);
}

function resolveWorkspacePath(candidate, workspace) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspace, candidate);
}

function requireRunDir(runDir) {
  if (typeof runDir !== "string" || runDir.trim() === "") {
    throw new WorkflowError("runDir is required.");
  }
  const resolved = path.resolve(runDir);
  if (!fs.existsSync(path.join(resolved, RUN_STATE_FILE))) {
    throw new WorkflowError("Run directory does not contain run.json.", { runDir: resolved });
  }
  if (!fs.existsSync(path.join(resolved, WORKFLOW_FILE))) {
    throw new WorkflowError("Run directory does not contain workflow.yaml.", { runDir: resolved });
  }
  return resolved;
}

function normalizeObjective(objective) {
  if (typeof objective !== "string" || objective.trim() === "") {
    throw new WorkflowError("Objective must be a non-empty string.");
  }
  const normalized = objective.trim();
  if (normalized.length > 4000) {
    throw new WorkflowError("Objective must be at most 4000 characters.");
  }
  return normalized;
}

function requireString(payload, field, errors, prefix = "") {
  if (typeof payload?.[field] !== "string" || payload[field].trim() === "") {
    errors.push(`${prefix ? `${prefix}.` : ""}${field} must be a non-empty string`);
  }
}

function requireArray(payload, field, errors, prefix = "") {
  if (!Array.isArray(payload?.[field])) {
    errors.push(`${prefix ? `${prefix}.` : ""}${field} must be an array`);
  }
}

function requireObject(payload, field, errors, prefix = "") {
  if (typeof payload?.[field] !== "object" || payload[field] == null || Array.isArray(payload[field])) {
    errors.push(`${prefix ? `${prefix}.` : ""}${field} must be an object`);
  }
}

function requireNonNegativeInteger(payload, field, errors) {
  if (!Number.isInteger(payload?.[field]) || payload[field] < 0) {
    errors.push(`${field} must be a non-negative integer`);
  }
}

function makeId(prefix) {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomUUID().slice(0, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, payload) {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, file);
}

function toRunRelative(runDir, file) {
  return path.relative(runDir, file).split(path.sep).join("/");
}

function filePathFromImportMeta(url) {
  return fileURLToPath(url);
}
