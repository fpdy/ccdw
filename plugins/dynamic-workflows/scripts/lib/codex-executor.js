import fs from "node:fs";
import { pushSafeWorkerArg } from "./executor-contract.js";
import { startNdjsonProcess } from "./process-runner.js";

export { WORKER_OUTPUT_SCHEMA } from "./output-schema.js";

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
  pushSafeWorkerArg(args, "--model", task.model, `task ${task.task_id} model`);
  pushSafeWorkerArg(args, "--profile", task.profile, `task ${task.task_id} profile`);
  if (task.effort != null) {
    throw new Error(`task ${task.task_id} effort is only supported for claude tasks (codex: set model_reasoning_effort via a profile)`);
  }
  return args;
}

// instructions carries the rendered prompt_template (template references
// resolved by the scheduler); the raw template is the fallback for callers
// that have nothing to render.
export function buildWorkerPrompt({ workflow, task, runDir, inputPaths, instructions }) {
  const lines = [
    `You are a workflow worker with role "${task.role}" executing task "${task.task_id}".`,
    "",
    `Workflow objective: ${workflow.objective}`,
    "",
    `Task instructions: ${instructions ?? task.prompt_template}`,
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
  );
  if (task.output_schema != null) {
    lines.push(
      "Your final response must be a single JSON object matching the provided output schema:",
      'status ("succeeded" or "failed"), summary, errors[], and output (the task-specific',
      "typed payload described by the schema).",
      'If you could not complete the task, set status to "failed", explain why in errors,',
      "and still emit a schema-valid output object.",
    );
  } else {
    lines.push(
      "Your final response must be a single JSON object matching the provided output schema:",
      'status ("succeeded" or "failed"), summary, findings[], errors[], evidence[],',
      "modified_files[], commands_run[], artifacts[].",
      "Report file paths and concrete evidence for every finding. If you could not",
      'complete the task, set status to "failed" and explain why in errors.',
    );
  }
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
