import path from "node:path";
import {
  CLAUDE_EFFORT_LEVELS,
  EXECUTOR_FIELD_CONTRACT,
  MODEL_VALUE_PATTERN,
  MODEL_VALUE_PATTERN_SOURCE,
} from "./executor-contract.js";
import {
  GOAL_STATUS_EFFECTS,
  PARTIAL_RESULT_POLICIES,
  RUN_ID_PATTERN,
  SCHEMA_VERSION,
  SPEC_ID_PATTERN,
  SPEC_ID_PATTERN_DESCRIPTION,
  WorkflowError,
} from "./constants.js";
import { detectCycle, isPlainObject, normalizeObjective, resolveExecutorKind } from "./util.js";
import { synthesizeWorkerSchema, validateOutputSchemaDecl } from "./output-schema.js";
import { TemplateSyntaxError, listRefs, parseTemplate } from "./template.js";

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
    on_failure: phase.on_failure ?? "fail",
    outputs: phase.outputs ?? [],
    // Removed v1 field is passed through so strict validation can reject it
    // with an explicit error instead of silently dropping it.
    ...(phase.verification_required !== undefined ? { verification_required: phase.verification_required } : {}),
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
        depends_on: task.depends_on ?? [],
        condition: task.condition ?? ((task.depends_on ?? []).length === 0 ? "always" : "dependencies_succeeded"),
        retry_policy: retryPolicy,
        stop_condition: task.stop_condition ?? "budget_or_cancelled",
        outputs: task.outputs ?? ["result.json"],
        ...(task.output_schema != null ? { output_schema: normalizedOutputSchema(task.output_schema) } : {}),
        ...(task.gates !== undefined ? { gates: task.gates } : {}),
        ...(task.route !== undefined ? { route: task.route } : {}),
        ...(task.foreach !== undefined ? { foreach: task.foreach } : {}),
        ...(task.gate_feedback_tail_bytes !== undefined
          ? { gate_feedback_tail_bytes: task.gate_feedback_tail_bytes }
          : {}),
        ...(task.timeout_ms != null ? { timeout_ms: task.timeout_ms } : {}),
        ...(task.model != null ? { model: task.model } : {}),
        ...(task.effort != null ? { effort: task.effort } : {}),
        ...(task.profile != null ? { profile: task.profile } : {}),
        // Removed v1 fields are passed through so strict validation can reject
        // them with explicit per-field errors instead of silently dropping them.
        ...(task.fanout_source !== undefined ? { fanout_source: task.fanout_source } : {}),
        ...(task.expected_output_schema !== undefined ? { expected_output_schema: task.expected_output_schema } : {}),
        ...(task.verification_required !== undefined ? { verification_required: task.verification_required } : {}),
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
    stop_conditions: spec.stop_conditions ?? ["budget_exceeded", "user_cancelled", "schema_violation"],
    ...(spec.verification_policy !== undefined ? { verification_policy: spec.verification_policy } : {}),
  };
}

function normalizedOutputSchema(schema) {
  const { errors, normalized } = validateOutputSchemaDecl(schema);
  // Invalid declarations are kept verbatim so validateWorkflowSpec reports
  // the precise per-keyword errors against the authored schema.
  return errors.length === 0 ? normalized : schema;
}

// --- Validation ------------------------------------------------------------

