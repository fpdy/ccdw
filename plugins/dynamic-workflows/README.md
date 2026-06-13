# Dynamic Workflows

Dynamic Workflows is a local Codex plugin that runs a caller-authored
declarative workflow as real `codex exec`, `claude -p`, or `opencode acp`
subagents: the
planning agent writes
a WorkflowSpec (JSON or YAML), the runner validates it, schedules tasks in parallel up to
`max_concurrency`, enforces token/duration/agent budgets fail-closed, and
persists every step for approval, resume, cancellation, and audit.

Each run directory stores:

- `workflow.yaml`: the workflow spec (normalized JSON, even for YAML input).
- `run.json`: the current runtime snapshot (single-writer, lock-protected).
- `events.ndjson`: append-only protocol and audit events.
- `artifacts/`: structured worker results (`artifacts/<task_id>/result.json`)
  and per-attempt raw output, including gate logs and verdicts.

Workflow `phase_id` and `task_id` values must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. The runner also checks resolved
artifact paths before writing, so caller-authored specs cannot escape the run's
`artifacts/` directory through task identifiers.

Tasks with `kind` starting with `codex` execute as `codex exec` subprocesses
(`--json` event stream, `--output-schema`-enforced structured results,
sandbox mapped from `workspace_policy`, thread ids recorded for audit/resume).
Set `CCDW_CODEX_BIN` to override the codex binary.

Tasks with `kind` starting with `claude` (recommended: `claude_agent`) execute
as Claude Code `claude -p` subprocesses (`stream-json` event stream, the same
`--json-schema`-enforced structured results, OS sandbox via a generated
fail-closed `--settings` file, ambient settings excluded with
`--setting-sources ""`, customizations disabled with `--safe-mode`, built-in
tools restricted via `--tools`/`--allowedTools`/`--disallowedTools`, no
session persistence, session ids recorded for audit). Set `CCDW_CLAUDE_BIN`
to override the claude binary; the minimum supported CLI is 2.1.x. Because
ambient settings are excluded, `apiKeyHelper`-based auth is not available to
workers (export `ANTHROPIC_API_KEY` instead) and the user-level `model`
setting does not apply (use the task-level `model` field).

Tasks with `kind` exactly `acp_opencode` (any other `acp*` value is rejected
at plan time) execute as `opencode acp` subprocesses driven over ACP (Agent
Client Protocol, nd-JSON-RPC over stdio), one process per attempt. They
REQUIRE a task-level `model` (ACP model id namespace, e.g.
`openrouter/anthropic/claude-haiku-4.5`), fixed per session via
`session/set_model`; `effort`, `profile`, `output_schema`, `route`,
`network: true`, and acting as a `foreach` producer are rejected at plan time
(foreach children and `gates` are allowed). There is no OS-level sandbox:
enforcement is an injected opencode permission config (read-only scope denies
bash/edit; write scope allows them) plus ccdw auto-rejecting every
`session/request_permission` ask, so network isolation is NOT guaranteed in
write scope — the approval summary discloses this. In write scope workers can
also write outside the workspace root and read inherited environment secrets
(e.g. provider API keys) via bash. Ambient opencode config
(global/project config, plugins, CLAUDE.md, skills) is blocked via a
spawn-time env recipe; the opencode data dir (auth/session DB) remains
ambient. Token usage is counted into the run budget from ACP
`PromptResponse.usage`. Results follow the same JSON envelope, but schema
adherence is prompt contract plus runner re-validation only (no CLI-side
schema enforcement exists for ACP), so `schema_violation` quarantine/retry
applies; prefer codex/claude kinds for schema-critical tasks and acp_opencode
for free-form, read, or analysis tasks. Set `CCDW_OPENCODE_BIN` to override
the opencode binary (an absolute path is recommended — PATH wrappers can
defeat the isolation env). Verified against opencode 1.16.2. Operational
hardening: setup requests have bounded response timeouts, the prompt turn is
bounded by the attempt timeout, oversized protocol lines are dropped, cumulative
agent-message text over 4 MiB fails closed with `message_overflow`,
`acp-frames.jsonl` is capped at 16 MiB, permission asks are logged individually
only up to 20 before a `permission_request_flood` summary, and `launch_started`
records a best-effort `opencode --version` probe.

