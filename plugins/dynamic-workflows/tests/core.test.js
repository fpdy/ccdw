import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelWorkflow,
  planWorkflow,
  resumeWorkflow,
  runWorkflow,
  statusWorkflow,
  validatePluginLayout,
  validateRunDirectory,
} from "../scripts/lib/core.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-test-"));
}

function withEnv(name, value, callback) {
  const original = process.env[name];
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    if (original == null) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

test("planWorkflow creates an approval-gated run directory", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    objective: "Review the local workflow contract",
    workspace,
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.required, true);
  assert.ok(fs.existsSync(result.paths.workflow_spec));
  assert.ok(fs.existsSync(result.paths.run_state));
  assert.ok(fs.existsSync(result.paths.event_log));
  assert.ok(fs.existsSync(result.paths.artifacts));
  assert.equal(validateRunDirectory({ runDir: result.run_dir }).valid, true);
});

test("planWorkflow stores runs under workspace .ccdw by default", () => {
  const workspace = makeTempWorkspace();
  const result = withEnv("CCDW_HOME", null, () =>
    planWorkflow({
      objective: "Use the default ccdw home",
      workspace,
      runId: "default-run",
    }),
  );

  assert.equal(result.run_dir, path.join(workspace, ".ccdw", "dynamic-workflows", "runs", "default-run"));
});

test("planWorkflow honors CCDW_HOME when no run root is provided", () => {
  const workspace = makeTempWorkspace();
  const ccdwHome = path.join(makeTempWorkspace(), "state");
  const result = withEnv("CCDW_HOME", ccdwHome, () =>
    planWorkflow({
      objective: "Use an environment configured ccdw home",
      workspace,
      runId: "env-run",
    }),
  );

  assert.equal(result.run_dir, path.join(ccdwHome, "dynamic-workflows", "runs", "env-run"));
});

test("planWorkflow resolves relative CCDW_HOME from the workspace root", () => {
  const workspace = makeTempWorkspace();
  const result = withEnv("CCDW_HOME", "custom-ccdw", () =>
    planWorkflow({
      objective: "Use a relative environment configured ccdw home",
      workspace,
      runId: "relative-env-run",
    }),
  );

  assert.equal(result.run_dir, path.join(workspace, "custom-ccdw", "dynamic-workflows", "runs", "relative-env-run"));
});

test("planWorkflow prefers explicit runRoot over CCDW_HOME", () => {
  const workspace = makeTempWorkspace();
  const ccdwHome = path.join(workspace, "ignored-home");
  const result = withEnv("CCDW_HOME", ccdwHome, () =>
    planWorkflow({
      objective: "Use the explicit run root",
      workspace,
      runRoot: "explicit-runs",
      runId: "explicit-run",
    }),
  );

  assert.equal(result.run_dir, path.join(workspace, "explicit-runs", "explicit-run"));
});

test("runWorkflow enforces approval and completes all local tasks", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Execute a deterministic workflow",
    workspace,
  });

  assert.throws(
    () => runWorkflow({ runDir: planned.run_dir }),
    /awaiting approval/,
  );

  const completed = runWorkflow({
    runDir: planned.run_dir,
    approve: true,
    approvedBy: "test",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");
  assert.equal(completed.tasks["explore-objective"].status, "succeeded");
  assert.equal(completed.tasks["verify-findings"].status, "succeeded");
  assert.equal(completed.tasks["synthesize-result"].status, "succeeded");
  assert.ok(completed.artifacts.includes("artifacts/synthesis.md"));
  assert.ok(completed.event_count >= 10);
});

test("resumeWorkflow leaves terminal runs terminal and records a noop event", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Resume a completed workflow",
    workspace,
  });
  const completed = runWorkflow({ runDir: planned.run_dir, approve: true });
  const resumed = resumeWorkflow({ runDir: completed.run_dir });

  assert.equal(resumed.status, "completed");
  assert.ok(resumed.event_count > completed.event_count);
});

test("cancelWorkflow cancels non-terminal runs", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Cancel before execution",
    workspace,
  });
  const cancelled = cancelWorkflow({
    runDir: planned.run_dir,
    reason: "test cancellation",
  });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(statusWorkflow({ runDir: planned.run_dir }).status, "cancelled");
});

