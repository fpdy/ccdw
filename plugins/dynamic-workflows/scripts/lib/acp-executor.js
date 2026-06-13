import { spawn } from "node:child_process";
import { createAcpConnection } from "./acp-client.js";

// ACP (Agent Client Protocol) executor for `opencode acp` workers. One
// attempt = one process = one session = one prompt turn (design decision D2).
// Outcome shape follows the codex/claude executor contract; success cannot be
// inferred from the exit code alone: opencode falls back to an unauthenticated
// default model with exit 0 / end_turn when session/set_model fails (Phase 0
// #8), so setModelError is the only deterministic guard and callers must
// combine exitCode === 0 with sawTurnCompleted and a non-empty final message.

export const OPENCODE_CONFIG_FILE = "opencode-config.json";
export const OPENCODE_XDG_CONFIG_DIR = "opencode-xdg-config";

// Advertised in the ACP initialize handshake; pinned to the plugin release
// version by the "release version surfaces are aligned" test.
export const ACP_CLIENT_VERSION = "0.7.0";

// Handshake requests (initialize / session/new / session/set_model) are
// bounded by this response timeout (or the attempt timeout if smaller);
// session/prompt is exempt (the model turn legitimately runs long) and is
// bounded by the attempt timer instead.
const HANDSHAKE_REQUEST_TIMEOUT_MS = 30000;

// Total agent_message_chunk text accumulated across all messageIds is capped;
// on overflow the outcome carries messageOverflow: true and the scheduler
// fails the attempt closed (a truncated final message must never reach the
// JSON validator looking complete).
const MAX_TOTAL_MESSAGE_CHARS = 4 * 1024 * 1024;

const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
});

const OPENCODE_VERSION_TIMEOUT_MS = 2000;

export function resolveOpencodeBin(env = process.env) {
  // An absolute path is recommended: PATH entries can be wrappers that
  // re-export OPENCODE_* and defeat the isolation recipe (Phase 0 finding).
  const candidate = env.CCDW_OPENCODE_BIN?.trim();
  return candidate || "opencode";
}

// Best-effort version probe for launch audit / smoke correlation. The worker
// itself is still launched separately as `opencode acp`; failures are recorded
// as a coarse status but never block execution.
export function probeOpencodeVersion({ bin, env = process.env, cwd = process.cwd(), timeoutMs = OPENCODE_VERSION_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const command = bin || resolveOpencodeBin(env);
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const killProbe = () => {
      try {
        if (process.platform === "win32" || child?.pid == null) {
          child?.kill("SIGKILL");
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Best-effort cleanup only.
      }
    };

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProbe();
          }, timeoutMs)
        : null;
    timer?.unref?.();

    try {
      child = spawn(command, ["--version"], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish({ version: null, status: "spawn_error" });
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 4096) {
        stdout = stdout.slice(-4096);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4096) {
        stderr = stderr.slice(-4096);
      }
    });
    child.on("error", (error) => {
      finish({ version: null, status: timedOut ? "timeout" : "spawn_error" });
    });
    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        finish({ version: null, status: "timeout" });
        return;
      }
      const firstLine = (value) => value.trim().split(/\r?\n/).find(Boolean)?.slice(0, 512) ?? null;
      const version = firstLine(stdout) ?? firstLine(stderr);
      if (exitCode !== 0 || signal != null) {
        finish({ version: null, status: "nonzero_exit" });
        return;
      }
      if (version == null) {
        finish({ version: null, status: "empty_output" });
        return;
      }
      finish({ version, status: "ok" });
    });
  });
}