Task-level executor fields are explicit and approval-visible. `model` applies
to codex and claude tasks and is required for acp_opencode tasks, `profile`
applies only to codex tasks (an explicit
task `model` remains visible in argv and wins over any profile model setting),
and `effort` applies only to claude tasks with one of `low`, `medium`, `high`,
`xhigh`, or `max`. Plans reject unsupported combinations, local-task
executor fields, and `model`/`profile` values outside
`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$`. Spawned executors additionally refuse
argv-unsafe stored values (leading `-`, whitespace/control characters, or more
than 512 characters) before starting the worker.

`local_*` kinds run a deterministic no-LLM executor used by the default
template and the test suite. Local tasks reject `output_schema`, `gates`,
`route`, and `foreach`.

The enforced sandbox is `read-only` unless `workspace_policy.write_scope`
includes `"workspace"`, in which case it becomes `workspace-write` (claude
filesystem writes are limited to the workspace root); network access is only
passed through for codex tasks in that workspace-write mode.
`workspace_policy.network:true` is rejected at plan time for workflows
containing claude tasks because the claude sandbox has no enforceable
allow-all network mechanism, and for workflows containing acp_opencode tasks
because opencode has no OS sandbox at all. The runner rejects
`workspace_policy.shell:true`
and `workspace_policy.mcp_write:true` because those permissions are not
enforced by the current worker invocations.

## Schema v2 (breaking)

v0.6.0 abandons backward compatibility. `schema_version` is now
`dynamic-workflows.v2`; run directories planned with earlier versions are
rejected by `status`/`run`/`resume`/`validate` with an explicit
"unsupported schema_version; re-plan required" error. The lenient re-read path
for stored runs was removed: stored specs are re-validated with the same
strict rules as new plans.

Removed spec fields (plan-time error with a pointer to the replacement):

- `expected_output_schema` → task `output_schema` (typed output).
- `verification_required` / `verification_policy` → task `gates`.
- `fanout_source` → task `foreach`.

Plan-time validation remains strict about engine semantics:
`entry_condition` / `condition` accept only `always` (with empty `depends_on`)
or `dependencies_succeeded`, `completion_condition` only
`all_tasks_succeeded`, task `stop_condition` only `budget_or_cancelled`.
`max_cost`, `max_retries`, and `max_no_progress_iterations` are recorded but
advisory; the approval summary lists them under `advisory_fields` so approval
reflects what the runner actually enforces.

New task statuses: `gate_failed` (terminal, retryable, resumable),
`skipped_by_route` (terminal; satisfies dependencies; never fails the run; not
resumable), and `expanded` (non-terminal, foreach parents). New events:
`gate_started`, `gate_result`, `route_resolved`, `tasks_expanded`,
`tasks_expanded_replayed`, `template_resolution_failed`.

## Spec authoring

### Typed task output: `output_schema`

A task may declare a restricted JSON-Schema subset for its domain output. The
allowed keywords are `type`, `properties`, `items`, `enum`, `description`, and
`title`; anything else (`$ref`, `oneOf`, `pattern`, `format`, `min*`/`max*`,
...) is a plan-time error. Rules:

- The root must be `type: "object"`. Property names must match
  `^[A-Za-z_][A-Za-z0-9_]{0,63}$` (so template dot-paths stay unambiguous).
- `type` unions are only `["<scalar>", "null"]` — the sole way to express an
  optional value. Limits: nesting depth ≤ 4, ≤ 64 total properties, ≤ 8
  nullable unions, ≤ 32 KB serialized; `enum` is string-only, ≤ 20 values of
  ≤ 64 characters each.
- Do not write `required` or `additionalProperties`: the runner generates
  `required` (all property names) and injects `additionalProperties: false` on
  every object (codex strict mode and the claude structured-output tool both
  demand this). User-authored values are rejected.

