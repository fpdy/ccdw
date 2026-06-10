import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodexExecArgs,
  buildWorkerPrompt,
  readLastMessageFile,
  resolveCodexBin,
  startCodexExec,
  WORKER_OUTPUT_SCHEMA,
} from "./codex-executor.js";
import {
  buildClaudeExecArgs,
  buildClaudeSandboxSettings,
  resolveClaudeBin,
  startClaudeExec,
} from "./claude-executor.js";

export const SCHEMA_VERSION = "dynamic-workflows.v1";
export const CCDW_HOME_ENV = "CCDW_HOME";
export const DEFAULT_CCDW_HOME = ".ccdw";
export const DEFAULT_RUN_ROOT = ".ccdw/dynamic-workflows/runs";
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const RUN_ID_PATTERN = /^(?!\.+$)[A-Za-z0-9._-]{1,64}$/;
export const SPEC_ID_PATTERN = /^(?!\.+$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const RUN_STATE_FILE = "run.json";
const WORKFLOW_FILE = "workflow.yaml";
const EVENT_LOG_FILE = "events.ndjson";
const LOCK_FILE = "orchestrator.lock";
const CONTROL_DIR = "control";
const CANCEL_SIGNAL_FILE = "cancel.json";
const RUNNER_LOG_FILE = "runner.log";
const WORKER_SCHEMA_FILE = "worker-output.schema.json";
const CLAUDE_SETTINGS_FILE = "claude-settings.json";
const SPEC_ID_PATTERN_DESCRIPTION = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const PARTIAL_RESULT_POLICIES = new Set(["quarantine", "accept", "discard"]);
const GOAL_STATUS_EFFECTS = new Set(["active", "complete", "blocked"]);

const PERMANENT_FAILURE_TASK_STATUSES = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "schema_violation",
  "skipped",
]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", ...PERMANENT_FAILURE_TASK_STATUSES]);
const RETRYABLE_TASK_STATUSES = new Set(["failed", "timed_out", "schema_violation"]);
// Resume may also requeue skipped tasks: a skip is always derived from a failed
// blocker, and the scheduler re-skips any task whose blocker is still dead.
const RESUMABLE_TASK_STATUSES = new Set([...RETRYABLE_TASK_STATUSES, "skipped"]);

// Spec fields that are recorded and surfaced to the approver but not enforced
// by the scheduler. They are listed in the approval summary so consent is
// based on what the runner actually does.
export const ADVISORY_SPEC_FIELDS = [
  "max_cost",
  "max_retries",
  "max_no_progress_iterations",
  "verification_required",
  "verification_policy",
];

export class WorkflowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkflowError";
    this.details = details;
  }
}

