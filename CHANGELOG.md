# Changelog

## v0.7.0 - 2026-06-13

### Added

- New worker kind `acp_opencode`: tasks execute as `opencode acp` subprocesses
  driven over ACP (Agent Client Protocol, nd-JSON-RPC over stdio), one process
  per attempt, alongside the existing `codex*` (`codex exec`) and `claude*`
  (`claude -p`) kinds. Set `CCDW_OPENCODE_BIN` to override the opencode binary
  (absolute path recommended — PATH wrappers can defeat the isolation env).
  Verified against opencode 1.16.2.
- Plan-time rules for acp tasks: only the exact kind `acp_opencode` is
  accepted (other `acp*` values are rejected); `model` is REQUIRED (ACP model
  id namespace, e.g. `openrouter/anthropic/claude-haiku-4.5`, fixed per
  session via `session/set_model` with a failed set_model failing the
  attempt); `effort`, `profile`, `output_schema`, `route`,
  `workspace_policy.network:true`, and acting as a `foreach` producer are
  rejected; foreach children and `gates` are allowed.
- Approval disclosure for acp tasks: no OS-level sandbox exists — enforcement
  is the injected opencode permission config (read-only scope denies
  bash/edit; write scope allows them) plus ccdw auto-rejecting every
  `session/request_permission` ask, and network isolation is NOT guaranteed in
  write scope. The approval summary also discloses that write-scope bash can
  write outside the workspace root, workers inherit non-`OPENCODE_*`
  environment variables, permission enforcement depends on an honest opencode
  binary, and `prompt.txt`/`acp-frames.jsonl` artifacts may contain sensitive
  content. Specs without acp tasks keep byte-identical summaries.
- opencode config injection and ambient isolation: a per-run generated
  permission config is injected via a spawn-time env recipe
  (`XDG_CONFIG_HOME` isolation, `OPENCODE_CONFIG`,
  `OPENCODE_DISABLE_PROJECT_CONFIG`, and related disable flags) that blocks
  global/project config, plugins, CLAUDE.md, and skills; the opencode data dir
  (auth/session DB) remains ambient. Token usage is counted into the run
  budget from ACP `PromptResponse.usage`. Worker results follow the same JSON
  envelope, but schema adherence is prompt contract plus runner re-validation
  only (no CLI-side schema enforcement exists for ACP), so the existing
  `schema_violation` quarantine/retry applies — prefer codex/claude kinds for
  schema-critical tasks. Phase 0 verification record:
  `docs/local/dynamic-workflows-smoke-runs/acp-phase0-20260613/RESULTS.md`.
- ACP executor hardening: handshake requests have response timeouts while the
  prompt turn remains attempt-timeout bounded; the attempt timeout is cleared
  once the prompt settles so teardown cannot relabel a successful turn as
  `timed_out`; oversized protocol lines and accumulated agent-message text are
  capped with `messageOverflow` failing closed; `acp-frames.jsonl` is capped at
  16 MiB per attempt; repeated permission requests are capped in `events.ndjson`
  with a `permission_request_flood` summary; and the ACP client version is
  pinned to the plugin release surface. Each ACP attempt also records a
  best-effort `opencode --version` probe in `launch_started` for audit and
  smoke-result correlation; probe failures are coarse-status audit data and do
  not block execution.

## v0.6.0 - 2026-06-12

### Changed (breaking)

- Backward compatibility is dropped entirely: `schema_version` is bumped to
  `dynamic-workflows.v2`, and run directories planned with earlier versions
  are rejected by `status`/`run`/`resume`/`validate` with an explicit
  "unsupported schema_version; re-plan required" error.
- The lenient re-read path for stored runs is removed. Stored specs are
  re-validated with the same strict rules as new plans; there is no longer a
  separate lenient ruleset for already-planned run directories.
- Five v1 fields are removed and now fail plan-time validation with pointers
  to their replacements: task `expected_output_schema` (→ `output_schema`),
  task/phase `verification_required` and workflow `verification_policy`
  (→ task `gates`), and `fanout_source` (→ task `foreach`). The approval
  summary's `advisory_fields` shrinks to `max_cost`, `max_retries`, and
  `max_no_progress_iterations`.

### Added

