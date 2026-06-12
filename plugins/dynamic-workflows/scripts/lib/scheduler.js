import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildCodexExecArgs,
  buildWorkerPrompt,
  readLastMessageFile,
  resolveCodexBin,
  startCodexExec,
} from "./codex-executor.js";
import { synthesizeWorkerSchema } from "./output-schema.js";
import { buildGateEnv, formatGateFeedback, runGates } from "./gates.js";
import {
  buildClaudeExecArgs,
  buildClaudeSandboxSettings,
  resolveClaudeBin,
  startClaudeExec,
} from "./claude-executor.js";
import {
  CLAUDE_SETTINGS_FILE,
  NON_FAILURE_TERMINAL_TASK_STATUSES,
  PERMANENT_FAILURE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  SCHEMA_VERSION,
  TERMINAL_TASK_STATUSES,
  WORKER_SCHEMA_FILE,
  WORKFLOW_FILE,
} from "./constants.js";
import {
  ensureDir,
  isPlainObject,
  normalizeOptionalMaxTasks,
  nowIso,
  readJson,
  resolveExecutorKind,
  resolveRunArtifactPath,
  sleep,
  toRunRelative,
  writeJson,
} from "./util.js";
import {
  TemplateRenderError,
  TemplateSyntaxError,
  listRefs,
  renderTemplate,
} from "./template.js";
import {
  failRun,
  persistRunState,
  recordEvent,
  setPhaseStatus,
  setTaskStatus,
  validateWorkerResult,
} from "./run-state.js";
import { clearCancelSignal, readCancelSignal } from "./lock-control.js";

// --- Scheduler -------------------------------------------------------------

// Spec §6.2: serialized foreach items above this size (UTF-8 bytes) fail the
// expansion closed; the resolved items are embedded verbatim in the
// tasks_expanded event so resume can replay the expansion.
const MAX_FOREACH_ITEMS_SERIALIZED_BYTES = 256 * 1024;

// Derives the expanded child definitions of a foreach parent (spec §6.2).
// Deterministic over (parentTask, items): the scheduler builds children here
// at expansion time and resume rebuilds the same definitions from the
// tasks_expanded event payload. Children inherit the executor surface
// (kind/model/effort/profile/timeout_ms), retry_policy, output_schema, and
// gates; dependencies were satisfied at expansion, so depends_on stays empty.
export function buildForeachChildDefs(parentTask, items) {
  return items.map((item, index) => ({
    task_id: `${parentTask.task_id}.${index}`,
    parent_task_id: parentTask.task_id,
    item_index: index,
    phase_id: parentTask.phase_id,
    kind: parentTask.kind,
    role: parentTask.role,
    prompt_template: parentTask.prompt_template,
    input_source: "objective",
    depends_on: [],
    condition: "always",
    retry_policy: parentTask.retry_policy,
    stop_condition: parentTask.stop_condition,
    outputs: parentTask.outputs,
    item,
    ...(parentTask.output_schema != null ? { output_schema: parentTask.output_schema } : {}),
    ...(parentTask.gates !== undefined ? { gates: parentTask.gates } : {}),
    ...(parentTask.gate_feedback_tail_bytes !== undefined
      ? { gate_feedback_tail_bytes: parentTask.gate_feedback_tail_bytes }
      : {}),
    ...(parentTask.timeout_ms != null ? { timeout_ms: parentTask.timeout_ms } : {}),
    ...(parentTask.model != null ? { model: parentTask.model } : {}),
    ...(parentTask.effort != null ? { effort: parentTask.effort } : {}),
    ...(parentTask.profile != null ? { profile: parentTask.profile } : {}),
  }));
}

