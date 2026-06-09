---
name: dynamic-workflows
description: Plan, run, inspect, resume, or cancel a local declarative workflow for a Codex task without using native /goal integration.
---

# Dynamic Workflows

Use this skill when the user asks Codex to break a task into a local dynamic
workflow, run a previously planned workflow, inspect workflow status, resume a
workflow, or cancel a workflow. This plugin does not hook or replace the
built-in `/goal` command.

## Runner

Resolve the runner relative to this skill file:

```bash
node ../../scripts/dynamic-workflows.js <command>
```

If you are not running from `plugins/dynamic-workflows/skills/dynamic-workflows`,
resolve the plugin root first and call:

```bash
node <plugin-root>/scripts/dynamic-workflows.js <command>
```

## Workflow

1. Create a plan:

   ```bash
   node <plugin-root>/scripts/dynamic-workflows.js plan \
     --objective "<task objective>" \
     --workspace "<repo root>" \
     --json
   ```

2. Review the approval summary in the JSON result before execution.
3. Run only after approval is appropriate for the current user request:

   ```bash
   node <plugin-root>/scripts/dynamic-workflows.js run \
     --run-dir "<run_dir>" \
     --approve \
     --json
   ```

4. Use `status`, `resume`, or `cancel` for follow-up operations.

The runner writes `workflow.yaml`, `run.json`, `events.ndjson`, and `artifacts/`
under the selected run directory. Keep final answers concise and report the run
directory plus the command results that matter.

## Guardrails

- Treat workflow execution as separate from Codex's native `/goal` lifecycle.
- Do not assume native `/goal` integration exists.
- Do not grant shell, network, or MCP write permissions implicitly.
- Prefer read-only or local-artifact-only workflow steps until the user asks for
  side-effecting execution.
- If a run is paused for permission, budget, or validation reasons, report the
  exact status and do not mark it complete.
