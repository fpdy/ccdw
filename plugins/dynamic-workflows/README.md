# Dynamic Workflows

Dynamic Workflows is a local Codex plugin that runs a caller-authored
declarative workflow as real `codex exec` subagents: the planning agent writes
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
`local_*` kinds run a deterministic no-LLM executor used by the default
template and the test suite. Set `CCDW_CODEX_BIN` to override the codex binary.

The enforced Codex sandbox is `read-only` unless
`workspace_policy.write_scope` includes `"workspace"`, in which case it becomes
`workspace-write`; network access is only passed through for that
workspace-write mode. The runner rejects `workspace_policy.shell:true` and
`workspace_policy.mcp_write:true` because those permissions are not enforced by
the current Codex invocation.

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
output in `runner.log`) and returns immediately; poll `status` or `events`.
Cancellation of a live run goes through `control/cancel.json` so the
orchestrator can kill its worker process groups cleanly.

`--max-tasks` must be a non-negative integer and pauses a run after that many
task launches. `plan --force --run-id <id>` replaces an existing non-running run
directory from scratch; it refuses to replace a run with a live orchestrator
lock.
