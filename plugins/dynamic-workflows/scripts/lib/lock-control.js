import fs from "node:fs";
import path from "node:path";
import {
  CANCEL_SIGNAL_FILE,
  CONTROL_DIR,
  LOCK_FILE,
  WorkflowError,
} from "./constants.js";
import { nowIso } from "./util.js";

// --- Locking and control signals -------------------------------------------

function lockPathFor(runDir) {
  return path.join(runDir, LOCK_FILE);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function readLiveLock(runDir) {
  const lockPath = lockPathFor(runDir);
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    return null;
  }
  if (isPidAlive(lock.pid)) {
    return lock;
  }
  return null;
}

export function acquireRunLock(runDir) {
  const lockPath = lockPathFor(runDir);
  const payload = JSON.stringify({ pid: process.pid, created_at: nowIso() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const live = readLiveLock(runDir);
      if (live) {
        throw new WorkflowError("Run is locked by an active orchestrator.", {
          runner_pid: live.pid,
        });
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another contender removed it first; retry.
      }
    }
  }
  throw new WorkflowError("Could not acquire the run lock.", { lockPath });
}

export function releaseRunLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already removed.
  }
}

export function withRunLock(runDir, fn) {
  const lockPath = acquireRunLock(runDir);
  try {
    return fn();
  } finally {
    releaseRunLock(lockPath);
  }
}

export function readCancelSignal(runDir) {
  const signalPath = path.join(runDir, CONTROL_DIR, CANCEL_SIGNAL_FILE);
  try {
    return JSON.parse(fs.readFileSync(signalPath, "utf8"));
  } catch {
    return null;
  }
}

export function clearCancelSignal(runDir) {
  try {
    fs.unlinkSync(path.join(runDir, CONTROL_DIR, CANCEL_SIGNAL_FILE));
  } catch {
    // Nothing to clear.
  }
}