export function validateWorkflowSpec(workflow) {
  const errors = [];
  requireString(workflow, "schema_version", errors);
  if (typeof workflow?.schema_version === "string" && workflow.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `unsupported schema_version: ${workflow.schema_version} (expected ${SCHEMA_VERSION}); re-plan required`,
    );
  }
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
  // Fail-closed: the claude sandbox has no enforceable allow-all network
  // mechanism, so network: true would diverge from what the executor can
  // actually enforce.
  const hasClaudeTask = (Array.isArray(workflow.tasks) ? workflow.tasks : []).some(
    (task) => resolveExecutorKind(task?.kind) === "claude",
  );
  if (hasClaudeTask && isPlainObject(workflow.workspace_policy) && workflow.workspace_policy.network === true) {
    errors.push(
      "workspace_policy.network: true is not supported for claude tasks (no enforceable allow-all network sandbox)",
    );
  }
  // Fail-closed (design D6): opencode has no OS-level sandbox, so the acp
  // executor cannot enforce any network guarantee either way; network: true
  // would promise an allow-all sandbox that does not exist.
  const hasAcpTask = (Array.isArray(workflow.tasks) ? workflow.tasks : []).some(
    (task) => resolveExecutorKind(task?.kind) === "acp",
  );
  if (hasAcpTask && isPlainObject(workflow.workspace_policy) && workflow.workspace_policy.network === true) {
    errors.push(
      "workspace_policy.network: true is not supported for acp tasks (no enforceable network sandbox)",
    );
  }
  if (workflow?.verification_policy !== undefined) {
    errors.push("workflow.verification_policy was removed in schema v2; express verification with task gates");
  }
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
    if (phase.verification_required !== undefined) {
      errors.push(`phase ${phase.phase_id} verification_required was removed in schema v2; express verification with task gates`);
    }
  }
  for (const task of workflow.tasks ?? []) {
    requireString(task, "task_id", errors, "task");
    validateSpecId(task.task_id, "task.task_id", errors);
    requireString(task, "phase_id", errors, `task:${task.task_id}`);
    validateSpecId(task.phase_id, `task ${task.task_id} phase_id`, errors);
    requireString(task, "kind", errors, `task:${task.task_id}`);
    // Design D1: the acp executor kind reserves the whole "acp" prefix, but
    // only acp_opencode is a verified agent; every other acp* kind is
    // rejected fail-closed instead of falling through to a worker launch.
    if (resolveExecutorKind(task.kind) === "acp" && task.kind !== "acp_opencode") {
      errors.push(`task ${task.task_id}: Unsupported acp kind: ${task.kind}. Supported: acp_opencode`);
    }
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
    if (task.fanout_source !== undefined) {
      errors.push(`task ${task.task_id} fanout_source was removed in schema v2; expand fan-out at plan time`);
    }
    if (task.expected_output_schema !== undefined) {
      errors.push(`task ${task.task_id} expected_output_schema was removed in schema v2; declare a typed output_schema instead`);
    }
    if (task.verification_required !== undefined) {
      errors.push(`task ${task.task_id} verification_required was removed in schema v2; express verification with task gates`);
    }
    if (task.output_schema !== undefined) {
      const outputSchemaKind = resolveExecutorKind(task.kind);
      if (outputSchemaKind === "local") {
        errors.push(`task ${task.task_id} output_schema is not supported for local tasks`);
      }
      // Design R4/D4: ACP v1 has no schema-constrained final output, so typed
      // output_schema cannot be CLI-enforced for acp tasks.
      if (outputSchemaKind === "acp") {
        errors.push(`task ${task.task_id} output_schema is not supported for acp tasks`);
      }
      for (const message of validateOutputSchemaDecl(task.output_schema).errors) {
        errors.push(`task ${task.task_id} ${message}`);
      }
    }
    validateTaskGates(task, errors);
    validateTaskRoute(task, errors);
    validateTaskForeach(task, errors);
    validateInputSource(task, errors);
    validateTaskExecutorFields(task, errors);
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
  validateRouteTopology(workflow, taskIds, errors);
  const foreachItemSchemas = validateForeachTopology(workflow, errors);
  validateTaskTemplates(workflow, errors, foreachItemSchemas);
  return errors;
}

// --- Default template ------------------------------------------------------

export function buildDefaultWorkflowSpec({ objective, workspace, runId, workflowId, createdAt }) {
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
        depends_on: [],
        condition: "always",
        retry_policy: retryPolicy,
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
        depends_on: ["explore-objective"],
        condition: "dependencies_succeeded",
        retry_policy: retryPolicy,
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
        depends_on: ["verify-findings"],
        condition: "dependencies_succeeded",
        retry_policy: retryPolicy,
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
    stop_conditions: ["budget_exceeded", "user_cancelled", "schema_violation"],
  };
}

// --- Validation helpers ------------------------------------------------------

function validateSpecId(value, label, errors) {
  if (typeof value !== "string" || !SPEC_ID_PATTERN.test(value)) {
    errors.push(`${label} must match ${SPEC_ID_PATTERN_DESCRIPTION}`);
  }
}

function validateTaskExecutorFields(task, errors) {
  const executorKind = resolveExecutorKind(task.kind);
  // Design D5-r2: without an explicit model the ACP session silently falls
  // back to the ambient default in opencode's data dir, breaking determinism,
  // so acp tasks must pin one (the executor enforces it via session/set_model).
  if (
    executorKind === "acp" &&
    (task.model == null || (typeof task.model === "string" && task.model.trim() === ""))
  ) {
    errors.push(
      `task ${task.task_id} acp tasks require model (ACP model id, e.g. "openrouter/anthropic/claude-haiku-4.5")`,
    );
  }
  validateExecutorStringField(task, "model", executorKind, errors);
  validateExecutorStringField(task, "profile", executorKind, errors);
  validateExecutorEffortField(task, executorKind, errors);
}

function validateExecutorStringField(task, field, executorKind, errors) {
  const value = task[field];
  if (value == null) {
    return;
  }
  if (EXECUTOR_FIELD_CONTRACT[field]?.[executorKind] !== true) {
    errors.push(`task ${task.task_id} ${field} is not supported for ${executorKind} tasks`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`task ${task.task_id} ${field} must be a non-empty string`);
    return;
  }
  if (!MODEL_VALUE_PATTERN.test(value)) {
    errors.push(`task ${task.task_id} ${field} must match ${MODEL_VALUE_PATTERN_SOURCE}`);
  }
}