export function planWorkflow(options = {}) {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const runId = options.runId ?? makeId("run");
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new WorkflowError("runId must be a string matching ^[A-Za-z0-9._-]{1,64}$.", { runId });
  }
  const workflowId = options.workflowId ?? makeId("wf");
  const createdAt = nowIso();

  let workflow;
  if (options.spec != null) {
    workflow = applySpecDefaults(options.spec, {
      objective: options.objective,
      workspace,
      runId,
      workflowId,
      createdAt,
    });
  } else {
    const objective = normalizeObjective(options.objective);
    workflow = buildDefaultWorkflowSpec({
      objective,
      workspace,
      runId,
      workflowId,
      createdAt,
    });
  }

  // Strict validation applies to new plans only; stored runs are re-read with
  // the lenient rules so a strictness upgrade never bricks existing run dirs.
  const workflowErrors = validateWorkflowSpec(workflow, { strict: true });
  if (options.dryRun) {
    return {
      dry_run: true,
      valid: workflowErrors.length === 0,
      errors: workflowErrors,
      workflow,
    };
  }
  if (workflowErrors.length > 0) {
    throw new WorkflowError("Workflow spec failed validation.", {
      errors: workflowErrors,
    });
  }

  const runRoot = resolveRunRoot(options.runRoot, workspace);
  const runDir = path.join(runRoot, runId);
  const resolvedRunDir = path.resolve(runDir);
  if (resolvedRunDir !== path.resolve(runRoot) && !resolvedRunDir.startsWith(path.resolve(runRoot) + path.sep)) {
    throw new WorkflowError("Run directory escapes the run root.", { runDir: resolvedRunDir });
  }
  if (fs.existsSync(runDir)) {
    if (!options.force) {
      throw new WorkflowError("Run directory already exists.", { runDir });
    }
    const liveLock = readLiveLock(runDir);
    if (liveLock) {
      throw new WorkflowError("Run directory is locked by an active orchestrator; refusing to replace it.", {
        runDir,
        runner_pid: liveLock.pid,
      });
    }
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  ensureDir(runDir);
  ensureDir(path.join(runDir, "artifacts"));
  writeJson(path.join(runDir, WORKFLOW_FILE), workflow);
  const specHash = hashFile(path.join(runDir, WORKFLOW_FILE));

  const state = buildInitialRunState({
    workflow,
    goalId: options.goalId ?? null,
    createdAt,
    specHash,
  });
  const stateErrors = validateRunState(state);
  if (stateErrors.length > 0) {
    throw new WorkflowError("Generated run state failed validation.", {
      errors: stateErrors,
    });
  }

  writeJson(path.join(runDir, RUN_STATE_FILE), state);
  recordEvent(runDir, state, "workflow_planned", {
    workflow_id: workflow.workflow_id,
    workflow_spec_path: WORKFLOW_FILE,
    spec_hash: specHash,
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

  return withRunLock(runDir, () => {
    const lockedState = readRunState(runDir);
    if (lockedState.status !== "awaiting_approval" && lockedState.status !== "planned") {
      return summarizeRun(runDir, lockedState, workflow);
    }
    const timestamp = nowIso();
    lockedState.status = "approved";
    lockedState.approval.approved_at = timestamp;
    lockedState.approval.approved_by = options.approvedBy ?? "local-user";
    recordEvent(runDir, lockedState, "approval_granted", {
      approved_by: lockedState.approval.approved_by,
    });
    return summarizeRun(runDir, readRunState(runDir), workflow);
  });
}

export async function runWorkflow(options = {}) {
  const maxTasks = normalizeOptionalMaxTasks(options.maxTasks);
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
    return withRunLock(runDir, () => {
      const lockedState = readRunState(runDir);
      recordEvent(runDir, lockedState, "run_noop", { reason: "already_completed" });
      return summarizeRun(runDir, readRunState(runDir), workflow);
    });
  }
  if (state.status === "cancelled") {
    throw new WorkflowError("Cancelled runs cannot be run.", { status: state.status });
  }
  if (state.status === "failed") {
    throw new WorkflowError("Failed runs require resume with --resume-failed.", {
      status: state.status,
    });
  }
  if (state.status === "running") {
    const lock = readLiveLock(runDir);
    if (lock) {
      throw new WorkflowError("Run is already being executed by an active orchestrator.", {
        runner_pid: lock.pid,
      });
    }
    throw new WorkflowError("Run is marked running but has no live orchestrator. Use resume to recover.", {
      status: state.status,
    });
  }
  if (state.status !== "approved" && state.status !== "paused") {
    throw new WorkflowError("Run is not in an executable status.", { status: state.status });
  }

  const lockPath = acquireRunLock(runDir);
  state = readRunState(runDir);
  try {
    state.runner = {
      pid: process.pid,
      started_at: nowIso(),
      heartbeat_at: nowIso(),
    };
    state.status = "running";
    recordEvent(runDir, state, "run_started", {
      workflow_id: workflow.workflow_id,
    runner_pid: process.pid,
    });
    await executeApprovedRun(runDir, workflow, state, { ...options, maxTasks });
  } finally {
    state.runner = null;
    persistRunState(runDir, state);
    releaseRunLock(lockPath);
  }
  return summarizeRun(runDir, readRunState(runDir), workflow);
}

export async function resumeWorkflow(options = {}) {
  const maxTasks = normalizeOptionalMaxTasks(options.maxTasks);
  const runDir = requireRunDir(options.runDir);
  const workflow = readWorkflowSpec(runDir);
  let state = readRunState(runDir);
  assertKnownRunState(state, workflow);

  const liveLock = readLiveLock(runDir);
  if (liveLock) {
    throw new WorkflowError("Run is being executed by an active orchestrator; cannot resume.", {
      runner_pid: liveLock.pid,
    });
  }

  const resumableFailure =
    options.resumeFailed === true &&
    (state.status === "failed" ||
      (state.status === "completed" && state.outcome?.status === "partial"));
  if (TERMINAL_RUN_STATUSES.has(state.status) && !resumableFailure) {
    recordEvent(runDir, state, "resume_noop", { reason: `terminal:${state.status}` });
    return summarizeRun(runDir, readRunState(runDir), workflow);
  }

  const currentHash = hashFile(path.join(runDir, WORKFLOW_FILE));
  if (typeof state.spec_hash === "string" && state.spec_hash !== currentHash) {
    throw new WorkflowError("Workflow spec changed since plan; refusing to resume.", {
      planned_hash: state.spec_hash,
      current_hash: currentHash,
    });
  }

  withRunLock(runDir, () => {
    state = readRunState(runDir);
    const fromStatus = state.status;
    const timestamp = nowIso();
    for (const [attemptId, attempt] of Object.entries(state.attempts ?? {})) {
      if (attempt.status === "running" || attempt.status === "created") {
        attempt.status = "orphaned";
        attempt.completed_at = timestamp;
        recordEvent(runDir, state, "attempt_orphaned", {
          attempt_id: attemptId,
          task_id: attempt.task_id,
        });
      }
    }
    for (const taskState of Object.values(state.tasks)) {
      if (taskState.status === "running") {
        taskState.status = "queued";
        taskState.updated_at = timestamp;
      }
      if (resumableFailure && RESUMABLE_TASK_STATUSES.has(taskState.status)) {
        taskState.status = "queued";
        taskState.updated_at = timestamp;
      }
    }
    for (const phaseState of Object.values(state.phases ?? {})) {
      if (phaseState.status === "running") {
        phaseState.status = "ready";
        phaseState.updated_at = timestamp;
      }
      if (resumableFailure && (phaseState.status === "failed" || phaseState.status === "skipped")) {
        phaseState.status = "waiting";
        phaseState.updated_at = timestamp;
      }
    }
    state.locks = {};
    state.runner = null;
    if (state.status === "paused" || state.status === "running" || resumableFailure) {
      state.status = "approved";
      state.outcome = null;
      state.current_phase = null;
    }
    recordEvent(runDir, state, "resume_requested", {
      continue: options.continueRun !== false,
      resume_failed: resumableFailure,
      from_status: fromStatus,
    });
  });

  if (options.continueRun === false) {
    return summarizeRun(runDir, readRunState(runDir), workflow);
  }
  return runWorkflow({
    runDir,
    approve: false,
    approvedBy: options.approvedBy,
    maxTasks,
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

  const reason = options.reason ?? "Workflow cancelled.";
  const liveLock = readLiveLock(runDir);
  if (liveLock) {
    // A live orchestrator owns run.json; request cancellation through the
    // control channel and let it fold the transition (and kill its workers).
    writeJson(path.join(runDir, CONTROL_DIR, CANCEL_SIGNAL_FILE), {
      reason,
      requested_at: nowIso(),
      requested_by: options.requestedBy ?? "local-user",
    });
    return {
      ...summarizeRun(runDir, state, workflow),
      cancel_requested: true,
      runner_pid: liveLock.pid,
    };
  }

  return withRunLock(runDir, () => {
    const lockedState = readRunState(runDir);
    if (lockedState.status === "cancelled") {
      return summarizeRun(runDir, lockedState, workflow);
    }
    lockedState.status = "cancelled";
    lockedState.current_phase = null;
    lockedState.outcome = {
      status: "cancelled",
      summary: reason,
    };
    recordEvent(runDir, lockedState, "cancel_requested", { reason });
    return summarizeRun(runDir, readRunState(runDir), workflow);
  });
}

export function statusWorkflow(options = {}) {
  const runDir = requireRunDir(options.runDir);
  const workflow = readWorkflowSpec(runDir);
  const state = readRunState(runDir);
  assertKnownRunState(state, workflow);
  return summarizeRun(runDir, state, workflow);
}

export function listWorkflowRuns(options = {}) {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const runRoot = resolveRunRoot(options.runRoot, workspace);
  if (!fs.existsSync(runRoot)) {
    return { run_root: runRoot, runs: [] };
  }
  const runs = [];
  for (const entry of fs.readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runDir = path.join(runRoot, entry.name);
    if (!fs.existsSync(path.join(runDir, RUN_STATE_FILE))) {
      continue;
    }
    try {
      const state = readRunState(runDir);
      runs.push({
        run_id: state.run_id,
        status: state.status,
        objective:
          typeof state.objective === "string" && state.objective.length > 80
            ? `${state.objective.slice(0, 77)}...`
            : state.objective,
        created_at: state.created_at,
        updated_at: state.updated_at,
        run_dir: path.resolve(runDir),
        task_counts: countTaskStatuses(state),
        outcome: state.outcome?.status ?? null,
      });
    } catch (error) {
      runs.push({
        run_id: entry.name,
        run_dir: path.resolve(runDir),
        status: "unreadable",
        warning: error.message,
      });
    }
  }
  runs.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  const filtered = options.status ? runs.filter((run) => run.status === options.status) : runs;
  const limit = options.limit != null ? Number(options.limit) : 20;
  return { run_root: runRoot, runs: filtered.slice(0, limit) };
}

export function readWorkflowEvents(options = {}) {
  const runDir = requireRunDir(options.runDir);
  const eventPath = path.join(runDir, EVENT_LOG_FILE);
  const sinceOffset = Number(options.sinceOffset ?? 0);
  if (!Number.isInteger(sinceOffset) || sinceOffset < 0) {
    throw new WorkflowError("sinceOffset must be a non-negative integer.");
  }
  if (!fs.existsSync(eventPath)) {
    return { run_dir: runDir, events: [], next_offset: 0 };
  }
  const size = fs.statSync(eventPath).size;
  if (sinceOffset >= size) {
    return { run_dir: runDir, events: [], next_offset: size };
  }
  const fd = fs.openSync(eventPath, "r");
  let chunk;
  try {
    const buffer = Buffer.alloc(size - sinceOffset);
    fs.readSync(fd, buffer, 0, buffer.length, sinceOffset);
    chunk = buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const limit = options.limit != null ? Number(options.limit) : Infinity;
  const events = [];
  let consumed = 0;
  let searchFrom = 0;
  while (events.length < limit) {
    const newlineIndex = chunk.indexOf("\n", searchFrom);
    if (newlineIndex === -1) {
      break;
    }
    const line = chunk.slice(searchFrom, newlineIndex);
    consumed = newlineIndex + 1;
    searchFrom = consumed;
    if (line.trim() !== "") {
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ type: "unparseable_event", raw: line });
      }
    }
  }
  return { run_dir: runDir, events, next_offset: sinceOffset + Buffer.byteLength(chunk.slice(0, consumed), "utf8") };
}

export async function detachWorkflowRun(options = {}) {
  const maxTasks = normalizeOptionalMaxTasks(options.maxTasks);
  const runDir = requireRunDir(options.runDir);
  const liveLock = readLiveLock(runDir);
  if (liveLock) {
    throw new WorkflowError("Run is already being executed by an active orchestrator.", {
      runner_pid: liveLock.pid,
    });
  }
  const preState = readRunState(runDir);
  if ((preState.status === "awaiting_approval" || preState.status === "planned") && !options.approve) {
    throw new WorkflowError("Run is awaiting approval. Approve first or pass approve.", {
      status: preState.status,
    });
  }
  if (TERMINAL_RUN_STATUSES.has(preState.status)) {
    throw new WorkflowError("Terminal runs cannot be started; use resume for failed runs.", {
      status: preState.status,
    });
  }
  const cliPath = path.resolve(libDirectory(), "..", "dynamic-workflows.js");
  const args = [cliPath, "run", "--run-dir", runDir, "--json"];
  if (options.approve) {
    args.push("--approve");
  }
  if (options.approvedBy) {
    args.push("--approved-by", String(options.approvedBy));
  }
  if (options.maxTasks != null) {
    args.push("--max-tasks", String(maxTasks));
  }
  const logPath = path.join(runDir, RUNNER_LOG_FILE);
  const logFd = fs.openSync(logPath, "a");
  let child;
  let childExit = null;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  // Two concurrent detach calls can both pass the lock precheck; the loser
  // child dies immediately with only runner.log to show for it. Wait briefly
  // for the lock to appear (or the child to exit) so a dead-on-arrival runner
  // surfaces as an error instead of detached:true. A fast local run may finish
  // entirely inside this window, which exits 0 and is fine.
  const pollDeadline = Date.now() + 2000;
  while (Date.now() < pollDeadline && childExit == null && !readLiveLock(runDir)) {
    // The child and logFd are already released, so an unref'd timer would let
    // a bare CLI process exit 0 before this promise resolves (empty stdout).
    await sleep(50, { unref: false });
  }
  if (childExit != null && (childExit.signal != null || childExit.code !== 0)) {
    throw new WorkflowError("Detached runner exited before executing the run; see the runner log.", {
      exit_code: childExit.code,
      signal: childExit.signal,
      runner_log: logPath,
    });
  }
  const state = readRunState(runDir);
  const workflow = readWorkflowSpec(runDir);
  return {
    ...summarizeRun(runDir, state, workflow),
    detached: true,
    runner_pid: child.pid ?? null,
    runner_log: logPath,
    poll: "Use status (or events with sinceOffset) to follow progress.",
  };
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
  const pluginRoot = path.resolve(options.pluginRoot ?? path.join(libDirectory(), "..", ".."));
  const requiredFiles = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "skills/dynamic-workflows/SKILL.md",
    "scripts/dynamic-workflows.js",
    "scripts/dynamic-workflows-mcp.js",
    "scripts/lib/codex-executor.js",
    "scripts/lib/claude-executor.js",
    "scripts/lib/process-runner.js",
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

// --- Spec construction -----------------------------------------------------

export function applySpecDefaults(spec, { objective, workspace, runId, workflowId, createdAt }) {
  if (typeof spec !== "object" || spec == null || Array.isArray(spec)) {
    throw new WorkflowError("Workflow spec must be a JSON object.");
  }
  const resolvedObjective = normalizeObjective(objective ?? spec.objective);
  const defaultRetryPolicy = {
    retryable: false,
    max_attempts: 1,
    backoff_ms: 0,
    partial_result_policy: "quarantine",
    cleanup_required: false,
    goal_status_effect: "active",
  };
  const policy = typeof spec.workspace_policy === "object" && spec.workspace_policy != null
    ? { ...spec.workspace_policy }
    : {};
  const workspaceRoot = policy.workspace_root
    ? path.resolve(workspace, policy.workspace_root)
    : workspace;

  const phases = (Array.isArray(spec.phases) ? spec.phases : [])
    .map((entry) => (typeof entry === "object" && entry != null ? entry : {}))
    .map((phase) => ({
    phase_id: phase.phase_id,
    name: phase.name ?? phase.phase_id,
    depends_on: phase.depends_on ?? [],
    entry_condition: phase.entry_condition ?? ((phase.depends_on ?? []).length === 0 ? "always" : "dependencies_succeeded"),
    tasks: phase.tasks ?? [],
    completion_condition: phase.completion_condition ?? "all_tasks_succeeded",
    verification_required: phase.verification_required ?? false,
    on_failure: phase.on_failure ?? "fail",
    outputs: phase.outputs ?? [],
  }));

  const tasks = (Array.isArray(spec.tasks) ? spec.tasks : [])
    .map((entry) => (typeof entry === "object" && entry != null ? entry : {}))
    .map((task) => {
      const retryPolicy = task.retry_policy == null
        ? { ...defaultRetryPolicy }
        : isPlainObject(task.retry_policy)
          ? { ...defaultRetryPolicy, ...task.retry_policy }
          : task.retry_policy;
      return {
        task_id: task.task_id,
        phase_id: task.phase_id,
        kind: task.kind ?? "codex_agent",
        role: task.role ?? "worker",
        prompt_template: task.prompt_template,
        input_source: task.input_source ?? "objective",
        fanout_source: task.fanout_source ?? null,
        depends_on: task.depends_on ?? [],
        condition: task.condition ?? ((task.depends_on ?? []).length === 0 ? "always" : "dependencies_succeeded"),
        expected_output_schema: task.expected_output_schema ?? "WorkerResult",
        retry_policy: retryPolicy,
        verification_required: task.verification_required ?? false,
        stop_condition: task.stop_condition ?? "budget_or_cancelled",
        outputs: task.outputs ?? ["result.json"],
        ...(task.timeout_ms != null ? { timeout_ms: task.timeout_ms } : {}),
        ...(task.model != null ? { model: task.model } : {}),
        ...(task.profile != null ? { profile: task.profile } : {}),
      };
    });

  return {
    schema_version: SCHEMA_VERSION,
    workflow_id: spec.workflow_id ?? workflowId,
    run_id: runId,
    name: spec.name ?? `Dynamic workflow ${runId}`,
    objective: resolvedObjective,
    created_at: createdAt,
    phases,
    tasks,
    max_concurrency: spec.max_concurrency ?? 2,
    max_agents: spec.max_agents ?? 32,
    max_tokens: spec.max_tokens ?? 2_000_000,
    max_cost: spec.max_cost ?? 0,
    max_duration_ms: spec.max_duration_ms ?? 3_600_000,
    max_retries: spec.max_retries ?? 1,
    max_no_progress_iterations: spec.max_no_progress_iterations ?? 3,
    required_capabilities: spec.required_capabilities ?? ["filesystem-read", "filesystem-write-run-artifacts"],
    workspace_policy: {
      write_scope: ["run_dir"],
      network: false,
      mcp_write: false,
      shell: false,
      worker_isolation: "local-artifacts",
      ...policy,
      workspace_root: workspaceRoot,
    },
    verification_policy: spec.verification_policy ?? {
      required: false,
      verifier_task_kinds: ["local_verification"],
      unresolved_policy: "report",
    },
    stop_conditions: spec.stop_conditions ?? ["budget_exceeded", "user_cancelled", "schema_violation"],
  };
}

// --- Validation ------------------------------------------------------------

export function validateWorkflowSpec(workflow, options = {}) {
  const strict = options.strict === true;
  const errors = [];
  requireString(workflow, "schema_version", errors);
  requireString(workflow, "workflow_id", errors);
  if (typeof workflow.run_id === "string" && !RUN_ID_PATTERN.test(workflow.run_id)) {
    errors.push("workflow.run_id must match ^[A-Za-z0-9._-]{1,64}$");
  }
  requireString(workflow, "name", errors);
  requireString(workflow, "objective", errors);
  requireArray(workflow, "phases", errors);
  requireArray(workflow, "tasks", errors);
  for (const field of ["max_concurrency", "max_agents", "max_duration_ms"]) {
    requirePositiveInteger(workflow, field, errors);
  }
  for (const field of ["max_tokens", "max_retries", "max_no_progress_iterations"]) {
    requireNonNegativeInteger(workflow, field, errors);
  }
  if (typeof workflow.max_cost !== "number" || workflow.max_cost < 0) {
    errors.push("workflow.max_cost must be a non-negative number");
  }
  requireArray(workflow, "required_capabilities", errors);
  requireObject(workflow, "workspace_policy", errors);
  validateWorkspacePolicy(workflow.workspace_policy, errors);
  if (strict) {
    // Fail-closed: the claude sandbox has no enforceable allow-all network
    // mechanism, so network: true would diverge from what the executor can
    // actually enforce. Strict (plan-time) only; lenient re-reads of already
    // planned runs are unchanged.
    const hasClaudeTask = (Array.isArray(workflow.tasks) ? workflow.tasks : []).some(
      (task) => resolveExecutorKind(task?.kind) === "claude",
    );
    if (hasClaudeTask && isPlainObject(workflow.workspace_policy) && workflow.workspace_policy.network === true) {
      errors.push(
        "workspace_policy.network: true is not supported for claude tasks (no enforceable allow-all network sandbox)",
      );
    }
  }
  requireObject(workflow, "verification_policy", errors);
  requireArray(workflow, "stop_conditions", errors);

  const phaseIds = new Set();
  const taskIds = new Set();
  const taskPhase = new Map();
  for (const phase of workflow.phases ?? []) {
    requireString(phase, "phase_id", errors, "phase");
    validateSpecId(phase.phase_id, "phase.phase_id", errors);
    requireString(phase, "name", errors, `phase:${phase.phase_id}`);
    if (phaseIds.has(phase.phase_id)) {
      errors.push(`duplicate phase_id: ${phase.phase_id}`);
    }
    phaseIds.add(phase.phase_id);
    for (const field of ["depends_on", "tasks", "outputs"]) {
      requireArray(phase, field, errors, `phase:${phase.phase_id}`);
    }
    for (const dependency of Array.isArray(phase.depends_on) ? phase.depends_on : []) {
      validateSpecId(dependency, `phase ${phase.phase_id} dependency`, errors);
    }
    for (const taskId of Array.isArray(phase.tasks) ? phase.tasks : []) {
      validateSpecId(taskId, `phase ${phase.phase_id} task reference`, errors);
    }
    if (phase.on_failure !== "fail" && phase.on_failure !== "continue") {
      errors.push(`phase ${phase.phase_id} on_failure must be "fail" or "continue"`);
    }
    if (strict) {
      if (phase.entry_condition !== "always" && phase.entry_condition !== "dependencies_succeeded") {
        errors.push(`phase ${phase.phase_id} entry_condition must be "always" or "dependencies_succeeded"`);
      } else if (phase.entry_condition === "always" && (phase.depends_on ?? []).length > 0) {
        errors.push(
          `phase ${phase.phase_id} entry_condition "always" contradicts depends_on; the engine always waits for dependency phases to succeed`,
        );
      }
      if (phase.completion_condition !== "all_tasks_succeeded") {
        errors.push(`phase ${phase.phase_id} completion_condition must be "all_tasks_succeeded"`);
      }
    }
  }
  for (const task of workflow.tasks ?? []) {
    requireString(task, "task_id", errors, "task");
    validateSpecId(task.task_id, "task.task_id", errors);
    requireString(task, "phase_id", errors, `task:${task.task_id}`);
    validateSpecId(task.phase_id, `task ${task.task_id} phase_id`, errors);
    requireString(task, "kind", errors, `task:${task.task_id}`);
    requireString(task, "role", errors, `task:${task.task_id}`);
    requireString(task, "prompt_template", errors, `task:${task.task_id}`);
    requireArray(task, "depends_on", errors, `task:${task.task_id}`);
    requireObject(task, "retry_policy", errors, `task:${task.task_id}`);
    validateRetryPolicy(task.retry_policy, errors, `task ${task.task_id}`);
    for (const dependency of Array.isArray(task.depends_on) ? task.depends_on : []) {
      validateSpecId(dependency, `task ${task.task_id} dependency`, errors);
    }
    if (task.timeout_ms != null && (!Number.isInteger(task.timeout_ms) || task.timeout_ms < 1)) {
      errors.push(`task ${task.task_id} timeout_ms must be a positive integer`);
    }
    if (strict) {
      if (task.condition !== "always" && task.condition !== "dependencies_succeeded") {
        errors.push(`task ${task.task_id} condition must be "always" or "dependencies_succeeded"`);
      } else if (task.condition === "always" && (task.depends_on ?? []).length > 0) {
        errors.push(
          `task ${task.task_id} condition "always" contradicts depends_on; the engine always waits for dependency tasks to succeed`,
        );
      }
      if (task.stop_condition !== "budget_or_cancelled") {
        errors.push(`task ${task.task_id} stop_condition must be "budget_or_cancelled"`);
      }
      if (task.fanout_source != null) {
        errors.push(
          `task ${task.task_id} fanout_source is not executed by the runner; expand fan-out at plan time and leave it null`,
        );
      }
      validateInputSource(task, errors);
    }
    if (taskIds.has(task.task_id)) {
      errors.push(`duplicate task_id: ${task.task_id}`);
    }
    taskIds.add(task.task_id);
    taskPhase.set(task.task_id, task.phase_id);
    if (!phaseIds.has(task.phase_id)) {
      errors.push(`task ${task.task_id} references missing phase ${task.phase_id}`);
    }
  }
  const tasksListedInPhases = new Set();
  for (const phase of workflow.phases ?? []) {
    for (const taskId of phase.tasks ?? []) {
      if (!taskIds.has(taskId)) {
        errors.push(`phase ${phase.phase_id} references missing task ${taskId}`);
      } else if (taskPhase.get(taskId) !== phase.phase_id) {
        errors.push(`phase ${phase.phase_id} lists task ${taskId} whose phase_id is ${taskPhase.get(taskId)}`);
      }
      if (tasksListedInPhases.has(taskId)) {
        errors.push(`task ${taskId} is listed in more than one phase`);
      }
      tasksListedInPhases.add(taskId);
    }
    for (const dependency of phase.depends_on ?? []) {
      if (!phaseIds.has(dependency)) {
        errors.push(`phase ${phase.phase_id} references missing dependency ${dependency}`);
      }
    }
  }
  for (const taskId of taskIds) {
    if (!tasksListedInPhases.has(taskId)) {
      errors.push(`task ${taskId} is not listed in any phase`);
    }
  }
  for (const task of workflow.tasks ?? []) {
    for (const dependency of task.depends_on ?? []) {
      if (!taskIds.has(dependency)) {
        errors.push(`task ${task.task_id} references missing dependency ${dependency}`);
      }
    }
  }

  const phaseCycle = detectCycle(
    new Map((workflow.phases ?? []).map((phase) => [phase.phase_id, phase.depends_on ?? []])),
  );
  if (phaseCycle) {
    errors.push(`phase dependency cycle: ${phaseCycle.join(" -> ")}`);
  }
  const taskCycle = detectCycle(
    new Map((workflow.tasks ?? []).map((task) => [task.task_id, task.depends_on ?? []])),
  );
  if (taskCycle) {
    errors.push(`task dependency cycle: ${taskCycle.join(" -> ")}`);
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

// --- Scheduler -------------------------------------------------------------

async function executeApprovedRun(runDir, workflow, state, options = {}) {
  const startedAt = Date.now();
  const maxTasks = normalizeOptionalMaxTasks(options.maxTasks);
  const inFlight = new Map();
  const settledQueue = [];
  const retryAt = new Map();
  // Sealed after abortInFlight: a worker promise that survives the abort grace
  // period must not touch run state or the event log once the orchestrator has
  // folded the run, or it would rewrite run.json after the lock is released.
  const runContext = { sealed: false };
  let launchedThisRun = 0;
  let lastHeartbeat = 0;

  let externalSignal = null;
  const onSignal = () => {
    externalSignal = { reason: "Runner received a termination signal." };
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const taskById = new Map(workflow.tasks.map((task) => [task.task_id, task]));
  const phaseById = new Map(workflow.phases.map((phase) => [phase.phase_id, phase]));

  const accumulateDuration = () => {
    state.budget_usage.duration_ms += Date.now() - startedAt;
  };

  const phaseEntered = (phase) =>
    (phase.depends_on ?? []).every((phaseId) => state.phases[phaseId]?.status === "succeeded");

  const taskIsReady = (task) => {
    const taskState = state.tasks[task.task_id];
    if (taskState.status !== "queued" || inFlight.has(task.task_id)) {
      return false;
    }
    const phase = phaseById.get(task.phase_id);
    const phaseStatus = state.phases[task.phase_id]?.status;
    if (!phase || phaseStatus === "failed" || phaseStatus === "skipped") {
      return false;
    }
    if (!phaseEntered(phase)) {
      return false;
    }
    if (!(task.depends_on ?? []).every((depId) => state.tasks[depId]?.status === "succeeded")) {
      return false;
    }
    const notBefore = retryAt.get(task.task_id);
    return notBefore == null || notBefore <= Date.now();
  };

  const abortInFlight = async (taskStatus, reason) => {
    for (const entry of inFlight.values()) {
      entry.cancel?.();
    }
    if (inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...inFlight.values()].map((entry) => entry.promise)),
        sleep(8000),
      ]);
    }
    runContext.sealed = true;
    const timestamp = nowIso();
    for (const taskId of inFlight.keys()) {
      if (state.tasks[taskId].status === "running") {
        state.tasks[taskId].status = taskStatus;
        state.tasks[taskId].updated_at = timestamp;
      }
    }
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.status === "running" || attempt.status === "created") {
        attempt.status = taskStatus === "cancelled" ? "cancelled" : "failed";
        attempt.completed_at = timestamp;
      }
    }
    inFlight.clear();
    if (reason) {
      recordEvent(runDir, state, "workers_aborted", { reason });
    }
  };

  const failClosed = async (summary, payload) => {
    await abortInFlight("failed", summary);
    accumulateDuration();
    failRun(runDir, state, summary, payload);
  };

  const propagateSkips = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of workflow.tasks) {
        const taskState = state.tasks[task.task_id];
        if (taskState.status !== "queued") {
          continue;
        }
        const phaseStatus = state.phases[task.phase_id]?.status;
        const blockedByDep = (task.depends_on ?? []).some((depId) =>
          PERMANENT_FAILURE_TASK_STATUSES.has(state.tasks[depId]?.status),
        );
        if (blockedByDep || phaseStatus === "skipped" || phaseStatus === "failed") {
          setTaskStatus(runDir, state, task.task_id, "skipped", {
            reason: blockedByDep ? "dependency_failed" : "phase_unreachable",
          });
          changed = true;
        }
      }
      for (const phase of workflow.phases) {
        const phaseState = state.phases[phase.phase_id];
        if (phaseState.status === "succeeded" || phaseState.status === "failed" || phaseState.status === "skipped") {
          continue;
        }
        const dependencyDead = (phase.depends_on ?? []).some((phaseId) => {
          const status = state.phases[phaseId]?.status;
          return status === "failed" || status === "skipped";
        });
        if (dependencyDead) {
          setPhaseStatus(runDir, state, phase.phase_id, "skipped", { reason: "dependency_failed" });
          changed = true;
          continue;
        }
        const taskStatuses = (phase.tasks ?? []).map((taskId) => state.tasks[taskId]?.status);
        if (taskStatuses.length > 0 && taskStatuses.every((status) => TERMINAL_TASK_STATUSES.has(status))) {
          if (taskStatuses.every((status) => status === "succeeded")) {
            setPhaseStatus(runDir, state, phase.phase_id, "succeeded");
          } else if (taskStatuses.every((status) => status === "skipped")) {
            setPhaseStatus(runDir, state, phase.phase_id, "skipped", { reason: "all_tasks_skipped" });
          } else {
            setPhaseStatus(runDir, state, phase.phase_id, "failed");
          }
          changed = true;
        }
      }
    }
  };

  // Returns "fail_run" when a phase with on_failure:"fail" failed.
  const foldTaskCompletion = (taskId) => {
    const task = taskById.get(taskId);
    const taskState = state.tasks[taskId];
    if (taskState.status === "succeeded") {
      propagateSkips();
      return "continue";
    }
    if (RETRYABLE_TASK_STATUSES.has(taskState.status)) {
      const retryPolicy = task.retry_policy ?? {};
      const attempts = taskState.attempts.length;
      const maxAttempts = retryPolicy.max_attempts;
      const backoffMs = retryPolicy.backoff_ms;
      if (retryPolicy.retryable === true && attempts < maxAttempts) {
        setTaskStatus(runDir, state, taskId, "queued", {
          reason: "retry_scheduled",
          attempt_count: attempts,
          backoff_ms: backoffMs,
        });
        retryAt.set(taskId, Date.now() + backoffMs);
        return "continue";
      }
    }
    const phase = phaseById.get(task.phase_id);
    if (phase.on_failure === "fail") {
      setPhaseStatus(runDir, state, phase.phase_id, "failed", { task_id: taskId });
      return "fail_run";
    }
    propagateSkips();
    return "continue";
  };

  const finalizeCompletion = () => {
    propagateSkips();
    accumulateDuration();
    const fatalPhase = workflow.phases.find(
      (phase) => phase.on_failure === "fail" && state.phases[phase.phase_id]?.status === "failed",
    );
    if (fatalPhase) {
      failRun(runDir, state, "Phase failed.", { phase_id: fatalPhase.phase_id });
      return;
    }
    const statuses = Object.values(state.tasks).map((taskState) => taskState.status);
    if (statuses.some((status) => status === "queued" || status === "running")) {
      failRun(runDir, state, "Unsatisfiable task dependencies; tasks remain queued with no runnable work.", {
        queued_tasks: Object.values(state.tasks)
          .filter((taskState) => taskState.status === "queued")
          .map((taskState) => taskState.task_id),
      });
      return;
    }
    state.status = "completed";
    state.current_phase = null;
    if (statuses.every((status) => status === "succeeded")) {
      state.outcome = {
        status: "success",
        summary: "Workflow completed with all tasks succeeded.",
        final_response_policy: state.final_response_policy,
      };
    } else {
      const failed = statuses.filter((status) => PERMANENT_FAILURE_TASK_STATUSES.has(status) && status !== "skipped").length;
      const skipped = statuses.filter((status) => status === "skipped").length;
      state.outcome = {
        status: "partial",
        summary: `Workflow completed with failures: ${failed} failed, ${skipped} skipped.`,
        final_response_policy: state.final_response_policy,
      };
    }
    recordEvent(runDir, state, "run_completed", {
      executed_tasks: launchedThisRun,
      outcome: state.outcome.status,
    });
  };

  const launchTask = (task) => {
    const phaseState = state.phases[task.phase_id];
    if (phaseState.status === "waiting" || phaseState.status === "ready") {
      setPhaseStatus(runDir, state, task.phase_id, "running");
    }
    retryAt.delete(task.task_id);
    const attemptNumber = state.tasks[task.task_id].attempts.length + 1;
    const attemptId = `${task.task_id}-a${attemptNumber}-${crypto.randomUUID().slice(0, 8)}`;
    const executorKind = resolveExecutorKind(task.kind);
    const isSubagent = executorKind === "codex" || executorKind === "claude";
    const attemptDir = isSubagent
      ? resolveRunArtifactPath(runDir, task.task_id, attemptId)
      : resolveRunArtifactPath(runDir, task.task_id);
    ensureDir(attemptDir);

    state.tasks[task.task_id].status = "running";
    state.tasks[task.task_id].updated_at = nowIso();
    state.tasks[task.task_id].attempts.push(attemptId);
    state.attempts[attemptId] = {
      attempt_id: attemptId,
      task_id: task.task_id,
      status: "created",
      artifact_dir: toRunRelative(runDir, attemptDir),
      started_at: null,
      completed_at: null,
      pid: null,
      thread_id: null,
    };
    recordEvent(runDir, state, "launch_requested", {
      task_id: task.task_id,
      attempt_id: attemptId,
      kind: task.kind,
      prompt: task.prompt_template,
      workspace_policy: workflow.workspace_policy,
      timeout_ms: task.timeout_ms ?? null,
    });

    const handle = { cancel: null };
    const runAttempt =
      executorKind === "codex"
        ? () => runCodexAttempt(runDir, workflow, state, task, attemptId, attemptDir, handle, startedAt, runContext)
        : executorKind === "claude"
          ? () => runClaudeAttempt(runDir, workflow, state, task, attemptId, attemptDir, handle, startedAt, runContext)
          : async () => runLocalAttempt(runDir, workflow, state, task, attemptId, attemptDir);
    const promise = (async () => {
      try {
        await runAttempt();
      } catch (error) {
        if (!runContext.sealed) {
          state.attempts[attemptId].status = "failed";
          state.attempts[attemptId].completed_at = nowIso();
          setTaskStatus(runDir, state, task.task_id, "failed", {
            reason: "executor_error",
            error: error.message,
          });
        }
      }
      return task.task_id;
    })();
    promise.then((taskId) => {
      inFlight.delete(taskId);
      settledQueue.push(taskId);
    });
    inFlight.set(task.task_id, { promise, cancel: () => handle.cancel?.() });
    launchedThisRun += 1;
  };

  try {
    while (true) {
      const cancelSignal = externalSignal ?? readCancelSignal(runDir);
      if (cancelSignal) {
        await abortInFlight("cancelled", "run_cancelled");
        accumulateDuration();
        state.status = "cancelled";
        state.current_phase = null;
        state.outcome = {
          status: "cancelled",
          summary: cancelSignal.reason ?? "Workflow cancelled.",
        };
        recordEvent(runDir, state, "cancel_requested", {
          reason: cancelSignal.reason ?? "Workflow cancelled.",
          via: externalSignal ? "signal" : "control_file",
        });
        clearCancelSignal(runDir);
        return;
      }

      if (Date.now() - startedAt > workflow.max_duration_ms) {
        await failClosed("Budget exceeded: max_duration_ms.", {
          stop_condition: "budget_exceeded",
          budget: "max_duration_ms",
          limit: workflow.max_duration_ms,
        });
        return;
      }
      if (workflow.max_tokens > 0 && state.budget_usage.tokens > workflow.max_tokens) {
        await failClosed("Budget exceeded: max_tokens.", {
          stop_condition: "budget_exceeded",
          budget: "max_tokens",
          limit: workflow.max_tokens,
          used: state.budget_usage.tokens,
        });
        return;
      }

      while (settledQueue.length > 0) {
        const taskId = settledQueue.shift();
        if (foldTaskCompletion(taskId) === "fail_run") {
          await failClosed("Phase failed.", { phase_id: taskById.get(taskId).phase_id, task_id: taskId });
          return;
        }
      }

      const ready = workflow.tasks.filter((task) => taskIsReady(task));
      const queuedRemaining = Object.values(state.tasks).some((taskState) => taskState.status === "queued");

      if (maxTasks != null && launchedThisRun >= maxTasks && (ready.length > 0 || queuedRemaining)) {
        if (inFlight.size > 0) {
          await Promise.race([...[...inFlight.values()].map((entry) => entry.promise), sleep(500)]);
          continue;
        }
        accumulateDuration();
        state.status = "paused";
        state.outcome = {
          status: "needs_user_input",
          summary: "Run paused after the requested max task count.",
        };
        recordEvent(runDir, state, "run_paused", { reason: "max_tasks_reached" });
        return;
      }

      while (
        ready.length > 0 &&
        inFlight.size < workflow.max_concurrency &&
        (maxTasks == null || launchedThisRun < maxTasks)
      ) {
        if (Object.keys(state.attempts).length >= workflow.max_agents) {
          await failClosed("Budget exceeded: max_agents.", {
            stop_condition: "budget_exceeded",
            budget: "max_agents",
            limit: workflow.max_agents,
          });
          return;
        }
        launchTask(ready.shift());
      }

      if (inFlight.size === 0) {
        if (settledQueue.length > 0) {
          continue;
        }
        const pendingRetry = [...retryAt.entries()].find(
          ([taskId]) => state.tasks[taskId]?.status === "queued",
        );
        if (pendingRetry) {
          const retryDelayMs = Math.min(Math.max(Number(pendingRetry[1]) - Date.now(), 0) + 10, 1000);
          await sleep(Number.isFinite(retryDelayMs) ? retryDelayMs : 1000);
          continue;
        }
        if (ready.length === 0) {
          finalizeCompletion();
          return;
        }
        continue;
      }

      if (Date.now() - lastHeartbeat > 5000 && state.runner) {
        state.runner.heartbeat_at = nowIso();
        persistRunState(runDir, state);
        lastHeartbeat = Date.now();
      }
      await Promise.race([...[...inFlight.values()].map((entry) => entry.promise), sleep(500)]);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

// --- Executors -------------------------------------------------------------

export function resolveExecutorKind(kind) {
  const value = String(kind);
  if (value.startsWith("codex")) {
    return "codex";
  }
  if (value.startsWith("claude")) {
    return "claude";
  }
  // Unknown kinds keep failing deterministically inside the local path.
  return "local";
}

// Shared schema-violation quarantine: the raw worker output is saved next to
// the attempt and the task transitions to schema_violation.
function quarantineWorkerOutput(runDir, state, task, attemptId, attemptDir, attempt, rawMessage, validationErrors) {
  writeJson(path.join(attemptDir, "rejected-result.json"), {
    raw_message: rawMessage,
    validation_errors: validationErrors,
  });
  attempt.status = "quarantined";
  setTaskStatus(runDir, state, task.task_id, "schema_violation", {
    attempt_id: attemptId,
    validation_errors: validationErrors,
  });
  recordEvent(runDir, state, "result_submitted", {
    task_id: task.task_id,
    attempt_id: attemptId,
    result_path: toRunRelative(runDir, path.join(attemptDir, "rejected-result.json")),
    validation_errors: validationErrors,
  });
}

async function runCodexAttempt(runDir, workflow, state, task, attemptId, attemptDir, handle, runStartedAt, runContext) {
  const schemaPath = path.join(runDir, WORKER_SCHEMA_FILE);
  if (!fs.existsSync(schemaPath)) {
    writeJson(schemaPath, WORKER_OUTPUT_SCHEMA);
  }
  const lastMessagePath = path.join(attemptDir, "last-message.txt");
  const workerEventsPath = path.join(attemptDir, "codex-events.jsonl");
  const inputPaths = resolveTaskInputs(runDir, workflow, state, task);
  const prompt = buildWorkerPrompt({ workflow, task, runDir, inputPaths });
  const remainingMs = workflow.max_duration_ms - (Date.now() - runStartedAt);
  const timeoutMs = Math.max(Math.min(task.timeout_ms ?? Infinity, remainingMs), 1000);
  const bin = resolveCodexBin();
  const args = buildCodexExecArgs({ workflow, task, lastMessagePath, schemaPath });

  const attempt = state.attempts[attemptId];
  attempt.status = "running";
  attempt.started_at = nowIso();

  const exec = startCodexExec({
    bin,
    args,
    prompt,
    cwd: workflow.workspace_policy.workspace_root,
    timeoutMs,
    onEvent: (event) => {
      try {
        fs.appendFileSync(workerEventsPath, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        // Telemetry capture is best-effort.
      }
      if (runContext.sealed) {
        return;
      }
      if (event.type === "thread.started") {
        attempt.thread_id = event.thread_id;
        recordEvent(runDir, state, "worker_thread_started", {
          task_id: task.task_id,
          attempt_id: attemptId,
          thread_id: event.thread_id,
        });
      }
      if (event.type === "turn.completed") {
        const usage = event.usage ?? {};
        const tokens =
          (Number(usage.input_tokens) || 0) +
          (Number(usage.output_tokens) || 0) +
          (Number(usage.reasoning_output_tokens) || 0);
        state.budget_usage.tokens += tokens;
        recordEvent(runDir, state, "progress", {
          task_id: task.task_id,
          attempt_id: attemptId,
          token_usage: usage,
          last_activity_at: nowIso(),
        });
      }
    },
  });
  attempt.pid = exec.pid;
  handle.cancel = exec.cancel;
  recordEvent(runDir, state, "launch_started", {
    task_id: task.task_id,
    attempt_id: attemptId,
    worker_id: `codex:${exec.pid ?? "unknown"}`,
    command: [bin, ...args, "<prompt>"],
    artifact_directory: toRunRelative(runDir, attemptDir),
    timeout_ms: timeoutMs,
  });

  const outcome = await exec.promise;
  if (runContext.sealed) {
    // The orchestrator already aborted and folded this attempt.
    return;
  }
  attempt.completed_at = nowIso();

  const finishAttempt = (attemptStatus, taskStatus, payload) => {
    attempt.status = attemptStatus;
    setTaskStatus(runDir, state, task.task_id, taskStatus, {
      attempt_id: attemptId,
      ...payload,
    });
    recordEvent(runDir, state, "worker_exited", {
      task_id: task.task_id,
      attempt_id: attemptId,
      exit_status: outcome.exitCode,
      stop_reason: attemptStatus,
      thread_id: outcome.threadId,
      stderr_tail: outcome.stderrTail ? outcome.stderrTail.slice(-1000) : "",
    });
  };

  if (outcome.cancelled) {
    finishAttempt("cancelled", "cancelled", { reason: "cancelled" });
    return;
  }
  if (outcome.timedOut) {
    finishAttempt("timed_out", "timed_out", { reason: "timeout", timeout_ms: timeoutMs });
    return;
  }
  // Exit codes are unreliable (SIGINT can exit 0); require stream semantics.
  const streamSuccess =
    outcome.exitCode === 0 && outcome.sawTurnCompleted && outcome.lastAgentMessage != null;
  const rawMessage = outcome.lastAgentMessage ?? readLastMessageFile(lastMessagePath);
  if (!streamSuccess || rawMessage == null) {
    finishAttempt("failed", "failed", {
      reason: "worker_failed",
      exit_code: outcome.exitCode,
      spawn_error: outcome.spawnError,
      saw_turn_completed: outcome.sawTurnCompleted,
    });
    return;
  }

  let workerOutput;
  try {
    workerOutput = JSON.parse(rawMessage);
  } catch {
    workerOutput = null;
  }
  const result = workerOutput == null
    ? null
    : { task_id: task.task_id, attempt_id: attemptId, ...workerOutput };
  const resultErrors = result == null ? ["worker output was not valid JSON"] : validateWorkerResult(result);
  const resultPath = resolveRunArtifactPath(runDir, task.task_id, "result.json");

  if (resultErrors.length > 0) {
    quarantineWorkerOutput(runDir, state, task, attemptId, attemptDir, attempt, rawMessage, resultErrors);
    return;
  }

  writeJson(resultPath, result);
  state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
  if (!state.artifacts.includes(toRunRelative(runDir, resultPath))) {
    state.artifacts.push(toRunRelative(runDir, resultPath));
  }
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
    token_usage: outcome.usage,
    thread_id: outcome.threadId,
  });
  finishAttempt(result.status, result.status === "succeeded" ? "succeeded" : "failed", {
    reason: result.status === "succeeded" ? "completed" : "worker_reported_failure",
  });
}

async function runClaudeAttempt(runDir, workflow, state, task, attemptId, attemptDir, handle, runStartedAt, runContext) {
  const settingsPath = path.join(runDir, CLAUDE_SETTINGS_FILE);
  if (!fs.existsSync(settingsPath)) {
    writeJson(settingsPath, buildClaudeSandboxSettings({ workflow }));
  }
  const workerEventsPath = path.join(attemptDir, "claude-events.jsonl");
  const inputPaths = resolveTaskInputs(runDir, workflow, state, task);
  const prompt = buildWorkerPrompt({ workflow, task, runDir, inputPaths });
  const remainingMs = workflow.max_duration_ms - (Date.now() - runStartedAt);
  const timeoutMs = Math.max(Math.min(task.timeout_ms ?? Infinity, remainingMs), 1000);
  const bin = resolveClaudeBin();
  const args = buildClaudeExecArgs({ workflow, task, settingsPath });

  const attempt = state.attempts[attemptId];
  attempt.status = "running";
  attempt.started_at = nowIso();
  let resultAccounted = false;

  const exec = startClaudeExec({
    bin,
    args,
    prompt,
    cwd: workflow.workspace_policy.workspace_root,
    timeoutMs,
    onEvent: (event) => {
      try {
        fs.appendFileSync(workerEventsPath, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        // Telemetry capture is best-effort.
      }
      if (runContext.sealed) {
        return;
      }
      if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
        attempt.thread_id = event.session_id;
        recordEvent(runDir, state, "worker_thread_started", {
          task_id: task.task_id,
          attempt_id: attemptId,
          thread_id: event.session_id,
        });
      }
      if (event.type === "result" && !resultAccounted) {
        // Single budget accounting point: the first result.usage only.
        // assistant events also carry usage, but adding them here would double
        // count; they stay in claude-events.jsonl as telemetry. The real CLI
        // emits exactly one result event; the guard keeps the budget and the
        // reported token_usage consistent if that contract ever breaks.
        resultAccounted = true;
        // Anthropic input_tokens excludes cache_read AND cache_creation;
        // cache_creation is freshly processed input and must be charged to
        // keep max_tokens enforcement comparable to codex. Only cache reads
        // stay uncounted ("cached input is not counted").
        const usage = event.usage ?? {};
        const tokens =
          (Number(usage.input_tokens) || 0) +
          (Number(usage.cache_creation_input_tokens) || 0) +
          (Number(usage.output_tokens) || 0) +
          (Number(usage.reasoning_output_tokens) || 0);
        state.budget_usage.tokens += tokens;
        recordEvent(runDir, state, "progress", {
          task_id: task.task_id,
          attempt_id: attemptId,
          token_usage: usage,
          last_activity_at: nowIso(),
        });
      }
    },
  });
  attempt.pid = exec.pid;
  handle.cancel = exec.cancel;
  recordEvent(runDir, state, "launch_started", {
    task_id: task.task_id,
    attempt_id: attemptId,
    worker_id: `claude:${exec.pid ?? "unknown"}`,
    command: [bin, ...args, "<prompt>"],
    artifact_directory: toRunRelative(runDir, attemptDir),
    timeout_ms: timeoutMs,
  });

  const outcome = await exec.promise;
  if (runContext.sealed) {
    // The orchestrator already aborted and folded this attempt.
    return;
  }
  attempt.completed_at = nowIso();

  // Cost is recorded only (max_cost stays advisory and unenforced); codex
  // attempts have no cost telemetry and leave budget_usage.cost untouched.
  if (typeof state.budget_usage.cost !== "number") {
    state.budget_usage.cost = 0;
  }
  state.budget_usage.cost += outcome.totalCostUsd;

  const finishAttempt = (attemptStatus, taskStatus, payload) => {
    attempt.status = attemptStatus;
    setTaskStatus(runDir, state, task.task_id, taskStatus, {
      attempt_id: attemptId,
      ...payload,
    });
    recordEvent(runDir, state, "worker_exited", {
      task_id: task.task_id,
      attempt_id: attemptId,
      exit_status: outcome.exitCode,
      stop_reason: attemptStatus,
      thread_id: outcome.threadId,
      stderr_tail: outcome.stderrTail ? outcome.stderrTail.slice(-1000) : "",
    });
  };

  if (outcome.cancelled) {
    finishAttempt("cancelled", "cancelled", { reason: "cancelled" });
    return;
  }
  if (outcome.timedOut) {
    finishAttempt("timed_out", "timed_out", { reason: "timeout", timeout_ms: timeoutMs });
    return;
  }
  // The claude CLI exhausted its own structured-output retries: the worker ran
  // but never produced schema-conforming output, so this is the
  // schema-violation quarantine path rather than worker_failed.
  if (outcome.resultSubtype === "error_max_structured_output_retries") {
    quarantineWorkerOutput(runDir, state, task, attemptId, attemptDir, attempt, outcome.lastAgentMessage, [
      "claude exhausted structured output retries (error_max_structured_output_retries)",
    ]);
    return;
  }
  // Exit codes are unreliable: auth failures surface as is_error: true with
  // exit code 0 while subtype can still read "success", so is_error and
  // subtype are required independently of the exit code.
  const streamSuccess =
    outcome.exitCode === 0 &&
    outcome.sawTurnCompleted &&
    !outcome.isError &&
    outcome.resultSubtype === "success" &&
    outcome.lastAgentMessage != null;
  if (!streamSuccess) {
    finishAttempt("failed", "failed", {
      reason: "worker_failed",
      exit_code: outcome.exitCode,
      spawn_error: outcome.spawnError,
      saw_turn_completed: outcome.sawTurnCompleted,
      is_error: outcome.isError,
      result_subtype: outcome.resultSubtype,
    });
    return;
  }

  const rawMessage = outcome.lastAgentMessage;
  let workerOutput;
  try {
    workerOutput = JSON.parse(rawMessage);
  } catch {
    workerOutput = null;
  }
  const result = workerOutput == null
    ? null
    : { task_id: task.task_id, attempt_id: attemptId, ...workerOutput };
  // The CLI-side --json-schema enforcement is not trusted on its own; the
  // worker output goes through the same validation as codex (defense in depth).
  const resultErrors = result == null ? ["worker output was not valid JSON"] : validateWorkerResult(result);
  const resultPath = resolveRunArtifactPath(runDir, task.task_id, "result.json");

  if (resultErrors.length > 0) {
    quarantineWorkerOutput(runDir, state, task, attemptId, attemptDir, attempt, rawMessage, resultErrors);
    return;
  }

  writeJson(resultPath, result);
  state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
  if (!state.artifacts.includes(toRunRelative(runDir, resultPath))) {
    state.artifacts.push(toRunRelative(runDir, resultPath));
  }
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
    token_usage: outcome.usage,
    thread_id: outcome.threadId,
  });
  finishAttempt(result.status, result.status === "succeeded" ? "succeeded" : "failed", {
    reason: result.status === "succeeded" ? "completed" : "worker_reported_failure",
  });
}