- F0 typed task output: optional task `output_schema` declares a restricted
  JSON-Schema subset (whitelisted keywords `type`/`properties`/`items`/`enum`/
  `description`/`title`; root object; depth ≤ 4, ≤ 64 properties, ≤ 8 nullable
  `["X","null"]` unions, ≤ 32 KB; string-only enums). The runner generates
  `required` and injects `additionalProperties: false`, synthesizes the worker
  envelope v2 per task (typed tasks report `{task_id, attempt_id, status,
  summary, errors, output}` and drop the self-report audit fields), and keeps
  double validation plus quarantine; `result.output` is the reference target
  for templates, route, and foreach. Rejected for local task kinds.
- F1 YAML authoring (CLI-only): `plan --spec-file` accepts `.yaml`/`.yml`,
  parsed with the `yaml` package (YAML 1.2, duplicate keys rejected,
  anchors/aliases forbidden via `maxAliasCount: 0`, 1 MiB input cap,
  `file:line:col` errors) and normalized to JSON before storage, so the stored
  spec bytes and the spec-hash mechanism are unchanged. New dependency:
  `yaml@^2`.
- F2 `{{...}}` templates in `prompt_template`: pure substitution of
  `{{objective}}`, `{{inputs.*}}` (saved workflows only; plain specs reject
  it), `{{tasks.<id>.result.<dotpath>}}`,
  `{{item}}`, and `{{gate_feedback}}`, statically validated at plan time
  (producer must be in the consumer's `depends_on` transitive closure, dotpath
  must resolve against the producer's synthesized schema, nullable properties
  and array indexing are rejected, `{{` is forbidden in `gates[].command`).
  Objects/arrays render as compact JSON; a defensive runtime resolution
  failure fails the task without retry and records a
  `template_resolution_failed` event.
- F3 command gates: `gates: [{command, timeout_ms}]` run sequentially after a
  schema-valid worker result while the task holds its concurrency slot; any
  non-zero exit or timeout yields the new `gate_failed` status (terminal,
  retryable, resumable) under the task's single `retry_policy.max_attempts`
  counter shared with worker failures. Gates run argv-only with no OS sandbox,
  `cwd` pinned to the workspace root, and an env allowlist
  (`PATH`/`HOME`/`TMPDIR`/`LANG`/`LC_ALL`); the approval summary lists every
  command verbatim. Per-attempt artifacts `gate-<n>.stdout.log`/
  `gate-<n>.stderr.log` (1 MiB cap) and `gate-verdict.json`, events
  `gate_started`/`gate_result`, and `{{gate_feedback}}` retry injection
  (4096-byte tails by default, `gate_feedback_tail_bytes` ≤ 16384;
  auto-appended on retries when the placeholder is absent).
- F4 enum branching: task `route` (`values`, `cases`, required `default`)
  injects a required `route` string enum into the worker envelope and resolves
  once on the routing task's final (post-gates) success, recording a
  `route_resolved` event; unselected case tasks get the new
  `skipped_by_route` status (terminal, satisfies dependencies, never fails or
  cascades, excluded from resume, reported separately as `routed_skipped`).
  Case arrays are unordered activation sets (ordering stays in `depends_on`);
  plan-time topology rules enforce cases ⊆ values, routing-task dependency
  closure for case tasks, no out-of-route dependencies on case tasks, at most
  one route per case task, route/foreach exclusivity, and route-consistent
  template references.
- F5 saved workflows: templates under `<CCDW_HOME>/workflows/<name>.{json,
  yaml,yml}` (safe-name pattern plus containment check) with typed `inputs`
  (`string`/`integer`/`number`/`boolean`, `required`/`default`); CLI
  `plan --workflow <name> --input key=value` coerces strings by declared type,
  MCP `workflow`+`inputs` validates typed JSON without coercion; unknown,
  missing-required, or mistyped inputs fail the plan. `{{inputs.*}}` expands
  in `objective`/`prompt_template` before the normal pipeline (the spec hash
  covers the expanded spec) and provenance (template name, path, hash,
  resolved inputs) is recorded in the plan result and approval summary.