function validateExecutorEffortField(task, executorKind, errors) {
  const value = task.effort;
  if (value == null) {
    return;
  }
  if (EXECUTOR_FIELD_CONTRACT.effort?.[executorKind] !== true) {
    const guidance = executorKind === "codex" ? " (set model_reasoning_effort via a codex profile instead)" : "";
    errors.push(`task ${task.task_id} effort is not supported for ${executorKind} tasks${guidance}`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`task ${task.task_id} effort must be a non-empty string`);
    return;
  }
  if (!CLAUDE_EFFORT_LEVELS.includes(value)) {
    errors.push(`task ${task.task_id} effort must be one of: ${CLAUDE_EFFORT_LEVELS.join(", ")}`);
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

// --- Gate validation (spec §4.1 / §4.4) ----------------------------------------

const GATE_ENTRY_KEYS = new Set(["command", "timeout_ms"]);
const GATE_COMMAND_ARG_MAX_LENGTH = 512;
const MAX_GATE_FEEDBACK_TAIL_BYTES = 16384;

// Argv-safety for gate commands. Gate argv elements are execve arguments, not
// values the runner interpolates into a CLI flag position (unlike model/
// profile), so the constraints diverge deliberately from
// validateExecutorStringField: spaces are allowed (real argv elements such as
// `node -e <script>` bodies contain them), and a leading "-" is allowed for
// every element except command[0] (gate commands legitimately pass flags like
// "--coverage", but the executable itself must never look like a flag).
// Control characters are forbidden everywhere and each element is capped at
// 512 characters, matching the executor-field limits.
function validateGateCommandArg(value, index, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (index === 0 && value.startsWith("-")) {
    errors.push(`${label} (the gate executable) must not start with "-"`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    errors.push(`${label} must not contain control characters`);
  }
  if (value.length > GATE_COMMAND_ARG_MAX_LENGTH) {
    errors.push(`${label} must be at most ${GATE_COMMAND_ARG_MAX_LENGTH} characters`);
  }
}

function validateTaskGates(task, errors) {
  const prefix = `task ${task.task_id}`;
  if (task.gate_feedback_tail_bytes !== undefined) {
    if (task.gates === undefined) {
      errors.push(`${prefix} gate_feedback_tail_bytes requires gates`);
    }
    if (
      !Number.isInteger(task.gate_feedback_tail_bytes) ||
      task.gate_feedback_tail_bytes < 1 ||
      task.gate_feedback_tail_bytes > MAX_GATE_FEEDBACK_TAIL_BYTES
    ) {
      errors.push(
        `${prefix} gate_feedback_tail_bytes must be a positive integer of at most ${MAX_GATE_FEEDBACK_TAIL_BYTES}`,
      );
    }
  }
  if (task.gates === undefined) {
    return;
  }
  if (resolveExecutorKind(task.kind) === "local") {
    errors.push(`${prefix} gates is not supported for local tasks`);
  }
  if (!Array.isArray(task.gates) || task.gates.length === 0) {
    errors.push(`${prefix} gates must be a non-empty array`);
    return;
  }
  for (const [gateIndex, gate] of task.gates.entries()) {
    const gateLabel = `${prefix} gates[${gateIndex}]`;
    if (!isPlainObject(gate)) {
      errors.push(`${gateLabel} must be an object with command and timeout_ms`);
      continue;
    }
    for (const key of Object.keys(gate)) {
      if (!GATE_ENTRY_KEYS.has(key)) {
        errors.push(`${gateLabel} has unsupported key: ${key}`);
      }
    }
    if (!Array.isArray(gate.command) || gate.command.length === 0) {
      errors.push(`${gateLabel}.command must be a non-empty argv array`);
    } else {
      for (const [argIndex, value] of gate.command.entries()) {
        validateGateCommandArg(value, argIndex, `${gateLabel}.command[${argIndex}]`, errors);
      }
    }
    if (!Number.isInteger(gate.timeout_ms) || gate.timeout_ms < 1) {
      errors.push(`${gateLabel}.timeout_ms must be a positive integer`);
    }
  }
}

// --- Route validation (spec §5.3, F4) ------------------------------------------

const ROUTE_ENTRY_KEYS = new Set(["values", "cases", "default"]);
const MIN_ROUTE_VALUES = 2;
// Aligned with the output_schema enum limits (spec §2.1): route.values becomes
// a string enum on the worker envelope's `route` property.
const MAX_ROUTE_VALUES = 20;
const MAX_ROUTE_VALUE_LENGTH = 64;

// Per-task shape checks: V1 (cases keys subset of values, default required),
// V6 (every listed case task must appear in at least one reachable
// resolution), and the V5 declaration-level rules. Cross-task rules (V2-V4)
// live in validateRouteTopology; V7 lives in the template validation.
function validateTaskRoute(task, errors) {
  if (task.route === undefined) {
    return;
  }
  const prefix = `task ${task.task_id}`;
  const routeKind = resolveExecutorKind(task.kind);
  if (routeKind === "local") {
    errors.push(`${prefix} route is not supported for local tasks`);
  }
  // Design D4: route resolution rides on the typed worker envelope's route
  // enum, which acp tasks cannot have (output_schema is rejected).
  if (routeKind === "acp") {
    errors.push(`${prefix} route is not supported for acp tasks`);
  }
  // V5: route and foreach are mutually exclusive (forward-compatible check;
  // foreach lands with F6).
  if (isPlainObject(task.foreach)) {
    errors.push(`${prefix} cannot declare both route and foreach`);
  }
  if (!isPlainObject(task.route)) {
    errors.push(`${prefix} route must be an object with values, cases, and default`);
    return;
  }
  for (const key of Object.keys(task.route)) {
    if (!ROUTE_ENTRY_KEYS.has(key)) {
      errors.push(`${prefix} route has unsupported key: ${key}`);
    }
  }
  const values = task.route.values;
  let knownValues = new Set();
  if (!Array.isArray(values) || values.length < MIN_ROUTE_VALUES) {
    errors.push(`${prefix} route.values must be an array of at least ${MIN_ROUTE_VALUES} strings`);
  } else {
    if (values.length > MAX_ROUTE_VALUES) {
      errors.push(`${prefix} route.values has ${values.length} values; limit is ${MAX_ROUTE_VALUES}`);
    }
    for (const value of values) {
      if (typeof value !== "string" || value === "") {
        errors.push(`${prefix} route.values entries must be non-empty strings`);
        break;
      }
      if (value.length > MAX_ROUTE_VALUE_LENGTH) {
        errors.push(`${prefix} route.values entries must be at most ${MAX_ROUTE_VALUE_LENGTH} characters`);
        break;
      }
    }
    if (new Set(values).size !== values.length) {
      errors.push(`${prefix} route.values must be distinct`);
    }
    knownValues = new Set(values.filter((value) => typeof value === "string"));
  }
  if (!isPlainObject(task.route.cases)) {
    errors.push(`${prefix} route.cases must be an object mapping route values to task id arrays`);
  } else {
    for (const [value, caseTasks] of Object.entries(task.route.cases)) {
      if (!knownValues.has(value)) {
        errors.push(`${prefix} route.cases key "${value}" is not in route.values`);
      }
      validateRouteTaskList(task, `route.cases.${value}`, caseTasks, errors);
    }
  }
  if (task.route.default === undefined) {
    errors.push(`${prefix} route.default is required`);
  } else {
    validateRouteTaskList(task, "route.default", task.route.default, errors);
  }
  validateRouteReachability(task, knownValues, errors);
}

// V6 (unreachable case tasks): at runtime a route resolving to value v
// activates cases[v] when v has an explicit case, otherwise default. The
// reachable resolutions are therefore { cases[v] : v in values } plus default
// only when at least one value lacks an explicit case. A task listed in
// cases/default but in no reachable resolution can never launch (e.g. a
// default-only task when every value has an explicit case) — reject it.
// Skipped when the route shape already errored; those messages stand in.
function validateRouteReachability(task, knownValues, errors) {
  const route = task.route;
  if (knownValues.size === 0 || !isPlainObject(route.cases) || !Array.isArray(route.default)) {
    return;
  }
  const reachable = [];
  for (const value of knownValues) {
    if (Object.hasOwn(route.cases, value) && Array.isArray(route.cases[value])) {
      reachable.push(new Set(route.cases[value]));
    }
  }
  const defaultReachable = [...knownValues].some((value) => !Object.hasOwn(route.cases, value));
  if (defaultReachable) {
    reachable.push(new Set(route.default));
  }
  for (const caseTaskId of collectRouteCaseTasks(route)) {
    if (!reachable.some((tasks) => tasks.has(caseTaskId))) {
      errors.push(
        `task ${task.task_id} route lists task ${caseTaskId} in no reachable resolution; route.default is only selected when some route value lacks an explicit case`,
      );
    }
  }
}

// Empty lists are allowed: a resolution may activate nothing.
function validateRouteTaskList(task, label, caseTasks, errors) {
  const prefix = `task ${task.task_id}`;
  if (!Array.isArray(caseTasks)) {
    errors.push(`${prefix} ${label} must be an array of task ids`);
    return;
  }
  for (const caseTaskId of caseTasks) {
    validateSpecId(caseTaskId, `${prefix} ${label} entry`, errors);
    // V5: the routing task must not list itself as a case task.
    if (caseTaskId === task.task_id) {
      errors.push(`${prefix} ${label} must not list the routing task itself`);
    }
  }
}

// All task ids listed anywhere in a route's cases/default ("case tasks").
// Tolerates malformed declarations: those already errored in validateTaskRoute.
function collectRouteCaseTasks(route) {
  const ids = new Set();
  if (!isPlainObject(route)) {
    return ids;
  }
  const lists = [
    ...(isPlainObject(route.cases) ? Object.values(route.cases) : []),
    ...(Array.isArray(route.default) ? [route.default] : []),
  ];
  for (const list of lists) {
    for (const caseTaskId of Array.isArray(list) ? list : []) {
      if (typeof caseTaskId === "string") {
        ids.add(caseTaskId);
      }
    }
  }
  return ids;
}

// case task id -> routing task ids listing it (V4 caps this at one).
function buildRouteIndex(tasks) {
  const index = new Map();
  for (const task of tasks) {
    if (task.route === undefined || typeof task.task_id !== "string") {
      continue;
    }
    for (const caseTaskId of collectRouteCaseTasks(task.route)) {
      if (!index.has(caseTaskId)) {
        index.set(caseTaskId, []);
      }
      index.get(caseTaskId).push(task.task_id);
    }
  }
  return index;
}

// Every reachable selection a route can produce: one entry per declared value,
// using cases[value] when an explicit case exists, otherwise falling back to
// default. A separate "default" resolution is NOT added — if every value has
// an explicit case the default list is unreachable, and including it
// unconditionally causes false V7 co-activation errors on provably-safe specs.
// This matches V6's reachability rule (validateRouteReachability): default is
// reachable only when at least one value lacks an explicit case, and in that
// situation it is already covered by the per-value loop above.
function routeResolutions(route) {
  if (!isPlainObject(route)) {
    return [];
  }
  const cases = isPlainObject(route.cases) ? route.cases : {};
  const defaultTasks = Array.isArray(route.default) ? route.default : [];
  const resolutions = [];
  for (const value of Array.isArray(route.values) ? route.values : []) {
    if (typeof value !== "string") {
      continue;
    }
    const selected = Object.hasOwn(cases, value) && Array.isArray(cases[value]) ? cases[value] : defaultTasks;
    resolutions.push({ label: value, tasks: new Set(selected.filter((id) => typeof id === "string")) });
  }
  return resolutions;
}

// Cross-task route rules (spec §5.3 V2-V4).
function validateRouteTopology(workflow, taskIds, errors) {
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks : [];
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const closures = new Map();
  const routeIndex = buildRouteIndex(tasks);
  for (const task of tasks) {
    if (task.route === undefined) {
      continue;
    }
    for (const caseTaskId of collectRouteCaseTasks(task.route)) {
      if (!taskIds.has(caseTaskId)) {
        errors.push(`task ${task.task_id} route references missing task ${caseTaskId}`);
        continue;
      }
      // V2: a case task must include its routing task in the depends_on
      // transitive closure; that ordering is what prevents the case task from
      // launching before the route resolves.
      if (caseTaskId !== task.task_id && !dependencyClosure(caseTaskId, taskById, closures).has(task.task_id)) {
        errors.push(
          `task ${caseTaskId} is listed in task ${task.task_id} route but does not include ${task.task_id} in its depends_on transitive closure`,
        );
      }
    }
  }
  // V4: a task may be a case task of at most one routing task.
  for (const [caseTaskId, routingTaskIds] of routeIndex) {
    if (routingTaskIds.length > 1) {
      errors.push(
        `task ${caseTaskId} is listed in the route of more than one routing task (${routingTaskIds.join(", ")})`,
      );
    }
  }
  // V3: depending directly on a case task is reserved for case tasks of the
  // same route. A skipped_by_route case task still satisfies dependencies
  // (R2), so a dependency from outside the route would silently run on a
  // branch the spec author routed away from.
  for (const task of tasks) {
    const ownRoutes = routeIndex.get(task.task_id) ?? [];
    for (const depId of Array.isArray(task.depends_on) ? task.depends_on : []) {
      const depRoutes = routeIndex.get(depId);
      if (!depRoutes || depId === task.task_id) {
        continue;
      }
      if (!depRoutes.some((routingTaskId) => ownRoutes.includes(routingTaskId))) {
        errors.push(
          `task ${task.task_id} depends on case task ${depId} of routing task ${depRoutes.join(", ")}; only case tasks of the same route may depend on a case task`,
        );
      }
    }
  }
}

// --- Foreach validation (spec §6.1 / §6.4, F6) ---------------------------------

const FOREACH_ENTRY_KEYS = new Set(["items", "max_items", "concurrency", "tolerated_failure_count"]);

// Validation-only schema for one entry of a foreach parent's aggregate
// output.results array (spec §6.3). Referencing a foreach producer (whether
// from foreach.items or from a downstream template) resolves against this
// shape. The per-child output payload is producer-specific and null for
// children without an accepted typed result, so it stays an opaque nullable
// leaf that templates can neither path into nor reference directly.
const FOREACH_AGGREGATE_ITEM_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    index: { type: "integer" },
    task_id: { type: "string" },
    status: { type: "string" },
    output: { type: ["object", "null"] },
  },
});

