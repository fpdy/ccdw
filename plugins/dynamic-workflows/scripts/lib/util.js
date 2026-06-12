import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CCDW_HOME_ENV,
  DEFAULT_CCDW_HOME,
  RUN_STATE_FILE,
  WORKFLOW_FILE,
  WorkflowError,
} from "./constants.js";

export function resolveExecutorKind(kind) {
  const value = String(kind);
  if (value.startsWith("codex")) {
    return "codex";
  }
  if (value.startsWith("claude")) {
    return "claude";
  }
  // Unknown kinds keep failing deterministically inside the local path.
  return "local";
}

export function resolveRunRoot(runRoot, workspace) {
  if (runRoot == null) {
    const configuredHome = process.env[CCDW_HOME_ENV]?.trim();
    const ccdwHome = configuredHome || DEFAULT_CCDW_HOME;
    return path.join(resolveWorkspacePath(ccdwHome, workspace), "dynamic-workflows", "runs");
  }
  return resolveWorkspacePath(runRoot, workspace);
}

export function resolveWorkspacePath(candidate, workspace) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspace, candidate);
}

export function requireRunDir(runDir) {
  if (typeof runDir !== "string" || runDir.trim() === "") {
    throw new WorkflowError("runDir is required.");
  }
  const resolved = path.resolve(runDir);
  if (!fs.existsSync(path.join(resolved, RUN_STATE_FILE))) {
    throw new WorkflowError("Run directory does not contain run.json.", { runDir: resolved });
  }
  if (!fs.existsSync(path.join(resolved, WORKFLOW_FILE))) {
    throw new WorkflowError("Run directory does not contain workflow.yaml.", { runDir: resolved });
  }
  return resolved;
}

export function normalizeObjective(objective) {
  if (typeof objective !== "string" || objective.trim() === "") {
    throw new WorkflowError("Objective must be a non-empty string.");
  }
  const normalized = objective.trim();
  if (normalized.length > 16000) {
    throw new WorkflowError("Objective must be at most 16000 characters.");
  }
  return normalized;
}

export function normalizeOptionalMaxTasks(value) {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowError("maxTasks must be a non-negative integer.", { maxTasks: value });
  }
  return value;
}

export function resolveRunArtifactPath(runDir, ...segments) {
  return resolveContainedPath(path.join(runDir, "artifacts"), ...segments);
}

export function resolveContainedPath(rootDir, ...segments) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new WorkflowError("Artifact path escapes the run artifacts directory.", {
      root,
      path: resolved,
    });
  }
  return resolved;
}

export function isPlainObject(value) {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function detectCycle(dependencyMap) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colors = new Map([...dependencyMap.keys()].map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;

  const visit = (node) => {
    if (cycle) {
      return;
    }
    colors.set(node, GRAY);
    stack.push(node);
    for (const dependency of dependencyMap.get(node) ?? []) {
      if (!dependencyMap.has(dependency)) {
        continue;
      }
      const color = colors.get(dependency);
      if (color === GRAY) {
        cycle = [...stack.slice(stack.indexOf(dependency)), dependency];
        return;
      }
      if (color === WHITE) {
        visit(dependency);
      }
    }
    stack.pop();
    colors.set(node, BLACK);
  };

  for (const node of dependencyMap.keys()) {
    if (colors.get(node) === WHITE) {
      visit(node);
    }
    if (cycle) {
      break;
    }
  }
  return cycle;
}

export function makeId(prefix) {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, payload) {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, file);
}

export function toRunRelative(runDir, file) {
  return path.relative(runDir, file).split(path.sep).join("/");
}

export function hashFile(file) {
  return hashBytes(fs.readFileSync(file));
}

export function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function libDirectory() {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function sleep(ms, { unref = true } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) {
      timer.unref?.();
    }
  });
}