function runLocalAttempt(runDir, workflow, state, task, attemptId, attemptDir) {
  const attempt = state.attempts[attemptId];
  attempt.status = "running";
  attempt.started_at = nowIso();
  recordEvent(runDir, state, "launch_started", {
    task_id: task.task_id,
    attempt_id: attemptId,
    worker_id: `local:${task.task_id}`,
    artifact_directory: toRunRelative(runDir, attemptDir),
  });

  const result = buildLocalWorkerResult(runDir, workflow, state, task, attemptId);
  const resultErrors = validateWorkerResult(result);
  const resultPath = path.join(attemptDir, "result.json");
  writeJson(resultPath, result);

  if (resultErrors.length > 0) {
    attempt.status = "quarantined";
    attempt.completed_at = nowIso();
    state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
    setTaskStatus(runDir, state, task.task_id, "schema_violation", {
      attempt_id: attemptId,
      validation_errors: resultErrors,
    });
    recordEvent(runDir, state, "result_submitted", {
      task_id: task.task_id,
      attempt_id: attemptId,
      result_path: toRunRelative(runDir, resultPath),
      validation_errors: resultErrors,
    });
    return;
  }

  state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
  attempt.status = result.status;
  attempt.completed_at = nowIso();
  if (!state.artifacts.includes(toRunRelative(runDir, resultPath))) {
    state.artifacts.push(toRunRelative(runDir, resultPath));
  }
  for (const artifact of result.artifacts) {
    if (!state.artifacts.includes(artifact)) {
      state.artifacts.push(artifact);
    }
  }
  setTaskStatus(runDir, state, task.task_id, result.status === "succeeded" ? "succeeded" : "failed", {
    attempt_id: attemptId,
  });
  recordEvent(runDir, state, "result_submitted", {
    task_id: task.task_id,
    attempt_id: attemptId,
    schema_version: SCHEMA_VERSION,
    result_path: toRunRelative(runDir, resultPath),
    artifact_manifest: result.artifacts,
    token_usage: 0,
  });
  recordEvent(runDir, state, "worker_exited", {
    task_id: task.task_id,
    attempt_id: attemptId,
    exit_status: 0,
    stop_reason: "completed",
    log_pointer: toRunRelative(runDir, resultPath),
  });
}