// The only downstream reference a foreach parent supports is the whole
// aggregate array {{tasks.<parent>.result.output.results}} (spec §6.3).
function isAggregateResultsRefPath(refPath) {
  return refPath.length === 2 && refPath[0] === "output" && refPath[1] === "results";
}

// Spec §6.1: expanded child ids are `<foreachTaskId>.<index>` (0-based, no
// padding), so that id space is reserved at plan time.
function isForeachChildId(candidate, foreachTaskId) {
  return (
    candidate.length > foreachTaskId.length + 1 &&
    candidate.startsWith(`${foreachTaskId}.`) &&
    /^[0-9]+$/.test(candidate.slice(foreachTaskId.length + 1))
  );
}

// Per-task shape checks (spec §6.4 bounds). Cross-task rules (items reference
// resolution, child-id collisions, the max_agents budget) live in
// validateForeachTopology; route exclusivity is reported by validateTaskRoute.
function validateTaskForeach(task, errors) {
  if (task.foreach === undefined) {
    return;
  }
  const prefix = `task ${task.task_id}`;
  if (resolveExecutorKind(task.kind) === "local") {
    errors.push(`${prefix} foreach is not supported for local tasks`);
  }
  if (!isPlainObject(task.foreach)) {
    errors.push(`${prefix} foreach must be an object with items and max_items`);
    return;
  }
  for (const key of Object.keys(task.foreach)) {
    if (!FOREACH_ENTRY_KEYS.has(key)) {
      errors.push(`${prefix} foreach has unsupported key: ${key}`);
    }
  }
  if (typeof task.foreach.items !== "string" || task.foreach.items.trim() === "") {
    errors.push(`${prefix} foreach.items must be a non-empty string holding a single {{tasks.<id>.result.<dotpath>}} reference`);
  }
  if (!Number.isInteger(task.foreach.max_items) || task.foreach.max_items < 1) {
    errors.push(`${prefix} foreach.max_items must be a positive integer`);
  }
  if (
    task.foreach.concurrency !== undefined &&
    (!Number.isInteger(task.foreach.concurrency) || task.foreach.concurrency < 1)
  ) {
    errors.push(`${prefix} foreach.concurrency must be a positive integer`);
  }
  if (
    task.foreach.tolerated_failure_count !== undefined &&
    (!Number.isInteger(task.foreach.tolerated_failure_count) || task.foreach.tolerated_failure_count < 0)
  ) {
    errors.push(`${prefix} foreach.tolerated_failure_count must be a non-negative integer`);
  }
}

