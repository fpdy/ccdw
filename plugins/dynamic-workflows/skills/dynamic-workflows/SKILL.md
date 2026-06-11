---
name: dynamic-workflows
description: Decompose a large task into a declarative workflow and run it as parallel codex exec or claude -p subagents with approval gates, budgets, progress polling, resume, and cancellation. Use for audits, migrations, research, and other work with 5+ independent subtasks that need fan-out and verification. This plugin does not hook or replace the built-in /goal command.
---

# Dynamic Workflows

You are the planner. The runner validates your plan, schedules tasks as real
`codex exec` or `claude -p` subagents (or deterministic local tasks), enforces
budgets fail-closed, and persists everything for resume and audit.

## When to use

- Use a workflow for tasks with 5 or more independent subtasks, large
  audits/migrations/research sweeps, or work that needs independent
  verification before synthesis.
- Do NOT use a workflow for small or sequential tasks; do them directly and
  say why a workflow is unnecessary.

## Runner

Resolve the plugin root once, then reuse it:

```bash
node <plugin-root>/scripts/dynamic-workflows.js <command> --json
```

If unsure of the plugin root, locate this skill file's directory and go two
levels up (`skills/dynamic-workflows` -> plugin root). The same operations are
available as MCP tools (`dynamic_workflows_*`).

codex tasks require the `codex` CLI on PATH; claude tasks require the `claude`
CLI (2.1.x or later) on PATH. claude workers run with all ambient settings
excluded (`--setting-sources ""`), so `apiKeyHelper`-based auth does not reach
them — such environments must export `ANTHROPIC_API_KEY` to the orchestrator's
environment — and the user-level `model` setting does not apply either, so set
a task-level `model` if you need a specific one.

Task-level executor fields are strict for new plans: `model` works for codex
and claude tasks, `profile` works only for codex tasks, `effort` works only for
claude tasks (`low`, `medium`, `high`, `xhigh`, `max`), and local tasks must
not carry any of them. New-plan `model` and `profile` values must match
`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$`; stored-run spawned executor values are
also guarded at argv build time against leading `-`, whitespace/control
characters, and values over 512 characters.

## Planning the spec

Write a WorkflowSpec JSON file yourself. Decompose into phases (DAG via
`depends_on`) and tasks:

```json
{
  "objective": "<one-paragraph goal>",
  "phases": [
    { "phase_id": "survey", "tasks": ["audit-auth", "audit-api"] },
    { "phase_id": "verify", "depends_on": ["survey"], "tasks": ["verify-findings"] }
  ],
  "tasks": [
    {
      "task_id": "audit-auth",
      "phase_id": "survey",
      "kind": "codex_agent",
      "role": "auditor",
      "prompt_template": "Audit src/auth for authorization gaps. Report each gap as a finding with file paths.",
      "timeout_ms": 600000
    },
    {
      "task_id": "verify-findings",
      "phase_id": "verify",
      "kind": "codex_agent",
      "role": "verifier",
      "prompt_template": "Read the input artifacts and try to refute each finding against the code.",
      "input_source": "accepted_worker_results",
      "depends_on": ["audit-auth", "audit-api"]
    }
  ],
  "max_concurrency": 3,
  "max_tokens": 500000,
  "max_duration_ms": 1800000
}
```

Rules for good specs:

- Every `prompt_template` must be self-contained: workers have no conversation
  context. Include concrete file paths, acceptance criteria, and scope limits.
- `phase_id` and `task_id` must match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; never use slashes, `..`, spaces, or
  user-supplied path fragments in ids.
- Tasks with `kind` starting with `codex` run as `codex exec` subagents;
  kinds starting with `claude` (e.g. `claude_agent`) run as `claude -p`
  subagents; `local_*` kinds are deterministic no-LLM steps. Workers run
  read-only unless `workspace_policy.write_scope` includes `"workspace"`.
- Use task-level `model` only when you need to pin the worker model. Use
  codex `profile` only for codex CLI profiles; explicit task `model` remains
  visible in argv and wins over profile model settings. Use claude `effort`
  only for claude tasks.
