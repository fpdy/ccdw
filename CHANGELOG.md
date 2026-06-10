# Changelog

## v0.4.0 - 2026-06-11

### Added

- Claude Code worker dispatch: task `kind` values starting with `claude`
  (recommended: `claude_agent`) now execute as `claude -p` subagents alongside
  the existing `codex*` and `local_*` families. Workers run with
  `--output-format stream-json`, structured results enforced via `--json-schema`
  (the shared `WORKER_OUTPUT_SCHEMA`, still double-validated and quarantined by
  the runner), a generated fail-closed sandbox settings file
  (`failIfUnavailable: true`, `allowUnsandboxedCommands: false`,
  `denyWrite`/`allowWrite` derived from `workspace_policy.write_scope`, empty
  network allowlist), all ambient user/project/local settings excluded via
  `--setting-sources ""`, customizations disabled via `--safe-mode`, built-in
  tools restricted per mode (`--tools` + `--allowedTools` + `--disallowedTools`
  incl. `mcp__*`), `--permission-mode default|dontAsk`, and
  `--no-session-persistence`. Session ids are recorded for audit,
  `total_cost_usd` accumulates into `budget_usage.cost` (advisory), and budget
  tokens are charged once per attempt from the final `result` event —
  including `cache_creation_input_tokens` (only cache reads stay uncounted).
  Success requires `is_error: false` in addition to exit code 0 (auth failures
  surface as `is_error: true` with exit 0 and subtype "success"). Set
  `CCDW_CLAUDE_BIN` to override the binary; requires claude CLI 2.1.x or later.
- Plan-time strict validation rejects `workspace_policy.network: true` for
  workflows containing claude tasks: the claude sandbox has no enforceable
  allow-all network mechanism (per-domain allowlists only), and the approval
  summary must not overstate reachability. Codex-only workflows are unchanged.
  Stored runs are still re-read leniently.
- The approval summary's `execution_sandbox` gains a per-executor `executors`
  block when claude tasks are present (permission mode, tool set, OS sandbox,
  `setting_sources: "none (all ambient excluded)"`, `--safe-mode`); codex-only
  summaries are byte-identical to v0.3.1.
- `tests/fixtures/fake-claude.js` test double reproducing the claude
  stream-json contract (incl. the exit-0/`is_error` trap, structured-output
  retry exhaustion, and cache-creation token accounting) plus 14 new tests.

### Changed

- Subprocess plumbing (spawn, process-group kill escalation, timeout, NDJSON
  line framing, stderr tail) is extracted from the codex executor into the
  shared `scripts/lib/process-runner.js`; both executors interpret only their
  own event types. Behavior-preserving, with one hardening: `cancel()` after
  the worker already exited is now a no-op instead of arming stray
  SIGTERM/SIGKILL escalation timers against a possibly recycled process group.
- The codex-specific plan error for network-without-workspace-write is
  generalized to "workspace_policy.network requires write_scope to include
  workspace (runner policy)" (same behavior, executor-neutral wording).

### Documentation

- Root READMEs, the plugin README, SKILL.md, and the MCP `plan` tool
  description now describe the three executor families, `CCDW_CLAUDE_BIN`, the
  claude network rejection, and the once-per-attempt claude token accounting.
  Operational note: because ambient settings are excluded, `apiKeyHelper`-based
  auth does not reach claude workers (export `ANTHROPIC_API_KEY` instead), and
  the user-level `model` setting does not apply (set task-level `model`).

## v0.3.1 - 2026-06-10

### Fixed

- `run --detach --json` from the CLI no longer exits 0 with empty stdout: the detach startup poll awaited an unref'd timer while the spawned child and log descriptor were already released, so a bare CLI process drained its event loop and exited before printing the summary (and before the v0.3.0 dead-runner detection could ever fire). The poll now uses a ref'd timer; the orchestrator-loop sleeps stay unref'd. Covered by a CLI-subprocess regression test, since in-process tests cannot reproduce the early exit.
- Plan-time strict validation now checks `input_source`: omitted or `null` values normalize to `"objective"`, and explicit values must be `"objective"`, `"accepted_worker_results"`, a non-empty path string, or a non-empty array of non-empty path strings. Previously `input_source: [123]` passed `--dry-run` as valid and failed at runtime with a `path` TypeError in the executor. Stored runs are still re-read leniently.

### Documentation

- SKILL.md's planning rules document the accepted `input_source` forms.

## v0.3.0 - 2026-06-10

### Changed (breaking for new plans)

- Plan-time spec validation is strict about fields the engine does not implement: `entry_condition` / `condition` accept only `always` (with empty `depends_on`) or `dependencies_succeeded`, `completion_condition` only `all_tasks_succeeded`, task `stop_condition` only `budget_or_cancelled`, and `fanout_source` must stay `null`. Previously these values were accepted and silently ignored. Already-planned run directories are still re-read with the lenient rules, so existing runs keep working.
- The approval summary now lists `advisory_fields` (`max_cost`, `max_retries`, `max_no_progress_iterations`, `verification_required`, `verification_policy`) as recorded-but-not-enforced, and its `budget` block only shows the budgets the runner actually enforces (`max_tokens`, `max_duration_ms`). `workflow.schema.json` documents the strict enums.

### Added

- `run --detach` now waits up to ~2 seconds for the spawned orchestrator to take the run lock and fails with a `runner.log` pointer if the runner dies on startup, instead of reporting `detached: true` for a dead-on-arrival child (closes the double-detach race). `detachWorkflowRun` is async accordingly.
- A spec-authored `input_source` that resolves outside the run directory and workspace root now records an `input_path_warning` audit event before the worker launches.

### Fixed

- Worker promises that survive the abort grace period (cancellation or fail-closed budget stops) no longer write task/attempt state or events after the orchestrator has folded the run, so a zombie continuation cannot rewrite `run.json` after the run lock is released.

### Documentation

- README and SKILL.md document the strict plan-time validation, the advisory fields, the approximate token accounting (cached input tokens uncounted, multi-turn input re-counted per turn), and the manual `orchestrator.lock` removal recovery for PID-reuse false positives. The MCP plan tool description notes that overwriting an existing runId requires the CLI's `plan --force`.

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