// Cross-task foreach rules (spec §6.1-§6.4): reserved child ids, the items
// reference (exactly one whole-field tasks ref, producer in the depends_on
// closure, V7 route co-activation, array-typed resolution), and the
// max_agents budget precondition.
// Returns task_id -> items element schema for {{item.<path>}} validation
// (null marks a foreach task whose items declaration already errored).
function validateForeachTopology(workflow, errors) {
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks : [];
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const closures = new Map();
  const routeIndex = buildRouteIndex(tasks);
  const itemSchemas = new Map();
  let expandedBudget = 0;
  let hasForeach = false;
  for (const task of tasks) {
    if (!isPlainObject(task.foreach) || typeof task.task_id !== "string") {
      continue;
    }
    hasForeach = true;
    if (Number.isInteger(task.foreach.max_items) && task.foreach.max_items > 0) {
      expandedBudget += task.foreach.max_items;
    }
    itemSchemas.set(task.task_id, null);
    for (const other of tasks) {
      if (other !== task && typeof other.task_id === "string" && isForeachChildId(other.task_id, task.task_id)) {
        errors.push(
          `task ${other.task_id} collides with the expanded child ids of foreach task ${task.task_id} (ids matching ${task.task_id}.<index> are reserved)`,
        );
      }
    }
    if (typeof task.foreach.items !== "string") {
      continue;
    }
    let segments;
    try {
      segments = parseTemplate(task.foreach.items);
    } catch (error) {
      if (!(error instanceof TemplateSyntaxError)) {
        throw error;
      }
      errors.push(`task ${task.task_id} foreach.items: ${error.message} (index ${error.index})`);
      continue;
    }
    if (segments.length !== 1 || segments[0].type !== "ref" || segments[0].ref.ns !== "tasks") {
      errors.push(
        `task ${task.task_id} foreach.items must be exactly one {{tasks.<id>.result.<dotpath>}} reference with no surrounding text`,
      );
      continue;
    }
    const ref = segments[0].ref;
    const label = `task ${task.task_id} foreach.items reference {{tasks.${ref.taskId}.result.${ref.path.join(".")}}}`;
    const producer = taskById.get(ref.taskId);
    if (!producer) {
      errors.push(`${label}: task ${ref.taskId} does not exist`);
      continue;
    }
    if (!dependencyClosure(task.task_id, taskById, closures).has(ref.taskId)) {
      errors.push(
        `${label}: task ${ref.taskId} is not in the depends_on transitive closure of task ${task.task_id}; references require an explicit dependency path`,
      );
      continue;
    }
    // Design D4: acp tasks reject output_schema, so they have no typed output
    // to drive an expansion — even the default-envelope arrays (e.g.
    // result.findings) are prompt-instructed only, never CLI-enforced.
    if (resolveExecutorKind(producer.kind) === "acp") {
      errors.push(
        `${label}: task ${ref.taskId} is an acp task; acp tasks have no typed output and cannot be a foreach items producer`,
      );
      continue;
    }
    // V7 also applies here: a route-skipped items producer would fail the
    // expansion at runtime (template_resolution_failed), so it is rejected at
    // plan time exactly like a prompt_template reference.
    validateRouteCoActivation(task.task_id, ref, label, taskById, routeIndex, errors);
    if (isPlainObject(producer.foreach)) {
      // Chaining off another foreach parent is allowed only through its
      // aggregate array (spec §6.3); its element shape is statically known.
      if (!isAggregateResultsRefPath(ref.path)) {
        errors.push(
          `${label}: task ${ref.taskId} declares foreach; only the aggregate {{tasks.${ref.taskId}.result.output.results}} may be referenced`,
        );
        continue;
      }
      itemSchemas.set(task.task_id, FOREACH_AGGREGATE_ITEM_SCHEMA);
      continue;
    }
    const node = walkSchemaPath(
      synthesizeWorkerSchema(producer, { includeIdentity: true }),
      ref.path,
      label,
      `task ${ref.taskId}'s worker result schema`,
      errors,
    );
    if (node == null) {
      continue;
    }
    if (!isPlainObject(node) || node.type !== "array" || Array.isArray(node.type)) {
      errors.push(
        `${label}: must resolve to an array-typed property in task ${ref.taskId}'s worker result schema (resolved type ${isPlainObject(node) ? JSON.stringify(node.type) : "unknown"})`,
      );
      continue;
    }
    itemSchemas.set(task.task_id, node.items ?? null);
  }
  // Budget necessary condition (spec §6.4): every expansion must fit the
  // max_agents attempt budget even before retries are considered.
  if (hasForeach && Number.isInteger(workflow.max_agents) && tasks.length + expandedBudget > workflow.max_agents) {
    errors.push(
      `foreach budget precondition failed: ${tasks.length} spec tasks + ${expandedBudget} max expanded children (sum of max_items) exceeds max_agents ${workflow.max_agents}`,
    );
  }
  return itemSchemas;
}

