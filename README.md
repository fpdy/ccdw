# ccdw

[日本語版](README.ja.md)

## Overview

This repository currently hosts local Codex agent assets and a Dynamic
Workflows plugin implementation.

Dynamic Workflows turns a task objective into a local declarative workflow run.
It writes a workflow specification, runtime state, an append-only event log, and
task artifacts so the workflow can be approved, executed, inspected, resumed, or
cancelled.

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

`docs/local` is reserved for ephemeral local documents, smoke-test outputs, and
other working artifacts. Do not treat files in that directory as durable project
documentation.

## Dynamic Workflows

The Dynamic Workflows plugin is in `plugins/dynamic-workflows`.

Each run directory contains:

- `workflow.yaml`: a YAML-compatible JSON workflow spec.
- `run.json`: the current runtime snapshot.
- `events.ndjson`: an append-only protocol and audit event log.
- `artifacts/`: structured worker results and synthesis output.

The current implementation uses a deterministic local worker executor. This
allows the state machine, approval gate, event log, resume path, cancellation,
MCP interface, and schema validation to be tested without spawning nested Codex
sessions.

## Requirements

- Node.js with ESM support.
- npm, for running the plugin test scripts.

No package installation is required for the current test suite.

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

Create a local workflow run from the repository root:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --objective "Review this repository" \
  --workspace "$PWD" \
  --json
```

The `plan` command returns a `run_dir`. Use that value in later commands.

## Runner Commands

Plan a run:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js plan \
  --objective "Review this repository" \
  --workspace "$PWD" \
  --json
```

Run after granting the approval gate:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js run \
  --run-dir "<run_dir>" \
  --approve \
  --json
```

Read status:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js status \
  --run-dir "<run_dir>" \
  --json
```

Resume a paused run:

```bash
node plugins/dynamic-workflows/scripts/dynamic-workflows.js resume \
  --run-dir "<run_dir>" \
  --json
```

Cancel a non-completed run:

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

- Planning an approval-gated run directory.
- Approval enforcement.
- Successful local task execution.
- Resume behavior for terminal runs.
- Cancellation of non-terminal runs.
- CLI plan and run JSON output.
- Plugin layout validation.
- MCP initialization, tool listing, and planning.
- LF-only MCP stdio headers.
- Codex newline-delimited JSON MCP framing.

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

The MCP interface exposes tools for planning, approving, running, resuming,
reading status, cancelling, and validating Dynamic Workflows runs.

## Local Artifacts

Default workflow runs are written under `.codex-dynamic-workflows/runs`, which
is ignored by this repository's `.gitignore`.

Use `docs/local` for local notes, smoke-test outputs, and temporary reports that
are useful while developing or verifying behavior.

## Troubleshooting

If `run` fails with an approval error, either pass `--approve` or approve the run
first.

If a run directory fails validation, inspect:

- `workflow.yaml`
- `run.json`
- `events.ndjson`
- task result files under `artifacts/`

If MCP startup fails, verify that commands are executed from
`plugins/dynamic-workflows` or that `.mcp.json` uses the plugin root as `cwd`.

## Development Notes

- Keep the Dynamic Workflows plugin independent from Codex `/goal`.
- Keep side effects scoped to run directories and local artifacts.
- Prefer structured JSON artifacts over ad hoc text parsing.
- Add or update tests when changing workflow state transitions, MCP framing, or
  schema validation behavior.