function resolveTaskInputs(runDir, workflow, state, task) {
  const source = task.input_source;
  if (source == null || source === "objective") {
    return [];
  }
  if (source === "accepted_worker_results") {
    return Object.values(state.tasks)
      .filter((taskState) => taskState.status === "succeeded" && taskState.result_path)
      .map((taskState) => path.join(runDir, taskState.result_path));
  }
  const sources = Array.isArray(source) ? source : [source];
  const resolved = sources.map((candidate) =>
    path.isAbsolute(candidate) ? candidate : path.join(runDir, candidate),
  );
  // Reads are not sandboxed the way artifact writes are; record an audit
  // event when a spec-authored input points outside the run and workspace.
  const allowedRoots = [path.resolve(runDir), path.resolve(workflow.workspace_policy?.workspace_root ?? runDir)];
  for (const inputPath of resolved) {
    const normalized = path.resolve(inputPath);
    const contained = allowedRoots.some(
      (root) => normalized === root || normalized.startsWith(root + path.sep),
    );
    if (!contained) {
      recordEvent(runDir, state, "input_path_warning", {
        task_id: task.task_id,
        input_path: normalized,
        reason: "input_source resolves outside the run directory and workspace root",
      });
    }
  }
  return resolved;
}

// --- Default template ------------------------------------------------------

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
        outputs: ["result.json", "artifacts/synthesis.md"],
      },
    ],
    max_concurrency: 1,
    max_agents: 8,
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

