# Dynamic Workflows

Dynamic Workflows is a local Codex plugin that runs a caller-authored
declarative workflow as real `codex exec` or `claude -p` subagents: the
planning agent writes
a WorkflowSpec JSON, the runner validates it, schedules tasks in parallel up to
`max_concurrency`, enforces token/duration/agent budgets fail-closed, and
persists every step for approval, resume, cancellation, and audit.

Each run directory stores:

- `workflow.yaml`: the workflow spec (JSON).
- `run.json`: the current runtime snapshot (single-writer, lock-protected).
- `events.ndjson`: append-only protocol and audit events.
- `artifacts/`: structured worker results (`artifacts/<task_id>/result.json`)
  and per-attempt raw output.

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

Task-level executor fields are explicit and approval-visible. `model` applies
to codex and claude tasks, `profile` applies only to codex tasks (an explicit
task `model` remains visible in argv and wins over any profile model setting),
and `effort` applies only to claude tasks with one of `low`, `medium`, `high`,
`xhigh`, or `max`. New plans reject unsupported combinations, local-task
executor fields, and `model`/`profile` values outside
`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$`. Stored runs remain lenient on reload,
but v0.5.0 refuses spawned executor values that are argv-unsafe (leading `-`,
whitespace/control characters, or more than 512 characters) before starting the
worker.

`local_*` kinds run a deterministic no-LLM executor used by the default
template and the test suite.

The enforced sandbox is `read-only` unless `workspace_policy.write_scope`
includes `"workspace"`, in which case it becomes `workspace-write` (claude
filesystem writes are limited to the workspace root); network access is only
passed through for codex tasks in that workspace-write mode.
`workspace_policy.network:true` is rejected at plan time for workflows
containing claude tasks because the claude sandbox has no enforceable
allow-all network mechanism. The runner rejects `workspace_policy.shell:true`
and `workspace_policy.mcp_write:true` because those permissions are not
enforced by the current worker invocations.

Plan-time validation is strict: `entry_condition` / `condition` accept only
`always` (with empty `depends_on`) or `dependencies_succeeded`,
`completion_condition` only `all_tasks_succeeded`, task `stop_condition` only
`budget_or_cancelled`, and `fanout_source` must stay `null` (expand fan-out at
plan time). `max_cost`, `max_retries`, `max_no_progress_iterations`,
`verification_required`, and `verification_policy` are accepted but advisory;
the approval summary lists them under `advisory_fields` so approval reflects
what the runner actually enforces. Already-planned run directories are re-read
with the previous, lenient rules.

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
node scripts/dynamic-workflows.js plan --spec-file spec.json --dry-run --json   # validate only
node scripts/dynamic-workflows.js plan --objective "Review this repository" --json  # scaffold template
node scripts/dynamic-workflows.js run --run-dir <run_dir> --detach --approve --max-tasks 4 --json
node scripts/dynamic-workflows.js status --run-dir <run_dir> --json
node scripts/dynamic-workflows.js events --run-dir <run_dir> --since-offset 0 --json
node scripts/dynamic-workflows.js list --workspace "$PWD" --json
node scripts/dynamic-workflows.js resume --run-dir <run_dir> --resume-failed --json
node scripts/dynamic-workflows.js cancel --run-dir <run_dir> --reason "No longer needed" --json
```

By default, runs are stored under `.ccdw/dynamic-workflows/runs`. Set
`CCDW_HOME` to relocate ccdw-managed local state, or pass `--run-root` for a
single run.

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
