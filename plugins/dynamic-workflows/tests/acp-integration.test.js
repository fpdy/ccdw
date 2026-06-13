import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelWorkflow,
  planWorkflow,
  readRunState,
  readWorkflowEvents,
  runWorkflow,
} from "../scripts/lib/core.js";

// End-to-end coverage for the acp_opencode executor (design §4.7): every case
// drives the real plan -> approve -> execute path with CCDW_OPENCODE_BIN
// pointing at the fake ACP agent, mirroring how core.test.js exercises the
// codex/claude executors through their fake binaries.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeAcpBin = path.join(pluginRoot, "tests", "fixtures", "fake-acp-agent.js");

const ACP_MODEL = "openrouter/anthropic/claude-haiku-4.5";

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-acp-test-"));
}

async function withEnvAsync(pairs, callback) {
  const originals = new Map();
  for (const [name, value] of Object.entries(pairs)) {
    originals.set(name, process.env[name]);
    if (value == null) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await callback();
  } finally {
    for (const [name, original] of originals) {
      if (original == null) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  }
}

function acpSpec({ tasks, phases, ...overrides }) {
  return {
    name: "acp test workflow",
    objective: "Exercise the acp executor with a fake agent",
    phases,
    tasks,
    max_concurrency: 1,
    ...overrides,
  };
}

function singleAcpTaskSpec(taskOverrides = {}, specOverrides = {}) {
  return acpSpec({
    phases: [{ phase_id: "p1", tasks: ["t1"] }],
    tasks: [
      {
        task_id: "t1",
        phase_id: "p1",
        kind: "acp_opencode",
        role: "tester",
        prompt_template: "Run task one.",
        model: ACP_MODEL,
        ...taskOverrides,
      },
    ],
    ...specOverrides,
  });
}

async function pollUntil(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function attemptInfo(runDir, taskId = "t1", index = 0) {
  const state = readRunState(runDir);
  const attemptId = state.tasks[taskId].attempts[index];
  const attempt = state.attempts[attemptId];
  return { state, attemptId, attempt, attemptDir: path.join(runDir, attempt.artifact_dir) };
}

function taskFailureEvent(runDir, taskId, status) {
  const { events } = readWorkflowEvents({ runDir });
  return events.find(
    (event) =>
      event.type === "task_status_changed" &&
      event.payload.task_id === taskId &&
      event.payload.status === status,
  );
}

// Case 1 (+ cases 11, 13, and the isolation-recipe assertion): success with a
// fence-wrapped final message, full artifact/audit surface, usage accounting,
// and the spawn-env recipe proven through the fixture trace.
test("acp executor runs a worker end-to-end with a fenced final message", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "acp-trace.jsonl");
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const completed = await withEnvAsync(
    {
      CCDW_OPENCODE_BIN: fakeAcpBin,
      FAKE_ACP_MODE: "success",
      FAKE_ACP_FENCED: "1",
      FAKE_ACP_VERSION: "FakeOpenCode 9.9.9",
      FAKE_ACP_TRACE: tracePath,
      // Decoy: the executor must scrub inherited OPENCODE_* before spawning.
      OPENCODE_CONFIG_DIR: "/decoy/opencode-config-dir",
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  // D7-r2 usage mapping: input 100 + cachedWrite 30 = 130, output 50,
  // reasoning (thought) 10; cached reads stay uncounted.
  assert.equal(completed.budget_usage.tokens, 190);

  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.equal(result.task_id, "t1");
  assert.equal(result.status, "succeeded");
  // Fence-stripped parse: the fixture wrapped the envelope in ```json fences.
  assert.equal(result.summary, "fake ok");

  const { attemptId, attempt, attemptDir } = attemptInfo(planned.run_dir);
  assert.ok(attempt.thread_id.startsWith("fake-ses"), `thread_id: ${attempt.thread_id}`);
  assert.equal(result.attempt_id, attemptId);

  // R6 artifacts: raw protocol frames plus the rendered prompt.
  const frames = readJsonLines(path.join(attemptDir, "acp-frames.jsonl"));
  assert.ok(frames.length > 0, "expected acp-frames.jsonl to be non-empty");
  assert.ok(frames.some((frame) => frame.dir === "send" && frame.msg?.method === "initialize"));
  assert.ok(frames.some((frame) => frame.dir === "recv" && frame.msg?.result?.stopReason === "end_turn"));

  const promptText = fs.readFileSync(path.join(attemptDir, "prompt.txt"), "utf8");
  assert.ok(promptText.includes("Exercise the acp executor with a fake agent"));
  assert.ok(promptText.includes("Task instructions: Run task one."));

  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const launch = events.find((event) => event.type === "launch_started");
  assert.deepEqual(launch.payload.command, [fakeAcpBin, "acp"]);
  assert.equal(launch.payload.opencode_version, "FakeOpenCode 9.9.9");
  assert.equal(launch.payload.opencode_version_probe_status, "ok");
  assert.equal(launch.payload.prompt_artifact, "prompt.txt");
  assert.match(launch.payload.worker_id, /^acp:/);
  assert.equal(attempt.opencode_version, "FakeOpenCode 9.9.9");
  assert.equal(attempt.opencode_version_probe_status, "ok");
  const progress = events.find((event) => event.type === "progress");
  assert.deepEqual(progress.payload.token_usage, {
    input_tokens: 130,
    cached_input_tokens: 0,
    output_tokens: 50,
    reasoning_output_tokens: 10,
  });

  // Isolation recipe (Phase 0 / design §4.4) as seen by the spawned worker.
  const trace = readJsonLines(tracePath);
  const spawned = trace.find((entry) => entry.event === "spawn");
  assert.equal(spawned.env.OPENCODE_CONFIG, path.join(planned.run_dir, "opencode-config.json"));
  assert.equal(spawned.env.XDG_CONFIG_HOME, path.join(planned.run_dir, "opencode-xdg-config"));
  assert.equal(spawned.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(spawned.env.OPENCODE_CONFIG_DIR, undefined, "inherited OPENCODE_CONFIG_DIR must be scrubbed");
  // process.cwd() in the worker resolves the /var -> /private/var symlink.
  assert.equal(spawned.cwd, fs.realpathSync(workspace));

  const opencodeConfig = readJsonFile(path.join(planned.run_dir, "opencode-config.json"));
  // Default write_scope is ["run_dir"]: read-only for the workspace, so the
  // injected permission config must deny bash (and edit).
  assert.equal(opencodeConfig.permission.bash, "deny");
  assert.equal(opencodeConfig.permission.edit, "deny");
  const xdgDir = path.join(planned.run_dir, "opencode-xdg-config");
  assert.ok(fs.existsSync(xdgDir));
  assert.deepEqual(fs.readdirSync(xdgDir), []);

  // The prompt sent over the wire is byte-identical to the prompt.txt artifact.
  const promptEvent = trace.find((entry) => entry.event === "prompt");
  assert.equal(promptEvent.textSha256, crypto.createHash("sha256").update(promptText).digest("hex"));
  const setModel = trace.find((entry) => entry.event === "set_model");
  assert.equal(setModel.modelId, ACP_MODEL);
});

// Case 12: the fixture always emits a non-JSON preamble under msg-1 before the
// final msg-2 envelope; only last-messageId extraction parses, and the
// unfenced path needs no fence stripping. The workspace-write scope also pins
// the injected permission config's other half (bash/edit allow).
test("unfenced multi-message turn resolves to the last messageId only", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: singleAcpTaskSpec({}, { workspace_policy: { write_scope: ["workspace"], network: false } }),
  });

  const completed = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "success" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.equal(result.summary, "fake ok");

  const opencodeConfig = readJsonFile(path.join(planned.run_dir, "opencode-config.json"));
  assert.equal(opencodeConfig.permission.bash, "allow");
  assert.equal(opencodeConfig.permission.edit, "allow");
});