// --- Template validation (spec §3.2 / §3.3) ----------------------------------

// String locations where template syntax is forbidden outright (spec §3.2):
// expanding templates into these values would open an injection channel, so
// any "{{" occurrence is a plan-time error. Data-driven so later features add
// entries without touching the check itself; today only gates[].command argv
// entries exist (the gates field itself lands with F3).
const TEMPLATE_FORBIDDEN_STRING_SOURCES = [
  (task) =>
    (Array.isArray(task.gates) ? task.gates : []).flatMap((gate, gateIndex) =>
      (Array.isArray(gate?.command) ? gate.command : []).map((value, argIndex) => ({
        label: `gates[${gateIndex}].command[${argIndex}]`,
        value,
      })),
    ),
];

function validateTaskTemplates(workflow, errors, foreachItemSchemas = new Map()) {
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks : [];
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const closures = new Map();
  const routeIndex = buildRouteIndex(tasks);
  for (const task of tasks) {
    for (const source of TEMPLATE_FORBIDDEN_STRING_SOURCES) {
      for (const { label, value } of source(task)) {
        if (typeof value === "string" && value.includes("{{")) {
          errors.push(`task ${task.task_id} ${label} must not contain template syntax ("{{")`);
        }
      }
    }
    if (typeof task.prompt_template !== "string") {
      // Already reported by requireString.
      continue;
    }
    let refs;
    try {
      refs = listRefs(task.prompt_template);
    } catch (error) {
      if (!(error instanceof TemplateSyntaxError)) {
        throw error;
      }
      errors.push(`task ${task.task_id} prompt_template: ${error.message} (index ${error.index})`);
      continue;
    }
    for (const ref of refs) {
      validatePromptRef(task, ref, taskById, closures, routeIndex, foreachItemSchemas, errors);
    }
  }
}