The runner synthesizes the worker result envelope (v2) per task. Tasks without
`output_schema` keep the default shape (`task_id`, `attempt_id`, `status`,
`summary`, `findings`, `errors`, `evidence`, `modified_files`, `commands_run`,
`artifacts`). Tasks with `output_schema` get the typed shape `{ task_id,
attempt_id, status, summary, errors, output }` — the self-reported audit
fields are dropped in favor of gate-based machine verification, and
`result.output` becomes the only reference target for templates, `route`, and
`foreach`. Routing tasks additionally report a required `route` string enum.
Double validation (executor-enforced schema plus runner re-validation with
quarantine) is unchanged.

### Templates: `{{...}}`

`prompt_template` supports pure-substitution references (no expressions, no
escaping; a literal `{{` is always parsed as a reference and anything
malformed is a plan-time error):

- `{{objective}}` — the run objective.
- `{{inputs.<key>}}` — saved-workflow inputs; expanded before validation, so a
  leftover reference is an error.
- `{{tasks.<taskId>.result.<dotpath>}}` — a field of a producer task's
  validated `result.json`. The producer must be in the consumer's `depends_on`
  transitive closure (a reference is not an implicit dependency), the dotpath
  must resolve statically against the producer's synthesized envelope (typed
  domain values live under `result.output.*`), arrays can only be referenced
  whole (no indexing), and nullable `["X","null"]` properties cannot be
  referenced.
- `{{item}}` / `{{item.<dotpath>}}` — only inside a `foreach` task.
- `{{gate_feedback}}` — only inside a task with `gates`.

At render time strings are inserted verbatim, numbers/booleans are
stringified, and objects/arrays are embedded as compact JSON. Template syntax
is forbidden everywhere else — in particular `gates[].command` argv entries
(injection channel). A defensive runtime resolution failure marks the task
`failed` without retry and records a `template_resolution_failed` event.
`input_source` still exists as the separate "pass file contents to the
worker" channel; templates embed values into the prompt text.

### Quality gates: `gates`

```json
{
  "task_id": "implement",
  "kind": "claude_agent",
  "gates": [{ "command": ["npm", "test"], "timeout_ms": 300000 }],
  "retry_policy": { "retryable": true, "max_attempts": 3, "backoff_ms": 1000 }
}
```

After a worker result passes schema validation, gates run sequentially in
declaration order while the task keeps its concurrency slot. All gates exit 0
→ the task succeeds; any non-zero exit or timeout → the new status
`gate_failed`, which retries under the task's `retry_policy` — there is a
single attempt counter (`retry_policy.max_attempts`) shared by worker failures
and gate failures, no separate gate policy. `timeout_ms` is required per gate;
the effective timeout is `max(min(timeout_ms, remaining run budget), 1000)`
with process-group kill escalation. Cancellation also kills gate processes.

Execution disclosure model (no OS sandbox in v0.6.0): gates are spawned
argv-only (no shell), with `cwd` fixed to `workspace_policy.workspace_root`
and an env allowlist of `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` only. The
approval summary lists every gate command verbatim so the human approves the
exact commands that will run. Each attempt directory records
`gate-<n>.stdout.log` / `gate-<n>.stderr.log` (capped at 1 MiB each) and a
machine-readable `gate-verdict.json`; the events log gains `gate_started` /
`gate_result`.

On a retry attempt, `{{gate_feedback}}` is replaced with the failed gate's
command, exit status, and stdout/stderr tails (4096 bytes per stream by
default; `gate_feedback_tail_bytes` raises it up to 16384). If the prompt has
no placeholder, the feedback block is appended automatically on retry
attempts; on the first attempt the placeholder renders as an empty string.

### Branching: `route`

```json
{
  "task_id": "review",
  "kind": "codex_agent",
  "route": {
    "values": ["approve", "minor_fix", "reject"],
    "cases": { "approve": ["land"], "minor_fix": ["fix", "land"] },
    "default": ["replan"]
  }
}
```

