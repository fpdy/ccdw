import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelWorkflow,
  planWorkflow,
  readRunState,
  resumeWorkflow,
  runWorkflow,
} from "../scripts/lib/core.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodexBin = path.join(pluginRoot, "tests", "fixtures", "fake-codex.js");
const fakeClaudeBin = path.join(pluginRoot, "tests", "fixtures", "fake-claude.js");
const nodeBin = process.execPath;

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-gates-int-test-"));
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readEvents(runDir) {
  const eventPath = path.join(runDir, "events.ndjson");
  if (!fs.existsSync(eventPath)) {
    return [];
  }
  const content = fs.readFileSync(eventPath, "utf8").trim();
  return content === "" ? [] : content.split("\n").map((line) => JSON.parse(line));
}

function attemptDirFor(runDir, state, taskId, attemptIndex) {
  const attemptId = state.tasks[taskId].attempts[attemptIndex];
  return path.join(runDir, state.attempts[attemptId].artifact_dir);
}

function attemptPrompt(runDir, state, taskId, attemptIndex) {
  return readJsonFile(path.join(attemptDirFor(runDir, state, taskId, attemptIndex), "trace.json")).prompt;
}

// All tasks live in one phase; dependencies sequence them.
function pipelineSpec(tasks, specOverrides = {}) {
  return {
    name: "gates integration workflow",
    objective: "Exercise gate integration",
    phases: [{ phase_id: "p1", tasks: tasks.map((task) => task.task_id) }],
    tasks: tasks.map((task) => ({ phase_id: "p1", kind: "codex_agent", role: "tester", ...task })),
    max_concurrency: 1,
    ...specOverrides,
  };
}

function planErrors(tasks) {
  const result = planWorkflow({
    workspace: makeTempWorkspace(),
    dryRun: true,
    spec: pipelineSpec(tasks),
  });
  return result.errors;
}

// Gate scripts run via `node -e` and must stay on a single line: gate argv
// elements reject control characters at plan time.
function nodeGate(script, timeoutMs = 30000, extraArgs = []) {
  return { command: [nodeBin, "-e", script, ...extraArgs], timeout_ms: timeoutMs };
}

// Fails on the first run (creating the marker), passes once the marker exists.
function failOnceGate(markerPath, stderrMarker) {
  const script = [
    "const fs=require('fs');",
    "if(fs.existsSync(process.argv[1])){process.exit(0)};",
    "fs.writeFileSync(process.argv[1],'x');",
    `console.error('${stderrMarker}');`,
    "process.exit(1);",
  ].join("");
  return nodeGate(script, 30000, [markerPath]);
}

