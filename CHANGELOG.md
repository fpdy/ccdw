# Changelog

## v0.2.1 - 2026-06-10

### Fixed

- `resume --resume-failed` now requeues skipped tasks alongside failed ones, so a task that was skipped because its blocker failed runs once the blocker succeeds on resume; tasks whose blocker fails again are re-skipped by the scheduler instead of being left behind permanently.
- `resume --resume-failed` now also accepts completed runs with a `partial` outcome, re-running only the failed/skipped tasks while reusing succeeded results; previously such runs were terminal and could only be re-planned from scratch. The `resume_requested` event records the originating run status as `from_status`. Completed runs with a `success` outcome remain a resume noop.
- The CLI no longer coerces digit-only values of string flags into numbers, so `plan --run-id 123` (and numeric `--objective`, `--reason`, `--approved-by` values) work instead of failing with a raw TypeError. Only `--max-tasks`, `--since-offset`, and `--limit` are parsed as numbers, and boolean flags reject values other than `true`/`false`. `planWorkflow` additionally rejects non-string `runId` values defensively.

### Changed

- SKILL.md's recovery section and the MCP resume tool description document resuming partial completed runs and the skipped-task requeue behavior.

## v0.2.0 - 2026-06-10

### Added

- Added a real codex worker executor: tasks whose `kind` starts with `codex` run as `codex exec` subprocesses with a JSONL event stream, `--output-schema`-enforced structured worker results, sandbox mapping from `workspace_policy`, per-task timeouts with process-group signal escalation, captured thread ids, and token usage accounting (verified end-to-end against codex-cli 0.137.0). `CCDW_CODEX_BIN` overrides the binary.
- Added caller-authored workflow plans: `plan --spec-file <file>` (CLI) and a `spec` object on the MCP plan tool, with default filling, strict validation (on_failure enum, phase/task cross-references, dependency cycle detection), and `--dry-run` validation without side effects.
- Added a ready-queue scheduler: tasks launch as soon as dependencies succeed, run concurrently up to `max_concurrency`, honor per-task retry policies, and the run fails closed on `max_tokens`, `max_duration_ms`, or `max_agents`.
- Added detached background execution (`run --detach`, default for the MCP run tool) with `orchestrator.lock` PID tracking, `runner.log`, and heartbeats.
- Added `list` (run discovery) and `events --since-offset` (incremental event reads) to the CLI and MCP surface.
- Added `resume --resume-failed` to retry failed tasks while reusing succeeded results, with orphaned-attempt cleanup and a spec-hash check that refuses to resume a modified workflow.
- Extended the approval summary with the spec hash, phase list, per-task roles and prompt summaries, concurrency/agent caps, and the enforced Codex execution sandbox.
- Added tests covering the codex executor (via a bundled fake codex binary), concurrency overlap, timeouts, budget enforcement, schema-violation quarantine, retries, live-run cancellation, detached runs, resume-after-failure, run listing, incremental events, spec files, cycle detection, safe phase/task id validation, retry policy validation, invalid `maxTasks` rejection, forced re-plan cleanup, runId traversal rejection, and MCP `isError` responses.

### Changed

- Run execution is now asynchronous; `run.json` has a single writer (the orchestrator) guarded by a lock file, and external cancellation of a live run flows through `control/cancel.json` so worker process groups are killed cleanly instead of clobbering state.
- A cancel that lands mid-run is no longer overwritten by the phase-failure path, and runs no longer report success while tasks remain queued (unsatisfiable dependencies now fail the run).
- MCP tool failures are returned as `isError` tool results with the request id instead of `id:null` protocol errors that left clients hanging.
- The MCP plan tool whitelists its inputs and `runId` values are validated against a safe pattern with run-root containment, closing a path traversal hole.
- Workflow `phase_id` and `task_id` values are now validated against a safe pattern, and artifact writes are contained under the run's `artifacts/` directory to prevent caller-authored specs from escaping the run directory.
- `retry_policy` and `maxTasks` inputs are validated strictly; malformed values now fail fast instead of leaving queued work in an infinite scheduler loop.
- Unsupported `workspace_policy.shell:true` and `workspace_policy.mcp_write:true` requests are rejected, and the approval summary now reports only the sandbox/network permissions actually passed to `codex exec`.
- `plan --force` replaces non-running run directories from scratch, removing stale event logs and artifacts; live orchestrator locks are still respected.
- Worker result validation aligned with the published schema (`rejection_reason` required, empty `verifier_notes` allowed); attempt ids are collision-free and codex attempts keep per-attempt artifact directories.
- `status` no longer re-reads the whole event log per call (event counts are tracked incrementally), and the objective length cap was raised to 16000 characters.
- Rewrote SKILL.md around the new contract: the calling agent is the planner; approval requires rendering the summary to the user; monitoring uses detach + status/events polling; recovery paths are documented.

## v0.1.0 - 2026-06-10

### Added

- Added the Dynamic Workflows Codex plugin with a local workflow planner, approval-gated runner, resumable run state, cancellation, append-only events, and schema validation.
- Added CLI and MCP entrypoints for planning, running, approving, resuming, cancelling, inspecting, and validating workflow runs.
- Added tests for core workflow state transitions, CLI JSON output, plugin layout validation, MCP tool behavior, and Codex newline-delimited JSON framing.

### Changed

- Store ccdw-managed local state under `.ccdw/` by default instead of `docs/local`.
- Added `CCDW_HOME` support for relocating ccdw-managed local state, with explicit `runRoot` and `--run-root` values taking precedence.
- Removed Japanese response language policy from the ccdw project instructions.