test("opencode version probe failure is recorded but does not block acp execution", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const completed = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "success", FAKE_ACP_VERSION_MODE: "fail" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  const { attempt } = attemptInfo(planned.run_dir);
  assert.equal(attempt.opencode_version, null);
  assert.equal(attempt.opencode_version_probe_status, "nonzero_exit");
  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const launch = events.find((event) => event.type === "launch_started");
  assert.equal(launch.payload.opencode_version, null);
  assert.equal(launch.payload.opencode_version_probe_status, "nonzero_exit");
});

// Case 2: invalid JSON in the final message -> quarantine + schema_violation.
test("invalid acp worker output is quarantined as a schema violation", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "invalid_json" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "schema_violation");
  const { attempt, attemptDir } = attemptInfo(planned.run_dir);
  assert.equal(attempt.status, "quarantined");
  const rejected = readJsonFile(path.join(attemptDir, "rejected-result.json"));
  assert.equal(rejected.raw_message, "this is not json");
});

// Schema-valid envelope reporting status:"failed" -> worker_reported_failure.
test("acp worker-reported failure folds to failed with worker_reported_failure", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "worker_reported_failure" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_reported_failure");
  // The failed result is still persisted (it passed schema validation).
  const persisted = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.equal(persisted.status, "failed");
});