// Approval-summary view of the enforced sandbox. The per-executor breakdown is
// emitted only when the workflow contains a claude-kind task: codex-only
// summaries must stay byte-identical to the pre-claude format.
function buildExecutionSandboxSummary(workflow, policy) {
  const workspaceWrite = Array.isArray(policy.write_scope) && policy.write_scope.includes("workspace");
  const summary = {
    mode: workspaceWrite ? "workspace-write" : "read-only",
    write_scope: policy.write_scope,
    network_access: workspaceWrite && policy.network === true,
    unsupported_permissions_rejected: ["shell", "mcp_write"],
  };
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks : [];
  const hasClaudeTask = tasks.some((task) => resolveExecutorKind(task?.kind) === "claude");
  if (!hasClaudeTask) {
    return summary;
  }
  const hasCodexTask = tasks.some((task) => resolveExecutorKind(task?.kind) === "codex");
  const executors = {};
  if (hasCodexTask) {
    executors.codex = { sandbox: workspaceWrite ? "workspace-write" : "read-only" };
  }
  executors.claude = {
    permission_mode: workspaceWrite ? "dontAsk" : "default",
    tools: workspaceWrite ? "write set" : "read-only set",
    os_sandbox: workspaceWrite
      ? `settings (allow write ${policy.workspace_root} / no network)`
      : `settings (deny write ${policy.workspace_root} / no network)`,
    setting_sources: "none (all ambient excluded)",
    customizations: "disabled (--safe-mode)",
  };
  summary.executors = executors;
  return summary;
}

