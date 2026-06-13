#!/usr/bin/env node
// Test double for `opencode acp`. Mimics the ACP (Agent Client Protocol) v1
// nd-JSON-RPC contract observed on opencode 1.16.2 (Phase 0, see
// docs/local/dynamic-workflows-smoke-runs/acp-phase0-20260613/RESULTS.md):
// initialize -> session/new -> session/set_model -> session/prompt with
// session/update notifications (agent_message_chunk carries messageId; the
// turn emits a preamble message, a tool_call/tool_call_update pair, then the
// final message split across chunks) and a PromptResponse carrying
// {stopReason, usage}. Behavior switches on FAKE_ACP_MODE; CCDW_OPENCODE_BIN
// points tests at this script (executable bit + shebang, like fake-codex.js).
// stdout carries protocol JSON lines only; all debug goes to stderr.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (process.argv[2] === "--version") {
  const versionMode = process.env.FAKE_ACP_VERSION_MODE ?? "success";
  if (versionMode === "fail") {
    process.stderr.write("fake-acp-agent version unavailable\n");
    process.exit(7);
  }
  if (versionMode === "hang") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else if (versionMode === "empty") {
    process.exit(0);
  } else {
    process.stdout.write(`${process.env.FAKE_ACP_VERSION ?? "FakeOpenCode 0.0.1"}\n`);
    process.exit(0);
  }
}

if (process.argv[2] !== "acp") {
  process.stderr.write('fake-acp-agent: expected "acp" subcommand as argv[2]\n');
  process.exit(2);
}

const mode = process.env.FAKE_ACP_MODE ?? "success";
const fenced = process.env.FAKE_ACP_FENCED === "1";
const setModelError = process.env.FAKE_ACP_SET_MODEL_ERROR === "1";
const ignoreSigint = process.env.FAKE_ACP_IGNORE_SIGINT === "1";
const tracePath = process.env.FAKE_ACP_TRACE;
// After the turn completes, keep the process alive N ms past stdin EOF (the
// pending timer holds the event loop open) before exiting naturally. Used by
// the attempt-timeout regression: turn succeeds fast, child lingers.
const exitDelayMs = Number(process.env.FAKE_ACP_EXIT_DELAY_MS ?? 0);
// permission mode option-set variants for the D8 responder fallbacks:
// "reject_always_only" offers only [reject_always]; "allow_only" offers only
// [allow_once, allow_always] (forcing the cancelled outcome).
const permissionOptionsVariant = process.env.FAKE_ACP_PERMISSION_OPTIONS ?? "default";
// permission mode: number of sequential session/request_permission rounds.
const permissionRepeat = Math.max(1, Number(process.env.FAKE_ACP_PERMISSION_REPEAT ?? 1) || 1);
// Overrides the PromptResponse stopReason and skips the final message (e.g.
// "max_tokens": the turn ends without a usable envelope).
const stopReasonOverride = process.env.FAKE_ACP_STOP_REASON;
// Emits a final message of ~N chars (512 KiB chunks) to exceed the
// executor's accumulated-message cap.
const hugeMessageTotal = Number(process.env.FAKE_ACP_HUGE_MESSAGE_TOTAL ?? 0);

const sessionId = `fake-ses-${process.pid}`;

// Isolation-recipe env keys the executor must set (or scrub) when spawning;
// recorded verbatim so tests can assert the recipe. OPENCODE_CONFIG_DIR must
// come out undefined when the inherited OPENCODE_* env was properly scrubbed.
const TRACE_ENV_KEYS = [
  "OPENCODE_CONFIG",
  "XDG_CONFIG_HOME",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_CONFIG_DIR",
];

function appendTrace(entry) {
  if (!tracePath) {
    return;
  }
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);
}

function debug(message) {
  process.stderr.write(`fake-acp-agent: ${message}\n`);
}

appendTrace({
  event: "spawn",
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(TRACE_ENV_KEYS.map((key) => [key, process.env[key]])),
});

if (ignoreSigint) {
  process.on("SIGINT", () => {
    debug("ignoring SIGINT (FAKE_ACP_IGNORE_SIGINT=1)");
  });
}

// Swallow EPIPE: kill-escalation tests can close our stdout while the slow
// loop is still emitting.
process.stdout.on("error", () => {});

function writeLine(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // Ignore writes after the pipe closed.
  }
}