// Case 3: stopReason refusal -> worker_failed with the stop reason in payload.
test("acp refusal stop reason fails the task as worker_failed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "refusal" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.equal(failure.payload.stop_reason, "refusal");
});

// end_turn with no agent_message_chunk at all: sawTurnCompleted is true but
// there is no final message, so the success predicate must reject the turn.
test("acp turn that completes without a final message fails as worker_failed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "no_message" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.equal(failure.payload.saw_turn_completed, true);
});

// Case 4: a session/request_permission is auto-rejected (D8), the run still
// succeeds, and the request lands in the audit log.
test("acp permission requests are auto-rejected and recorded as events", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "acp-permission-trace.jsonl");
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const completed = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "permission", FAKE_ACP_TRACE: tracePath },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");

  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const permission = events.find((event) => event.type === "permission_request");
  assert.ok(permission, "expected a permission_request event");
  assert.equal(permission.payload.task_id, "t1");
  assert.equal(permission.payload.selected, "opt-reject-once");
  assert.deepEqual(permission.payload.options_offered, ["allow_once", "allow_always", "reject_once"]);
  assert.deepEqual(permission.payload.tool_call, { title: "bash", kind: "execute" });

  // The fixture observed the deterministic reject answer on the wire.
  const trace = readJsonLines(tracePath);
  const outcome = trace.find((entry) => entry.event === "permission_outcome");
  assert.deepEqual(outcome.outcome, { outcome: "selected", optionId: "opt-reject-once" });
});

// Case 10: session/set_model failure aborts the attempt before any prompt is
// sent (D5-r2: the only deterministic guard against the ambient fallback).
test("acp set_model failure fails the attempt without sending a prompt", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "acp-set-model-trace.jsonl");
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    {
      CCDW_OPENCODE_BIN: fakeAcpBin,
      FAKE_ACP_MODE: "success",
      FAKE_ACP_SET_MODEL_ERROR: "1",
      FAKE_ACP_TRACE: tracePath,
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.match(failure.payload.set_model_error, /model not found/);

  const trace = readJsonLines(tracePath);
  assert.ok(trace.some((entry) => entry.event === "spawn"));
  assert.ok(!trace.some((entry) => entry.event === "set_model"), "set_model must not have been accepted");
  assert.ok(!trace.some((entry) => entry.event === "prompt"), "no prompt may be sent after a set_model failure");
});