// Injected opencode config (design §4.4). opencode defaults are fail-open
// (most tools allow), so the worker config pins a deny catch-all and opens
// only the tools the write scope needs. opencode permission rules are
// last-match-wins, so the "*" catch-all MUST stay the first key.
export function buildOpencodeWorkerConfig({ workflow }) {
  const policy = workflow.workspace_policy ?? {};
  const writeScope = Array.isArray(policy.write_scope) ? policy.write_scope : [];
  const workspaceWrite = writeScope.includes("workspace");
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      "*": "deny",
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
      glob: "allow",
      grep: "allow",
      lsp: "allow",
      // Read-only scope denies bash entirely: opencode has no OS sandbox
      // layer, so a shell cannot be confined to reads (design §4.4).
      edit: workspaceWrite ? "allow" : "deny",
      bash: workspaceWrite ? "allow" : "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      skill: "deny",
      question: "deny",
      external_directory: { "*": "deny" },
      doom_loop: "deny",
    },
  };
}

// Phase 0 isolation recipe: strip every inherited OPENCODE_* variable (e.g.
// OPENCODE_CONFIG_DIR pulls in ambient plugins), point XDG_CONFIG_HOME at an
// empty dir to block the global config, and disable project config / plugins
// / CLAUDE.md ingestion explicitly. OPENCODE_CONFIG alone is NOT sufficient
// (the project opencode.json wins over it). Provider API keys (OPENAI_API_KEY
// etc.) are inherited untouched; the data dir stays shared because auth.json
// lives there (residual ambient, disclosed in the approval summary).
export function buildAcpWorkerEnv({ env = process.env, configPath, xdgConfigDir }) {
  const workerEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("OPENCODE_")) {
      continue;
    }
    workerEnv[key] = value;
  }
  workerEnv.XDG_CONFIG_HOME = xdgConfigDir;
  workerEnv.OPENCODE_CONFIG = configPath;
  workerEnv.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  workerEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
  workerEnv.OPENCODE_DISABLE_AUTOUPDATE = "true";
  workerEnv.OPENCODE_DISABLE_CLAUDE_CODE = "true";
  workerEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
  return workerEnv;
}

// ACP has no schema-constrained final output, and models wrap the final JSON
// in a markdown fence (```json ... ```) in practice (Phase 0 #4). Strips the
// leading fence line and a trailing ``` line (tolerating whitespace) before
// the scheduler attempts JSON.parse.
export function extractFinalMessageText(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const lines = trimmed.split("\n");
  let end = lines.length;
  if (lines.length > 1 && lines[lines.length - 1].trim() === "```") {
    end = lines.length - 1;
  }
  return lines.slice(1, end).join("\n").trim();
}

// D7-r2 usage mapping from PromptResponse.usage. cachedWriteTokens is freshly
// processed input, so it is charged as input (same rationale as the claude
// cache_creation normalization); only cache READS stay out of input_tokens.
export function normalizeAcpUsage(usage) {
  const raw = usage ?? {};
  const num = (value) => Number(value) || 0;
  return {
    input_tokens: num(raw.inputTokens) + num(raw.cachedWriteTokens),
    cached_input_tokens: num(raw.cachedReadTokens),
    output_tokens: num(raw.outputTokens),
    reasoning_output_tokens: num(raw.thoughtTokens),
  };
}

