import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGateEnv, formatGateFeedback, runGates } from "../scripts/lib/gates.js";

const nodeBin = process.execPath;
const LOG_CAP_BYTES = 1024 * 1024;

function makeAttemptDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gates-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function nodeGate(script, timeoutMs = 30000) {
  return { command: [nodeBin, "-e", script], timeout_ms: timeoutMs };
}

test("runGates runs all gates to success and writes audit artifacts", async (t) => {
  const attemptDir = makeAttemptDir(t);
  const events = [];
  const gates = [
    nodeGate("console.log('first gate stdout')"),
    nodeGate("console.error('second gate stderr')"),
  ];
  const result = await runGates({
    gates,
    cwd: attemptDir,
    env: buildGateEnv(process.env),
    remainingMs: 60000,
    attemptDir,
    attemptId: "attempt-1",
    onEvent: (type, payload) => events.push([type, payload]),
  });

  assert.equal(result.passed, true);
  assert.equal(result.verdicts.length, 2);
  assert.equal(result.verdicts[0].exit_code, 0);
  assert.equal(result.verdicts[1].exit_code, 0);
  assert.equal(result.verdicts[0].timed_out, false);

  const verdict = JSON.parse(fs.readFileSync(path.join(attemptDir, "gate-verdict.json"), "utf8"));
  assert.equal(verdict.attempt_id, "attempt-1");
  assert.equal(verdict.passed, true);
  assert.equal(verdict.gates.length, 2);
  assert.deepEqual(verdict.gates[0].command, gates[0].command);
  assert.equal(verdict.gates[1].exit_code, 0);

  assert.match(fs.readFileSync(path.join(attemptDir, "gate-0.stdout.log"), "utf8"), /first gate stdout/);
  assert.match(fs.readFileSync(path.join(attemptDir, "gate-1.stderr.log"), "utf8"), /second gate stderr/);

  assert.deepEqual(
    events.map(([type, payload]) => [type, payload.index]),
    [["gate_started", 0], ["gate_result", 0], ["gate_started", 1], ["gate_result", 1]],
  );
  assert.deepEqual(events[0][1].command, gates[0].command);
  assert.equal(events[1][1].exit_code, 0);

  assert.equal(formatGateFeedback(result.verdicts, attemptDir), "");
});

test("runGates stops at the first failure and captures the non-zero exit", async (t) => {
  const attemptDir = makeAttemptDir(t);
  const sentinel = path.join(attemptDir, "gate-2-ran.txt");
  const events = [];
  const result = await runGates({
    gates: [
      nodeGate("console.error('boom'); process.exit(3)"),
      nodeGate(`require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`),
    ],
    cwd: attemptDir,
    env: buildGateEnv(process.env),
    remainingMs: 60000,
    attemptDir,
    attemptId: "attempt-2",
    onEvent: (type, payload) => events.push([type, payload.index]),
  });

  assert.equal(result.passed, false);
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0].exit_code, 3);
  assert.equal(result.verdicts[0].timed_out, false);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.existsSync(path.join(attemptDir, "gate-1.stdout.log")), false);

  const verdict = JSON.parse(fs.readFileSync(path.join(attemptDir, "gate-verdict.json"), "utf8"));
  assert.equal(verdict.passed, false);
  assert.equal(verdict.gates.length, 1);
  assert.equal(verdict.gates[0].exit_code, 3);

  assert.deepEqual(events, [["gate_started", 0], ["gate_result", 0]]);
});

test("runGates kills a gate on timeout and records timed_out", async (t) => {
  const attemptDir = makeAttemptDir(t);
  const result = await runGates({
    gates: [nodeGate("console.log(process.pid); setInterval(() => {}, 1000)", 1200)],
    cwd: attemptDir,
    env: buildGateEnv(process.env),
    remainingMs: 60000,
    attemptDir,
  });

  assert.equal(result.passed, false);
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0].timed_out, true);
  assert.notEqual(result.verdicts[0].exit_code, 0);
  assert.ok(result.verdicts[0].duration_ms >= 1000);
  assert.ok(result.verdicts[0].duration_ms < 15000);

  // The gate printed its pid before idling; by the time runGates resolves the
  // process group must be dead.
  const pid = Number(fs.readFileSync(path.join(attemptDir, "gate-0.stdout.log"), "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0));
});