// Case 5 (trap half): run-level cancellation through the control channel.
// The fixture resolves the cancelled turn with stopReason "end_turn"
// (Phase 0 #7), so the ccdw cancel flag alone must decide the cancelled fold.
test("run cancel folds an acp attempt to cancelled despite stopReason end_turn", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "cancel_endturn" },
    async () => {
      const runPromise = runWorkflow({ runDir: planned.run_dir, approve: true });
      const started = await pollUntil(() => {
        try {
          const state = readRunState(planned.run_dir);
          const attemptId = state.tasks.t1.attempts[0];
          return attemptId != null && state.attempts[attemptId].status === "running";
        } catch {
          return false;
        }
      });
      assert.ok(started, "worker attempt never reached running status");

      const cancelResult = cancelWorkflow({ runDir: planned.run_dir, reason: "acp cancel test" });
      assert.equal(cancelResult.cancel_requested, true);

      const final = await runPromise;
      assert.equal(final.status, "cancelled");
      assert.equal(final.outcome.status, "cancelled");
      assert.equal(final.tasks.t1.status, "cancelled");

      const { attempt, attemptDir } = attemptInfo(planned.run_dir);
      assert.equal(attempt.status, "cancelled");
      // The trap on the wire: the cancelled turn still reported end_turn.
      const frames = readJsonLines(path.join(attemptDir, "acp-frames.jsonl"));
      assert.ok(
        frames.some((frame) => frame.dir === "recv" && frame.msg?.result?.stopReason === "end_turn"),
        "expected the cancelled turn to resolve with stopReason end_turn",
      );
      assert.ok(
        frames.some((frame) => frame.dir === "send" && frame.msg?.method === "session/cancel"),
        "expected a session/cancel notification to be sent",
      );
    },
  );
});

test("run cancel during acp version probe still stamps the in-flight task cancelled", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "success", FAKE_ACP_VERSION_MODE: "hang" },
    async () => {
      const runPromise = runWorkflow({ runDir: planned.run_dir, approve: true });
      const started = await pollUntil(() => {
        try {
          return readRunState(planned.run_dir).tasks.t1.status === "running";
        } catch {
          return false;
        }
      });
      assert.ok(started, "task never reached running status");

      const cancelResult = cancelWorkflow({ runDir: planned.run_dir, reason: "cancel during acp version probe" });
      assert.equal(cancelResult.cancel_requested, true);

      const final = await runPromise;
      assert.equal(final.status, "cancelled");
      assert.equal(final.tasks.t1.status, "cancelled");
      const { attempt } = attemptInfo(planned.run_dir);
      assert.equal(attempt.status, "cancelled");
      assert.equal(attempt.opencode_version, undefined);
      assert.equal(attempt.opencode_version_probe_status, undefined);
    },
  );
});

// Case 6: a hung prompt is bounded by the task timeout (graceful cancel, then
// teardown) and folds to timed_out.
test("acp worker timeout folds the task to timed_out fail-closed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec({ timeout_ms: 300 }) });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "hang" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "timed_out");
  const { attempt } = attemptInfo(planned.run_dir);
  assert.equal(attempt.status, "timed_out");
});

// Case 7: spawn ENOENT folds to worker_failed with the spawn error recorded.
test("acp spawn failure surfaces as worker_failed with spawn_error", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: "/nonexistent-ccdw-opencode-bin" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.match(failure.payload.spawn_error, /ENOENT/);
});

// Case 8: process death mid-handshake -> worker_failed, sawTurnCompleted false.
test("acp process death mid-handshake fails as worker_failed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "die_mid_handshake" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.equal(failure.payload.saw_turn_completed, false);
  assert.equal(failure.payload.exit_code, 1);
});

// Case 9: an unexpected server->client request (fs/read_text_file) is answered
// -32601 fail-closed and the turn still completes successfully.
test("unsupported server requests get method-not-found while the turn succeeds", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "acp-unknown-request-trace.jsonl");
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const completed = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "unknown_request", FAKE_ACP_TRACE: tracePath },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");

  const trace = readJsonLines(tracePath);
  const reply = trace.find((entry) => entry.event === "unknown_request_reply");
  assert.ok(reply, "expected the fixture to record the reply to its fs/read_text_file request");
  assert.equal(reply.error.code, -32601);
});

