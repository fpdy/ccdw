import { CLAUDE_EFFORT_LEVELS, pushSafeWorkerArg } from "./executor-contract.js";
import { startNdjsonProcess } from "./process-runner.js";
import { WORKER_OUTPUT_SCHEMA } from "./output-schema.js";

export function resolveClaudeBin(env = process.env) {
  const candidate = env.CCDW_CLAUDE_BIN?.trim();
  return candidate || "claude";
}

// Sandbox settings passed to claude via --settings. The CLI default is
// fail-open (sandbox failures fall back to unsandboxed execution and rejected
// commands can retry with dangerouslyDisableSandbox), so failIfUnavailable and
// allowUnsandboxedCommands must both be pinned explicitly. network is always
// an empty allowlist: claude tasks with workspace_policy.network: true are
// rejected at plan time (there is no enforceable allow-all network sandbox),
// so the executor never widens network access — fail-closed.
export function buildClaudeSandboxSettings({ workflow }) {
  const policy = workflow.workspace_policy ?? {};
  const writeScope = Array.isArray(policy.write_scope) ? policy.write_scope : [];
  const workspaceWrite = writeScope.includes("workspace");
  const workspaceRoot = policy.workspace_root ?? process.cwd();
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Read-only: the OS sandbox already denies writes outside cwd; the
      // explicit denyWrite on the workspace root closes the cwd hole without
      // breaking the CLI's internal shell state files (denyWrite ["/"] does).
      filesystem: workspaceWrite ? { allowWrite: [workspaceRoot] } : { denyWrite: [workspaceRoot] },
      network: { allowedDomains: [] },
    },
  };
}

export function buildClaudeExecArgs({ workflow, task, settingsPath, workerSchema = WORKER_OUTPUT_SCHEMA }) {
  const policy = workflow.workspace_policy ?? {};
  const writeScope = Array.isArray(policy.write_scope) ? policy.write_scope : [];
  const workspaceWrite = writeScope.includes("workspace");
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--no-session-persistence",
    "--json-schema",
    JSON.stringify(workerSchema),
    "--settings",
    settingsPath,
    // Empty value fully excludes user/project/local settings so ambient
    // settings cannot merge wider permissions into the generated settings.
    "--setting-sources",
    "",
    "--max-turns",
    "50",
  ];
  if (workspaceWrite) {
    args.push(
      "--tools",
      "Edit,Write,Read,Glob,Grep,Bash",
      "--allowedTools",
      "Edit,Write,Read,Glob,Grep,Bash",
      "--disallowedTools",
      "NotebookEdit,WebFetch,WebSearch,mcp__*",
      "--permission-mode",
      "dontAsk",
    );
  } else {
    // --allowedTools is needed even in read-only mode: compound Bash commands
    // are not covered by autoAllowBashIfSandboxed and would hit permission
    // denials; the OS sandbox stays the enforcement layer.
    args.push(
      "--tools",
      "Read,Glob,Grep,Bash",
      "--allowedTools",
      "Read,Glob,Grep,Bash",
      "--disallowedTools",
      "Edit,Write,NotebookEdit,WebFetch,WebSearch,mcp__*",
      "--permission-mode",
      "default",
    );
  }
  pushSafeWorkerArg(args, "--model", task.model, `task ${task.task_id} model`);
  if (task.effort != null) {
    if (!CLAUDE_EFFORT_LEVELS.includes(task.effort)) {
      throw new Error(`task ${task.task_id} effort must be one of ${CLAUDE_EFFORT_LEVELS.join("|")}`);
    }
    args.push("--effort", task.effort);
  }
  // task.profile is codex-only; strict validation rejects it for claude tasks,
  // and the runtime ignores it defensively.
  return args;
}

// Spawns one claude -p worker. Success cannot be inferred from the exit code
// alone: auth failures surface as is_error: true with exit code 0 (or 1) while
// subtype can still read "success", so callers must check isError
// independently of both exitCode and resultSubtype.
export function startClaudeExec({ bin, args, prompt, cwd, timeoutMs, onEvent }) {
  let threadId = null;
  // sawTurnCompleted here means "observed the result event"; the field name is
  // kept for outcome-shape parity with the codex executor.
  let sawTurnCompleted = false;
  let lastAgentMessage = null;
  let isError = false;
  let resultSubtype = null;
  let totalCostUsd = 0;
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
      if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
        threadId = event.session_id;
      }
      if (event.type === "result") {
        sawTurnCompleted = true;
        isError = event.is_error === true;
        resultSubtype = event.subtype ?? null;
        totalCostUsd = Number(event.total_cost_usd) || 0;
        // Usage is set once from the final result event (assistant events also
        // carry usage but are telemetry only). Keys are normalized to the
        // codex usage shape; claude has no separate reasoning token counter.
        // Anthropic usage semantics: input_tokens EXCLUDES cache_read and
        // cache_creation. cache_creation is freshly processed input, so it must
        // be charged to keep max_tokens enforcement comparable to codex (where
        // input_tokens includes the cached subset); only cache READS stay
        // uncounted, matching the documented "cached input is not counted".
        const resultUsage = event.usage ?? {};
        usage.input_tokens =
          (Number(resultUsage.input_tokens) || 0) +
          (Number(resultUsage.cache_creation_input_tokens) || 0);
        usage.cached_input_tokens = Number(resultUsage.cache_read_input_tokens) || 0;
        usage.output_tokens = Number(resultUsage.output_tokens) || 0;
        usage.reasoning_output_tokens = 0;
        lastAgentMessage =
          event.structured_output !== undefined && event.structured_output !== null
            ? JSON.stringify(event.structured_output)
            : typeof event.result === "string" && event.result.trim() !== ""
              ? event.result
              : null;
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
      isError,
      resultSubtype,
      totalCostUsd,
    })),
    cancel: handle.cancel,
  };
}