- The runner rejects `workspace_policy.shell:true` and `mcp_write:true`; the
  approval summary reports the actually enforced worker sandbox and network
  access instead. `workspace_policy.network:true` is rejected at plan time for
  workflows containing claude tasks.
- Expand fan-out yourself at plan time (one task per file group/claim/area);
  `fanout_source` must stay null because the runner never expands it.
- Conditions must match what the engine actually does: `entry_condition` /
  `condition` accept only `"always"` (empty `depends_on`) or
  `"dependencies_succeeded"`, `completion_condition` only
  `"all_tasks_succeeded"`, and task `stop_condition` only
  `"budget_or_cancelled"`. Plan rejects anything else.
- Omitted or `null` `input_source` values normalize to `"objective"`.
  Explicit values must be `"objective"`, `"accepted_worker_results"`, a
  non-empty path string, or a non-empty array of non-empty path strings; paths
  resolve relative to the run directory.
- Keep `max_concurrency` low (2-4); each worker is a full codex or claude
  session.
- Set per-task `timeout_ms` and a run-level `max_tokens`; the runner enforces
  both fail-closed. Token accounting is approximate: cached input tokens are
  not counted and multi-turn workers re-count input per turn, so leave margin
  in `max_tokens` rather than sizing it exactly. The same margin advice
  applies to claude tasks (their usage is counted once per attempt).
- `max_cost`, `max_retries`, `max_no_progress_iterations`,
  `verification_required`, and `verification_policy` are advisory: they are
  recorded and shown in the approval summary's `advisory_fields`, but the
  runner does not enforce them (use per-task `retry_policy` for retries).
- Use a verification phase that tries to REFUTE earlier findings rather than
  restate them.

Validate without side effects first: `plan --spec-file spec.json --dry-run --json`.

## Approval

1. `plan --spec-file <file> --workspace <repo-root> --json` returns
   `approval.summary` (phases, per-task prompts, optional model/effort/profile,
   enforced sandbox, budget, spec hash).
2. Render that summary to the user as a short bulleted plan and ask for
   consent. Never self-approve. Never auto-approve any spec that requests
   workspace write or network access beyond what the user explicitly accepted.
3. Only after stated consent: `run --run-dir <run_dir> --detach --approve --json`.

## Monitoring

- `run --detach` returns immediately with `runner_pid`; the orchestrator runs
  in the background and writes `runner.log` in the run dir.
- Poll `status --run-dir <d> --json` (cheap) every 15-30 seconds; report phase
  progress and task counts ("phase 2/3, 4 succeeded, 2 running, 110k tokens").
- For detail, `events --run-dir <d> --since-offset <n> --json` returns only new
  events plus the next offset.
- If you lost the run_dir, `list --workspace <repo-root> --json` discovers runs.
- Never claim completion until `status` reports `completed`; report the
  `outcome` (success vs partial) honestly, including failed/skipped tasks.

## Recovery

- `paused`: report the exact reason (e.g. max-tasks reached) and offer resume.
- `failed`: inspect the last events and the failing task's artifacts under
  `artifacts/<task_id>/`, then offer `resume --run-dir <d> --resume-failed --json`
  (re-runs failed and skipped tasks, keeps succeeded results).
- `completed` with outcome `partial`: `--resume-failed` works here too — it
  re-runs only the failed/skipped tasks and reuses every succeeded result.
- `cancel --run-dir <d> --reason "..."` stops a live run via the control
  channel; confirm with `status` afterwards.
- A crashed run (status running, `runner.active: false`) recovers with `resume`.
- If `resume` refuses with a `runner_pid` that is not actually a ccdw
  orchestrator (PID reuse after a crash), verify the process, delete
  `<run_dir>/orchestrator.lock`, and resume again.

## Guardrails

- Treat workflow execution as separate from Codex's native `/goal` lifecycle.
- Do not grant shell, network, or MCP write permissions implicitly.
- `--max-tasks` must be a non-negative integer; use it for staged execution
  when the user wants to inspect progress before more workers launch.
- Prefer read-only workers; the runner writes all run artifacts itself.
- Results live under `<run_dir>/artifacts/<task_id>/result.json`; synthesize
  your final answer from those structured results, separating verified,
  rejected, and unresolved findings.