function buildInitialRunState({ workflow, goalId, createdAt, specHash }) {
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
  const policy = workflow.workspace_policy ?? {};
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
    spec_hash: specHash,
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
        objective: workflow.objective,
        workspace_root: policy.workspace_root,
        spec_hash: specHash,
        phases: workflow.phases.map((phase) => ({
          phase_id: phase.phase_id,
          name: phase.name,
          task_count: phase.tasks.length,
        })),
        tasks: workflow.tasks.map((task) => ({
          task_id: task.task_id,
          role: task.role,
          kind: task.kind,
          prompt_summary:
            task.prompt_template.length > 120
              ? `${task.prompt_template.slice(0, 117)}...`
              : task.prompt_template,
        })),
        max_agents: workflow.max_agents,
        max_concurrency: workflow.max_concurrency,
        requested_capabilities: workflow.required_capabilities,
        execution_sandbox: buildExecutionSandboxSummary(workflow, policy),
        budget: {
          max_tokens: workflow.max_tokens,
          max_duration_ms: workflow.max_duration_ms,
        },
        advisory_fields: {
          note: "Recorded in the spec and shown here, but not enforced by the runner.",
          fields: [...ADVISORY_SPEC_FIELDS],
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
    runner: null,
    event_count: 0,
    event_log_offset: 0,
  };
}

