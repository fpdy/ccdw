---
name: dynamic-workflows
description: Decompose a large task into a declarative workflow and run it as parallel codex exec or claude -p subagents with approval gates, budgets, typed task outputs, command gates, enum branching, bounded fan-out, progress polling, resume, and cancellation. Use for audits, migrations, research, and other work with 5+ independent subtasks that need fan-out and verification. This plugin does not hook or replace the built-in /goal command.
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

Task-level executor fields are strict: `model` works for codex and claude
tasks, `profile` works only for codex tasks, `effort` works only for claude
tasks (`low`, `medium`, `high`, `xhigh`, `max`), and local tasks must not
carry any of them. `model` and `profile` values must match
`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$`; spawned executor values are also
guarded at argv build time against leading `-`, whitespace/control characters,
and values over 512 characters.

## Planning the spec

Write a WorkflowSpec file yourself (JSON, or YAML via the CLI — YAML is
normalized to JSON at plan time; anchors/aliases and duplicate keys are
rejected). Decompose into phases (DAG via `depends_on`) and tasks:

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

The spec schema is `dynamic-workflows.v2`. The v1 fields
`expected_output_schema`, `verification_required`, `verification_policy`, and
`fanout_source` are gone and rejected at plan time — use `output_schema`,
`gates`, and `foreach` instead. Run directories planned before v0.6.0 are
rejected ("unsupported schema_version; re-plan required"); re-plan them.

### Baseline rules

- Every `prompt_template` must be self-contained: workers have no conversation
  context. Include concrete file paths, acceptance criteria, and scope limits.
- `phase_id` and `task_id` must match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; never use slashes, `..`, spaces, or
  user-supplied path fragments in ids.
- Tasks with `kind` starting with `codex` run as `codex exec` subagents;
  kinds starting with `claude` (e.g. `claude_agent`) run as `claude -p`
  subagents; `local_*` kinds are deterministic no-LLM steps (and reject
  `output_schema`/`gates`/`route`/`foreach`). Workers run read-only unless
  `workspace_policy.write_scope` includes `"workspace"`.
- The runner rejects `workspace_policy.shell:true` and `mcp_write:true`; the
  approval summary reports the actually enforced worker sandbox and network
  access instead. `workspace_policy.network:true` is rejected at plan time for
  workflows containing claude tasks.
- Conditions must match what the engine actually does: `entry_condition` /
  `condition` accept only `"always"` (empty `depends_on`) or
  `"dependencies_succeeded"`, `completion_condition` only
  `"all_tasks_succeeded"`, and task `stop_condition` only
  `"budget_or_cancelled"`. Plan rejects anything else.
- Omitted or `null` `input_source` values normalize to `"objective"`.
  Explicit values must be `"objective"`, `"accepted_worker_results"`, a
  non-empty path string, or a non-empty array of non-empty path strings; paths
  resolve relative to the run directory. `input_source` passes file contents
  to the worker; templates (below) embed values into the prompt text — they
  coexist, pick per channel.
- Keep `max_concurrency` low (2-4); each worker is a full codex or claude
  session.
- Set per-task `timeout_ms` and a run-level `max_tokens`; the runner enforces
  both fail-closed. Token accounting is approximate (cached input tokens are
  not counted, multi-turn input is re-counted per turn), so leave margin.
- `max_cost`, `max_retries`, and `max_no_progress_iterations` are advisory:
  recorded and shown in `advisory_fields`, not enforced (use per-task
  `retry_policy` for retries).
- Use a verification phase that tries to REFUTE earlier findings rather than
  restate them.

### Typed outputs (`output_schema`)

Declare `output_schema` on a task whenever a downstream task, `route`, or
`foreach` needs to consume its result — typed domain values land in
`result.output` and are the only statically checkable reference target.

