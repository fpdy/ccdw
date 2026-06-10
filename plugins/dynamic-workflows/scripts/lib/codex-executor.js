import fs from "node:fs";
import { startNdjsonProcess } from "./process-runner.js";

// Strict-mode schema for the model's final message: codex exec --output-schema
// requires additionalProperties:false and every property listed in required.
// task_id and attempt_id are injected by the runner, never trusted from the model.
export const WORKER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "findings",
    "errors",
    "evidence",
    "modified_files",
    "commands_run",
    "artifacts",
  ],
  properties: {
    status: { type: "string", enum: ["succeeded", "failed"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "claim",
          "evidence",
          "source_files",
          "confidence",
          "severity",
          "verification_status",
          "verifier_notes",
          "rejection_reason",
        ],
        properties: {
          claim: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          source_files: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          severity: { type: "string" },
          verification_status: {
            type: "string",
            enum: ["unverified", "verified", "rejected", "unresolved"],
          },
          verifier_notes: { type: "string" },
          rejection_reason: { type: ["string", "null"] },
        },
      },
    },
    errors: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    modified_files: { type: "array", items: { type: "string" } },
    commands_run: { type: "array", items: { type: "string" } },
    artifacts: { type: "array", items: { type: "string" } },
  },
};

export function resolveCodexBin(env = process.env) {
  const candidate = env.CCDW_CODEX_BIN?.trim();
  return candidate || "codex";
}

export function buildCodexExecArgs({ workflow, task, lastMessagePath, schemaPath }) {
  const policy = workflow.workspace_policy ?? {};
  const writeScope = Array.isArray(policy.write_scope) ? policy.write_scope : [];
  const workspaceWrite = writeScope.includes("workspace");
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--cd",
    policy.workspace_root ?? process.cwd(),
    "--sandbox",
    workspaceWrite ? "workspace-write" : "read-only",
    "--output-last-message",
    lastMessagePath,
    "--output-schema",
    schemaPath,
  ];
  if (workspaceWrite) {
    args.push("-c", `sandbox_workspace_write.network_access=${policy.network === true}`);
  }
  if (typeof task.model === "string" && task.model.trim() !== "") {
    args.push("--model", task.model);
  }
  if (typeof task.profile === "string" && task.profile.trim() !== "") {
    args.push("--profile", task.profile);
  }
  return args;
}

export function buildWorkerPrompt({ workflow, task, runDir, inputPaths }) {
  const lines = [
    `You are a workflow worker with role "${task.role}" executing task "${task.task_id}".`,
    "",
    `Workflow objective: ${workflow.objective}`,
    "",
    `Task instructions: ${task.prompt_template}`,
  ];
  if (inputPaths.length > 0) {
    lines.push("", "Input artifacts from previous tasks (read them before working):");
    for (const inputPath of inputPaths) {
      lines.push(`- ${inputPath}`);
    }
  }
  lines.push(
    "",
    `Run directory (for reference only): ${runDir}`,
    "",
    "Work strictly within your sandbox permissions.",
    "Your final response must be a single JSON object matching the provided output schema:",
    'status ("succeeded" or "failed"), summary, findings[], errors[], evidence[],',
    "modified_files[], commands_run[], artifacts[].",
    "Report file paths and concrete evidence for every finding. If you could not",
    'complete the task, set status to "failed" and explain why in errors.',
  );
  return lines.join("\n");
}

// Spawns one codex exec worker. Success cannot be inferred from the exit code
// alone (SIGINT can exit 0): callers must combine exitCode === 0 with
// sawTurnCompleted and a non-empty final message.
export function startCodexExec({ bin, args, prompt, cwd, timeoutMs, onEvent }) {
  let threadId = null;
  let sawTurnCompleted = false;
  let lastAgentMessage = null;
  const usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };

  const handle = startNdjsonProcess({
    bin,
    args,
    prompt,
    cwd,
    timeoutMs,
    onEvent(event) {
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (event.type === "turn.completed") {
        sawTurnCompleted = true;
        const turnUsage = event.usage ?? {};
        for (const key of Object.keys(usage)) {
          usage[key] += Number(turnUsage[key]) || 0;
        }
      }
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        lastAgentMessage = event.item.text;
      }
      onEvent?.(event);
    },
  });

  return {
    pid: handle.pid,
    promise: handle.promise.then(({ exitCode, spawnError, timedOut, cancelled, stderrTail, pid }) => ({
      exitCode,
      spawnError,
      timedOut,
      cancelled,
      threadId,
      sawTurnCompleted,
      lastAgentMessage,
      usage,
      stderrTail,
      pid,
    })),
    cancel: handle.cancel,
  };
}

export function readLastMessageFile(lastMessagePath) {
  try {
    const content = fs.readFileSync(lastMessagePath, "utf8").trim();
    return content === "" ? null : content;
  } catch {
    return null;
  }
}