The routing task's worker envelope gains a required `route` string enum
(domain = `values`, 2–20 distinct strings of ≤ 64 chars), so the branching
input is always schema-valid. When the routing task finally succeeds
(post-gates) the route resolves exactly once (`route_resolved` event):
`cases[value]` — falling back to `default`, which is required — selects the
case tasks to activate; the other case tasks become `skipped_by_route`.

`skipped_by_route` is terminal but benign: it satisfies downstream
dependencies, does not cascade skips or fail the run (the outcome reports
those tasks separately as `routed_skipped`), and is not requeued by resume —
a route resolution is final. Case arrays are unordered activation sets;
execution order still comes only from `depends_on`.

Plan-time rules: cases keys ⊆ values and `default` required (V1); every case
task must include the routing task in its `depends_on` transitive closure (V2
— this is what keeps case tasks from launching before the route resolves);
only case tasks of the same route may depend directly on a case task (V3); a
task may be a case task of at most one routing task (V4); `route` and
`foreach` are mutually exclusive, and a routing task cannot list itself (V5).
Template references to a case-task producer are only allowed from co-activated
case tasks of the same route, checked per resolution (the producer might
otherwise be `skipped_by_route` with an unrenderable consumer prompt).

### Fan-out: `foreach`

```json
{
  "task_id": "fix-each",
  "kind": "claude_agent",
  "foreach": {
    "items": "{{tasks.plan.result.output.items}}",
    "max_items": 16,
    "concurrency": 4,
    "tolerated_failure_count": 0
  },
  "prompt_template": "Fix: {{item.description}} ({{item.file}})"
}
```

`foreach.items` must be exactly one whole-field
`{{tasks.<id>.result.<dotpath>}}` reference to a producer array. When the
parent's dependencies are satisfied it expands instead of launching a worker:
status `expanded` (non-terminal), children `<parent>.<index>` (0-based; specs
that contain colliding ids are rejected at plan time), one `tasks_expanded`
event (fail-closed if the serialized items exceed 256 KB). Children inherit
`kind`/`model`/`effort`/`profile`/`timeout_ms`/`retry_policy`/`output_schema`/`gates`/`gate_feedback_tail_bytes`,
render their prompt with `{{item}}`, and run gates per child; the parent
consumes no attempt.

Fail-closed bounds: `max_items` is required, and more items than `max_items`
fails the parent (no truncation); zero items succeed immediately with
`output.results: []`. Plan-time budget precondition: `static task count +
Σ(max_items over all foreach tasks) ≤ max_agents`, with the runtime attempt
budget still enforced as a second net. Effective child concurrency is
`min(foreach.concurrency, max_concurrency)`. The approval summary shows each
foreach template, its `max_items`, and the budget estimate.

When all children are terminal the runner synthesizes
`artifacts/<parent>/result.json` (typed envelope, `attempt_id: "aggregate"`)
with `output.results` as an order-preserving array of
`{ index, task_id, status, output | null }`. The parent succeeds when failed
children (after their own retries) stay within `tolerated_failure_count`.
Downstream templates may reference the aggregate only whole:
`{{tasks.<parent>.result.output.results}}`. Resume rebuilds expansions by
replaying `tasks_expanded` events.

### Saved workflows and typed inputs

Reusable templates live under `<CCDW_HOME>/workflows/<name>.json|.yaml|.yml`
(name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; resolved paths are
containment-checked). A template is a normal WorkflowSpec plus an optional
`inputs` declaration:

```json
{
  "inputs": {
    "target_path": { "type": "string", "required": true },
    "max_findings": { "type": "integer", "default": 10 }
  },
  "objective": "Review {{inputs.target_path}}",
  "tasks": [{ "prompt_template": "Review {{inputs.target_path}} ..." }]
}
```

