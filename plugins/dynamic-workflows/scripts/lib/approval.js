import {
  ADVISORY_SPEC_FIELDS,
  SCHEMA_VERSION,
  WORKFLOW_FILE,
} from "./constants.js";
import { isPlainObject, resolveExecutorKind } from "./util.js";

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
  // Gate execution conditions (spec §4.4): gates run outside any OS sandbox,
  // so consent must be based on the exact disclosure below. Emitted only when
  // the workflow declares gates; gate-free summaries keep the existing shape.
  if (tasks.some((task) => Array.isArray(task?.gates) && task.gates.length > 0)) {
    summary.gates = {
      os_sandbox: "none",
      cwd: policy.workspace_root,
      // Keep in sync with GATE_ENV_ALLOWLIST in gates.js.
      env_allowlist: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
      invocation: "argv-only (no shell)",
    };
  }
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

function buildApprovalTaskSummary(task) {
  return {
    task_id: task.task_id,
    role: task.role,
    kind: task.kind,
    ...(task.model != null ? { model: task.model } : {}),
    ...(task.effort != null ? { effort: task.effort } : {}),
    ...(task.profile != null ? { profile: task.profile } : {}),
    // Full gate command argv (spec §4.4): the approver consents to the exact
    // commands the runner will execute, never a truncated summary.
    ...(Array.isArray(task.gates) && task.gates.length > 0
      ? { gates: task.gates.map((gate) => ({ command: gate.command, timeout_ms: gate.timeout_ms })) }
      : {}),
    // Full route declaration (spec §5): the approver consents to every branch
    // path a resolution can activate, including the default.
    ...(isPlainObject(task.route)
      ? { route: { values: task.route.values, cases: task.route.cases, default: task.route.default } }
      : {}),
    // Full foreach declaration with effective defaults (spec §6.4): the
    // approver consents to the fan-out bounds the runner will enforce.
    ...(isPlainObject(task.foreach)
      ? {
          foreach: {
            items: task.foreach.items,
            max_items: task.foreach.max_items,
            concurrency: task.foreach.concurrency ?? null,
            tolerated_failure_count: task.foreach.tolerated_failure_count ?? 0,
          },
        }
      : {}),
    // foreach tasks disclose the full template (spec §6.4): every expanded
    // child renders its prompt from this exact text.
    prompt_summary:
      task.prompt_template.length > 120 && !isPlainObject(task.foreach)
        ? `${task.prompt_template.slice(0, 117)}...`
        : task.prompt_template,
  };
}

// The §6.4 estimate disclosed to the approver: the same numbers the plan-time
// budget precondition enforces (spec tasks + Σ max_items ≤ max_agents).
function buildForeachBudgetSummary(workflow) {
  const maxExpandedChildren = workflow.tasks
    .filter((task) => isPlainObject(task.foreach))
    .reduce((total, task) => total + task.foreach.max_items, 0);
  return {
    static_task_count: workflow.tasks.length,
    max_expanded_children: maxExpandedChildren,
    estimated_max_total_tasks: workflow.tasks.length + maxExpandedChildren,
    max_agents: workflow.max_agents,
  };
}

export function buildInitialRunState({ workflow, goalId, createdAt, specHash, provenance = null }) {
  const tasks = {};
  for (const task of workflow.tasks) {
    tasks[task.task_id] = {
      task_id: task.task_id,
      phase_id: task.phase_id,
      status: "queued",
      attempts: [],
      result_path: null,
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
        // Saved-workflow provenance (F5): which template produced this spec,
        // with which resolved input values.
        ...(provenance != null
          ? {
              workflow_template: {
                name: provenance.workflow_template,
                template_path: provenance.template_path,
                template_hash: provenance.template_hash,
                inputs: provenance.inputs,
              },
            }
          : {}),
        phases: workflow.phases.map((phase) => ({
          phase_id: phase.phase_id,
          name: phase.name,
          task_count: phase.tasks.length,
        })),
        tasks: workflow.tasks.map((task) => buildApprovalTaskSummary(task)),
        max_agents: workflow.max_agents,
        max_concurrency: workflow.max_concurrency,
        // Foreach budget estimate (spec §6.4): the plan-time necessary
        // condition the approver consents to, shown only for fan-out specs.
        ...(workflow.tasks.some((task) => isPlainObject(task.foreach))
          ? { foreach_budget: buildForeachBudgetSummary(workflow) }
          : {}),
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
    // Foreach child task definitions appended at expansion time (spec §6.2);
    // state.tasks gains a matching entry per child id.
    expanded_tasks: [],
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