export async function executeApprovedRun(runDir, workflow, state, options = {}) {
  const startedAt = Date.now();
  const maxTasks = normalizeOptionalMaxTasks(options.maxTasks);
  const inFlight = new Map();
  const settledQueue = [];
  const retryAt = new Map();
  // Tasks whose prompt template failed to render at launch: the failure is a
  // contract violation (templates are statically validated at plan time), so
  // the task is failed permanently and must never enter the retry path.
  const templateFailures = new Set();
  // Sealed after abortInFlight: a worker promise that survives the abort grace
  // period must not touch run state or the event log once the orchestrator has
  // folded the run, or it would rewrite run.json after the lock is released.
  // aborting is set first: an attempt whose worker already exited must not
  // start its gate phase while the orchestrator is tearing the run down.
  const runContext = { sealed: false, aborting: false };
  let launchedThisRun = 0;
  let lastHeartbeat = 0;

  let externalSignal = null;
  const onSignal = () => {
    externalSignal = { reason: "Runner received a termination signal." };
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Task lookups cover the union of spec tasks and foreach children (spec
  // §6.2): persisted expanded tasks are indexed at startup and new expansions
  // register themselves in expandForeachTask. scheduledTasks() is the single
  // source for every site that iterates schedulable tasks.
  const taskById = new Map(workflow.tasks.map((task) => [task.task_id, task]));
  for (const child of state.expanded_tasks ?? []) {
    taskById.set(child.task_id, child);
  }
  const scheduledTasks = () => [...workflow.tasks, ...(state.expanded_tasks ?? [])];
  const expandedChildrenOf = (parentId) =>
    (state.expanded_tasks ?? []).filter((child) => child.parent_task_id === parentId);
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
    // R2 (spec §5.2): skipped_by_route satisfies dependencies — a task routed
    // away on purpose must not block its downstream consumers.
    if (
      !(task.depends_on ?? []).every((depId) =>
        NON_FAILURE_TERMINAL_TASK_STATUSES.has(state.tasks[depId]?.status),
      )
    ) {
      return false;
    }
    const notBefore = retryAt.get(task.task_id);
    return notBefore == null || notBefore <= Date.now();
  };

  const abortInFlight = async (taskStatus, reason) => {
    runContext.aborting = true;
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
      for (const task of scheduledTasks()) {
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
          // R3 (spec §5.2): skipped_by_route counts toward phase success.
          if (taskStatuses.every((status) => NON_FAILURE_TERMINAL_TASK_STATUSES.has(status))) {
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

  // Route resolution (spec §5.1): runs exactly once per routing task, after it
  // folds to succeeded (post-gates) and before propagateSkips. The accepted
  // result's route value was persisted on the task state entry when the result
  // was accepted, so resolution works identically after a resume. Idempotent:
  // route_resolved marks consumed resolutions.
  const resolveRoute = (taskId) => {
    const task = taskById.get(taskId);
    const taskState = state.tasks[taskId];
    if (!isPlainObject(task?.route) || taskState.status !== "succeeded" || taskState.route_resolved === true) {
      return;
    }
    const value = taskState.route_value;
    const cases = isPlainObject(task.route.cases) ? task.route.cases : {};
    const selected = typeof value === "string" && Object.hasOwn(cases, value)
      ? cases[value]
      : task.route.default;
    const selectedSet = new Set(selected);
    const skipped = [];
    for (const caseTaskId of routeCaseTasks(task.route)) {
      if (!selectedSet.has(caseTaskId) && state.tasks[caseTaskId]?.status === "queued") {
        setTaskStatus(runDir, state, caseTaskId, "skipped_by_route", {
          reason: "route_not_selected",
          routing_task_id: taskId,
          route_value: value,
        });
        skipped.push(caseTaskId);
      }
    }
    taskState.route_resolved = true;
    recordEvent(runDir, state, "route_resolved", {
      task_id: taskId,
      value,
      selected: [...selected],
      skipped,
    });
  };

  // Foreach expansion and fold (spec §6.2-§6.4) -------------------------------

  // Resolves the statically validated foreach.items reference against the
  // producer's accepted result.json. A resolution failure is a contract
  // violation surfaced through the defensive template path (spec §3.4).
  const resolveForeachItems = (task) => {
    const [ref] = listRefs(task.foreach.items);
    const resultPath = state.tasks[ref.taskId]?.result_path;
    if (typeof resultPath !== "string" || resultPath === "") {
      throw new TemplateRenderError(
        `foreach.items references tasks.${ref.taskId} but task ${ref.taskId} has no recorded result (contract violation).`,
        { ref },
      );
    }
    let node;
    try {
      node = readJson(path.join(runDir, resultPath));
    } catch (error) {
      throw new TemplateRenderError(
        `foreach.items references tasks.${ref.taskId} but its result could not be read: ${error.message}`,
        { ref },
      );
    }
    let where = `tasks.${ref.taskId}.result`;
    for (const segment of ref.path) {
      if (node == null || typeof node !== "object" || !Object.hasOwn(node, segment)) {
        throw new TemplateRenderError(
          `foreach.items reference "${where}.${segment}" resolved to a missing value (contract violation).`,
          { ref },
        );
      }
      node = node[segment];
      where = `${where}.${segment}`;
    }
    return node;
  };

  // Synthesizes the parent's aggregate result.json (spec §6.3): an
  // order-preserving typed envelope over the children's terminal statuses.
  // Written only on the success fold (failures <= tolerated_failure_count)
  // and for the empty expansion.
  const writeForeachAggregate = (parentTask, children) => {
    const results = children.map((child) => {
      const childState = state.tasks[child.task_id];
      let output = null;
      if (typeof childState.result_path === "string" && childState.result_path !== "") {
        try {
          output = readJson(path.join(runDir, childState.result_path)).output ?? null;
        } catch {
          // A missing or unreadable child result degrades to output: null.
        }
      }
      return { index: child.item_index, task_id: child.task_id, status: childState.status, output };
    });
    const succeeded = results.filter((entry) => entry.status === "succeeded").length;
    const aggregate = {
      task_id: parentTask.task_id,
      attempt_id: "aggregate",
      status: "succeeded",
      summary: `${results.length} items: ${succeeded} succeeded, ${results.length - succeeded} failed`,
      errors: [],
      output: { results },
    };
    const resultPath = resolveRunArtifactPath(runDir, parentTask.task_id, "result.json");
    writeJson(resultPath, aggregate);
    state.tasks[parentTask.task_id].result_path = toRunRelative(runDir, resultPath);
    if (!state.artifacts.includes(toRunRelative(runDir, resultPath))) {
      state.artifacts.push(toRunRelative(runDir, resultPath));
    }
  };

  // Folds an expanded parent once every child is terminal: within
  // tolerated_failure_count the parent succeeds with the aggregate result,
  // beyond it the parent fails through the normal failure fold (no retry —
  // foreach parents are excluded from the retry path). Idempotent and a noop
  // (null) while any child is still pending, so it doubles as the startup
  // re-application for resumed runs (spec §6.2).
  const foldExpandedParent = (parentId) => {
    const parentTask = taskById.get(parentId);
    const parentState = state.tasks[parentId];
    if (parentState?.status !== "expanded") {
      return null;
    }
    const children = expandedChildrenOf(parentId);
    if (
      children.length === 0 ||
      !children.every((child) => TERMINAL_TASK_STATUSES.has(state.tasks[child.task_id]?.status))
    ) {
      return null;
    }
    const failures = children.filter((child) =>
      PERMANENT_FAILURE_TASK_STATUSES.has(state.tasks[child.task_id]?.status),
    ).length;
    const tolerated = parentTask.foreach.tolerated_failure_count ?? 0;
    if (failures > tolerated) {
      setTaskStatus(runDir, state, parentId, "failed", {
        reason: "foreach_children_failed",
        failed_children: failures,
        tolerated_failure_count: tolerated,
      });
    } else {
      writeForeachAggregate(parentTask, children);
      setTaskStatus(runDir, state, parentId, "succeeded", {
        reason: "foreach_aggregated",
        child_count: children.length,
        failed_children: failures,
      });
    }
    return foldTaskCompletion(parentId);
  };

  // Expands a ready foreach parent instead of launching a worker (spec §6.2):
  // the parent consumes no attempt, children are derived from the parent
  // definition plus one resolved item each, and the expansion is recorded as
  // a single replayable tasks_expanded event. Every bound violation fails the
  // parent closed (no truncation).
  const expandForeachTask = (task) => {
    const parentId = task.task_id;
    const phaseState = state.phases[task.phase_id];
    if (phaseState.status === "waiting" || phaseState.status === "ready") {
      setPhaseStatus(runDir, state, task.phase_id, "running");
    }
    // Idempotent re-expansion: resume can find the children already persisted
    // (crash window after the tasks_expanded event, or a resume-failed parent
    // whose children were requeued). Only the parent status is re-applied;
    // items are not re-resolved and no second event is recorded.
    const existing = expandedChildrenOf(parentId);
    if (existing.length > 0) {
      setTaskStatus(runDir, state, parentId, "expanded", {
        reason: "foreach_reexpanded",
        count: existing.length,
      });
      return;
    }
    const failExpansion = (reason, payload) => {
      setTaskStatus(runDir, state, parentId, "failed", { reason, ...payload });
      settledQueue.push(parentId);
    };
    let items;
    try {
      items = resolveForeachItems(task);
    } catch (error) {
      if (!(error instanceof TemplateRenderError)) {
        throw error;
      }
      templateFailures.add(parentId);
      recordEvent(runDir, state, "template_resolution_failed", {
        task_id: parentId,
        message: error.message,
      });
      failExpansion("template_resolution_failed", { error: error.message });
      return;
    }
    if (!Array.isArray(items)) {
      failExpansion("foreach_items_not_array", { items_type: typeof items });
      return;
    }
    if (items.length > task.foreach.max_items) {
      failExpansion("foreach_max_items_exceeded", {
        item_count: items.length,
        max_items: task.foreach.max_items,
      });
      return;
    }
    if (items.length === 0) {
      writeForeachAggregate(task, []);
      setTaskStatus(runDir, state, parentId, "succeeded", {
        reason: "foreach_empty",
        item_count: 0,
      });
      settledQueue.push(parentId);
      return;
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(items), "utf8");
    if (serializedBytes > MAX_FOREACH_ITEMS_SERIALIZED_BYTES) {
      failExpansion("foreach_items_too_large", {
        serialized_bytes: serializedBytes,
        limit: MAX_FOREACH_ITEMS_SERIALIZED_BYTES,
      });
      return;
    }
    const children = buildForeachChildDefs(task, items);
    const timestamp = nowIso();
    if (!Array.isArray(state.expanded_tasks)) {
      state.expanded_tasks = [];
    }
    for (const child of children) {
      state.expanded_tasks.push(child);
      taskById.set(child.task_id, child);
      state.tasks[child.task_id] = {
        task_id: child.task_id,
        phase_id: child.phase_id,
        status: "queued",
        attempts: [],
        result_path: null,
        updated_at: timestamp,
      };
    }
    recordEvent(runDir, state, "tasks_expanded", {
      task_id: parentId,
      count: children.length,
      items,
      expanded_ids: children.map((child) => child.task_id),
    });
    setTaskStatus(runDir, state, parentId, "expanded", {
      reason: "foreach_expanded",
      count: children.length,
    });
  };

  // Per-parent concurrency (spec §6.4): a child launches only while the
  // in-flight children of its parent stay below
  // min(foreach.concurrency, workflow.max_concurrency).
  const foreachChildBlocked = (task) => {
    if (task.parent_task_id == null) {
      return false;
    }
    const parentTask = taskById.get(task.parent_task_id);
    const limit = Math.min(
      parentTask?.foreach?.concurrency ?? workflow.max_concurrency,
      workflow.max_concurrency,
    );
    let inFlightSiblings = 0;
    for (const child of expandedChildrenOf(task.parent_task_id)) {
      if (inFlight.has(child.task_id)) {
        inFlightSiblings += 1;
      }
    }
    return inFlightSiblings >= limit;
  };

  // Returns "fail_run" when a phase with on_failure:"fail" failed.
  const foldTaskCompletion = (taskId) => {
    const task = taskById.get(taskId);
    const taskState = state.tasks[taskId];
    if (taskState.status === "succeeded") {
      resolveRoute(taskId);
      propagateSkips();
      // A settled foreach child folds its parent once every sibling is
      // terminal; the recursive parent fold owns the phase consequences.
      return task.parent_task_id != null
        ? foldExpandedParent(task.parent_task_id) ?? "continue"
        : "continue";
    }
    if (
      RETRYABLE_TASK_STATUSES.has(taskState.status) &&
      !templateFailures.has(taskId) &&
      // A foreach parent never retries (spec §6.3): its failure is a fold or
      // expansion verdict, not a worker attempt.
      !isPlainObject(task.foreach)
    ) {
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
    if (task.parent_task_id != null) {
      // A permanently failed child never fails the phase by itself: the
      // parent fold decides via tolerated_failure_count once all siblings
      // are terminal (spec §6.3).
      propagateSkips();
      return foldExpandedParent(task.parent_task_id) ?? "continue";
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
    // "expanded" is pending work (spec §6.2): a foreach parent with live
    // children must neither finalize the run nor read as unsatisfiable.
    if (statuses.some((status) => status === "queued" || status === "running" || status === "expanded")) {
      failRun(runDir, state, "Unsatisfiable task dependencies; tasks remain queued with no runnable work.", {
        queued_tasks: Object.values(state.tasks)
          .filter((taskState) => taskState.status === "queued" || taskState.status === "expanded")
          .map((taskState) => taskState.task_id),
      });
      return;
    }
    state.status = "completed";
    state.current_phase = null;
    // R4 (spec §5.2): skipped_by_route never demotes a run to partial and is
    // excluded from the failure counts; it is reported separately.
    const routedSkipped = statuses.filter((status) => status === "skipped_by_route").length;
    if (statuses.every((status) => NON_FAILURE_TERMINAL_TASK_STATUSES.has(status))) {
      state.outcome = {
        status: "success",
        summary: routedSkipped > 0
          ? `Workflow completed with all activated tasks succeeded (${routedSkipped} skipped by route).`
          : "Workflow completed with all tasks succeeded.",
        ...(routedSkipped > 0 ? { routed_skipped: routedSkipped } : {}),
        final_response_policy: state.final_response_policy,
      };
    } else {
      const failed = statuses.filter((status) => PERMANENT_FAILURE_TASK_STATUSES.has(status) && status !== "skipped").length;
      const skipped = statuses.filter((status) => status === "skipped").length;
      state.outcome = {
        status: "partial",
        summary: `Workflow completed with failures: ${failed} failed, ${skipped} skipped${routedSkipped > 0 ? `, ${routedSkipped} skipped by route` : ""}.`,
        ...(routedSkipped > 0 ? { routed_skipped: routedSkipped } : {}),
        final_response_policy: state.final_response_policy,
      };
    }
    recordEvent(runDir, state, "run_completed", {
      executed_tasks: launchedThisRun,
      outcome: state.outcome.status,
    });
  };

  const launchTask = (task) => {
    const executorKind = resolveExecutorKind(task.kind);
    const isSubagent = executorKind === "codex" || executorKind === "claude";
    // The prompt template is rendered before any attempt state exists: local
    // attempts never consume the prompt, and for subagents a render failure is
    // a contract violation (templates are statically validated at plan time),
    // so the task fails permanently without spawning a worker.
    let renderedPrompt = null;
    if (isSubagent) {
      try {
        const gateFeedback = collectGateFeedback(runDir, state, task);
        renderedPrompt = renderTaskPrompt(runDir, workflow, state, task, {
          gateFeedback,
          // Foreach children carry their resolved item (spec §6.2) so
          // {{item}}/{{item.<path>}} render through the template context.
          ...(Object.hasOwn(task, "item") ? { item: task.item } : {}),
        });
        if (
          gateFeedback !== "" &&
          !listRefs(task.prompt_template).some((ref) => ref.ns === "gate_feedback")
        ) {
          // Spec §4.4: templates without a {{gate_feedback}} placeholder get
          // the retry feedback appended as a clearly delimited standard block.
          renderedPrompt = [
            renderedPrompt,
            "",
            "--- previous gate failure ---",
            gateFeedback,
            "--- end of previous gate failure ---",
          ].join("\n");
        }
      } catch (error) {
        if (!(error instanceof TemplateRenderError) && !(error instanceof TemplateSyntaxError)) {
          throw error;
        }
        retryAt.delete(task.task_id);
        templateFailures.add(task.task_id);
        recordEvent(runDir, state, "template_resolution_failed", {
          task_id: task.task_id,
          message: error.message,
        });
        setTaskStatus(runDir, state, task.task_id, "failed", {
          reason: "template_resolution_failed",
          error: error.message,
        });
        settledQueue.push(task.task_id);
        return;
      }
    }
    const phaseState = state.phases[task.phase_id];
    if (phaseState.status === "waiting" || phaseState.status === "ready") {
      setPhaseStatus(runDir, state, task.phase_id, "running");
    }
    retryAt.delete(task.task_id);
    const attemptNumber = state.tasks[task.task_id].attempts.length + 1;
    const attemptId = `${task.task_id}-a${attemptNumber}-${crypto.randomUUID().slice(0, 8)}`;
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
        ? () => runCodexAttempt(runDir, workflow, state, task, renderedPrompt, attemptId, attemptDir, handle, startedAt, runContext)
        : executorKind === "claude"
          ? () => runClaudeAttempt(runDir, workflow, state, task, renderedPrompt, attemptId, attemptDir, handle, startedAt, runContext)
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
    // Resume safety: a routing task can be persisted as succeeded before its
    // resolution was applied (crash between the result fold and the route
    // fold). Re-applying here is idempotent; route_resolved marks resolutions
    // already consumed in a previous orchestrator life.
    let pendingResolutions = false;
    for (const task of workflow.tasks) {
      const taskState = state.tasks[task.task_id];
      if (isPlainObject(task.route) && taskState.status === "succeeded" && taskState.route_resolved !== true) {
        resolveRoute(task.task_id);
        pendingResolutions = true;
      }
    }
    if (pendingResolutions) {
      propagateSkips();
    }
    // Resume safety (spec §6.2): a foreach parent persisted as "expanded"
    // whose children all reached a terminal status before the crash is folded
    // now, mirroring the route re-application above. foldExpandedParent is a
    // noop while any child is still pending.
    for (const task of workflow.tasks) {
      if (isPlainObject(task.foreach) && state.tasks[task.task_id]?.status === "expanded") {
        if (foldExpandedParent(task.task_id) === "fail_run") {
          await failClosed("Phase failed.", { phase_id: task.phase_id, task_id: task.task_id });
          return;
        }
      }
    }

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

      const ready = scheduledTasks().filter((task) => taskIsReady(task));
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

      let expandedThisPass = false;
      while (
        ready.length > 0 &&
        inFlight.size < workflow.max_concurrency &&
        (maxTasks == null || launchedThisRun < maxTasks)
      ) {
        const launchableIndex = ready.findIndex((task) => !foreachChildBlocked(task));
        if (launchableIndex === -1) {
          // Every ready task is a child held back by its parent's foreach
          // concurrency; an in-flight sibling settling frees the next slot.
          break;
        }
        const [task] = ready.splice(launchableIndex, 1);
        if (isPlainObject(task.foreach)) {
          // Expansion replaces the worker launch and consumes no attempt
          // (spec §6.2); the children join the ready set on the next pass.
          expandForeachTask(task);
          expandedThisPass = true;
          continue;
        }
        if (Object.keys(state.attempts).length >= workflow.max_agents) {
          await failClosed("Budget exceeded: max_agents.", {
            stop_condition: "budget_exceeded",
            budget: "max_agents",
            limit: workflow.max_agents,
          });
          return;
        }
        launchTask(task);
      }
      if (expandedThisPass) {
        // The ready set was computed before the expansion; recompute so the
        // run is never finalized while fresh children sit queued.
        continue;
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

async function runCodexAttempt(runDir, workflow, state, task, renderedPrompt, attemptId, attemptDir, handle, runStartedAt, runContext) {
  // The schema file is per attempt: each task gets its own synthesized worker
  // schema (default or typed form), written after the argv guard passes.
  const schemaPath = path.join(attemptDir, WORKER_SCHEMA_FILE);
  const lastMessagePath = path.join(attemptDir, "last-message.txt");
  const workerEventsPath = path.join(attemptDir, "codex-events.jsonl");
  const remainingMs = workflow.max_duration_ms - (Date.now() - runStartedAt);
  const timeoutMs = Math.max(Math.min(task.timeout_ms ?? Infinity, remainingMs), 1000);
  const bin = resolveCodexBin();
  const args = buildCodexExecArgs({ workflow, task, lastMessagePath, schemaPath });
  writeJson(schemaPath, synthesizeWorkerSchema(task));
  const inputPaths = resolveTaskInputs(runDir, workflow, state, task);
  const prompt = buildWorkerPrompt({ workflow, task, runDir, inputPaths, instructions: renderedPrompt });

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
  // Runner-injected identity wins: a worker emitting its own task_id or
  // attempt_id must not be able to spoof the persisted result identity.
  const result = workerOutput == null
    ? null
    : { ...workerOutput, task_id: task.task_id, attempt_id: attemptId };
  const resultErrors = result == null ? ["worker output was not valid JSON"] : validateWorkerResult(result, task);
  const resultPath = resolveRunArtifactPath(runDir, task.task_id, "result.json");

  if (resultErrors.length > 0) {
    quarantineWorkerOutput(runDir, state, task, attemptId, attemptDir, attempt, rawMessage, resultErrors);
    return;
  }

  writeJson(resultPath, result);
  state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
  if (isPlainObject(task.route)) {
    // Persisted alongside the accepted result so route resolution (which runs
    // at fold time, after gates) and resume agree on the value (spec §5.1).
    state.tasks[task.task_id].route_value = result.route;
  }
  if (!state.artifacts.includes(toRunRelative(runDir, resultPath))) {
    state.artifacts.push(toRunRelative(runDir, resultPath));
  }
  for (const artifact of result.artifacts ?? []) {
    if (!state.artifacts.includes(artifact)) {
      state.artifacts.push(artifact);
    }
  }
  recordEvent(runDir, state, "result_submitted", {
    task_id: task.task_id,
    attempt_id: attemptId,
    schema_version: SCHEMA_VERSION,
    result_path: toRunRelative(runDir, resultPath),
    artifact_manifest: result.artifacts ?? [],
    token_usage: outcome.usage,
    thread_id: outcome.threadId,
  });
  if (result.status !== "succeeded") {
    finishAttempt(result.status, "failed", { reason: "worker_reported_failure" });
    return;
  }
  if (Array.isArray(task.gates) && task.gates.length > 0) {
    await runGatePhase(runDir, workflow, state, task, attemptId, attemptDir, handle, runStartedAt, runContext, finishAttempt);
    return;
  }
  finishAttempt("succeeded", "succeeded", { reason: "completed" });
}

async function runClaudeAttempt(runDir, workflow, state, task, renderedPrompt, attemptId, attemptDir, handle, runStartedAt, runContext) {
  const settingsPath = path.join(runDir, CLAUDE_SETTINGS_FILE);
  const workerEventsPath = path.join(attemptDir, "claude-events.jsonl");
  const remainingMs = workflow.max_duration_ms - (Date.now() - runStartedAt);
  const timeoutMs = Math.max(Math.min(task.timeout_ms ?? Infinity, remainingMs), 1000);
  const bin = resolveClaudeBin();
  const args = buildClaudeExecArgs({ workflow, task, settingsPath, workerSchema: synthesizeWorkerSchema(task) });
  if (!fs.existsSync(settingsPath)) {
    writeJson(settingsPath, buildClaudeSandboxSettings({ workflow }));
  }
  const inputPaths = resolveTaskInputs(runDir, workflow, state, task);
  const prompt = buildWorkerPrompt({ workflow, task, runDir, inputPaths, instructions: renderedPrompt });

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
        const model = typeof event.model === "string" && event.model.trim() !== "" ? event.model : null;
        attempt.thread_id = event.session_id;
        if (model) {
          attempt.models_used = [model];
        }
        recordEvent(runDir, state, "worker_thread_started", {
          task_id: task.task_id,
          attempt_id: attemptId,
          thread_id: event.session_id,
          ...(model ? { model } : {}),
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
        const modelsUsed = sortedModelUsageKeys(event.modelUsage);
        if (modelsUsed.length > 0) {
          attempt.models_used = modelsUsed;
        }
        recordEvent(runDir, state, "progress", {
          task_id: task.task_id,
          attempt_id: attemptId,
          token_usage: usage,
          ...(modelsUsed.length > 0 ? { models_used: modelsUsed } : {}),
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
  // Runner-injected identity wins: a worker emitting its own task_id or
  // attempt_id must not be able to spoof the persisted result identity.
  const result = workerOutput == null
    ? null
    : { ...workerOutput, task_id: task.task_id, attempt_id: attemptId };
  // The CLI-side --json-schema enforcement is not trusted on its own; the
  // worker output goes through the same validation as codex (defense in depth).
  const resultErrors = result == null ? ["worker output was not valid JSON"] : validateWorkerResult(result, task);
  const resultPath = resolveRunArtifactPath(runDir, task.task_id, "result.json");

  if (resultErrors.length > 0) {
    quarantineWorkerOutput(runDir, state, task, attemptId, attemptDir, attempt, rawMessage, resultErrors);
    return;
  }

  writeJson(resultPath, result);
  state.tasks[task.task_id].result_path = toRunRelative(runDir, resultPath);
  if (isPlainObject(task.route)) {
    // Persisted alongside the accepted result so route resolution (which runs
    // at fold time, after gates) and resume agree on the value (spec §5.1).
    state.tasks[task.task_id].route_value = result.route;
  }
  if (!state.artifacts.includes(toRunRelative(runDir, resultPath))) {
    state.artifacts.push(toRunRelative(runDir, resultPath));
  }
  for (const artifact of result.artifacts ?? []) {
    if (!state.artifacts.includes(artifact)) {
      state.artifacts.push(artifact);
    }
  }
  recordEvent(runDir, state, "result_submitted", {
    task_id: task.task_id,
    attempt_id: attemptId,
    schema_version: SCHEMA_VERSION,
    result_path: toRunRelative(runDir, resultPath),
    artifact_manifest: result.artifacts ?? [],
    token_usage: outcome.usage,
    thread_id: outcome.threadId,
  });
  if (result.status !== "succeeded") {
    finishAttempt(result.status, "failed", { reason: "worker_reported_failure" });
    return;
  }
  if (Array.isArray(task.gates) && task.gates.length > 0) {
    await runGatePhase(runDir, workflow, state, task, attemptId, attemptDir, handle, runStartedAt, runContext, finishAttempt);
    return;
  }
  finishAttempt("succeeded", "succeeded", { reason: "completed" });
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
  const resultErrors = validateWorkerResult(result, task);
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

// --- Gate phase (spec §4.2-§4.4) ---------------------------------------------

// Runs after the worker result was accepted (schema-validated, result.json
// written) and the task would otherwise fold to succeeded. The task stays
// in-flight, so the concurrency slot is held and gate wall time naturally
// counts against max_duration_ms; gates consume no tokens and no attempt.
// The task's cancel handle is repointed at the gate runner so abortInFlight
// kills an in-flight gate process group together with the run.
async function runGatePhase(runDir, workflow, state, task, attemptId, attemptDir, handle, runStartedAt, runContext, finishAttempt) {
  if (runContext.aborting) {
    // The orchestrator is tearing the run down; abortInFlight folds this
    // attempt, and starting gates now would leave them running unkillable.
    return;
  }
  const remainingMs = workflow.max_duration_ms - (Date.now() - runStartedAt);
  const gateHandle = {};
  handle.cancel = () => gateHandle.cancel?.();
  const { passed, verdicts, cancelled } = await runGates({
    gates: task.gates,
    cwd: workflow.workspace_policy.workspace_root,
    env: buildGateEnv(process.env),
    remainingMs,
    attemptDir,
    attemptId,
    handle: gateHandle,
    onEvent: (type, payload) => {
      if (runContext.sealed) {
        return;
      }
      recordEvent(runDir, state, type, {
        task_id: task.task_id,
        attempt_id: attemptId,
        ...payload,
      });
    },
  });
  if (runContext.sealed) {
    return;
  }
  if (passed) {
    finishAttempt("succeeded", "succeeded", { reason: "completed" });
    return;
  }
  if (cancelled) {
    finishAttempt("cancelled", "cancelled", { reason: "cancelled" });
    return;
  }
  const failedGate = verdicts.find((verdict) => verdict.exit_code !== 0 || verdict.timed_out);
  finishAttempt("gate_failed", "gate_failed", {
    reason: failedGate?.timed_out ? "gate_timed_out" : "gate_failed",
    gate_index: failedGate?.index ?? null,
    gate_exit_code: failedGate?.exit_code ?? null,
    gate_timed_out: failedGate?.timed_out ?? false,
  });
}

// Resume-safe gate feedback (spec §4.4): the most recent prior attempt whose
// artifact directory holds a failing gate-verdict.json provides the feedback
// text for the retry prompt. Everything is read back from disk via the
// artifact_dir recorded in run state, so feedback survives resume. First
// attempts (and tasks without gates) render with "".
function collectGateFeedback(runDir, state, task) {
  if (!Array.isArray(task.gates) || task.gates.length === 0) {
    return "";
  }
  const attemptIds = state.tasks[task.task_id].attempts;
  for (let index = attemptIds.length - 1; index >= 0; index -= 1) {
    const artifactDir = state.attempts[attemptIds[index]]?.artifact_dir;
    if (typeof artifactDir !== "string" || artifactDir === "") {
      continue;
    }
    const attemptDir = path.join(runDir, artifactDir);
    let verdictDocument;
    try {
      verdictDocument = readJson(path.join(attemptDir, "gate-verdict.json"));
    } catch {
      // Attempts that never reached the gate phase leave no verdict behind.
      continue;
    }
    if (verdictDocument?.passed === false) {
      return formatGateFeedback(verdictDocument.gates ?? [], attemptDir, {
        tailBytes: task.gate_feedback_tail_bytes ?? 4096,
      });
    }
  }
  return "";
}

// All task ids listed in a route's cases/default (F4). The shape was already
// strictly validated at plan time; runs only execute validated specs.
function routeCaseTasks(route) {
  const ids = new Set();
  for (const list of [...Object.values(isPlainObject(route.cases) ? route.cases : {}), route.default]) {
    for (const caseTaskId of list) {
      ids.add(caseTaskId);
    }
  }
  return ids;
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

// --- Prompt template rendering (spec §3.4) -----------------------------------

// Builds the render context for a task's prompt_template. Only the producer
// results the template actually references are loaded (via listRefs), using
// the result_path recorded in run state; readiness guarantees the referenced
// producers completed before the consumer launches. Later features extend the
// context through extras (item for foreach, gateFeedback for gate retries).
export function buildTemplateContext(runDir, workflow, state, task, extras = {}) {
  const tasks = {};
  for (const ref of listRefs(task.prompt_template)) {
    if (ref.ns !== "tasks" || Object.hasOwn(tasks, ref.taskId)) {
      continue;
    }
    const resultPath = state.tasks[ref.taskId]?.result_path;
    if (typeof resultPath !== "string" || resultPath === "") {
      throw new TemplateRenderError(
        `Template references tasks.${ref.taskId} but task ${ref.taskId} has no recorded result (contract violation).`,
        { ref },
      );
    }
    try {
      tasks[ref.taskId] = readJson(path.join(runDir, resultPath));
    } catch (error) {
      throw new TemplateRenderError(
        `Template references tasks.${ref.taskId} but its result could not be read: ${error.message}`,
        { ref },
      );
    }
  }
  return {
    objective: workflow.objective,
    tasks,
    gate_feedback: extras.gateFeedback ?? "",
    ...(extras.item !== undefined ? { item: extras.item } : {}),
  };
}

export function renderTaskPrompt(runDir, workflow, state, task, extras = {}) {
  return renderTemplate(task.prompt_template, buildTemplateContext(runDir, workflow, state, task, extras));
}

function sortedModelUsageKeys(modelUsage) {
  if (!isPlainObject(modelUsage)) {
    return [];
  }
  return [...new Set(Object.keys(modelUsage).filter((key) => key.trim() !== ""))].sort();
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
