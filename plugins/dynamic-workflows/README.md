# Dynamic Workflows

Dynamic Workflows is a local Codex plugin that turns a task objective into a
declarative workflow run. It stores:

- `workflow.yaml`: a YAML-compatible JSON workflow spec.
- `run.json`: the current runtime snapshot.
- `events.ndjson`: append-only protocol and audit events.
- `artifacts/`: structured worker results and synthesis output.

The plugin intentionally does not hook or replace Codex's built-in `/goal`
command. Invoke the bundled skill or call the runner directly.

## Commands

```bash
node scripts/dynamic-workflows.js plan --objective "Review this repository" --json
node scripts/dynamic-workflows.js run --run-dir .codex-dynamic-workflows/runs/<run_id> --approve --json
node scripts/dynamic-workflows.js status --run-dir .codex-dynamic-workflows/runs/<run_id> --json
node scripts/dynamic-workflows.js resume --run-dir .codex-dynamic-workflows/runs/<run_id> --json
node scripts/dynamic-workflows.js cancel --run-dir .codex-dynamic-workflows/runs/<run_id> --reason "No longer needed" --json
```

The first implementation uses a deterministic local worker executor so the
state machine, approval gate, event log, resume path, and schema validation can
be tested without spawning nested Codex sessions.