Input types are `string`, `integer`, `number`, `boolean` with optional
`required`/`default`. CLI values (`plan --workflow <name> --input key=value`,
repeatable) are coerced by declared type (`integer`/`number` via `Number()`
with finiteness checks, `boolean` only from the literals `true`/`false`); MCP
`inputs` values arrive typed and are validated without coercion. Unknown
inputs, missing required inputs, and type mismatches are plan-time errors.
`{{inputs.*}}` is expanded in `objective` and task `prompt_template` fields,
then the result enters the normal pipeline (defaults → strict validation →
normalized JSON → hash; the spec hash covers the expanded spec, not the
template). The template must declare an `objective`; an explicit
`--objective`/`objective` argument overrides it. The plan result and approval
summary record provenance: template name, path, template hash, and the
resolved input values.

### YAML authoring

`plan --spec-file` accepts `.yaml`/`.yml` in addition to `.json` (CLI-only;
the MCP `spec` parameter stays a JSON object). Parsing uses the `yaml` package
in YAML 1.2 mode with duplicate keys rejected and anchors/aliases entirely
forbidden (`maxAliasCount: 0` — no alias-bomb or cycle path), input capped at
1 MiB, and parse errors reported as `file:line:col`. The spec is normalized to
JSON before storage, so the run-dir `workflow.yaml` content and the spec hash
mechanism are unchanged from JSON input.

## Integrity and budgets

Approval, run, resume, and detached startup verify the stored spec hash before
mutating run state or spawning workers. The verified workflow bytes are parsed
once and reused for execution so an approved run cannot execute a swapped
`workflow.yaml`.

Token accounting is approximate: `cached_input_tokens` are not counted toward
`max_tokens`, and multi-turn workers re-count their input tokens each turn, so
budget with margin instead of sizing `max_tokens` exactly. claude usage is
counted once per attempt from the final result event; mid-attempt overruns are
bounded by the per-task `timeout_ms` and `--max-turns`.

The plugin intentionally does not hook or replace Codex's built-in `/goal`
command. Invoke the bundled skill or call the runner directly.

## Commands

```bash
node scripts/dynamic-workflows.js plan --spec-file spec.json --workspace "$PWD" --json
node scripts/dynamic-workflows.js plan --spec-file spec.yaml --workspace "$PWD" --json  # YAML input
node scripts/dynamic-workflows.js plan --spec-file spec.json --dry-run --json   # validate only
node scripts/dynamic-workflows.js plan --workflow review-and-fix --input target_path=src/auth --json
node scripts/dynamic-workflows.js plan --objective "Review this repository" --json  # scaffold template
node scripts/dynamic-workflows.js run --run-dir <run_dir> --detach --approve --max-tasks 4 --json
node scripts/dynamic-workflows.js status --run-dir <run_dir> --json
node scripts/dynamic-workflows.js events --run-dir <run_dir> --since-offset 0 --json
node scripts/dynamic-workflows.js list --workspace "$PWD" --json
node scripts/dynamic-workflows.js resume --run-dir <run_dir> --resume-failed --json
node scripts/dynamic-workflows.js cancel --run-dir <run_dir> --reason "No longer needed" --json
```

`--spec-file` and `--workflow` are mutually exclusive; `--input` may be
repeated and requires `--workflow`.

By default, runs are stored under `.ccdw/dynamic-workflows/runs`. Set
`CCDW_HOME` to relocate ccdw-managed local state, or pass `--run-root` for a
single run. Saved workflow templates are read from `<CCDW_HOME>/workflows`.

`run --detach` starts a background orchestrator (PID in `orchestrator.lock`,
output in `runner.log`) and returns once the orchestrator has taken the run
lock (or errors if the runner dies on startup); poll `status` or `events`.
Cancellation of a live run goes through `control/cancel.json` so the
orchestrator can kill its worker process groups cleanly.

Liveness checks compare the lock PID against running processes. If the
orchestrator crashed and its PID was reused by an unrelated process, `resume`
keeps refusing; verify the process is not a ccdw runner, delete
`<run_dir>/orchestrator.lock`, and resume again.

`--max-tasks` must be a non-negative integer and pauses a run after that many
task launches. `plan --force --run-id <id>` replaces an existing non-running run
directory from scratch; it refuses to replace a run with a live orchestrator
lock.
