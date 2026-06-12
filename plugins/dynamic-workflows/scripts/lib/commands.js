import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CANCEL_SIGNAL_FILE,
  CONTROL_DIR,
  EVENT_LOG_FILE,
  RESUMABLE_TASK_STATUSES,
  RUN_ID_PATTERN,
  RUN_STATE_FILE,
  RUNNER_LOG_FILE,
  TERMINAL_RUN_STATUSES,
  WORKFLOW_FILE,
  WorkflowError,
} from "./constants.js";
import {
  ensureDir,
  hashFile,
  isPlainObject,
  libDirectory,
  makeId,
  normalizeObjective,
  normalizeOptionalMaxTasks,
  nowIso,
  requireRunDir,
  resolveRunRoot,
  sleep,
  writeJson,
} from "./util.js";
import { applySpecDefaults, buildDefaultWorkflowSpec, validateWorkflowSpec } from "./spec.js";
import {
  assertKnownRunState,
  countEvents,
  countTaskStatuses,
  persistRunState,
  readRunState,
  readVerifiedWorkflowSpec,
  readWorkflowSpec,
  recordEvent,
  validateRunConsistency,
  validateRunState,
} from "./run-state.js";
import { buildInitialRunState } from "./approval.js";
import { loadSavedWorkflow } from "./saved-workflows.js";
import {
  acquireRunLock,
  readLiveLock,
  releaseRunLock,
  withRunLock,
} from "./lock-control.js";
import { buildForeachChildDefs, executeApprovedRun } from "./scheduler.js";

export function planWorkflow(options = {}) {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const runId = options.runId ?? makeId("run");
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new WorkflowError("runId must be a string matching ^[A-Za-z0-9._-]{1,64}$.", { runId });
  }
  const workflowId = options.workflowId ?? makeId("wf");
  const createdAt = nowIso();

  let workflow;
  let provenance = null;
  if (options.workflow != null && options.spec != null) {
    throw new WorkflowError("workflow (saved template) and spec are mutually exclusive.", {
      workflow: options.workflow,
    });
  }
  if (options.inputs != null && options.workflow == null) {
    throw new WorkflowError("inputs require a saved workflow (pass workflow).", {
      inputs: Object.keys(options.inputs ?? {}),
    });
  }
  if (options.workflow != null) {
    const loaded = loadSavedWorkflow({
      name: options.workflow,
      inputs: options.inputs,
      workspace,
    });
    provenance = loaded.provenance;
    // An explicit objective option overrides the expanded template objective.
    workflow = applySpecDefaults(loaded.spec, {
      objective: options.objective,
      workspace,
      runId,
      workflowId,
      createdAt,
    });
  } else if (options.spec != null) {
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

  // Validation is uniformly strict: stored runs are re-validated with the same
  // rules on every read (schema v2 has no lenient re-read path).
  const workflowErrors = validateWorkflowSpec(workflow);
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
    provenance,
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
  const workflow = readVerifiedWorkflowSpec(runDir, state, "approve");
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
    const lockedWorkflow = readVerifiedWorkflowSpec(runDir, lockedState, "approve");
    assertKnownRunState(lockedState, lockedWorkflow);
    if (lockedState.status !== "awaiting_approval" && lockedState.status !== "planned") {
      return summarizeRun(runDir, lockedState, lockedWorkflow);
    }
    const timestamp = nowIso();
    lockedState.status = "approved";
    lockedState.approval.approved_at = timestamp;
    lockedState.approval.approved_by = options.approvedBy ?? "local-user";
    recordEvent(runDir, lockedState, "approval_granted", {
      approved_by: lockedState.approval.approved_by,
    });
    return summarizeRun(runDir, readRunState(runDir), lockedWorkflow);
  });
}

