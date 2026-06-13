import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createAcpConnection } from "../scripts/lib/acp-client.js";

// Unit coverage for the connection-level hardening: per-request response
// timeouts (design §4.2 応答タイムアウト) and the bounded stdout line buffer.

function makeConnection(options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const noise = [];
  const sent = [];
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() !== "") {
        sent.push(JSON.parse(line));
      }
    }
  });
  const connection = createAcpConnection({
    stdin,
    stdout,
    onNoise: (line) => noise.push(line),
    ...options.connection,
  });
  return { connection, stdin, stdout, noise, sent };
}

test("acp-client request rejects with timedOut after requestTimeoutMs", async () => {
  const { connection } = makeConnection({ connection: { requestTimeoutMs: 40 } });
  const start = Date.now();
  await assert.rejects(
    () => connection.request("initialize", {}),
    (error) => {
      assert.equal(error.message, "ACP request timed out: initialize");
      assert.equal(error.timedOut, true);
      return true;
    },
  );
  assert.ok(Date.now() - start >= 35, "should not reject before the timeout");
});

test("acp-client late response after a request timeout is ignored", async () => {
  const { connection, stdout } = makeConnection({ connection: { requestTimeoutMs: 30 } });
  await assert.rejects(() => connection.request("session/new", {}), /ACP request timed out/);
  // The in-flight entry was removed: a late reply must not throw or resolve.
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "late" } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("acp-client per-request timeoutMs overrides the connection default", async () => {
  const { connection } = makeConnection({ connection: { requestTimeoutMs: 10000 } });
  await assert.rejects(
    () => connection.request("session/set_model", {}, { timeoutMs: 30 }),
    (error) => error.timedOut === true,
  );
});

test("acp-client timeoutMs Infinity and 0 disable the response timeout", async () => {
  const { connection, stdout } = makeConnection({ connection: { requestTimeoutMs: 30 } });
  const unbounded = connection.request("session/prompt", {}, { timeoutMs: Infinity });
  const disabled = connection.request("session/prompt", {}, { timeoutMs: 0 });
  // Wait well past the 30ms connection default before answering.
  await new Promise((resolve) => setTimeout(resolve, 80));
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } })}\n`);
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } })}\n`);
  assert.deepEqual(await unbounded, { stopReason: "end_turn" });
  assert.deepEqual(await disabled, { stopReason: "end_turn" });
});

test("acp-client settled responses clear their timers and resolve normally", async () => {
  const { connection, stdout, sent } = makeConnection({ connection: { requestTimeoutMs: 5000 } });
  const pending = connection.request("initialize", { protocolVersion: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent[0].method, "initialize");
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: { ok: true } })}\n`);
  assert.deepEqual(await pending, { ok: true });
});

test("acp-client drops an oversized line as noise and keeps the connection alive", async () => {
  const { connection, stdout, noise } = makeConnection();
  const pending = connection.request("session/new", {}, { timeoutMs: 0 });
  // > 1 MiB without a newline, streamed in two chunks, then terminated.
  stdout.write("x".repeat(700 * 1024));
  stdout.write("y".repeat(700 * 1024));
  stdout.write("z-tail\n");
  // The connection must still parse subsequent well-formed lines.
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "after-noise" } })}\n`);
  assert.deepEqual(await pending, { sessionId: "after-noise" });
  assert.ok(noise.length >= 1, "expected the oversized line to surface as noise");
  assert.match(noise[0], /\[truncated\] oversized ACP line dropped/);
  // The tail of the oversized line is discarded, not re-dispatched as a line.
  assert.ok(!noise.some((line) => line === "z-tail"));
});

test("acp-client drops an oversized complete line arriving in one chunk", async () => {
  const { connection, stdout, noise } = makeConnection();
  const pending = connection.request("session/new", {}, { timeoutMs: 0 });
  stdout.write(`${"a".repeat(1100 * 1024)}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } })}\n`);
  assert.deepEqual(await pending, { ok: 1 });
  assert.equal(noise.length, 1);
  assert.match(noise[0], /\[truncated\] oversized ACP line dropped/);
});