test("runGates clamps the effective timeout to at least 1000ms", async (t) => {
  const attemptDir = makeAttemptDir(t);
  // timeout_ms of 1 would kill the gate before it could finish; the 1000ms
  // floor leaves a fast gate enough time to exit cleanly.
  const result = await runGates({
    gates: [nodeGate("process.exit(0)", 1)],
    cwd: attemptDir,
    env: buildGateEnv(process.env),
    remainingMs: 60000,
    attemptDir,
  });
  assert.equal(result.passed, true);
  assert.equal(result.verdicts[0].timed_out, false);
});

test("formatGateFeedback includes command, status, and stream tails", async (t) => {
  const attemptDir = makeAttemptDir(t);
  // Markers are concatenated inside the script so they appear only in the
  // stream output, never in the command text echoed by the feedback block.
  const script = [
    "process.stdout.write('STDOUT-' + 'HEAD-' + 'x'.repeat(8000) + 'STDOUT-' + 'TAIL-MARKER');",
    "process.stderr.write('STDERR-' + 'TAIL-MARKER');",
    "process.exit(2);",
  ].join(" ");
  const result = await runGates({
    gates: [nodeGate(script)],
    cwd: attemptDir,
    env: buildGateEnv(process.env),
    remainingMs: 60000,
    attemptDir,
  });
  assert.equal(result.passed, false);

  const feedback = formatGateFeedback(result.verdicts, attemptDir);
  assert.match(feedback, /Gate 0 failed:/);
  assert.ok(feedback.includes(nodeBin));
  assert.match(feedback, /exit_code: 2/);
  assert.match(feedback, /timed_out: false/);
  assert.ok(feedback.includes("STDOUT-TAIL-MARKER"));
  assert.ok(feedback.includes("STDERR-TAIL-MARKER"));
  // Output before the last 4096 bytes is excluded from the default tail.
  assert.ok(!feedback.includes("STDOUT-HEAD-"));

  // tailBytes is honored and capped by maxTailBytes.
  const small = formatGateFeedback(result.verdicts, attemptDir, { tailBytes: 64 });
  assert.ok(small.includes("STDOUT-TAIL-MARKER"));
  assert.ok(!small.includes("STDOUT-HEAD-"));
  const clamped = formatGateFeedback(result.verdicts, attemptDir, {
    tailBytes: 999999,
    maxTailBytes: 1024,
  });
  assert.ok(clamped.includes("STDOUT-TAIL-MARKER"));
  assert.ok(!clamped.includes("STDOUT-HEAD-"));
});

test("runGates caps each log file at 1 MiB with a truncation marker", async (t) => {
  const attemptDir = makeAttemptDir(t);
  const result = await runGates({
    gates: [nodeGate("process.stdout.write('x'.repeat(2 * 1024 * 1024))")],
    cwd: attemptDir,
    env: buildGateEnv(process.env),
    remainingMs: 60000,
    attemptDir,
  });
  assert.equal(result.passed, true);

  const logPath = path.join(attemptDir, "gate-0.stdout.log");
  assert.equal(fs.statSync(logPath).size, LOG_CAP_BYTES);
  const content = fs.readFileSync(logPath, "utf8");
  assert.ok(content.endsWith("[log truncated: 1 MiB cap reached]\n"));
});

test("buildGateEnv copies only the allowlisted variables", () => {
  const env = buildGateEnv({
    PATH: "/usr/bin",
    HOME: "/home/u",
    TMPDIR: "/tmp",
    LANG: "C",
    LC_ALL: "C.UTF-8",
    SECRET_TOKEN: "do-not-leak",
    NODE_OPTIONS: "--max-old-space-size=64",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/u",
    TMPDIR: "/tmp",
    LANG: "C",
    LC_ALL: "C.UTF-8",
  });
  // Allowlisted keys absent from the base env stay absent.
  assert.deepEqual(buildGateEnv({ PATH: "/bin", SECRET: "y" }), { PATH: "/bin" });
});