- F6 bounded foreach fan-out: task `foreach` (`items` as a single whole-field
  producer-array reference, required `max_items`, `concurrency`,
  `tolerated_failure_count`) expands the parent (new non-terminal `expanded`
  status) into `<parent>.<index>` children that inherit executor fields,
  `output_schema`, and `gates`, recording a `tasks_expanded` event (fail-closed
  when serialized items exceed 256 KB). More items than `max_items` fails the
  parent without truncation; zero items succeed with an empty aggregate; the
  plan is rejected unless static tasks + Σ `max_items` ≤ `max_agents`; child
  concurrency is `min(foreach.concurrency, max_concurrency)`. The runner
  aggregates ordered child results into the parent's `result.output.results`,
  succeeds within `tolerated_failure_count`, and resume rebuilds expansions by
  replaying `tasks_expanded` events.

### Fixed

- `validate-plugin-layout` now checks the complete runtime layout: the
  `requiredFiles` list grew from 12 to 26 entries, adding `package.json`, the
  `core.js` facade, and every v0.6.0 `scripts/lib` module. A missing module
  previously crashed the CLI with `ERR_MODULE_NOT_FOUND` (fail-closed but
  unstructured) instead of appearing in the structured `missing` report; a
  negative regression test (`tests/plugin-layout.test.js`) pins the new
  behavior.
- The V7 route co-activation check now inspects reachable resolutions only,
  matching V6 and the runtime `cases[value] ?? default` semantics. A `default`
  list that is unreachable because every route value has an explicit case no
  longer triggers false plan rejections of safe `prompt_template` /
  `foreach.items` references.
- `workflow.schema.json` now forbids `gates`, `gate_feedback_tail_bytes`,
  `route`, and `foreach` for local task kinds (in addition to
  `model`/`effort`/`profile`/`output_schema`), closing a schema-vs-runtime
  divergence where the JSON Schema accepted fields the runtime rejects.

### Documentation

- Root READMEs (`README.md`, `README.ja.md`), the plugin README, SKILL.md,
  the MCP tool descriptions, and `workflow.schema.json` document the v2
  spec surface: `output_schema`, templates, `gates`, `route`, `foreach`,
  saved workflows, YAML authoring, the new statuses/events, and the
  compatibility break. SKILL.md's planning rules now cover route design
  guidance (multi-value branching instead of OK/ABORT), the
  depends_on-closure rule for template references, gate disclosure, and
  foreach budgeting.

### Known limitations

- A retry-pending task that settles in the same scheduler drain window as a
  sibling can let downstream tasks be skipped before the retry actually runs
  (pre-existing fold-order race). Recover with
  `resume --resume-failed`.
- Plain `resume` requeues only tasks that were `running` when the runner
  stopped; terminal `gate_failed`/`failed` tasks need `--resume-failed`
  (pre-existing).

## v0.5.0 - 2026-06-12

### Changed (breaking for new plans)

- Added explicit task-level executor fields. `model` is supported for codex and
  claude tasks, `profile` is codex-only, and `effort` is claude-only with
  values `low`, `medium`, `high`, `xhigh`, or `max`. New plans reject
  unsupported executor/field combinations, invalid model/profile strings, and
  executor fields on local tasks; rejection messages for codex `effort` point
  to `model_reasoning_effort` via a codex profile instead. Approval summaries
  include these fields when present so consent matches the worker argv.
- Spawned executor argv now rejects unsafe stored values before worker launch:
  leading `-`, whitespace, control characters, or values longer than 512
  characters. This can cause pre-v0.5.0 stored runs with unsafe `model`,
  `profile`, or `effort` values to fail before spawning the worker; local tasks
  remain unaffected.

### Fixed

- Approval, run, resume, and detached startup now verify the stored spec hash
  before execution-sensitive mutations. The workflow bytes are read once,
  hashed, and parsed from the same bytes, preventing an approved run from
  executing a swapped `workflow.yaml`.
- `run --approve` validates the spec before writing the approval event, and
  detached startup validates before writing `runner.log` or spawning the
  background runner. Completed/tampered runs now fail integrity checks before
  `run_noop` / `resume_noop` events are appended.
- Claude attempts record resolved model telemetry as `models_used` arrays from
  raw `modelUsage` result events, with raw stream events retained in
  `claude-events.jsonl`.

### Documentation

- README, SKILL.md, MCP tool descriptions, and `workflow.schema.json` document
  `model`, `profile`, `effort`, task `timeout_ms`, and the executor-family
  field contract. `README.ja.md` is synced with the executor-field and
  spec-hash verification paragraphs.

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