// Spawns one `opencode acp` worker and drives the full handshake:
// initialize -> session/new -> session/set_model (required, fail-closed) ->
// session/prompt. Returns { pid, promise, cancel }; the promise resolves with
// the outcome and never rejects (process-runner convention).
export function startAcpExec({ bin, cwd, env, prompt, modelId, timeoutMs, onEvent }) {
  const child = spawn(bin, ["acp"], {
    cwd,
    env,
    // Unlike the NDJSON workers, stdin stays open: it is the JSON-RPC send path.
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let settled = false;
  let timedOut = false;
  let cancelled = false;
  let cancelSequenceStarted = false;
  let stderrTail = "";
  let threadId = null;
  let sawTurnCompleted = false;
  let stopReason = null;
  let setModelError = null;
  let usage = null;
  const escalationTimers = [];
  const sequenceTimers = [];
  // agent_message_chunk text accumulates per messageId; only the LAST
  // messageId is the final message (Phase 0 #4: naive concatenation of all
  // chunks mixes in pre-tool preamble messages).
  const messageChunks = new Map();
  let lastMessageId = null;
  let sawAnyChunk = false;
  let totalMessageChars = 0;
  let messageOverflow = false;

  const emitFrame = (frame) => {
    try {
      onEvent?.(frame);
    } catch {
      // Observers must not break worker accounting.
    }
  };

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

  const endStdin = () => {
    try {
      child.stdin?.end();
    } catch {
      // Already destroyed.
    }
  };

  child.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
  });

  const contentText = (content) => {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(contentText).join("");
    }
    if (content && typeof content === "object" && typeof content.text === "string") {
      return content.text;
    }
    return "";
  };

  const handleNotification = (method, params) => {
    if (settled || method !== "session/update") {
      return;
    }
    const update = params?.update;
    if (update?.sessionUpdate !== "agent_message_chunk") {
      // tool_call / tool_call_update / plan / agent_thought_chunk /
      // usage_update etc. are telemetry-only; the raw frame already reached
      // onEvent via the connection tap.
      return;
    }
    const messageId = update.messageId;
    sawAnyChunk = true;
    lastMessageId = messageId;
    if (messageOverflow) {
      // Cap already hit: keep tracking message identity for telemetry but
      // stop accumulating text (the attempt fails closed on the flag).
      return;
    }
    const text = contentText(update.content);
    if (totalMessageChars + text.length > MAX_TOTAL_MESSAGE_CHARS) {
      messageOverflow = true;
      return;
    }
    totalMessageChars += text.length;
    let parts = messageChunks.get(messageId);
    if (!parts) {
      parts = [];
      messageChunks.set(messageId, parts);
    }
    parts.push(text);
  };

  // D8 permission responder: deterministic full-deny. Permissions are decided
  // by the injected config; anything that still reaches "ask" is out of
  // policy and gets rejected. allow_always is never selected (it would let
  // the worker widen its own permissions for the rest of the session).
  const handleServerRequest = (method, params) => {
    if (method === "session/request_permission") {
      const options = Array.isArray(params?.options) ? params.options : [];
      const pick =
        options.find((option) => option?.kind === "reject_once") ??
        options.find((option) => option?.kind === "reject_always");
      const selected = pick ? pick.optionId : "cancelled";
      emitFrame({
        dir: "meta",
        permissionRequest: {
          toolCall: params?.toolCall ?? null,
          optionsOffered: options.map((option) => option?.kind ?? null),
          selected,
        },
      });
      if (pick) {
        return { outcome: { outcome: "selected", optionId: pick.optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    }
    // fs/* and terminal/* should never arrive (clientCapabilities is empty,
    // D9); anything else is answered -32601 by the connection (fail-closed).
    return { __methodNotFound: true };
  };

  const connection = createAcpConnection({
    stdin: child.stdin,
    stdout: child.stdout,
    onNotification: handleNotification,
    onServerRequest: handleServerRequest,
    onNoise: (line) => emitFrame({ dir: "meta", protocolNoise: line }),
    onFrame: emitFrame,
  });

  // Graceful stop: ask the agent to cancel the turn, then force teardown if
  // the prompt has not settled within the 2s grace window (ACP specifies no
  // cancellation deadline, so the kill escalation stays the backstop).
  const cancelSequence = () => {
    if (settled || cancelSequenceStarted) {
      return;
    }
    cancelSequenceStarted = true;
    if (threadId != null) {
      connection.notify("session/cancel", { sessionId: threadId });
    }
    const graceTimer = setTimeout(() => {
      endStdin();
      escalate();
    }, 2000);
    graceTimer.unref?.();
    sequenceTimers.push(graceTimer);
  };

  let timeoutTimer = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      cancelSequence();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }
  const clearAttemptTimeout = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  };

  // Handshake steps are bounded by the smaller of the attempt timeout and the
  // 30s response timeout; the prompt turn is exempt (attempt timer owns it).
  const handshakeTimeoutMs = Math.min(
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : HANDSHAKE_REQUEST_TIMEOUT_MS,
    HANDSHAKE_REQUEST_TIMEOUT_MS,
  );
  const handshakeOpts = { timeoutMs: handshakeTimeoutMs };

  const runHandshake = async () => {
    await connection.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "ccdw-dynamic-workflows", version: ACP_CLIENT_VERSION },
      },
      handshakeOpts,
    );
    const session = await connection.request("session/new", { cwd, mcpServers: [] }, handshakeOpts);
    threadId = typeof session?.sessionId === "string" ? session.sessionId : null;
    try {
      await connection.request("session/set_model", { sessionId: threadId, modelId }, handshakeOpts);
    } catch (error) {
      // Fail-closed (D5-r2): without a pinned model opencode silently falls
      // back to an ambient default with exit 0 / end_turn (Phase 0 #8), so a
      // set_model failure must abort the attempt before any prompt is sent.
      // Only a real JSON-RPC error reply (.rpc) is classified as a model
      // error; connection-closed/request-timeout errors fold into the
      // generic worker_failed path so audit does not mislabel process death.
      if (error?.rpc) {
        setModelError = error.message ?? String(error);
      }
      return;
    }
    const result = await connection.request(
      "session/prompt",
      {
        sessionId: threadId,
        prompt: [{ type: "text", text: prompt }],
      },
      { timeoutMs: Infinity },
    );
    // cancelled stays authoritative on the ccdw side: a cancelled turn can
    // still report stopReason end_turn (Phase 0 #7), so sawTurnCompleted is
    // purely stopReason === "end_turn" and the scheduler checks the cancelled
    // flag first.
    stopReason = result?.stopReason ?? null;
    sawTurnCompleted = stopReason === "end_turn";
    usage = normalizeAcpUsage(result?.usage);
  };

  // Handshake failures (JSON-RPC errors, connection closed mid-flight) fold
  // into the outcome via the state captured above; they never throw out.
  runHandshake()
    .catch(() => {})
    .then(() => {
      // The handshake (prompt request) settled: the attempt timer must not
      // stay armed into teardown, or a slow child exit after stdin EOF would
      // mislabel a successful turn as timed_out. Teardown is guarded by its
      // own 3s escalation below.
      clearAttemptTimeout();
      if (settled) {
        return;
      }
      // Teardown: stdin EOF asks `opencode acp` to exit on its own; escalate
      // if the child has not closed within the 3s guard.
      endStdin();
      const guardTimer = setTimeout(() => escalate(), 3000);
      guardTimer.unref?.();
      sequenceTimers.push(guardTimer);
    });

  const computeLastAgentMessage = () => {
    if (!sawAnyChunk) {
      return null;
    }
    const text = (messageChunks.get(lastMessageId) ?? []).join("");
    return text === "" ? null : text;
  };

  const promise = new Promise((resolve) => {
    const finalize = (exitCode, spawnError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearAttemptTimeout();
      for (const timer of [...escalationTimers, ...sequenceTimers]) {
        clearTimeout(timer);
      }
      // Seals the connection and rejects any in-flight request so the
      // handshake chain can never hang past process exit.
      connection.close();
      resolve({
        exitCode,
        spawnError: spawnError?.message ?? null,
        timedOut,
        cancelled,
        threadId,
        sawTurnCompleted,
        lastAgentMessage: computeLastAgentMessage(),
        messageOverflow,
        usage: usage ?? { ...ZERO_USAGE },
        stderrTail,
        pid: child.pid ?? null,
        stopReason: stopReason ?? null,
        setModelError: setModelError ?? null,
      });
    };
    child.on("error", (error) => finalize(null, error));
    child.on("close", (code) => finalize(code, null));
  });

  return {
    pid: child.pid ?? null,
    promise,
    cancel() {
      // No-op after settle: escalating would arm SIGTERM/SIGKILL timers that
      // nothing clears and that could signal a recycled process group.
      if (settled) {
        return;
      }
      cancelled = true;
      cancelSequence();
    },
  };
}