function validatePromptRef(task, ref, taskById, closures, routeIndex, foreachItemSchemas, errors) {
  switch (ref.ns) {
    case "objective":
      return;
    case "inputs":
      // Saved-workflow inputs are expanded textually before validation (F5);
      // a leftover reference means the input was never declared/resolved.
      errors.push(
        `task ${task.task_id} prompt_template contains an unresolved input reference {{inputs.${ref.key}}}; workflow inputs are expanded before validation`,
      );
      return;
    case "gate_feedback":
      // Forward-compatible: passes automatically once the task declares gates (F3).
      if (!(Array.isArray(task.gates) && task.gates.length > 0)) {
        errors.push(
          `task ${task.task_id} prompt_template uses {{gate_feedback}} but the task declares no gates`,
        );
      }
      return;
    case "item":
      validateItemRef(task, ref, foreachItemSchemas, errors);
      return;
    case "tasks":
      validateTasksRef(task, ref, taskById, closures, routeIndex, errors);
      return;
    default:
      errors.push(`task ${task.task_id} prompt_template uses unknown template namespace "${ref.ns}"`);
  }
}

function validateTasksRef(task, ref, taskById, closures, routeIndex, errors) {
  const label = `task ${task.task_id} prompt_template reference {{tasks.${ref.taskId}.result.${ref.path.join(".")}}}`;
  const producer = taskById.get(ref.taskId);
  if (!producer) {
    errors.push(`${label}: task ${ref.taskId} does not exist`);
    return;
  }
  if (!dependencyClosure(task.task_id, taskById, closures).has(ref.taskId)) {
    errors.push(
      `${label}: task ${ref.taskId} is not in the depends_on transitive closure of task ${task.task_id}; references require an explicit dependency path`,
    );
    return;
  }
  validateRouteCoActivation(task.task_id, ref, label, taskById, routeIndex, errors);
  // F6 special case (spec §6.3): a foreach parent's result.json is the
  // runner-synthesized aggregate envelope, so the only stable downstream
  // reference is the whole results array.
  if (isPlainObject(producer.foreach)) {
    if (!isAggregateResultsRefPath(ref.path)) {
      errors.push(
        `${label}: task ${ref.taskId} declares foreach; only the aggregate {{tasks.${ref.taskId}.result.output.results}} may be referenced`,
      );
    }
    return;
  }
  // The dotpath starts after ".result." and resolves against the producer's
  // result.json, which is the identity-including worker envelope (the runner
  // injects task_id/attempt_id before validating and persisting it).
  const node = walkSchemaPath(
    synthesizeWorkerSchema(producer, { includeIdentity: true }),
    ref.path,
    label,
    `task ${ref.taskId}'s worker result schema`,
    errors,
  );
  if (node != null && isPlainObject(node) && Array.isArray(node.type)) {
    errors.push(
      `${label}: resolves to a nullable (${JSON.stringify(node.type)}) property; nullable properties cannot be referenced from templates`,
    );
  }
}