function respond(id, result) {
  writeLine({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendUpdate(update) {
  writeLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

// Server -> client requests (session/request_permission, fs/read_text_file in
// unknown_request mode). Resolved with the whole response message so callers
// can inspect either result or error.
let nextServerRequestId = 1;
const pendingServerRequests = new Map();

function sendServerRequest(method, params) {
  const id = nextServerRequestId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    writeLine({ jsonrpc: "2.0", id, method, params });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function standardUsage() {
  return { inputTokens: 100, outputTokens: 50, totalTokens: 160, thoughtTokens: 10, cachedWriteTokens: 30 };
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function buildFinalText() {
  if (mode === "invalid_json") {
    return "this is not json";
  }
  const status = mode === "worker_reported_failure" ? "failed" : "succeeded";
  // task_id / attempt_id deliberately absent: the runner injects identity.
  const envelope = {
    status,
    summary: status === "failed" ? "fake failure" : "fake ok",
    findings: [],
    errors: status === "failed" ? ["fake failure"] : [],
    evidence: [],
    modified_files: [],
    commands_run: [],
    artifacts: [],
  };
  const json = JSON.stringify(envelope);
  // Replicates real model behavior: 2/2 Phase 0 turns wrapped the envelope in
  // a markdown fence; the executor must strip it before JSON.parse.
  return fenced ? `\`\`\`json\n${json}\n\`\`\`` : json;
}

function splitChunks(text, minParts) {
  const size = Math.max(1, Math.floor(text.length / minParts));
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

let pendingPromptId = null;
let slowTimer = null;

// cancel_endturn / cancel_ignore: keep streaming preamble chunks (one every
// 100ms, up to 60s) so the client has an in-flight turn to cancel.
function startSlowPreamble() {
  let tick = 0;
  slowTimer = setInterval(() => {
    tick += 1;
    if (tick <= 600) {
      sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `working... tick ${tick} ` },
        messageId: "msg-1",
      });
    } else if (mode !== "cancel_ignore") {
      // cancel_ignore keeps the interval alive forever so only signal
      // escalation (SIGTERM/SIGKILL) can end the process.
      clearInterval(slowTimer);
      slowTimer = null;
    }
  }, 100);
}

function permissionOptionSet() {
  if (permissionOptionsVariant === "reject_always_only") {
    return [{ optionId: "opt-reject-always", kind: "reject_always", name: "Never" }];
  }
  if (permissionOptionsVariant === "allow_only") {
    return [
      { optionId: "opt-allow-once", kind: "allow_once", name: "Allow" },
      { optionId: "opt-allow-always", kind: "allow_always", name: "Always" },
    ];
  }
  return [
    { optionId: "opt-allow-once", kind: "allow_once", name: "Allow" },
    { optionId: "opt-allow-always", kind: "allow_always", name: "Always" },
    { optionId: "opt-reject-once", kind: "reject_once", name: "Reject" },
  ];
}

// Phase 0 observed turn shape shared by all message-emitting modes: preamble
// message (msg-1, multiple chunks) -> tool_call -> tool_call_update -> final
// message (msg-2, >=3 chunks) -> usage_update -> PromptResponse.
async function runScriptedTurn(id) {
  sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning the task." } });
  await sleep(5);
  sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll do " }, messageId: "msg-1" });
  sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "that now." }, messageId: "msg-1" });
  await sleep(5);
  sendUpdate({ sessionUpdate: "tool_call", title: "bash", kind: "execute", status: "pending" });
  if (mode === "permission") {
    for (let round = 0; round < permissionRepeat; round += 1) {
      const reply = await sendServerRequest("session/request_permission", {
        sessionId,
        toolCall: { title: "bash", kind: "execute" },
        options: permissionOptionSet(),
      });
      appendTrace({
        event: "permission_outcome",
        outcome: reply.error ? { error: reply.error } : (reply.result?.outcome ?? null),
      });
    }
    // Phase 0 #2: rejected permission -> tool_call_update failed, turn continues.
    sendUpdate({ sessionUpdate: "tool_call_update", title: "bash", status: "failed" });
  } else {
    sendUpdate({ sessionUpdate: "tool_call_update", title: "bash", status: "completed" });
  }
  if (mode === "unknown_request") {
    // The ccdw client advertises no fs capability and must answer -32601.
    const reply = await sendServerRequest("fs/read_text_file", { path: "x" });
    appendTrace({ event: "unknown_request_reply", error: reply.error ?? null });
  }
  await sleep(5);
  if (hugeMessageTotal > 0) {
    // 512 KiB chunks: large enough to bulk up fast, small enough that each
    // JSON line stays under the client's 1 MiB line cap.
    const chunkSize = 512 * 1024;
    let sent = 0;
    while (sent < hugeMessageTotal) {
      const size = Math.min(chunkSize, hugeMessageTotal - sent);
      sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(size) }, messageId: "msg-2" });
      sent += size;
    }
  } else {
    for (const chunk of splitChunks(buildFinalText(), 3)) {
      sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk }, messageId: "msg-2" });
      await sleep(5);
    }
  }
  sendUpdate({ sessionUpdate: "usage_update", usage: standardUsage() });
  respond(id, { stopReason: "end_turn", usage: standardUsage(), _meta: {} });
  if (exitDelayMs > 0) {
    debug(`holding process alive ${exitDelayMs}ms past turn completion (FAKE_ACP_EXIT_DELAY_MS)`);
    setTimeout(() => debug("exit delay elapsed"), exitDelayMs);
  }
}