// Fails until the marker exists; never creates it itself (resume scenarios).
function untilMarkerGate(markerPath, stderrMarker) {
  const script = [
    "const fs=require('fs');",
    "if(fs.existsSync(process.argv[1])){process.exit(0)};",
    `console.error('${stderrMarker}');`,
    "process.exit(1);",
  ].join("");
  return nodeGate(script, 30000, [markerPath]);
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// --- Plan-time validation -------------------------------------------------------

test("plan rejects gates on local tasks", () => {
  const errors = planErrors([
    {
      task_id: "t1",
      kind: "local_analysis",
      prompt_template: "local work",
      gates: [{ command: ["true"], timeout_ms: 1000 }],
    },
  ]);
  assert.ok(
    errors.some((message) => message.includes("task t1 gates is not supported for local tasks")),
    errors.join(" | "),
  );
});

test("plan rejects malformed gates declarations", () => {
  const cases = [
    [{ gates: {} }, "gates must be a non-empty array"],
    [{ gates: [] }, "gates must be a non-empty array"],
    [{ gates: ["npm test"] }, "gates[0] must be an object with command and timeout_ms"],
    [{ gates: [{ timeout_ms: 1000 }] }, "gates[0].command must be a non-empty argv array"],
    [{ gates: [{ command: [], timeout_ms: 1000 }] }, "gates[0].command must be a non-empty argv array"],
    [{ gates: [{ command: "npm test", timeout_ms: 1000 }] }, "gates[0].command must be a non-empty argv array"],
    [{ gates: [{ command: ["npm", 7], timeout_ms: 1000 }] }, "gates[0].command[1] must be a non-empty string"],
    [{ gates: [{ command: ["npm", ""], timeout_ms: 1000 }] }, "gates[0].command[1] must be a non-empty string"],
    [{ gates: [{ command: ["npm", "te\nst"], timeout_ms: 1000 }] }, "gates[0].command[1] must not contain control characters"],
    [{ gates: [{ command: ["npm", "x".repeat(513)], timeout_ms: 1000 }] }, "gates[0].command[1] must be at most 512 characters"],
    [{ gates: [{ command: ["-npm", "test"], timeout_ms: 1000 }] }, 'gates[0].command[0] (the gate executable) must not start with "-"'],
    [{ gates: [{ command: ["npm", "test"] }] }, "gates[0].timeout_ms must be a positive integer"],
    [{ gates: [{ command: ["npm", "test"], timeout_ms: 0 }] }, "gates[0].timeout_ms must be a positive integer"],
    [{ gates: [{ command: ["npm", "test"], timeout_ms: 1.5 }] }, "gates[0].timeout_ms must be a positive integer"],
    [{ gates: [{ command: ["npm", "test"], timeout_ms: 1000, shell: true }] }, "gates[0] has unsupported key: shell"],
  ];
  for (const [taskFields, expected] of cases) {
    const errors = planErrors([{ task_id: "t1", prompt_template: "do it", ...taskFields }]);
    assert.ok(
      errors.some((message) => message.includes(`task t1 ${expected}`)),
      `${expected} :: ${errors.join(" | ")}`,
    );
  }
});

test("plan allows flag-style argv elements after the gate executable", () => {
  const result = planWorkflow({
    workspace: makeTempWorkspace(),
    dryRun: true,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "do it",
        gates: [{ command: [nodeBin, "-e", "process.exit(0)", "--", "--grep", "case one"], timeout_ms: 1000 }],
      },
    ]),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("plan rejects template syntax inside gate argv", () => {
  const errors = planErrors([
    {
      task_id: "t1",
      prompt_template: "do it",
      gates: [{ command: ["echo", "{{objective}}"], timeout_ms: 1000 }],
    },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes('task t1 gates[0].command[1] must not contain template syntax ("{{")'),
    ),
    errors.join(" | "),
  );
});

test("plan enforces gate_feedback_tail_bytes bounds and gates coupling", () => {
  const gate = { command: ["true"], timeout_ms: 1000 };
  for (const bad of [0, -1, 1.5, "4096", 16385]) {
    const errors = planErrors([
      { task_id: "t1", prompt_template: "do it", gates: [gate], gate_feedback_tail_bytes: bad },
    ]);
    assert.ok(
      errors.some((message) =>
        message.includes("task t1 gate_feedback_tail_bytes must be a positive integer of at most 16384"),
      ),
      `${bad} :: ${errors.join(" | ")}`,
    );
  }
  for (const good of [1, 4096, 16384]) {
    const errors = planErrors([
      { task_id: "t1", prompt_template: "do it", gates: [gate], gate_feedback_tail_bytes: good },
    ]);
    assert.deepEqual(errors, [], `${good} :: ${errors.join(" | ")}`);
  }
  const withoutGates = planErrors([
    { task_id: "t1", prompt_template: "do it", gate_feedback_tail_bytes: 4096 },
  ]);
  assert.ok(
    withoutGates.some((message) => message.includes("task t1 gate_feedback_tail_bytes requires gates")),
    withoutGates.join(" | "),
  );
});

// --- Approval disclosure ---------------------------------------------------------

test("approval summary discloses gate commands and the gate execution sandbox", () => {
  const workspace = makeTempWorkspace();
  const gates = [
    { command: ["npm", "test", "--silent"], timeout_ms: 300000 },
    { command: [nodeBin, "-e", "process.exit(0)"], timeout_ms: 5000 },
  ];
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      { task_id: "t1", prompt_template: "implement", gates },
      { task_id: "t2", prompt_template: "no gates here" },
    ]),
  });

  const tasks = Object.fromEntries(planned.approval.summary.tasks.map((task) => [task.task_id, task]));
  assert.deepEqual(tasks.t1.gates, [
    { command: ["npm", "test", "--silent"], timeout_ms: 300000 },
    { command: [nodeBin, "-e", "process.exit(0)"], timeout_ms: 5000 },
  ]);
  assert.equal(tasks.t2.gates, undefined);

  assert.deepEqual(planned.approval.summary.execution_sandbox.gates, {
    os_sandbox: "none",
    cwd: workspace,
    env_allowlist: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    invocation: "argv-only (no shell)",
  });
});

