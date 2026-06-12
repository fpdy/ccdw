import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Gate runner for F3 (spec §4.2-§4.4): after a worker attempt passes schema
// validation, gates run sequentially in declaration order, stopping at the
// first failure. Full stdout/stderr is captured into per-attempt log files
// (capped at 1 MiB each) and a machine-readable gate-verdict.json records the
// audit trail.
//
// Reuse decision: process-runner.js was considered but not adopted. It frames
// and JSON-parses stdout as NDJSON events and discards the raw stream, while
// gates must capture both streams in full. The spawn plumbing below mirrors
// its pattern instead: detached spawn (own process group on POSIX), stdin
// ignored, and on timeout a process-group kill escalation (SIGTERM, then
// SIGKILL after a grace period).

const GATE_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
const LOG_CAP_BYTES = 1024 * 1024;
const LOG_TRUNCATION_MARKER = Buffer.from("\n[log truncated: 1 MiB cap reached]\n");
const MIN_GATE_TIMEOUT_MS = 1000;
const SIGKILL_ESCALATION_MS = 3000;
const DEFAULT_FEEDBACK_TAIL_BYTES = 4096;
const MAX_FEEDBACK_TAIL_BYTES = 16384;

// Gates run with an allowlisted environment only (spec §4.2-2); nothing else
// from the parent process leaks into gate commands.
export function buildGateEnv(baseEnv = process.env) {
  const env = {};
  for (const key of GATE_ENV_ALLOWLIST) {
    if (baseEnv[key] != null) {
      env[key] = baseEnv[key];
    }
  }
  return env;
}

// Collects stream chunks up to the log cap. The body is capped so that body
// plus truncation marker never exceeds LOG_CAP_BYTES; extra chunks are
// drained and discarded so the child never blocks on a full pipe.
function createCappedCollector(capBytes = LOG_CAP_BYTES) {
  const bodyCap = capBytes - LOG_TRUNCATION_MARKER.length;
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) {
        return;
      }
      if (size + chunk.length <= bodyCap) {
        chunks.push(chunk);
        size += chunk.length;
        return;
      }
      const room = bodyCap - size;
      if (room > 0) {
        chunks.push(chunk.subarray(0, room));
        size = bodyCap;
      }
      truncated = true;
    },
    finalize() {
      const body = Buffer.concat(chunks);
      return truncated ? Buffer.concat([body, LOG_TRUNCATION_MARKER]) : body;
    },
  };
}

function runSingleGate({ command, cwd, env, timeoutMs, registerKill }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const [bin, ...args] = command;
    const child = spawn(bin, args, {
      cwd,
      env,
      // stdin is ignored; gates must not wait for interactive input.
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let settled = false;
    let timedOut = false;
    const stdout = createCappedCollector();
    const stderr = createCappedCollector();
    const escalationTimers = [];

    const killGroup = (signal) => {
      try {
        if (process.platform === "win32" || child.pid == null) {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        // Process group already gone.
      }
    };

    // Shared kill escalation: SIGTERM the process group, SIGKILL after a
    // grace period. Used by the timeout below and exposed to the caller via
    // registerKill so cancellation can terminate an in-flight gate.
    const requestKill = () => {
      if (settled) {
        return;
      }
      killGroup("SIGTERM");
      const killTimer = setTimeout(() => killGroup("SIGKILL"), SIGKILL_ESCALATION_MS);
      killTimer.unref?.();
      escalationTimers.push(killTimer);
    };
    registerKill?.(requestKill);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestKill();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const finalize = (exitCode, signal, spawnError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      for (const timer of escalationTimers) {
        clearTimeout(timer);
      }
      if (spawnError) {
        // Surface spawn failures (e.g. ENOENT) in the stderr log so they
        // reach the audit artifacts and gate feedback.
        stderr.push(Buffer.from(`spawn error: ${spawnError.message}\n`));
      }
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdout: stdout.finalize(),
        stderr: stderr.finalize(),
      });
    };
    child.on("error", (error) => finalize(null, null, error));
    child.on("close", (code, signal) => finalize(code, signal, null));
  });
}

function gatePassed(verdict) {
  return verdict.exit_code === 0 && !verdict.timed_out;
}

