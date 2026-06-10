import { spawn } from "node:child_process";

// Generic runner for CLI workers that stream NDJSON events on stdout.
// Spawning, process-group kill escalation, timeout handling, line framing,
// and stderr capture live here; interpreting individual event types is left
// to the executor that wraps this runner. The returned promise resolves with
// the base outcome { exitCode, spawnError, timedOut, cancelled, stderrTail,
// pid }; it never rejects.
export function startNdjsonProcess({ bin, args, prompt, cwd, timeoutMs, onEvent }) {
  const child = spawn(bin, [...args, prompt], {
    cwd,
    // stdin must be closed: an open-but-unwritten stdin pipe hangs codex exec.
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let settled = false;
  let timedOut = false;
  let cancelled = false;
  let stdoutBuffer = "";
  let stderrTail = "";
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

  const escalate = () => {
    killGroup("SIGINT");
    for (const [delay, signal] of [[3000, "SIGTERM"], [6000, "SIGKILL"]]) {
      const timer = setTimeout(() => killGroup(signal), delay);
      timer.unref?.();
      escalationTimers.push(timer);
    }
  };

  let timeoutTimer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      escalate();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    try {
      onEvent?.(event);
    } catch {
      // Observers must not break worker accounting.
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      handleLine(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
  });

  const promise = new Promise((resolve) => {
    const finalize = (exitCode, spawnError) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      for (const timer of escalationTimers) {
        clearTimeout(timer);
      }
      if (stdoutBuffer) {
        handleLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      resolve({
        exitCode,
        spawnError: spawnError?.message ?? null,
        timedOut,
        cancelled,
        stderrTail,
        pid: child.pid ?? null,
      });
    };
    child.on("error", (error) => finalize(null, error));
    child.on("close", (code) => finalize(code, null));
  });

  return {
    pid: child.pid ?? null,
    promise,
    cancel() {
      // After finalize the process is gone; escalating would arm SIGTERM/
      // SIGKILL timers that nothing clears and that could signal a recycled
      // process group in a long-lived orchestrator.
      if (settled) {
        return;
      }
      cancelled = true;
      escalate();
    },
  };
}