- Restricted subset: only `type`, `properties`, `items`, `enum`,
  `description`, `title`. Root must be an object; property names match
  `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; optionality only as `["<scalar>","null"]`.
  Depth ≤ 4, ≤ 64 properties, ≤ 8 nullable unions, string-only `enum` ≤ 20
  values. Do NOT write `required` or `additionalProperties` — the runner
  generates them (all properties required, no additional properties).
- Typed tasks lose the self-report fields (`findings`, `evidence`,
  `modified_files`, `commands_run`, `artifacts`): verify with `gates` instead
  of trusting self-reports.
- Declare values you plan to reference from templates as non-nullable;
  nullable properties cannot be referenced.

### Templates (`{{...}}`)

Namespaces in `prompt_template`: `{{objective}}`, `{{inputs.<key>}}`
(saved workflows only), `{{tasks.<id>.result.<dotpath>}}`,
`{{item}}`/`{{item.<path>}}` (foreach tasks only), `{{gate_feedback}}` (gated
tasks only). Pure substitution — no expressions, no array indexing, no escape
for a literal `{{`.

The depends_on-closure rule: a `{{tasks.<id>...}}` reference does NOT create a
dependency. The producer must already be in the consumer's `depends_on`
transitive closure, and the dotpath must resolve against the producer's
declared schema, or the plan is rejected. Write the dependency explicitly,
then reference. Objects/arrays are embedded as compact JSON; arrays only
whole.

### Command gates (`gates`)

Deterministic verification beats self-report: when a task claims success, make
it prove it with commands (`npm test`, linters, builds).

```json
"gates": [{ "command": ["npm", "test"], "timeout_ms": 300000 }],
"retry_policy": { "retryable": true, "max_attempts": 3, "backoff_ms": 1000 }
```

- Gates run after a schema-valid worker result, in order; all must exit 0.
  Failure → status `gate_failed` → retry. There is ONE attempt counter:
  `retry_policy.max_attempts` covers worker failures and gate failures
  together — budget attempts accordingly.
- Feedback injection: on retry, `{{gate_feedback}}` carries the failed
  command, exit code, and output tails (default 4096 bytes/stream,
  `gate_feedback_tail_bytes` ≤ 16384). Without the placeholder the block is
  appended automatically on retries. Put it where the worker will act on it.
- Disclosure: gates run with NO OS sandbox, `cwd` = workspace root, env
  allowlist `PATH/HOME/TMPDIR/LANG/LC_ALL`, argv-only (no shell, no `{{` in
  argv). Every gate command appears verbatim in the approval summary — the
  user is consenting to those exact commands.
- An LLM-judged gate does not exist; express "evaluator" steps as a verifier
  task with `output_schema` + `route`.

### Branching (`route`)

```json
"route": {
  "values": ["approve", "minor_fix", "reject"],
  "cases": { "approve": ["land"], "minor_fix": ["fix", "land"] },
  "default": ["replan"]
}
```

- The worker must report `route` (schema-enforced enum). On the routing
  task's final success the route resolves once: selected case tasks proceed,
  unselected ones become `skipped_by_route` — which SATISFIES dependencies,
  never fails the run, and is not resumable. So `land` with
  `depends_on: ["review", "fix"]` runs on the approve path even though `fix`
  was skipped.
- Design lesson (from takt operations): avoid two-way OK/ABORT branching — it
  collapses real outcomes into false binaries and stalls runs. Model "minor
  issues but proceed" as a middle enum value (`minor_fix` above) so partial
  acceptance has a path.
- Case arrays are UNORDERED activation sets. If case tasks must run in
  sequence, write `depends_on` between them; tasks listed together without
  dependencies run concurrently.
- Topology rules the plan enforces: every case task must depend (transitively)
  on its routing task; only case tasks of the same route may depend on a case
  task; a task belongs to at most one route; `default` is required; `route`
  and `foreach` cannot share a task; template references to a case task are
  only legal from co-activated case tasks of the same route.

### Fan-out (`foreach`)

```json
"foreach": {
  "items": "{{tasks.plan.result.output.items}}",
  "max_items": 16,
  "concurrency": 4,
  "tolerated_failure_count": 0
},
"prompt_template": "Fix: {{item.description}} ({{item.file}})"
```

- `items` must be exactly one whole-field reference to a producer array
  (declare the producer's `output_schema`). The parent expands into children
  `<parent>.0`, `<parent>.1`, ... (status `expanded`), each inheriting
  kind/model/effort/profile/timeout/retry/output_schema/gates/
  gate_feedback_tail_bytes.
- Bounded and fail-closed: `max_items` is required; more items than
  `max_items` fails the parent (no truncation); zero items succeed with an
  empty aggregate. At plan time, `static tasks + Σ max_items` must fit within
  `max_agents` — `max_items` counts against the agent budget BEFORE anything
  runs, so size both deliberately.
- The parent aggregates to `result.output.results` (ordered
  `{index, task_id, status, output|null}`); it succeeds while failed children
  ≤ `tolerated_failure_count`. Downstream may reference only
  `{{tasks.<parent>.result.output.results}}` whole.
- Effective child concurrency is `min(foreach.concurrency, max_concurrency)`.

### Saved workflows

Store reusable specs in `<CCDW_HOME>/workflows/<name>.json|.yaml|.yml` with typed
`inputs` (`string`/`integer`/`number`/`boolean`, `required`/`default`), use
`{{inputs.*}}` in `objective` and prompts, then plan with
`plan --workflow <name> --input key=value` (CLI coerces strings by declared
type) or the MCP `workflow`+`inputs` parameters (typed JSON, no coercion).
Unknown/missing/mistyped inputs fail the plan. The approval summary records
provenance (template name, hash, resolved inputs); the spec hash covers the
expanded spec. An explicit objective argument overrides the template's.

Validate without side effects first: `plan --spec-file spec.json --dry-run --json`
(or `spec.yaml`).

## Approval

1. `plan --spec-file <file> --workspace <repo-root> --json` returns
   `approval.summary` (phases, per-task prompts, optional model/effort/profile,
   gate commands, route/foreach declarations with budget estimates, enforced
   sandbox, budget, spec hash, saved-workflow provenance).
2. Render that summary to the user as a short bulleted plan and ask for
   consent. Always include the gate commands verbatim — gates run unsandboxed
   in the workspace. Never self-approve. Never auto-approve any spec that
   requests workspace write or network access beyond what the user explicitly
   accepted.
3. Only after stated consent: `run --run-dir <run_dir> --detach --approve --json`.

## Monitoring

- `run --detach` returns immediately with `runner_pid`; the orchestrator runs
  in the background and writes `runner.log` in the run dir.
- Poll `status --run-dir <d> --json` (cheap) every 15-30 seconds; report phase
  progress and task counts ("phase 2/3, 4 succeeded, 2 running, 110k tokens").
- For detail, `events --run-dir <d> --since-offset <n> --json` returns only new
  events plus the next offset. New v2 events worth surfacing: `gate_started`/
  `gate_result` (verification progress), `route_resolved` (which branch won),
  `tasks_expanded` (fan-out size), `tasks_expanded_replayed` (expansion
  reconstructed on resume), `template_resolution_failed`.
- If you lost the run_dir, `list --workspace <repo-root> --json` discovers runs.
- Never claim completion until `status` reports `completed`; report the
  `outcome` (success vs partial) honestly, including failed/skipped tasks.
  `skipped_by_route` tasks are normal routing outcomes, not failures.

## Recovery

- `paused`: report the exact reason (e.g. max-tasks reached) and offer resume.
- `failed`: inspect the last events and the failing task's artifacts under
  `artifacts/<task_id>/` (for gate failures: `gate-verdict.json` and
  `gate-<n>.stdout.log`/`gate-<n>.stderr.log` per attempt), then offer
  `resume --run-dir <d> --resume-failed --json`
  (requeues `failed`, `gate_failed`, `timed_out`, `schema_violation`, and
  `skipped` tasks, keeps succeeded results; `skipped_by_route` tasks stay
  skipped — route resolutions are final).
- `completed` with outcome `partial`: `--resume-failed` works here too — it
  re-runs only the failed/skipped tasks and reuses every succeeded result.
- `cancel --run-dir <d> --reason "..."` stops a live run via the control
  channel; confirm with `status` afterwards.
- A crashed run (status running, `runner.active: false`) recovers with `resume`.
- If `resume` refuses with a `runner_pid` that is not actually a ccdw
  orchestrator (PID reuse after a crash), verify the process, delete
  `<run_dir>/orchestrator.lock`, and resume again.
- A pre-v0.6.0 run directory cannot be resumed (schema v1); re-plan it.

## Guardrails

- Treat workflow execution as separate from Codex's native `/goal` lifecycle.
- Do not grant shell, network, or MCP write permissions implicitly; remember
  gates execute real commands in the workspace without an OS sandbox.
- `--max-tasks` must be a non-negative integer; use it for staged execution
  when the user wants to inspect progress before more workers launch.
- Prefer read-only workers; the runner writes all run artifacts itself.
- Results live under `<run_dir>/artifacts/<task_id>/result.json`; synthesize
  your final answer from those structured results, separating verified,
  rejected, and unresolved findings.
