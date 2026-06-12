import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePluginLayout } from "../scripts/lib/core.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempPluginRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-layout-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function copyPluginRoot(src, dest) {
  const skip = new Set(["node_modules", ".git", "tests", "coverage", ".ccdw"]);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      const rel = path.relative(src, srcPath);
      const topLevel = rel.split(path.sep)[0];
      return !skip.has(topLevel);
    },
  });
}

test("validatePluginLayout returns valid:true for a complete plugin layout", (t) => {
  const tempRoot = makeTempPluginRoot(t);
  copyPluginRoot(pluginRoot, tempRoot);

  const result = validatePluginLayout({ pluginRoot: tempRoot });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});

test("validatePluginLayout returns valid:false and reports a missing runtime module", (t) => {
  const tempRoot = makeTempPluginRoot(t);
  copyPluginRoot(pluginRoot, tempRoot);

  const removed = path.join(tempRoot, "scripts", "lib", "scheduler.js");
  fs.rmSync(removed);

  const result = validatePluginLayout({ pluginRoot: tempRoot });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ["scripts/lib/scheduler.js"]);
});