// Regression (review fix 1): the attempt timeout must be disarmed once the
// prompt request settles. The fixture completes the turn quickly but lingers
// 2s past stdin EOF, well beyond the 1500ms attempt timeout; before the fix
// the still-armed timer fired during teardown and mislabeled the successful
// turn as timed_out. The 3s teardown guard stays the only reaper.
test("acp attempt timeout does not fire during teardown of a successful turn", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec({ timeout_ms: 1500 }) });

  const completed = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "success", FAKE_ACP_EXIT_DELAY_MS: "2000" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  const { attempt } = attemptInfo(planned.run_dir);
  assert.notEqual(attempt.status, "timed_out");
  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.equal(result.status, "succeeded");
});

// Review fix 6: kill escalation. The fixture ignores session/cancel, stdin
// EOF, and the first SIGINT (FAKE_ACP_IGNORE_SIGINT=1); only the escalated
// SIGTERM reaps it. Timeline: timeout 1s -> cancel grace 2s -> SIGINT
// (ignored) -> SIGTERM +3s, so the run completes in ~6-8s wall time.
test("acp kill escalation reaps a worker that ignores cancel and SIGINT", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec({ timeout_ms: 1000 }) });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "cancel_ignore", FAKE_ACP_IGNORE_SIGINT: "1" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "timed_out");
  const { attempt } = attemptInfo(planned.run_dir);
  assert.equal(attempt.status, "timed_out");
  assert.ok(Number.isInteger(attempt.pid), "expected the attempt to record a pid");
  // The escalation must have actually reaped the child.
  assert.throws(() => process.kill(attempt.pid, 0), "worker process must be dead after the run");
});

// Review fix 3: total accumulated agent_message_chunk text is capped at 4 MiB;
// overflow folds the attempt to worker_failed with message_overflow so a
// truncated final message never reaches the JSON validator looking complete.
test("acp message overflow fails closed with message_overflow", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    {
      CCDW_OPENCODE_BIN: fakeAcpBin,
      FAKE_ACP_MODE: "success",
      FAKE_ACP_HUGE_MESSAGE_TOTAL: String(5 * 1024 * 1024),
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.equal(failure.payload.message_overflow, true);
  // No result.json: the truncated message must not have reached the validator.
  assert.ok(!fs.existsSync(path.join(planned.run_dir, "artifacts", "t1", "result.json")));
});

// Review fix 4a: acp-frames.jsonl stops growing at 16 MiB per attempt; the
// cut is marked with one {"truncated":true} sentinel line.
test("acp frames capture is capped at 16 MiB with a truncation sentinel", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    {
      CCDW_OPENCODE_BIN: fakeAcpBin,
      FAKE_ACP_MODE: "success",
      FAKE_ACP_HUGE_MESSAGE_TOTAL: String(20 * 1024 * 1024),
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  // 20 MiB of chunks also blows the 4 MiB message cap: fail-closed fold.
  assert.equal(result.status, "failed");
  const { attemptDir } = attemptInfo(planned.run_dir);
  const framesPath = path.join(attemptDir, "acp-frames.jsonl");
  const stat = fs.statSync(framesPath);
  assert.ok(stat.size <= 16 * 1024 * 1024 + 1024, `frames file too large: ${stat.size}`);
  const lines = fs.readFileSync(framesPath, "utf8").trim().split("\n");
  assert.equal(lines[lines.length - 1], '{"truncated":true}');
  // Exactly one sentinel: appends stop after the cap.
  assert.equal(lines.filter((line) => line === '{"truncated":true}').length, 1);
});

