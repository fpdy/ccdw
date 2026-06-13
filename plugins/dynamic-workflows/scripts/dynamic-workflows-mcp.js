#!/usr/bin/env node
import {
  approveWorkflow,
  cancelWorkflow,
  detachWorkflowRun,
  listWorkflowRuns,
  planWorkflow,
  readWorkflowEvents,
  resumeWorkflow,
  runWorkflow,
  statusWorkflow,
  validateRunDirectory,
} from "./lib/core.js";
import fs from "node:fs";

const serverInfo = {
  name: "dynamic-workflows",
  version: "0.7.0",
};

const tools = [
  {
    name: "dynamic_workflows_plan",
    description:
      "Validate and register a workflow run, leaving it awaiting approval. Pass `spec` (a WorkflowSpec JSON object you author, schema dynamic-workflows.v2: phases[], tasks[] with self-contained prompt_template per task, depends_on, budgets) to run your own plan; tasks with kind starting with \"codex\" execute as real codex exec subagents, kinds starting with \"claude\" as claude -p subagents, kind \"acp_opencode\" as an opencode worker over ACP (requires task-level model; output_schema/route rejected), and other kinds as deterministic local tasks. v2 task fields: `output_schema` (restricted typed-output subset; keywords type/properties/items/enum/description/title only, required/additionalProperties are runner-generated, domain output lands in result.output), `gates` (argv command + timeout_ms verification commands run after a schema-valid result; failure -> retryable gate_failed with {{gate_feedback}} injected on retry; gates run unsandboxed with cwd=workspace root and an env allowlist, and appear verbatim in the approval summary), `route` (schema-enforced enum branching with required default; unselected case tasks become skipped_by_route, which satisfies dependencies without failing the run), and `foreach` (bounded fan-out over a producer array; max_items is required, counted against max_agents at plan time, and exceeding it fails the parent; aggregate in result.output.results). prompt_template supports statically validated {{...}} references ({{objective}}, {{tasks.<id>.result.<dotpath>}} with the producer in depends_on, {{item}}, {{gate_feedback}}, {{inputs.*}} (saved workflows only; plain specs reject it)). The v1 fields expected_output_schema, verification_required, verification_policy, and fanout_source were removed and are rejected. Alternatively pass `workflow` (a saved template under <CCDW_HOME>/workflows) plus typed `inputs` instead of `spec`. Without `spec`/`workflow`, a fixed local explore/verify/synthesize template is planned (a smoke-test scaffold, not a real decomposition). Set dryRun:true to validate a spec without creating a run. This tool never overwrites an existing runId; replacing a non-running run requires the CLI's `plan --force`. YAML authoring is CLI-only; `spec` stays a JSON object here. Returns the approval summary (including gate commands, foreach budget estimates, saved-workflow provenance, and advisory_fields — the spec fields the runner records but does not enforce); render it to the user before approving.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Task objective (required unless spec.objective is set). Max 16000 chars." },
        spec: { type: "object", description: "Caller-authored WorkflowSpec JSON. Defaults are filled for omitted budget/policy fields." },
        workflow: { type: "string", description: "Name of a saved workflow template under <CCDW_HOME>/workflows (mutually exclusive with spec)." },
        inputs: { type: "object", description: "Typed input values for the saved workflow's declared inputs (requires workflow)." },
        workspace: { type: "string", description: "Workspace root the workers read (defaults to the server cwd)." },
        runRoot: { type: "string" },
        runId: { type: "string", description: "Optional run id matching ^[A-Za-z0-9._-]{1,64}$." },
        dryRun: { type: "boolean", description: "Validate only; do not create a run directory." },
      },
    },
  },
  {
    name: "dynamic_workflows_approve",
    description: "Grant the approval gate for a planned run. Only call after the user has seen the approval summary and consented.",
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
    description:
      "Start an approved workflow run. By default the run executes in a detached background process and this tool returns immediately; poll dynamic_workflows_status (cheap) or dynamic_workflows_events to follow progress. Pass detach:false only for fast local-executor runs.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
        approve: { type: "boolean" },
        approvedBy: { type: "string" },
        detach: { type: "boolean", description: "Default true. false runs synchronously inside this call." },
        maxTasks: { type: "integer", minimum: 0, description: "Pause the run after launching this many tasks." },
      },
    },
  },
  {
    name: "dynamic_workflows_resume",
    description:
      "Resume a paused or crashed run (re-queues interrupted tasks, reuses completed results). Pass resumeFailed:true to requeue the failed, gate_failed, timed_out, schema_violation, and skipped tasks of a failed run, or of a completed run whose outcome is partial. skipped_by_route tasks are never requeued (route resolutions are final). Run directories planned before schema v2 are rejected (re-plan required). Refuses while an orchestrator is alive.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
        continueRun: { type: "boolean" },
        resumeFailed: { type: "boolean" },
        approvedBy: { type: "string" },
        maxTasks: { type: "integer", minimum: 0, description: "Pause the resumed run after launching this many tasks." },
      },
    },
  },
  {
    name: "dynamic_workflows_status",
    description: "Cheap snapshot of a run: status, per-task statuses and counts, budget usage, runner liveness, artifact paths. Safe to poll.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
      },
    },
  },
  {
    name: "dynamic_workflows_list",
    description: "Discover workflow runs under the run root (newest first). Use when you do not have a runDir.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" },
        runRoot: { type: "string" },
        status: { type: "string", description: "Filter by run status (e.g. running, paused, completed, failed)." },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "dynamic_workflows_events",
    description: "Incrementally read the run's append-only event log. Pass the previous next_offset as sinceOffset to get only new events. v2 adds gate_started/gate_result (verification commands), route_resolved (branch selection), tasks_expanded (foreach fan-out), tasks_expanded_replayed (expansion replayed from the event log on resume), and template_resolution_failed events.",
    inputSchema: {
      type: "object",
      required: ["runDir"],
      properties: {
        runDir: { type: "string" },
        sinceOffset: { type: "integer" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "dynamic_workflows_cancel",
    description: "Cancel a non-completed run. If an orchestrator is alive the cancellation is requested via a control signal and folds in within ~1s; poll status to confirm.",
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
        id: message?.id ?? null,
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
    // Tool failures are returned as result.isError so the client can correlate
    // and surface them; protocol-level errors are reserved for malformed input.
    let response;
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      response = {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      response = {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error.message,
                details: error.details ?? {},
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    send(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: response,
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

async function callTool(name, args) {
  switch (name) {
    case "dynamic_workflows_plan":
      // Whitelist fields instead of forwarding the args object wholesale.
      return planWorkflow({
        objective: args.objective,
        spec: args.spec,
        workflow: args.workflow,
        inputs: args.inputs,
        workspace: args.workspace,
        runRoot: args.runRoot,
        runId: args.runId,
        dryRun: Boolean(args.dryRun),
      });
    case "dynamic_workflows_approve":
      return approveWorkflow({
        runDir: args.runDir,
        approvedBy: args.approvedBy,
      });
    case "dynamic_workflows_run":
      if (args.detach !== false) {
        return detachWorkflowRun({
          runDir: args.runDir,
          approve: Boolean(args.approve),
          approvedBy: args.approvedBy,
          maxTasks: args.maxTasks,
        });
      }
      return runWorkflow({
        runDir: args.runDir,
        approve: Boolean(args.approve),
        approvedBy: args.approvedBy,
        maxTasks: args.maxTasks,
      });
    case "dynamic_workflows_resume":
      return resumeWorkflow({
        runDir: args.runDir,
        continueRun: args.continueRun !== false,
        resumeFailed: Boolean(args.resumeFailed),
        approvedBy: args.approvedBy,
        maxTasks: args.maxTasks,
      });
    case "dynamic_workflows_status":
      return statusWorkflow({ runDir: args.runDir });
    case "dynamic_workflows_list":
      return listWorkflowRuns({
        workspace: args.workspace,
        runRoot: args.runRoot,
        status: args.status,
        limit: args.limit,
      });
    case "dynamic_workflows_events":
      return readWorkflowEvents({
        runDir: args.runDir,
        sinceOffset: args.sinceOffset,
        limit: args.limit,
      });
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
