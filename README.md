# ccdw

[日本語版](README.ja.md)

## Overview

This repository currently hosts local Codex agent assets and a Dynamic
Workflows plugin implementation.

Dynamic Workflows turns a task plan into a local declarative workflow run
executed by real `codex exec` subagents. The calling agent authors a
WorkflowSpec JSON; the runner validates it, schedules tasks in parallel with
fail-closed budgets, and writes a workflow specification, runtime state, an
append-only event log, and task artifacts so the workflow can be approved,
executed, watched, resumed, or cancelled.

The plugin is intentionally separate from Codex's built-in `/goal` lifecycle. It
does not hook or replace `/goal`; use the bundled skill or invoke the runner
directly.

## Repository Layout

```text
.
├── AGENTS.md
└── plugins/
    └── dynamic-workflows/
        ├── .codex-plugin/plugin.json
        ├── .mcp.json
        ├── README.md
        ├── package.json
        ├── schemas/
        ├── scripts/
        ├── skills/
        └── tests/
```

ccdw-managed local state and generated artifacts are stored under `.ccdw/` by
default. Set `CCDW_HOME` to relocate that state; relative values are resolved
from the workspace root.

## Dynamic Workflows

The Dynamic Workflows plugin is in `plugins/dynamic-workflows`.

Each run directory contains:

- `workflow.yaml`: the workflow spec (JSON).
- `run.json`: the current runtime snapshot (single-writer, lock-protected).
- `events.ndjson`: an append-only protocol and audit event log.
- `artifacts/`: structured worker results and per-attempt raw output.

Two executors are built in:

- **codex executor**: tasks whose `kind` starts with `codex` run as
  `codex exec` subprocesses with a JSONL event stream, schema-enforced
  structured output, sandbox mapping from `workspace_policy` (read-only unless
  the spec grants workspace write), per-task timeouts with process-group
  kill escalation, and token usage accounting into the run budget. Set
  `CCDW_CODEX_BIN` to override the binary.
- **local executor**: deterministic `local_*` task kinds used by the default
  template and the test suite; no Codex sessions are spawned.

The scheduler is a ready-queue over the phase/task DAG: tasks run as soon as
their dependencies succeed, up to `max_concurrency`, and the run fails closed
when `max_tokens`, `max_duration_ms`, or `max_agents` is exceeded. Retry
policies (`retryable`, `max_attempts`, `backoff_ms`) are honored per task.
Workflow `phase_id` and `task_id` values must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; artifact writes are also checked so task
identifiers cannot escape the run's `artifacts/` directory.

The approval summary reports the actually enforced Codex sandbox. Workers run
with a read-only sandbox unless `workspace_policy.write_scope` includes
`"workspace"`; network access is only supported in that workspace-write mode.
The runner rejects `workspace_policy.shell:true` and
`workspace_policy.mcp_write:true` because those permissions are not enforced by
the current Codex invocation.

## Requirements

- Node.js with ESM support.
- npm, for running the plugin test scripts.
- The `codex` CLI on PATH (only for workflows that use codex tasks).

No package installation is required for the test suite; tests exercise the
codex executor through a bundled fake binary.

## Quick Start

Run the plugin tests:

```bash
cd plugins/dynamic-workflows
npm test
```

Validate the plugin layout:

```bash
cd plugins/dynamic-workflows
npm run validate -- --json
```

Plan a caller-authored workflow from the repository root:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --spec-file my-workflow.json \
  --workspace "$PWD" \
  --json
```

The `plan` command returns a `run_dir` and an `approval.summary` (phases,
per-task prompts, enforced sandbox, budget, spec hash). Use the `run_dir` in
later commands. `plan --objective "..."` without a spec file plans a fixed
local explore/verify/synthesize template, useful as a smoke test.

## Runner Commands

Validate a spec without creating a run:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --spec-file my-workflow.json --dry-run --json
```

Run detached after granting the approval gate (recommended for codex tasks):

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js run \
  --run-dir "<run_dir>" \
  --detach \
  --approve \
  --max-tasks 4 \
  --json
