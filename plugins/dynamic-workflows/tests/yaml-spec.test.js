import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { approveWorkflow, planWorkflow, WorkflowError } from "../scripts/lib/core.js";
import { MAX_SPEC_FILE_BYTES, readSpecFile } from "../scripts/lib/saved-workflows.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "dynamic-workflows.js");

const YAML_SPEC = `name: yaml workflow
objective: Plan from a YAML spec
phases:
  - phase_id: p1
    tasks:
      - t1
tasks:
  - task_id: t1
    phase_id: p1
    kind: local_analysis
    role: worker
    prompt_template: Do the YAML thing.
max_concurrency: 1
`;

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-yaml-test-"));
}

function runCli(args) {
  return execFileSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

test("CLI plans a .yaml spec end-to-end; run dir holds normalized JSON and hash verification works", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "spec.yaml");
  fs.writeFileSync(specPath, YAML_SPEC, "utf8");
  const runRoot = path.join(workspace, "runs");

  const stdout = runCli([
    "plan",
    "--spec-file", specPath,
    "--workspace", workspace,
    "--run-root", runRoot,
    "--json",
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.objective, "Plan from a YAML spec");

  // The stored spec is normalized JSON regardless of the authored format.
  const storedRaw = fs.readFileSync(result.paths.workflow_spec, "utf8");
  const stored = JSON.parse(storedRaw);
  assert.equal(storedRaw, `${JSON.stringify(stored, null, 2)}\n`);
  assert.equal(stored.tasks[0].prompt_template, "Do the YAML thing.");

  // Approval re-reads the spec through hash verification.
  const approved = approveWorkflow({ runDir: result.run_dir });
  assert.equal(approved.status, "approved");
});

test(".yml extension is accepted", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "spec.yml");
  fs.writeFileSync(specPath, YAML_SPEC, "utf8");

  const spec = readSpecFile(specPath);
  assert.equal(spec.name, "yaml workflow");

  const result = planWorkflow({
    spec,
    workspace,
    runRoot: path.join(workspace, "runs"),
    dryRun: true,
  });
  assert.equal(result.valid, true);
});

test("anchors and aliases are rejected (maxAliasCount: 0)", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "spec.yaml");
  fs.writeFileSync(specPath, "shared: &anchor\n  role: worker\ntasks:\n  - *anchor\n", "utf8");

  assert.throws(
    () => readSpecFile(specPath),
    (error) => error instanceof WorkflowError && /not valid YAML/.test(error.message),
  );
});

test("duplicate keys are rejected with file:line:col", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "spec.yaml");
  fs.writeFileSync(specPath, "name: one\nname: two\n", "utf8");

  assert.throws(
    () => readSpecFile(specPath),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.ok(error.message.startsWith(`${path.resolve(specPath)}:`));
      assert.match(error.message, /:\d+:\d+: /);
      assert.equal(error.details.code, "DUPLICATE_KEY");
      return true;
    },
  );
});

test("YAML syntax errors are reported as file:line:col", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "broken.yaml");
  fs.writeFileSync(specPath, "foo: [unclosed\n", "utf8");

  assert.throws(
    () => readSpecFile(specPath),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.ok(error.message.startsWith(`${path.resolve(specPath)}:`));
      assert.match(error.message, /:\d+:\d+: /);
      assert.equal(typeof error.details.code, "string");
      return true;
    },
  );
});

test("YAML files over 1 MiB are rejected before parsing", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "huge.yaml");
  fs.writeFileSync(specPath, `objective: ${"a".repeat(MAX_SPEC_FILE_BYTES)}\n`, "utf8");

  assert.throws(
    () => readSpecFile(specPath),
    (error) => error instanceof WorkflowError && /1 MiB size limit/.test(error.message),
  );
});

test("JSON files over 1 MiB are rejected before parsing", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "huge.json");
  fs.writeFileSync(specPath, `{"objective":"${"a".repeat(MAX_SPEC_FILE_BYTES)}"}`, "utf8");

  assert.throws(
    () => readSpecFile(specPath),
    (error) => error instanceof WorkflowError && /1 MiB size limit/.test(error.message),
  );
});

test(".json files keep strict JSON parsing", () => {
  const workspace = makeTempWorkspace();
  const specPath = path.join(workspace, "spec.json");
  fs.writeFileSync(specPath, YAML_SPEC, "utf8");

  assert.throws(
    () => readSpecFile(specPath),
    (error) => error instanceof WorkflowError && /not valid JSON/.test(error.message),
  );

  fs.writeFileSync(specPath, `${JSON.stringify({ name: "json workflow" })}\n`, "utf8");
  assert.equal(readSpecFile(specPath).name, "json workflow");
});