async function handlePrompt(id, params) {
  const text = (Array.isArray(params.prompt) ? params.prompt : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  appendTrace({
    event: "prompt",
    textLength: text.length,
    textSha256: crypto.createHash("sha256").update(text).digest("hex"),
  });
  if (stopReasonOverride) {
    // e.g. max_tokens: the turn ends with the overridden stopReason and no
    // final message (nothing usable was produced).
    respond(id, { stopReason: stopReasonOverride, usage: standardUsage(), _meta: {} });
    return;
  }
  switch (mode) {
    case "refusal":
      // No message chunks at all.
      respond(id, { stopReason: "refusal", usage: zeroUsage(), _meta: {} });
      return;
    case "no_message":
      respond(id, { stopReason: "end_turn", usage: standardUsage(), _meta: {} });
      return;
    case "hang":
      // Never respond; the process exits naturally when stdin closes.
      return;
    case "cancel_endturn":
    case "cancel_ignore":
      pendingPromptId = id;
      startSlowPreamble();
      return;
    default:
      await runScriptedTurn(id);
  }
}

function handleNotification(message) {
  if (message.method !== "session/cancel") {
    debug(`ignoring notification ${message.method}`);
    return;
  }
  if (mode === "cancel_ignore") {
    debug("ignoring session/cancel (cancel_ignore mode)");
    return;
  }
  if (mode === "cancel_endturn") {
    if (slowTimer) {
      clearInterval(slowTimer);
      slowTimer = null;
    }
    if (pendingPromptId != null) {
      // Phase 0 #7 trap: a cancelled turn still resolves with stopReason
      // "end_turn" (usage all zeros), never "cancelled". No final message.
      respond(pendingPromptId, { stopReason: "end_turn", usage: zeroUsage(), _meta: {} });
      pendingPromptId = null;
    }
    return;
  }
  debug("session/cancel received; no scripted reaction in this mode");
}

function handleRequest(message) {
  const { id, method } = message;
  const params = message.params ?? {};
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true, image: true },
        },
        agentInfo: { name: "FakeOpenCode", version: "0.0.1" },
      });
      return;
    case "session/new":
      if (mode === "die_mid_handshake") {
        debug("dying mid-handshake before answering session/new");
        process.exit(1);
      }
      respond(id, {
        sessionId,
        configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "opencode/big-pickle" }],
        modes: null,
      });
      return;
    case "session/set_model":
      if (mode === "die_at_set_model") {
        // Process death instead of a JSON-RPC error reply: the executor must
        // fold this into the generic worker_failed path, not set_model_error.
        debug("dying before answering session/set_model");
        process.exit(1);
      }
      if (setModelError) {
        // Phase 0 #8: the only deterministic guard against the zen fallback.
        respondError(id, -32602, `Invalid params: model not found: ${params.modelId}`);
        return;
      }
      appendTrace({ event: "set_model", modelId: params.modelId });
      respond(id, {});
      return;
    case "session/prompt":
      handlePrompt(id, params).catch((error) => {
        debug(`prompt handler failed: ${error?.stack ?? error}`);
        respondError(id, -32603, "Internal error in fake-acp-agent prompt handler");
      });
      return;
    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleMessage(message) {
  if (message.method === undefined && message.id !== undefined) {
    // Response to one of our server -> client requests.
    const resolve = pendingServerRequests.get(message.id);
    if (resolve) {
      pendingServerRequests.delete(message.id);
      resolve(message);
    } else {
      debug(`response for unknown request id ${message.id}`);
    }
    return;
  }
  if (message.id === undefined) {
    handleNotification(message);
    return;
  }
  handleRequest(message);
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (line === "") {
      continue;
    }
    try {
      handleMessage(JSON.parse(line));
    } catch {
      debug(`discarding non-JSON stdin line: ${line.slice(0, 120)}`);
    }
  }
});
process.stdin.on("end", () => {
  if (mode === "cancel_ignore") {
    debug("ignoring stdin close (cancel_ignore mode)");
    return;
  }
  // Natural exit once pending timers drain (no process.exit: pending stdout
  // writes must flush, same trap as fake-codex.js).
  process.exitCode = 0;
});