```

`--max-tasks` must be a non-negative integer and pauses after that many task
launches. `plan --force --run-id <id>` replaces an existing non-running run
directory from scratch; it refuses to replace a run with a live orchestrator
lock.

Read status (cheap; safe to poll):

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js status \
  --run-dir "<run_dir>" \
  --json
```

Tail new events incrementally:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js events \
  --run-dir "<run_dir>" \
  --since-offset 0 \
  --json
```

Discover runs:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js list \
  --workspace "$PWD" \
  --json
```

Resume a paused or crashed run, or retry a failed run:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js resume \
  --run-dir "<run_dir>" \
  --resume-failed \
  --json
```

Cancel a non-completed run (live runs are cancelled via the control channel
and their workers are killed):

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js cancel \
  --run-dir "<run_dir>" \
  --reason "No longer needed" \
  --json
```

Validate a run directory:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js validate \
  --run-dir "<run_dir>" \
  --json
```

## Testing

From `plugins/dynamic-workflows`:

```bash
npm test
```

The current tests cover:

- Planning approval-gated runs, including caller-authored specs, dry-run
  validation, dependency-cycle rejection, safe phase/task IDs, retry policy
  validation, and runId path-traversal rejection.
- Approval enforcement and local task execution.
- The ready-queue scheduler (out-of-order phase declarations, concurrency
  overlap, fail-closed token budgets, per-task timeouts, invalid `maxTasks`
  rejection).
- The codex executor against a bundled fake codex binary (JSONL parsing,
  thread id capture, schema-violation quarantine, retry policies).
- Cancellation of live runs via the control channel and of planned runs.
- Detached background execution and crash-safe resume, including
  `--resume-failed`, plus stale-state cleanup for forced re-planning.
- Run discovery (`list`) and incremental event reads (`events`).
- CLI JSON output and plugin layout validation.
- MCP initialization, tool listing, planning, `isError` tool failures,
  LF-only stdio headers, and Codex newline-delimited JSON framing.

## MCP Integration

The plugin includes an MCP server configuration at
`plugins/dynamic-workflows/.mcp.json`.

The configured server starts from the plugin root:

```json
{
  "command": "node",
  "args": ["./scripts/dynamic-workflows-mcp.js"],
  "cwd": "."
}
```

The MCP interface exposes tools for planning (with caller-authored `spec`
objects), approving, running (detached by default; poll status), resuming,
reading status, listing runs, reading incremental events, cancelling, and
validating Dynamic Workflows runs. Tool failures are returned as `isError`
results so the calling model can react without timing out.

## Local Artifacts

Default workflow runs are written under `.ccdw/dynamic-workflows/runs`, which is
ignored by this repository's `.gitignore`.

Set `CCDW_HOME` to relocate ccdw-managed local state. Dynamic Workflows stores
runs under `<CCDW_HOME>/dynamic-workflows/runs`; an explicit CLI `--run-root` or
MCP `runRoot` value overrides `CCDW_HOME` for that run.

## Troubleshooting

If `run` fails with an approval error, either pass `--approve` or approve the run
first.

If a run directory fails validation, inspect:

- `workflow.yaml`
- `run.json`
- `events.ndjson`
- task result files under `artifacts/`

If a detached run looks stuck, check `runner.log` in the run directory and
`status --json` (`runner.active` reports orchestrator liveness). A run whose
orchestrator died recovers with `resume`.

If MCP startup fails, verify that commands are executed from
`plugins/dynamic-workflows` or that `.mcp.json` uses the plugin root as `cwd`.

## Development Notes

- Keep the Dynamic Workflows plugin independent from Codex `/goal`.
- Keep side effects scoped to run directories and local artifacts.
- Prefer structured JSON artifacts over ad hoc text parsing.
- The orchestrator is the single writer of `run.json`; other processes
  communicate through `control/` signal files and the `orchestrator.lock`
  liveness check.
- Add or update tests when changing workflow state transitions, scheduling,
  executor behavior, MCP framing, or schema validation.
