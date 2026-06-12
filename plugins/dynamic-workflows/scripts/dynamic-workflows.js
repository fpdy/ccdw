#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
// Spec-file parsing (JSON/YAML) lives next to the saved-workflow loader so the
// CLI and the engine share one parser; it is not part of the core.js facade.
import { readSpecFile } from "./lib/saved-workflows.js";
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
  validatePluginLayout,
  validateRunDirectory,
  WorkflowError,
} from "./lib/core.js";

const COMMANDS = new Set([
  "plan",
  "approve",
  "run",
  "resume",
  "status",
  "list",
  "events",
  "cancel",
  "validate",
  "validate-plugin-layout",
]);

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;
  switch (command) {
    case "plan": {
      if (options.specFile && options.workflow) {
        throw new WorkflowError("--spec-file and --workflow are mutually exclusive.");
      }
      let spec;
      if (options.specFile) {
        spec = readSpecFile(options.specFile);
      }
      result = planWorkflow({
        objective: options.objective,
        spec,
        workflow: options.workflow,
        inputs: parseInputAssignments(options.input),
        workspace: options.workspace,
        runRoot: options.runRoot,
        runId: options.runId,
        goalId: options.goalId,
        force: Boolean(options.force),
        dryRun: Boolean(options.dryRun),
      });
      break;
    }
    case "approve":
      result = approveWorkflow({
        runDir: options.runDir,
        approvedBy: options.approvedBy,
      });
      break;
    case "run":
      if (options.detach) {
        result = await detachWorkflowRun({
          runDir: options.runDir,
          approve: Boolean(options.approve),
          approvedBy: options.approvedBy,
          maxTasks: options.maxTasks,
        });
      } else {
        result = await runWorkflow({
          runDir: options.runDir,
          approve: Boolean(options.approve),
          approvedBy: options.approvedBy,
          maxTasks: options.maxTasks,
        });
      }
      break;
    case "resume":
      result = await resumeWorkflow({
        runDir: options.runDir,
        continueRun: options.continue !== false,
        resumeFailed: Boolean(options.resumeFailed),
        maxTasks: options.maxTasks,
      });
      break;
    case "status":
      result = statusWorkflow({ runDir: options.runDir });
      break;
    case "list":
      result = listWorkflowRuns({
        workspace: options.workspace,
        runRoot: options.runRoot,
        status: options.status,
        limit: options.limit,
      });
      break;
    case "events":
      result = readWorkflowEvents({
        runDir: options.runDir,
        sinceOffset: options.sinceOffset,
        limit: options.limit,
      });
      break;
    case "cancel":
      result = cancelWorkflow({
        runDir: options.runDir,
        reason: options.reason,
      });
      break;
    case "validate":
      result = validateRunDirectory({ runDir: options.runDir });
      if (!result.valid) {
        throw new WorkflowError("Run directory validation failed.", result);
      }
      break;
    case "validate-plugin-layout": {
      const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      result = validatePluginLayout({ pluginRoot });
      if (!result.valid) {
        throw new WorkflowError("Plugin layout validation failed.", result);
      }
      break;
    }
    default:
      throw new WorkflowError(`Unknown command: ${command}`);
  }
  printResult(command, result, Boolean(options.json));
}

// Saved-workflow input values stay strings here; loadSavedWorkflow coerces
// them by the declared type.
function parseInputAssignments(entries) {
  if (entries == null) {
    return undefined;
  }
  const inputs = {};
  for (const entry of entries) {
    const separatorIndex = typeof entry === "string" ? entry.indexOf("=") : -1;
    if (separatorIndex < 1) {
      throw new WorkflowError("--input expects key=value.", { input: entry });
    }
    inputs[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
  }
  return inputs;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) {
    throw new WorkflowError(`Command is required. Expected one of: ${[...COMMANDS].join(", ")}`);
  }

  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new WorkflowError(`Unexpected positional argument: ${arg}`);
    }
    // Split on the first "=" only: values like --input key=value keep their
    // own "=" intact.
    const separatorIndex = arg.indexOf("=");
    const rawKey = separatorIndex === -1 ? arg.slice(2) : arg.slice(2, separatorIndex);
    const key = toCamelCase(rawKey);
    if (separatorIndex !== -1) {
      setOption(options, key, coerceValue(key, rawKey, arg.slice(separatorIndex + 1)));
      continue;
    }
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      setOption(options, key, true);
      continue;
    }
    setOption(options, key, coerceValue(key, rawKey, next));
    index += 1;
  }
  return { command, options };
}

// Flags that may be repeated accumulate into an array; all others overwrite.
const REPEATABLE_OPTIONS = new Set(["input"]);

function setOption(options, key, value) {
  if (REPEATABLE_OPTIONS.has(key)) {
    (options[key] ??= []).push(value);
    return;
  }
  options[key] = value;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Only flags that are typed numeric/boolean get coerced; everything else stays
// a string so values like `--run-id 123` are never turned into numbers.
const NUMBER_OPTIONS = new Set(["maxTasks", "sinceOffset", "limit"]);
const BOOLEAN_OPTIONS = new Set([
  "approve",
  "continue",
  "detach",
  "dryRun",
  "force",
  "json",
  "resumeFailed",
]);

function coerceValue(key, rawKey, value) {
  if (BOOLEAN_OPTIONS.has(key)) {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    throw new WorkflowError(`--${rawKey} expects true or false.`, { value });
  }
  if (NUMBER_OPTIONS.has(key) && /^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function printResult(command, result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.valid === false) {
    console.log(`Invalid: ${result.errors.join("; ")}`);
    return;
  }
  if (command === "list") {
    if (result.runs.length === 0) {
      console.log(`No runs under ${result.run_root}`);
      return;
    }
    for (const run of result.runs) {
      const counts = run.task_counts
        ? Object.entries(run.task_counts)
            .map(([status, count]) => `${status}:${count}`)
            .join(" ")
        : "";
      console.log(`${run.status.padEnd(18)} ${run.run_id}  ${counts}`);
      console.log(`  ${run.objective ?? run.warning ?? ""}`);
      console.log(`  ${run.run_dir}`);
    }
    return;
  }
  if (command === "events") {
    for (const event of result.events) {
      console.log(JSON.stringify(event));
    }
    console.log(`next_offset: ${result.next_offset}`);
    return;
  }
  console.log(`${result.status ?? "ok"} ${result.run_id ?? ""}`.trim());
  if (result.run_dir) {
    console.log(`run_dir: ${result.run_dir}`);
  }
  if (result.detached) {
    console.log(`runner_pid: ${result.runner_pid}`);
    console.log(`runner_log: ${result.runner_log}`);
  }
}

main().catch((error) => {
  const payload = {
    error: error.message,
    details: error.details ?? {},
  };
  if (process.argv.includes("--json")) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(`${error.name ?? "Error"}: ${error.message}`);
    if (Object.keys(payload.details).length > 0) {
      console.error(JSON.stringify(payload.details, null, 2));
    }
  }
  process.exit(1);
});
