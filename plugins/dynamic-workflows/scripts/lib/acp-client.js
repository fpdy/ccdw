// Minimal newline-delimited JSON-RPC 2.0 connection for the Agent Client
// Protocol (ACP) subset used by the acp executor. Implemented in-repo instead
// of pulling the ACP SDK (design decision D3: dependency-minimal, no 0.x
// churn, full control over fail-closed behavior).
//
// stdin is the write side (to the spawned agent), stdout the read side (from
// the agent). Line framing follows process-runner.js conventions: one JSON
// message per line, the trailing unterminated line is flushed when the read
// stream closes, and unparseable lines are surfaced via onNoise instead of
// breaking the connection. Observer callbacks (onNotification /
// onServerRequest / onNoise / onFrame) must never break protocol accounting,
// so exceptions thrown by them are swallowed.

const noop = () => {};

const connectionClosedError = () => new Error("ACP connection closed");

// A single buffered line may not grow without bound (a hostile or broken
// agent could stream gigabytes without a newline). Oversized lines are
// dropped as protocol noise; the connection itself survives.
const MAX_LINE_BYTES = 1024 * 1024;

// onFrame({ dir: "send" | "recv", msg }) is the telemetry tap: it observes
// every JSON-RPC message this connection parses or writes, so the executor
// can persist the raw protocol exchange (acp-frames.jsonl, requirement R6).
// requestTimeoutMs bounds every request() by default (design §4.2 応答
// タイムアウト); per-call { timeoutMs } overrides it, 0/Infinity disables.
export function createAcpConnection({
  stdin,
  stdout,
  onNotification,
  onServerRequest,
  onNoise,
  onFrame,
  requestTimeoutMs = 30000,
}) {
  let nextId = 1;
  let closed = false;
  let buffer = "";
  // True while discarding the remainder of an oversized line (everything up
  // to the next newline is part of the line that already overflowed).
  let droppingOversizedLine = false;
  const inFlight = new Map();

  const safeObserve = (fn, ...args) => {
    if (typeof fn !== "function") {
      return;
    }
    try {
      fn(...args);
    } catch {
      // Observers must not break protocol accounting.
    }
  };

  // Writes to a dying child surface EPIPE asynchronously on the stream;
  // no-op error listeners keep that from crashing the orchestrator.
  stdin?.on?.("error", noop);
  stdout?.on?.("error", noop);

  const writeMessage = (msg) => {
    if (closed) {
      return;
    }
    safeObserve(onFrame, { dir: "send", msg });
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return;
    }
    try {
      stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // Stream destroyed mid-write; async EPIPE is absorbed by the listener.
    }
  };

  const replyError = (id, code, message) => {
    writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
  };

  // Server -> client request (has both id and method). The handler returns a
  // Promise of the result; a thrown error becomes a JSON-RPC error reply, and
  // the { __methodNotFound: true } sentinel (or a missing handler) becomes
  // -32601 so unsupported delegations fail closed without killing the turn.
  const handleServerRequest = (msg) => {
    const methodNotFound = () => replyError(msg.id, -32601, `Method not found: ${msg.method}`);
    if (typeof onServerRequest !== "function") {
      methodNotFound();
      return;
    }
    Promise.resolve()
      .then(() => onServerRequest(msg.method, msg.params))
      .then((result) => {
        if (result != null && result.__methodNotFound === true) {
          methodNotFound();
          return;
        }
        writeMessage({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
      })
      .catch((error) => {
        replyError(msg.id, -32603, error?.message ?? "Internal error");
      });
  };

  const handleResponse = (msg) => {
    const pending = inFlight.get(msg.id);
    if (!pending) {
      // Late or unknown response: the request was already rejected/settled.
      return;
    }
    inFlight.delete(msg.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (msg.error != null) {
      const rpc = {
        code: msg.error.code ?? null,
        message: msg.error.message ?? null,
        data: msg.error.data ?? null,
      };
      const error = new Error(rpc.message ?? `JSON-RPC error ${rpc.code}`);
      error.rpc = rpc;
      pending.reject(error);
      return;
    }
    pending.resolve(msg.result);
  };

  const handleLine = (line) => {
    if (closed) {
      // Sealed connection: late frames are dropped, never re-dispatched.
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      safeObserve(onNoise, line);
      return;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      safeObserve(onNoise, line);
      return;
    }
    safeObserve(onFrame, { dir: "recv", msg });
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) {
        handleServerRequest(msg);
      } else {
        safeObserve(onNotification, msg.method, msg.params);
      }
      return;
    }
    if (msg.id !== undefined) {
      handleResponse(msg);
    }
  };

  // Callers must never hang on a dead agent: every in-flight request is
  // rejected when the connection closes (stream close or explicit close()).
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    const pendingEntries = [...inFlight.values()];
    inFlight.clear();
    for (const pending of pendingEntries) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(connectionClosedError());
    }
  };

  const dropOversized = (text) => {
    safeObserve(onNoise, `[truncated] oversized ACP line dropped (${text.length} chars > ${MAX_LINE_BYTES}): ${text.slice(0, 120)}`);
  };

  stdout?.on?.("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (droppingOversizedLine) {
        // Tail of a line whose head already overflowed and was dropped.
        droppingOversizedLine = false;
      } else if (line.length > MAX_LINE_BYTES) {
        dropOversized(line);
      } else {
        handleLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
    if (droppingOversizedLine) {
      buffer = "";
    } else if (buffer.length > MAX_LINE_BYTES) {
      dropOversized(buffer);
      buffer = "";
      droppingOversizedLine = true;
    }
  });
  stdout?.on?.("close", () => {
    if (buffer && !droppingOversizedLine) {
      // Flush the trailing unterminated line before sealing the connection so
      // a final response without a newline still settles its request.
      handleLine(buffer);
    }
    buffer = "";
    close();
  });

  const request = (method, params, options = {}) => {
    if (closed) {
      return Promise.reject(connectionClosedError());
    }
    const id = nextId++;
    const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!inFlight.has(id)) {
            return;
          }
          inFlight.delete(id);
          const error = new Error(`ACP request timed out: ${method}`);
          error.timedOut = true;
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }
      inFlight.set(id, { resolve, reject, timer });
      writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  };

  const notify = (method, params) => {
    writeMessage({ jsonrpc: "2.0", method, params });
  };

  return { request, notify, close };
}
