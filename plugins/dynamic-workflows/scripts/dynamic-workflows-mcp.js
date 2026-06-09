#!/usr/bin/env node
import {
  approveWorkflow,
  cancelWorkflow,
  planWorkflow,
  resumeWorkflow,
  runWorkflow,
  statusWorkflow,
  validateRunDirectory,
} from "./lib/core.js";
import fs from "node:fs";

const serverInfo = {
  name: "dynamic-workflows",
  version: "0.1.0",
};

const tools = [
  {
    name: "dynamic_workflows_plan",
    description: "Create a local declarative workflow run and leave it awaiting approval.",
    inputSchema: {
      type: "object",
      required: ["objective"],
      properties: {
        objective: { type: "string" },
        workspace: { type: "string" },
        runRoot: { type: "string" },
        runId: { type: "string" },
      },
    },
  },
  {
    name: "dynamic_workflows_approve",
    description: "Approve a planned workflow run.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
        approvedBy: { type: "string" },
      },
    },
  },
  {
    name: "dynamic_workflows_run",
    description: "Execute an approved workflow run, optionally granting the approval gate.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
        approve: { type: "boolean" },
        approvedBy: { type: "string" },
      },
    },
  },
  {
    name: "dynamic_workflows_resume",
    description: "Resume a non-terminal workflow run.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
        continueRun: { type: "boolean" },
      },
    },
  },
  {
    name: "dynamic_workflows_status",
    description: "Read workflow run status, tasks, phases, event count, and artifact paths.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
      },
    },
  },
  {
    name: "dynamic_workflows_cancel",
    description: "Cancel a non-completed workflow run.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "dynamic_workflows_validate",
    description: "Validate a workflow run directory.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
      },
    },
  },
];

let inputBuffer = Buffer.alloc(0);

debugLog("start", {
  argv: process.argv,
  cwd: process.cwd(),
  execPath: process.execPath,
  nodeVersion: process.version,
  path: process.env.PATH,
});

process.stdin.on("data", (chunk) => {
  debugLog("stdin.data", {
    bytes: chunk.length,
    previewHex: chunk.subarray(0, 256).toString("hex"),
    previewText: chunk.subarray(0, 256).toString("utf8"),
  });
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainMessages();
});

process.stdin.on("end", () => {
  debugLog("stdin.end");
  process.exit(0);
});

function drainMessages() {
  while (true) {
    if (inputBuffer.length === 0) {
      return;
    }

    if (looksLikeJsonLine(inputBuffer)) {
      const lineEnd = inputBuffer.indexOf("\n");
      if (lineEnd === -1) {
        debugLog("drain.wait_jsonl", { bufferedBytes: inputBuffer.length });
        return;
      }

      const rawMessage = inputBuffer.slice(0, lineEnd).toString("utf8").trim();
      inputBuffer = inputBuffer.slice(lineEnd + 1);
      if (!rawMessage) {
        continue;
      }
      debugLog("drain.jsonl_message", { rawMessage });
      handleRawMessage(rawMessage, "jsonl");
      continue;
    }

    const headerBoundary = findHeaderBoundary(inputBuffer);
    if (!headerBoundary) {
      debugLog("drain.wait_header", { bufferedBytes: inputBuffer.length });
      return;
    }
    const header = inputBuffer.slice(0, headerBoundary.index).toString("utf8");
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      debugLog("drain.invalid_header", { header });
      inputBuffer = Buffer.alloc(0);
      return;
    }
    const contentLength = Number(lengthMatch[1]);
    const messageStart = headerBoundary.index + headerBoundary.length;
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) {
      debugLog("drain.wait_body", {
        bufferedBytes: inputBuffer.length,
        expectedBytes: messageEnd,
        contentLength,
      });
      return;
    }
    const rawMessage = inputBuffer.slice(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(messageEnd);
    debugLog("drain.message", { rawMessage });
    handleRawMessage(rawMessage, "headers");
  }
}

function handleRawMessage(rawMessage, responseFraming) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch (error) {
    debugLog("parse.error", { message: error.message, rawMessage });
    send(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      },
      responseFraming,
    );
    return;
  }

  handleMessage(message, responseFraming).catch((error) => {
    debugLog("handle.error", { message: error.message, stack: error.stack });
    send(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error.message,
        },
      },
      responseFraming,
    );
  });
}

function looksLikeJsonLine(buffer) {
  const firstIndex = firstNonWhitespaceIndex(buffer);
  return firstIndex !== -1 && buffer[firstIndex] === 0x7b;
}

function firstNonWhitespaceIndex(buffer) {
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) {
      return index;
    }
  }
  return -1;
}

function findHeaderBoundary(buffer) {
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const lfIndex = buffer.indexOf("\n\n");

  if (crlfIndex === -1 && lfIndex === -1) {
    return null;
  }
  if (crlfIndex === -1) {
    return { index: lfIndex, length: 2 };
  }
  if (lfIndex === -1 || crlfIndex < lfIndex) {
    return { index: crlfIndex, length: 4 };
  }
  return { index: lfIndex, length: 2 };
}

async function handleMessage(message, responseFraming) {
  debugLog("handle.message", {
    id: message.id,
    method: message.method,
    hasParams: Boolean(message.params),
    responseFraming,
  });

  if (message.id == null) {
    return;
  }

  if (message.method === "initialize") {
    send(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo,
          instructions:
            "Use Dynamic Workflows for local declarative task orchestration. Do not treat it as native /goal integration.",
        },
      },
      responseFraming,
    );
    return;
  }

  if (message.method === "tools/list") {
    send(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools },
      },
      responseFraming,
    );
    return;
  }

  if (message.method === "tools/call") {
    const result = callTool(message.params?.name, message.params?.arguments ?? {});
    send(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      },
      responseFraming,
    );
    return;
  }

  send(
    {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Unknown method: ${message.method}`,
      },
    },
    responseFraming,
  );
}

function callTool(name, args) {
  switch (name) {
    case "dynamic_workflows_plan":
      return planWorkflow(args);
    case "dynamic_workflows_approve":
      return approveWorkflow({
        runDir: args.runDir,
        approvedBy: args.approvedBy,
      });
    case "dynamic_workflows_run":
      return runWorkflow({
        runDir: args.runDir,
        approve: Boolean(args.approve),
        approvedBy: args.approvedBy,
      });
    case "dynamic_workflows_resume":
      return resumeWorkflow({
        runDir: args.runDir,
        continueRun: args.continueRun !== false,
      });
    case "dynamic_workflows_status":
      return statusWorkflow({ runDir: args.runDir });
    case "dynamic_workflows_cancel":
      return cancelWorkflow({
        runDir: args.runDir,
        reason: args.reason,
      });
    case "dynamic_workflows_validate":
      return validateRunDirectory({ runDir: args.runDir });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message, framing) {
  const json = JSON.stringify(message);
  debugLog("send", {
    id: message.id,
    hasResult: Object.hasOwn(message, "result"),
    hasError: Object.hasOwn(message, "error"),
    bytes: Buffer.byteLength(json, "utf8"),
    framing,
    preview: json.slice(0, 1000),
  });
  if (framing === "jsonl") {
    process.stdout.write(`${json}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function debugLog(event, data = undefined) {
  const logPath = process.env.DYNAMIC_WORKFLOWS_MCP_DEBUG_LOG;
  if (!logPath) {
    return;
  }

  try {
    fs.mkdirSync(new URL(".", `file://${logPath}`).pathname, { recursive: true });
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} ${event} ${data === undefined ? "" : JSON.stringify(data)}\n`,
    );
  } catch {
    // Diagnostics must never interfere with MCP handshaking.
  }
}