export async function runWorkflow(options = {}) {
  const maxTasks = normalizeOptionalMaxTasks(options.maxTasks);
  const runDir = requireRunDir(options.runDir);
  let state = readRunState(runDir);
  let workflow = readVerifiedWorkflowSpec(runDir, state, "run");
  assertKnownRunState(state, workflow);

  if (state.status === "awaiting_approval" || state.status === "planned") {
    if (!options.approve) {
      throw new WorkflowError("Run is awaiting approval. Re-run with --approve or call approve first.", {
        status: state.status,
      });
    }
    approveWorkflow({ runDir, approvedBy: options.approvedBy });
    state = readRunState(runDir);
    workflow = readVerifiedWorkflowSpec(runDir, state, "run");
    assertKnownRunState(state, workflow);
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
    if (state.status !== "completed") {
      throw new WorkflowError("Run is not in an executable status.", { status: state.status });
    }
  }

  const lockPath = acquireRunLock(runDir);
  let earlySummary = null;
  try {
    state = readRunState(runDir);
    workflow = readVerifiedWorkflowSpec(runDir, state, "run");
    assertKnownRunState(state, workflow);
    earlySummary = prepareLockedRunStart(runDir, state, workflow);
  } catch (error) {
    releaseRunLock(lockPath);
    throw error;
  }
  if (earlySummary) {
    releaseRunLock(lockPath);
    return earlySummary;
  }

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

function prepareLockedRunStart(runDir, state, workflow) {
  if (state.status === "completed") {
    recordEvent(runDir, state, "run_noop", { reason: "already_completed" });
    return summarizeRun(runDir, readRunState(runDir), workflow);
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
    throw new WorkflowError("Run is marked running but has no live orchestrator. Use resume to recover.", {
      status: state.status,
    });
  }
  if (state.status !== "approved" && state.status !== "paused") {
    throw new WorkflowError("Run is not in an executable status.", { status: state.status });
  }
  return null;
}

export async function resumeWorkflow(options = {}) {
  const maxTasks = normalizeOptionalMaxTasks(options.maxTasks);
  const runDir = requireRunDir(options.runDir);
  let state = readRunState(runDir);
  let workflow = readVerifiedWorkflowSpec(runDir, state, "resume");
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

  withRunLock(runDir, () => {
    state = readRunState(runDir);
    workflow = readVerifiedWorkflowSpec(runDir, state, "resume");
    assertKnownRunState(state, workflow);
    // F6 resume safety (spec §6.2): replay tasks_expanded events before the
    // requeue pass so the crash window between the event append and the
    // run-state write cannot lose expanded children.
    replayExpandedTaskEvents(runDir, state, workflow);
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

// Idempotent replay of tasks_expanded events (spec §6.2): rebuilds any
// state.expanded_tasks definitions and state.tasks child entries that the
// crash window between recordEvent and the run-state write lost. Existing
// entries (including completed children) are never touched; child definitions
// are re-derived deterministically from the parent definition plus the items
// payload embedded in the event. The caller persists the state afterwards.
function replayExpandedTaskEvents(runDir, state, workflow) {
  const eventPath = path.join(runDir, EVENT_LOG_FILE);
  if (!fs.existsSync(eventPath)) {
    return;
  }
  const taskById = new Map(workflow.tasks.map((task) => [task.task_id, task]));
  if (!Array.isArray(state.expanded_tasks)) {
    state.expanded_tasks = [];
  }
  const knownChildren = new Set(state.expanded_tasks.map((child) => child?.task_id));
  const timestamp = nowIso();
  for (const line of fs.readFileSync(eventPath, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "tasks_expanded") {
      continue;
    }
    const payload = event.payload ?? {};
    const parent = taskById.get(payload.task_id);
    if (!parent || !isPlainObject(parent.foreach) || !Array.isArray(payload.items)) {
      continue;
    }
    const replayedIds = [];
    for (const child of buildForeachChildDefs(parent, payload.items)) {
      if (!knownChildren.has(child.task_id)) {
        state.expanded_tasks.push(child);
        knownChildren.add(child.task_id);
        replayedIds.push(child.task_id);
      }
      if (!state.tasks[child.task_id]) {
        state.tasks[child.task_id] = {
          task_id: child.task_id,
          phase_id: child.phase_id,
          status: "queued",
          attempts: [],
          result_path: null,
          updated_at: timestamp,
        };
      }
    }
    if (replayedIds.length > 0) {
      recordEvent(runDir, state, "tasks_expanded_replayed", {
        task_id: parent.task_id,
        expanded_ids: replayedIds,
      });
    }
  }
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
  const workflow = readVerifiedWorkflowSpec(runDir, preState, "detach");
  assertKnownRunState(preState, workflow);
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
    "package.json",
    "skills/dynamic-workflows/SKILL.md",
    "scripts/dynamic-workflows.js",
    "scripts/dynamic-workflows-mcp.js",
    "scripts/lib/approval.js",
    "scripts/lib/claude-executor.js",
    "scripts/lib/codex-executor.js",
    "scripts/lib/commands.js",
    "scripts/lib/constants.js",
    "scripts/lib/core.js",
    "scripts/lib/executor-contract.js",
    "scripts/lib/gates.js",
    "scripts/lib/lock-control.js",
    "scripts/lib/output-schema.js",
    "scripts/lib/process-runner.js",
    "scripts/lib/run-state.js",
    "scripts/lib/saved-workflows.js",
    "scripts/lib/scheduler.js",
    "scripts/lib/spec.js",
    "scripts/lib/template.js",
    "scripts/lib/util.js",
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