function buildLocalWorkerResult(runDir, workflow, state, task, attemptId) {
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
    const dependencyResults = task.depends_on.map((taskId) => resolveRunArtifactPath(runDir, taskId, "result.json"));
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
    const acceptedResults = Object.values(state.tasks)
      .filter((taskState) => taskState.result_path)
      .map((taskState) => taskState.result_path);
    const synthesisPath = resolveRunArtifactPath(runDir, "synthesis.md");
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

// --- State helpers ---------------------------------------------------------

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

function countTaskStatuses(state) {
  const counts = {};
  for (const taskState of Object.values(state.tasks ?? {})) {
    counts[taskState.status] = (counts[taskState.status] ?? 0) + 1;
  }
  return counts;
}

function summarizeRun(runDir, state, workflow) {
  const liveLock = readLiveLock(runDir);
  return {
    run_id: state.run_id,
    workflow_id: workflow.workflow_id,
    run_dir: path.resolve(runDir),
    status: state.status,
    objective: workflow.objective,
    current_phase: state.current_phase,
    outcome: state.outcome,
    approval: state.approval,
    spec_hash: state.spec_hash ?? null,
    runner: liveLock ? { active: true, pid: liveLock.pid } : { active: false, pid: null },
    tasks: state.tasks,
    task_counts: countTaskStatuses(state),
    phases: state.phases,
    artifacts: state.artifacts,
    budget_usage: state.budget_usage,
    paths: {
      workflow_spec: path.join(path.resolve(runDir), WORKFLOW_FILE),
      run_state: path.join(path.resolve(runDir), RUN_STATE_FILE),
      event_log: path.join(path.resolve(runDir), EVENT_LOG_FILE),
      artifacts: path.join(path.resolve(runDir), "artifacts"),
    },
    event_count: state.event_count ?? countEvents(runDir),
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
  state.event_count = (state.event_count ?? 0) + 1;
  state.event_log_offset = fs.statSync(eventPath).size;
  writeJson(path.join(runDir, RUN_STATE_FILE), state);
  return event;
}

function persistRunState(runDir, state) {
  writeJson(path.join(runDir, RUN_STATE_FILE), state);
}

function countEvents(runDir) {
  const eventPath = path.join(runDir, EVENT_LOG_FILE);
  if (!fs.existsSync(eventPath)) {
    return 0;
  }
  const content = fs.readFileSync(eventPath, "utf8").trim();
  return content ? content.split("\n").length : 0;
}

// --- Locking and control signals -------------------------------------------

function lockPathFor(runDir) {
  return path.join(runDir, LOCK_FILE);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function readLiveLock(runDir) {
  const lockPath = lockPathFor(runDir);
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    return null;
  }
  if (isPidAlive(lock.pid)) {
    return lock;
  }
  return null;
}

function acquireRunLock(runDir) {
  const lockPath = lockPathFor(runDir);
  const payload = JSON.stringify({ pid: process.pid, created_at: nowIso() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const live = readLiveLock(runDir);
      if (live) {
        throw new WorkflowError("Run is locked by an active orchestrator.", {
          runner_pid: live.pid,
        });
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another contender removed it first; retry.
      }
    }
  }
  throw new WorkflowError("Could not acquire the run lock.", { lockPath });
}

function releaseRunLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already removed.
  }
}

