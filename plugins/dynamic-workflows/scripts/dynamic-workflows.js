#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveWorkflow,
  cancelWorkflow,
  planWorkflow,
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
  "cancel",
  "validate",
  "validate-plugin-layout",
]);

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;
  switch (command) {
    case "plan":
      result = planWorkflow({
        objective: options.objective,
        workspace: options.workspace,
        runRoot: options.runRoot,
        runId: options.runId,
        goalId: options.goalId,
        force: Boolean(options.force),
      });
      break;
    case "approve":
      result = approveWorkflow({
        runDir: options.runDir,
        approvedBy: options.approvedBy,
      });
      break;
    case "run":
      result = runWorkflow({
        runDir: options.runDir,
        approve: Boolean(options.approve),
        approvedBy: options.approvedBy,
        maxTasks: options.maxTasks,
      });
      break;
    case "resume":
      result = resumeWorkflow({
        runDir: options.runDir,
        continueRun: options.continue !== false,
        resumeFailed: Boolean(options.resumeFailed),
      });
      break;
    case "status":
      result = statusWorkflow({ runDir: options.runDir });
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
  printResult(result, Boolean(options.json));
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
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = toCamelCase(rawKey);
    if (inlineValue !== undefined) {
      options[key] = coerceValue(inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = coerceValue(next);
    index += 1;
  }
  return { command, options };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function coerceValue(value) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.valid === false) {
    console.log(`Invalid: ${result.errors.join("; ")}`);
    return;
  }
  console.log(`${result.status ?? "ok"} ${result.run_id ?? ""}`.trim());
  if (result.run_dir) {
    console.log(`run_dir: ${result.run_dir}`);
  }
}

try {
  main();
} catch (error) {
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
}