// Review fix 4b: at most 20 permission_request events per attempt; a flood
// beyond that folds into one permission_request_flood summary at attempt end.
test("acp permission request flood is capped with a summary event", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const completed = await withEnvAsync(
    {
      CCDW_OPENCODE_BIN: fakeAcpBin,
      FAKE_ACP_MODE: "permission",
      FAKE_ACP_PERMISSION_REPEAT: "25",
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const permissionEvents = events.filter((event) => event.type === "permission_request");
  assert.equal(permissionEvents.length, 20);
  const flood = events.filter((event) => event.type === "permission_request_flood");
  assert.equal(flood.length, 1);
  assert.equal(flood[0].payload.task_id, "t1");
  assert.equal(flood[0].payload.total_requests, 25);
});

// Review fix 8 (D8 responder fallback): when only reject_always is offered,
// the responder selects it (reject_once is preferred but absent).
test("acp permission responder falls back to reject_always when offered alone", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "acp-reject-always-trace.jsonl");
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const completed = await withEnvAsync(
    {
      CCDW_OPENCODE_BIN: fakeAcpBin,
      FAKE_ACP_MODE: "permission",
      FAKE_ACP_PERMISSION_OPTIONS: "reject_always_only",
      FAKE_ACP_TRACE: tracePath,
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const permission = events.find((event) => event.type === "permission_request");
  assert.equal(permission.payload.selected, "opt-reject-always");
  assert.deepEqual(permission.payload.options_offered, ["reject_always"]);
  const trace = readJsonLines(tracePath);
  const outcome = trace.find((entry) => entry.event === "permission_outcome");
  assert.deepEqual(outcome.outcome, { outcome: "selected", optionId: "opt-reject-always" });
});

// Review fix 8 (D8 responder fallback): when only allow options are offered,
// nothing is selectable fail-closed and the request is answered "cancelled"
// (allow_always would let the worker widen its own permissions).
test("acp permission responder answers cancelled when only allow options exist", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "acp-allow-only-trace.jsonl");
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const completed = await withEnvAsync(
    {
      CCDW_OPENCODE_BIN: fakeAcpBin,
      FAKE_ACP_MODE: "permission",
      FAKE_ACP_PERMISSION_OPTIONS: "allow_only",
      FAKE_ACP_TRACE: tracePath,
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const permission = events.find((event) => event.type === "permission_request");
  assert.equal(permission.payload.selected, "cancelled");
  assert.deepEqual(permission.payload.options_offered, ["allow_once", "allow_always"]);
  const trace = readJsonLines(tracePath);
  const outcome = trace.find((entry) => entry.event === "permission_outcome");
  assert.deepEqual(outcome.outcome, { outcome: "cancelled" });
});

// Review fix 8: stopReason max_tokens with no final message folds to
// worker_failed with the stop reason preserved in the payload.
test("acp max_tokens stop reason fails the task as worker_failed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "success", FAKE_ACP_STOP_REASON: "max_tokens" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.equal(failure.payload.stop_reason, "max_tokens");
});

// Review fix 5: process death during session/set_model is NOT a model error
// (no JSON-RPC error reply arrived); it folds into the generic worker_failed
// path with exit_code, and no prompt is ever sent.
test("acp process death at set_model folds generically without set_model_error", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "acp-die-set-model-trace.jsonl");
  const planned = planWorkflow({ workspace, spec: singleAcpTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_OPENCODE_BIN: fakeAcpBin, FAKE_ACP_MODE: "die_at_set_model", FAKE_ACP_TRACE: tracePath },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const failure = taskFailureEvent(planned.run_dir, "t1", "failed");
  assert.equal(failure.payload.reason, "worker_failed");
  assert.equal(failure.payload.set_model_error, undefined, "process death must not be labeled a model error");
  assert.equal(failure.payload.exit_code, 1);

  const trace = readJsonLines(tracePath);
  assert.ok(!trace.some((entry) => entry.event === "prompt"), "no prompt may be sent after a set_model failure");
});