test("CLI plan and run commands work with JSON output", () => {
  const workspace = makeTempWorkspace();
  const cli = path.join(pluginRoot, "scripts", "dynamic-workflows.js");
  const planOutput = execFileSync(
    "node",
    [cli, "plan", "--objective", "Run through the CLI", "--workspace", workspace, "--json"],
    { encoding: "utf8" },
  );
  const planned = JSON.parse(planOutput);
  const runOutput = execFileSync(
    "node",
    [cli, "run", "--run-dir", planned.run_dir, "--approve", "--json"],
    { encoding: "utf8" },
  );
  const completed = JSON.parse(runOutput);

  assert.equal(completed.status, "completed");
});

test("validatePluginLayout sees the expected plugin files", () => {
  const result = validatePluginLayout({ pluginRoot });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});

test("MCP server initializes, lists tools, and plans a workflow", async (t) => {
  const workspace = makeTempWorkspace();
  const server = spawn("node", [path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server);

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");

  const listed = await client.request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.ok(listed.result.tools.some((tool) => tool.name === "dynamic_workflows_plan"));

  const planned = await client.request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "dynamic_workflows_plan",
      arguments: {
        objective: "Plan through MCP",
        workspace,
      },
    },
  });
  const payload = JSON.parse(planned.result.content[0].text);
  assert.equal(payload.status, "awaiting_approval");
  assert.ok(fs.existsSync(payload.paths.run_state));
});

test("MCP config starts from the plugin root", async (t) => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const serverConfig = config.mcpServers["dynamic-workflows"];

  assert.equal(serverConfig.cwd, ".");

  const server = spawn(serverConfig.command, serverConfig.args, {
    cwd: path.resolve(pluginRoot, serverConfig.cwd),
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server);

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });

  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");
});

test("MCP server accepts LF-only stdio headers", { timeout: 3000 }, async (t) => {
  const server = spawn("node", [path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server, { requestDelimiter: "\n\n" });

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });

  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");
});

test("MCP server accepts Codex newline-delimited JSON framing", { timeout: 3000 }, async (t) => {
  const server = spawn("node", [path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server, { framing: "jsonl" });

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: {
        name: "codex-mcp-client",
        title: "Codex",
        version: "0.137.0",
      },
    },
  });
  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");

  const listed = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  assert.ok(listed.result.tools.some((tool) => tool.name === "dynamic_workflows_plan"));
});

function createMcpClient(child, options = {}) {
  const framing = options.framing ?? "headers";
  const requestDelimiter = options.requestDelimiter ?? "\r\n\r\n";
  let buffer = Buffer.alloc(0);
  const pending = [];
  const queued = [];

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });

  child.stderr.on("data", (chunk) => {
    if (pending.length > 0) {
      pending.shift().reject(new Error(chunk.toString("utf8")));
    }
  });

  function request(message) {
    writeMcpMessage(child.stdin, message, { framing, delimiter: requestDelimiter });
    if (queued.length > 0) {
      return Promise.resolve(queued.shift());
    }
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  }

  function drain() {
    if (framing === "jsonl") {
      drainJsonLines();
      return;
    }
    drainHeaders();
  }

  function drainHeaders() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      assert.ok(lengthMatch, `invalid MCP header: ${header}`);
      const contentLength = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }
      const raw = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);
      const parsed = JSON.parse(raw);
      deliver(parsed);
    }
  }

  function drainJsonLines() {
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      const raw = buffer.slice(0, lineEnd).toString("utf8").trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!raw) {
        continue;
      }
      deliver(JSON.parse(raw));
    }
  }

  function deliver(message) {
    if (pending.length > 0) {
      pending.shift().resolve(message);
    } else {
      queued.push(message);
    }
  }

  return { request };
}

function writeMcpMessage(stdin, message, options = {}) {
  const framing = options.framing ?? "headers";
  const delimiter = options.delimiter ?? "\r\n\r\n";
  const json = JSON.stringify(message);
  if (framing === "jsonl") {
    stdin.write(`${json}\n`);
    return;
  }
  stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}${delimiter}${json}`);
}