function withRunLock(runDir, fn) {
  const lockPath = acquireRunLock(runDir);
  try {
    return fn();
  } finally {
    releaseRunLock(lockPath);
  }
}

function readCancelSignal(runDir) {
  const signalPath = path.join(runDir, CONTROL_DIR, CANCEL_SIGNAL_FILE);
  try {
    return JSON.parse(fs.readFileSync(signalPath, "utf8"));
  } catch {
    return null;
  }
}

function clearCancelSignal(runDir) {
  try {
    fs.unlinkSync(path.join(runDir, CONTROL_DIR, CANCEL_SIGNAL_FILE));
  } catch {
    // Nothing to clear.
  }
}

// --- Generic helpers --------------------------------------------------------

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
  if (normalized.length > 16000) {
    throw new WorkflowError("Objective must be at most 16000 characters.");
  }
  return normalized;
}

function normalizeOptionalMaxTasks(value) {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowError("maxTasks must be a non-negative integer.", { maxTasks: value });
  }
  return value;
}

function validateSpecId(value, label, errors) {
  if (typeof value !== "string" || !SPEC_ID_PATTERN.test(value)) {
    errors.push(`${label} must match ${SPEC_ID_PATTERN_DESCRIPTION}`);
  }
}

function validateInputSource(task, errors) {
  const source = task.input_source;
  if (source == null || source === "objective" || source === "accepted_worker_results") {
    return;
  }
  const message = `task ${task.task_id} input_source must be null, "objective", "accepted_worker_results", a non-empty path string, or a non-empty array of non-empty path strings`;
  if (typeof source === "string") {
    if (source.trim() === "") {
      errors.push(message);
    }
    return;
  }
  if (Array.isArray(source)) {
    if (source.length === 0 || !source.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
      errors.push(message);
    }
    return;
  }
  errors.push(message);
}

function validateRetryPolicy(policy, errors, prefix) {
  if (!isPlainObject(policy)) {
    return;
  }
  if (typeof policy.retryable !== "boolean") {
    errors.push(`${prefix} retry_policy.retryable must be a boolean`);
  }
  if (!Number.isInteger(policy.max_attempts) || policy.max_attempts < 1) {
    errors.push(`${prefix} retry_policy.max_attempts must be a positive integer`);
  }
  if (!Number.isInteger(policy.backoff_ms) || policy.backoff_ms < 0) {
    errors.push(`${prefix} retry_policy.backoff_ms must be a non-negative integer`);
  }
  if (!PARTIAL_RESULT_POLICIES.has(policy.partial_result_policy)) {
    errors.push(`${prefix} retry_policy.partial_result_policy must be one of: ${[...PARTIAL_RESULT_POLICIES].join(", ")}`);
  }
  if (typeof policy.cleanup_required !== "boolean") {
    errors.push(`${prefix} retry_policy.cleanup_required must be a boolean`);
  }
  if (!GOAL_STATUS_EFFECTS.has(policy.goal_status_effect)) {
    errors.push(`${prefix} retry_policy.goal_status_effect must be one of: ${[...GOAL_STATUS_EFFECTS].join(", ")}`);
  }
}

function validateWorkspacePolicy(policy, errors) {
  if (!isPlainObject(policy)) {
    return;
  }
  if (policy.write_scope != null) {
    if (!Array.isArray(policy.write_scope)) {
      errors.push("workspace_policy.write_scope must be an array");
    } else {
      const allowedScopes = new Set(["run_dir", "workspace"]);
      for (const scope of policy.write_scope) {
        if (!allowedScopes.has(scope)) {
          errors.push(`workspace_policy.write_scope contains unsupported scope: ${scope}`);
        }
      }
    }
  }
  if (policy.network != null && typeof policy.network !== "boolean") {
    errors.push("workspace_policy.network must be a boolean");
  }
  const writeScope = Array.isArray(policy.write_scope) ? policy.write_scope : [];
  // Applies to claude tasks too: claude could technically do read-only+network,
  // but per-executor policy vocabularies would make the approval summary ambiguous (design decision).
  if (policy.network === true && !writeScope.includes("workspace")) {
    errors.push("workspace_policy.network requires write_scope to include workspace (runner policy)");
  }
  if (policy.shell === true) {
    errors.push("workspace_policy.shell is not supported by the runner and cannot be requested");
  } else if (policy.shell != null && policy.shell !== false) {
    errors.push("workspace_policy.shell must be false when present");
  }
  if (policy.mcp_write === true) {
    errors.push("workspace_policy.mcp_write is not supported by the runner and cannot be requested");
  } else if (policy.mcp_write != null && policy.mcp_write !== false) {
    errors.push("workspace_policy.mcp_write must be false when present");
  }
}

function resolveRunArtifactPath(runDir, ...segments) {
  return resolveContainedPath(path.join(runDir, "artifacts"), ...segments);
}

function resolveContainedPath(rootDir, ...segments) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new WorkflowError("Artifact path escapes the run artifacts directory.", {
      root,
      path: resolved,
    });
  }
  return resolved;
}

function isPlainObject(value) {
  return typeof value === "object" && value != null && !Array.isArray(value);
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

function requirePositiveInteger(payload, field, errors) {
  if (!Number.isInteger(payload?.[field]) || payload[field] < 1) {
    errors.push(`${field} must be a positive integer`);
  }
}

function detectCycle(dependencyMap) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colors = new Map([...dependencyMap.keys()].map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;

  const visit = (node) => {
    if (cycle) {
      return;
    }
    colors.set(node, GRAY);
    stack.push(node);
    for (const dependency of dependencyMap.get(node) ?? []) {
      if (!dependencyMap.has(dependency)) {
        continue;
      }
      const color = colors.get(dependency);
      if (color === GRAY) {
        cycle = [...stack.slice(stack.indexOf(dependency)), dependency];
        return;
      }
      if (color === WHITE) {
        visit(dependency);
      }
    }
    stack.pop();
    colors.set(node, BLACK);
  };

  for (const node of dependencyMap.keys()) {
    if (colors.get(node) === WHITE) {
      visit(node);
    }
    if (cycle) {
      break;
    }
  }
  return cycle;
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

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function libDirectory() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function sleep(ms, { unref = true } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) {
      timer.unref?.();
    }
  });
}