// --- E2E: gates pass -------------------------------------------------------------

test("codex task with passing gates succeeds and records the gate audit trail", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Implement the feature.",
        gates: [
          // The first gate proves cwd: it writes relative to the workspace root.
          nodeGate("require('fs').writeFileSync('gate-cwd-proof.txt', process.cwd())"),
          nodeGate("console.log('second gate ok')"),
        ],
      },
    ]),
  });

  const completed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  assert.equal(completed.outcome.status, "success");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.t1.attempts.length, 1);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "succeeded");

  // Gates ran with cwd = workspace root (realpath: the gate child resolves
  // tmpdir symlinks such as /var -> /private/var on macOS).
  assert.equal(
    fs.readFileSync(path.join(workspace, "gate-cwd-proof.txt"), "utf8"),
    fs.realpathSync(workspace),
  );

  const attemptDir = attemptDirFor(planned.run_dir, state, "t1", 0);
  const verdict = readJsonFile(path.join(attemptDir, "gate-verdict.json"));
  assert.equal(verdict.passed, true);
  assert.equal(verdict.attempt_id, attemptId);
  assert.equal(verdict.gates.length, 2);
  assert.match(fs.readFileSync(path.join(attemptDir, "gate-1.stdout.log"), "utf8"), /second gate ok/);

  const gateEvents = readEvents(planned.run_dir).filter((event) =>
    event.type === "gate_started" || event.type === "gate_result",
  );
  assert.deepEqual(
    gateEvents.map((event) => [event.type, event.payload.index]),
    [["gate_started", 0], ["gate_result", 0], ["gate_started", 1], ["gate_result", 1]],
  );
  for (const event of gateEvents) {
    assert.equal(event.payload.task_id, "t1");
    assert.equal(event.payload.attempt_id, attemptId);
  }
  assert.equal(gateEvents[1].payload.exit_code, 0);
});

test("claude task with passing gates succeeds", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        kind: "claude_agent",
        prompt_template: "Implement the feature.",
        gates: [nodeGate("process.exit(0)")],
      },
    ]),
  });

  const completed = await withEnvAsync({ CCDW_CLAUDE_BIN: fakeClaudeBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");

  const state = readRunState(planned.run_dir);
  const verdict = readJsonFile(path.join(attemptDirFor(planned.run_dir, state, "t1", 0), "gate-verdict.json"));
  assert.equal(verdict.passed, true);
});

// --- E2E: gate failure, retry, and feedback injection -----------------------------