// V7 (route/template consistency): a producer that is a case task may be
// skipped_by_route, which would leave the consumer's reference unrenderable
// at launch time. The consumer must be a case task of the same route, and
// every resolution that activates the consumer must also activate the
// producer. Iterates all listing routes so a V4 violation still gets precise
// per-route messages. Shared by prompt_template refs (validateTasksRef) and
// foreach.items producer refs (validateForeachTopology).
function validateRouteCoActivation(consumerTaskId, ref, label, taskById, routeIndex, errors) {
  for (const routingTaskId of routeIndex.get(ref.taskId) ?? []) {
    if (!(routeIndex.get(consumerTaskId) ?? []).includes(routingTaskId)) {
      errors.push(
        `${label}: task ${ref.taskId} is a case task of routing task ${routingTaskId}; only case tasks of the same route may reference it (the producer may be skipped_by_route)`,
      );
      continue;
    }
    for (const resolution of routeResolutions(taskById.get(routingTaskId)?.route)) {
      if (resolution.tasks.has(consumerTaskId) && !resolution.tasks.has(ref.taskId)) {
        errors.push(
          `${label}: routing task ${routingTaskId} resolution "${resolution.label}" activates task ${consumerTaskId} without activating producer ${ref.taskId}`,
        );
      }
    }
  }
}

// {{item}} / {{item.<path>}} validation (spec §3.3-4 / §6): the bare item
// reference works for any element type, while a dotpath requires the foreach
// items element schema to declare the path as non-nullable object properties.
function validateItemRef(task, ref, foreachItemSchemas, errors) {
  if (!isPlainObject(task.foreach)) {
    errors.push(
      `task ${task.task_id} prompt_template uses {{item${ref.path.length > 0 ? `.${ref.path.join(".")}` : ""}}} but the task declares no foreach`,
    );
    return;
  }
  if (ref.path.length === 0) {
    return;
  }
  const itemsSchema = foreachItemSchemas.get(task.task_id);
  if (itemsSchema == null) {
    // The items declaration itself failed validation; those errors stand in.
    return;
  }
  const label = `task ${task.task_id} prompt_template reference {{item.${ref.path.join(".")}}}`;
  const node = walkSchemaPath(
    itemsSchema,
    ref.path,
    label,
    `the foreach items schema of task ${task.task_id}`,
    errors,
  );
  if (node != null && isPlainObject(node) && Array.isArray(node.type)) {
    errors.push(
      `${label}: resolves to a nullable (${JSON.stringify(node.type)}) property; nullable properties cannot be referenced from templates`,
    );
  }
}

// Walks a template dotpath through a restricted-subset schema (worker
// envelope or foreach items element). Each segment must step through a
// non-nullable object's declared properties; the caller applies its own leaf
// rules (nullable rejection, array requirement) to the returned node. Pushes
// the shared path-shape errors and returns null on failure.
function walkSchemaPath(root, refPath, label, schemaLabel, errors) {
  let node = root;
  for (const segment of refPath) {
    if (!isPlainObject(node) || node.type !== "object" || Array.isArray(node.type)) {
      const into = isPlainObject(node) && node.type === "array"
        ? "an array property (arrays can only be referenced whole; indexing is not supported)"
        : `a ${isPlainObject(node) ? JSON.stringify(node.type) : "non-object"} property`;
      errors.push(`${label}: segment "${segment}" paths into ${into}`);
      return null;
    }
    if (!isPlainObject(node.properties) || !Object.hasOwn(node.properties, segment)) {
      errors.push(`${label}: "${segment}" is not a declared property in ${schemaLabel}`);
      return null;
    }
    node = node.properties[segment];
  }
  return node;
}

// Transitive closure of task-level depends_on, memoized across refs. The
// pre-seeded entry guards against dependency cycles (reported separately by
// detectCycle); closures computed inside a cycle may be incomplete, which is
// acceptable for an already-invalid spec.
function dependencyClosure(taskId, taskById, closures) {
  if (closures.has(taskId)) {
    return closures.get(taskId);
  }
  const closure = new Set();
  closures.set(taskId, closure);
  const dependsOn = taskById.get(taskId)?.depends_on;
  for (const depId of Array.isArray(dependsOn) ? dependsOn : []) {
    if (typeof depId !== "string" || closure.has(depId)) {
      continue;
    }
    closure.add(depId);
    for (const transitive of dependencyClosure(depId, taskById, closures)) {
      closure.add(transitive);
    }
  }
  return closure;
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

export function requireString(payload, field, errors, prefix = "") {
  if (typeof payload?.[field] !== "string" || payload[field].trim() === "") {
    errors.push(`${prefix ? `${prefix}.` : ""}${field} must be a non-empty string`);
  }
}

export function requireArray(payload, field, errors, prefix = "") {
  if (!Array.isArray(payload?.[field])) {
    errors.push(`${prefix ? `${prefix}.` : ""}${field} must be an array`);
  }
}

export function requireObject(payload, field, errors, prefix = "") {
  if (typeof payload?.[field] !== "object" || payload[field] == null || Array.isArray(payload[field])) {
    errors.push(`${prefix ? `${prefix}.` : ""}${field} must be an object`);
  }
}

export function requireNonNegativeInteger(payload, field, errors) {
  if (!Number.isInteger(payload?.[field]) || payload[field] < 0) {
    errors.push(`${field} must be a non-negative integer`);
  }
}

function requirePositiveInteger(payload, field, errors) {
  if (!Number.isInteger(payload?.[field]) || payload[field] < 1) {
    errors.push(`${field} must be a positive integer`);
  }
}