// Runs gates sequentially in declaration order, stopping at the first
// failure. Writes gate-<n>.stdout.log / gate-<n>.stderr.log per executed gate
// plus gate-verdict.json into attemptDir, and resolves with
// { passed, verdicts, cancelled }. Never rejects on gate failure; only on I/O
// errors writing the audit artifacts. When a handle object is supplied its
// cancel property is set to a function that kills the in-flight gate's
// process group and stops further gates from launching (spec §4.2-5: gates
// die with the run).
export async function runGates({ gates, cwd, env, remainingMs, attemptDir, attemptId, onEvent, handle = null }) {
  const startedAt = Date.now();
  const budgetMs = Number.isFinite(remainingMs) ? remainingMs : Infinity;
  const verdicts = [];
  let passed = true;
  let cancelled = false;
  let killActiveGate = null;
  fs.mkdirSync(attemptDir, { recursive: true });

  if (handle) {
    handle.cancel = () => {
      cancelled = true;
      killActiveGate?.();
    };
  }

  const emit = (type, payload) => {
    try {
      onEvent?.(type, payload);
    } catch {
      // Observers must not break gate accounting.
    }
  };

  for (let index = 0; index < gates.length; index += 1) {
    if (cancelled) {
      passed = false;
      break;
    }
    const gate = gates[index];
    const elapsed = Date.now() - startedAt;
    const timeoutMs = Math.max(Math.min(gate.timeout_ms, budgetMs - elapsed), MIN_GATE_TIMEOUT_MS);
    emit("gate_started", { index, command: gate.command });
    const outcome = await runSingleGate({
      command: gate.command,
      cwd,
      env,
      timeoutMs,
      registerKill: (kill) => {
        killActiveGate = kill;
      },
    });
    killActiveGate = null;
    fs.writeFileSync(path.join(attemptDir, `gate-${index}.stdout.log`), outcome.stdout);
    fs.writeFileSync(path.join(attemptDir, `gate-${index}.stderr.log`), outcome.stderr);
    const verdict = {
      index,
      command: gate.command,
      exit_code: outcome.exitCode,
      signal: outcome.signal,
      duration_ms: outcome.durationMs,
      timed_out: outcome.timedOut,
    };
    verdicts.push(verdict);
    emit("gate_result", {
      index,
      exit_code: verdict.exit_code,
      signal: verdict.signal,
      duration_ms: verdict.duration_ms,
      timed_out: verdict.timed_out,
    });
    if (!gatePassed(verdict)) {
      passed = false;
      break;
    }
  }

  const verdictDocument = {
    attempt_id: attemptId ?? null,
    passed,
    gates: verdicts,
  };
  fs.writeFileSync(
    path.join(attemptDir, "gate-verdict.json"),
    `${JSON.stringify(verdictDocument, null, 2)}\n`,
  );
  return { passed, verdicts, cancelled };
}

function readTailBytes(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Builds the human-readable feedback block injected into retry prompts via
// {{gate_feedback}} (spec §4.4): the failed gate's command, exit status, and
// the tail of its stdout/stderr read back from the attempt log files.
// Returns "" when every verdict passed.
export function formatGateFeedback(
  verdicts,
  attemptDir,
  { tailBytes = DEFAULT_FEEDBACK_TAIL_BYTES, maxTailBytes = MAX_FEEDBACK_TAIL_BYTES } = {},
) {
  const failed = (verdicts ?? []).filter((verdict) => !gatePassed(verdict));
  if (failed.length === 0) {
    return "";
  }
  const effectiveTailBytes = Math.min(tailBytes, maxTailBytes);
  const blocks = [];
  for (const verdict of failed) {
    const lines = [
      `Gate ${verdict.index} failed: ${verdict.command.join(" ")}`,
      `  exit_code: ${verdict.exit_code ?? "null"}`,
      `  signal: ${verdict.signal ?? "null"}`,
      `  timed_out: ${verdict.timed_out}`,
      `  duration_ms: ${verdict.duration_ms}`,
    ];
    for (const stream of ["stdout", "stderr"]) {
      const fileName = `gate-${verdict.index}.${stream}.log`;
      const tail = readTailBytes(path.join(attemptDir, fileName), effectiveTailBytes);
      lines.push(`--- ${stream} tail (last ${effectiveTailBytes} bytes of ${fileName}) ---`);
      lines.push(tail ? tail : "(empty)");
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