test("a failing gate retries the task and injects {{gate_feedback}} into the retry prompt", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "gate-fail-once.marker");
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Fix it. Feedback: {{gate_feedback}}",
        gates: [failOnceGate(marker, "MARKER-LINT-FAILURE")],
        retry_policy: { retryable: true, max_attempts: 2 },
      },
    ]),
  });

  const completed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");

  const state = readRunState(planned.run_dir);
  // One counter: the gate failure consumed a regular attempt, nothing more.
  assert.equal(state.tasks.t1.attempts.length, 2);
  // Gates charge no tokens; both worker attempts account 150 each.
  assert.equal(state.budget_usage.tokens, 300);

  const firstVerdict = readJsonFile(path.join(attemptDirFor(planned.run_dir, state, "t1", 0), "gate-verdict.json"));
  assert.equal(firstVerdict.passed, false);
  assert.equal(firstVerdict.gates[0].exit_code, 1);
  const secondVerdict = readJsonFile(path.join(attemptDirFor(planned.run_dir, state, "t1", 1), "gate-verdict.json"));
  assert.equal(secondVerdict.passed, true);

  // First attempt renders the placeholder as the empty string.
  const firstPrompt = attemptPrompt(planned.run_dir, state, "t1", 0);
  assert.ok(!firstPrompt.includes("Gate 0 failed"), firstPrompt);
  assert.ok(!firstPrompt.includes("{{"), firstPrompt);

  // The retry prompt carries the failed gate's command, status, and tails.
  const retryPrompt = attemptPrompt(planned.run_dir, state, "t1", 1);
  assert.ok(retryPrompt.includes("Gate 0 failed"), retryPrompt);
  assert.ok(retryPrompt.includes("MARKER-LINT-FAILURE"), retryPrompt);
  assert.ok(retryPrompt.includes("exit_code: 1"), retryPrompt);
  // The placeholder was used; no auto-appended block.
  assert.ok(!retryPrompt.includes("--- previous gate failure ---"), retryPrompt);

  const gateFailures = readEvents(planned.run_dir).filter(
    (event) => event.type === "task_status_changed" && event.payload.status === "gate_failed",
  );
  assert.equal(gateFailures.length, 1);
  assert.equal(gateFailures[0].payload.reason, "gate_failed");
  assert.equal(gateFailures[0].payload.gate_index, 0);
  assert.equal(gateFailures[0].payload.gate_exit_code, 1);
});

test("gate feedback is auto-appended when the template has no placeholder", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "gate-fail-once.marker");
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Fix the thing.",
        gates: [failOnceGate(marker, "MARKER-AUTO-APPEND")],
        retry_policy: { retryable: true, max_attempts: 2 },
      },
    ]),
  });

  const completed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");

  const state = readRunState(planned.run_dir);
  const firstPrompt = attemptPrompt(planned.run_dir, state, "t1", 0);
  assert.ok(!firstPrompt.includes("--- previous gate failure ---"), firstPrompt);

  const retryPrompt = attemptPrompt(planned.run_dir, state, "t1", 1);
  assert.ok(retryPrompt.includes("--- previous gate failure ---"), retryPrompt);
  assert.ok(retryPrompt.includes("--- end of previous gate failure ---"), retryPrompt);
  assert.ok(retryPrompt.includes("MARKER-AUTO-APPEND"), retryPrompt);
  assert.ok(retryPrompt.indexOf("Fix the thing.") < retryPrompt.indexOf("--- previous gate failure ---"), retryPrompt);
});

// --- E2E: terminal gate_failed ----------------------------------------------------

test("exhausted retries leave the task gate_failed and fail the run", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Fix it.",
        gates: [nodeGate("console.error('MARKER-ALWAYS-FAIL');process.exit(7)")],
        retry_policy: { retryable: true, max_attempts: 2 },
      },
    ]),
  });

  const failed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.outcome.status, "failed");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.t1.status, "gate_failed");
  assert.equal(state.tasks.t1.attempts.length, 2);
  assert.equal(state.phases.p1.status, "failed");
  for (const attemptId of state.tasks.t1.attempts) {
    assert.equal(state.attempts[attemptId].status, "gate_failed");
  }
  // Both attempts produced a failing verdict with the gate's exit code.
  for (const index of [0, 1]) {
    const verdict = readJsonFile(path.join(attemptDirFor(planned.run_dir, state, "t1", index), "gate-verdict.json"));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.gates[0].exit_code, 7);
  }
});

test("a gate timeout records timed_out and folds the task to gate_failed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Fix it.",
        gates: [nodeGate("setInterval(() => {}, 1000)", 1200)],
      },
    ]),
  });

  const failed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.t1.status, "gate_failed");
  const verdict = readJsonFile(path.join(attemptDirFor(planned.run_dir, state, "t1", 0), "gate-verdict.json"));
  assert.equal(verdict.passed, false);
  assert.equal(verdict.gates[0].timed_out, true);

  const gateFailures = readEvents(planned.run_dir).filter(
    (event) => event.type === "task_status_changed" && event.payload.status === "gate_failed",
  );
  assert.equal(gateFailures.length, 1);
  assert.equal(gateFailures[0].payload.reason, "gate_timed_out");
  assert.equal(gateFailures[0].payload.gate_timed_out, true);
});

// --- E2E: gates never run for non-succeeded worker attempts ------------------------

test("a worker-reported failure never runs gates", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Fix it.",
        gates: [nodeGate("process.exit(0)")],
      },
    ]),
  });

  const failed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_RESULT_STATUS: "failed" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.t1.status, "failed");
  assert.equal(fs.existsSync(path.join(attemptDirFor(planned.run_dir, state, "t1", 0), "gate-verdict.json")), false);
  assert.deepEqual(
    readEvents(planned.run_dir).filter((event) => event.type === "gate_started" || event.type === "gate_result"),
    [],
  );
});

// --- E2E: resume ------------------------------------------------------------------

test("resume --resume-failed requeues a terminal gate_failed task with disk-backed feedback", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "gate-resume.marker");
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Fix it. Feedback: {{gate_feedback}}",
        gates: [untilMarkerGate(marker, "MARKER-RESUME-GATE")],
      },
    ]),
  });

  const env = { CCDW_CODEX_BIN: fakeCodexBin };
  const failed = await withEnvAsync(env, () => runWorkflow({ runDir: planned.run_dir, approve: true }));
  assert.equal(failed.status, "failed");
  assert.equal(readRunState(planned.run_dir).tasks.t1.status, "gate_failed");

  // The blocker is fixed out of band; resume must requeue the gate_failed task.
  fs.writeFileSync(marker, "fixed\n");
  const resumed = await withEnvAsync(env, () =>
    resumeWorkflow({ runDir: planned.run_dir, resumeFailed: true }),
  );
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.tasks.t1.status, "succeeded");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.t1.attempts.length, 2);
  // Feedback came from the first attempt's gate-verdict.json on disk, across
  // a fresh orchestrator start.
  const retryPrompt = attemptPrompt(planned.run_dir, state, "t1", 1);
  assert.ok(retryPrompt.includes("Gate 0 failed"), retryPrompt);
  assert.ok(retryPrompt.includes("MARKER-RESUME-GATE"), retryPrompt);
});

// --- E2E: cancellation kills in-flight gates ---------------------------------------

test("cancelling a run kills an in-flight gate process group", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "Fix it.",
        gates: [nodeGate("console.log(process.pid);setInterval(() => {}, 1000)", 60000)],
      },
    ]),
  });

  const final = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, async () => {
    const runPromise = runWorkflow({ runDir: planned.run_dir, approve: true });
    await waitFor(
      () => readEvents(planned.run_dir).some((event) => event.type === "gate_started"),
      "gate_started event",
    );
    cancelWorkflow({ runDir: planned.run_dir, reason: "stop the gate" });
    return runPromise;
  });

  assert.equal(final.status, "cancelled");
  assert.equal(final.outcome.status, "cancelled");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.t1.status, "cancelled");

  // The gate printed its pid before idling; the cancel path must have killed
  // its process group.
  const attemptDir = attemptDirFor(planned.run_dir, state, "t1", 0);
  const pid = Number(fs.readFileSync(path.join(attemptDir, "gate-0.stdout.log"), "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0));
});
