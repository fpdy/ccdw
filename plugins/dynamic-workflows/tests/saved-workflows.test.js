import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { planWorkflow, WorkflowError } from "../scripts/lib/core.js";
import { loadSavedWorkflow } from "../scripts/lib/saved-workflows.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "dynamic-workflows.js");

// The templates dir resolves through CCDW_HOME; tests pin the default
// (.ccdw under the temp workspace) unless a test sets it explicitly.
delete process.env.CCDW_HOME;

function makeTempWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dw-saved-wf-test-"));
  fs.mkdirSync(path.join(workspace, ".ccdw", "workflows"), { recursive: true });
  return workspace;
}

function writeTemplate(workspace, fileName, template) {
  const filePath = path.join(workspace, ".ccdw", "workflows", fileName);
  const contents = fileName.endsWith(".json")
    ? `${JSON.stringify(template, null, 2)}\n`
    : stringifyYaml(template);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function reviewTemplate(overrides = {}) {
  return {
    name: "review template",
    objective: "Review {{inputs.target}}",
    inputs: {
      target: { type: "string", required: true },
      count: { type: "integer", default: 3 },
      strict: { type: "boolean", default: false },
    },
    phases: [{ phase_id: "p1", tasks: ["analyze", "summarize"] }],
    tasks: [
      {
        task_id: "analyze",
        phase_id: "p1",
        kind: "local_analysis",
        role: "worker",
        prompt_template: "Analyze {{inputs.target}} with count {{inputs.count}} strict {{inputs.strict}}.",
      },
      {
        task_id: "summarize",
        phase_id: "p1",
        kind: "local_analysis",
        role: "worker",
        prompt_template: "Summarize {{tasks.analyze.result.summary}} for {{inputs.target}}.",
        depends_on: ["analyze"],
      },
    ],
    max_concurrency: 1,
    ...overrides,
  };
}

function planSaved(workspace, options = {}) {
  return planWorkflow({
    workflow: "review",
    workspace,
    runRoot: path.join(workspace, "runs"),
    ...options,
  });
}

function storedSpec(result) {
  return JSON.parse(fs.readFileSync(result.paths.workflow_spec, "utf8"));
}

function taskById(spec, taskId) {
  return spec.tasks.find((task) => task.task_id === taskId);
}

test("happy path: CLI-string inputs are coerced, substituted, and other refs survive verbatim", () => {
  const workspace = makeTempWorkspace();
  const templatePath = writeTemplate(workspace, "review.json", reviewTemplate());

  const result = planSaved(workspace, {
    inputs: { target: "src/app.js", count: "5", strict: "true" },
  });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.objective, "Review src/app.js");

  const spec = storedSpec(result);
  assert.equal(spec.inputs, undefined);
  assert.equal(
    taskById(spec, "analyze").prompt_template,
    "Analyze src/app.js with count 5 strict true.",
  );
  // Non-inputs references are re-emitted verbatim for later rendering.
  assert.equal(
    taskById(spec, "summarize").prompt_template,
    "Summarize {{tasks.analyze.result.summary}} for src/app.js.",
  );

  const provenance = result.approval.summary.workflow_template;
  assert.equal(provenance.name, "review");
  assert.equal(provenance.template_path, templatePath);
  assert.equal(
    provenance.template_hash,
    crypto.createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex"),
  );
  assert.deepEqual(provenance.inputs, { target: "src/app.js", count: 5, strict: true });
});

test("defaults are applied for omitted inputs", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  const result = planSaved(workspace, { inputs: { target: "lib" } });
  const spec = storedSpec(result);
  assert.equal(taskById(spec, "analyze").prompt_template, "Analyze lib with count 3 strict false.");
  assert.deepEqual(result.approval.summary.workflow_template.inputs, {
    target: "lib",
    count: 3,
    strict: false,
  });
});

test("MCP-typed inputs are accepted without coercion", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  const result = planSaved(workspace, { inputs: { target: "lib", count: 7, strict: true } });
  const spec = storedSpec(result);
  assert.equal(taskById(spec, "analyze").prompt_template, "Analyze lib with count 7 strict true.");
  assert.deepEqual(result.approval.summary.workflow_template.inputs, {
    target: "lib",
    count: 7,
    strict: true,
  });
});

test("type mismatches are rejected for both CLI strings and MCP-typed values", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  for (const inputs of [
    { target: "lib", count: "abc" },
    { target: "lib", count: "1.5" },
    { target: "lib", count: 1.5 },
    { target: "lib", strict: "yes" },
    { target: "lib", strict: 1 },
    { target: 42 },
  ]) {
    assert.throws(
      () => planSaved(workspace, { inputs }),
      (error) => error instanceof WorkflowError && /declared type/.test(error.message),
      `expected rejection for ${JSON.stringify(inputs)}`,
    );
  }
});

test("number inputs accept floats and reject non-finite strings", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "ratio.json", {
    objective: "Tune to {{inputs.ratio}}",
    inputs: { ratio: { type: "number", required: true } },
    phases: [{ phase_id: "p1", tasks: ["t1"] }],
    tasks: [
      {
        task_id: "t1",
        phase_id: "p1",
        kind: "local_analysis",
        role: "worker",
        prompt_template: "Use ratio {{inputs.ratio}}.",
      },
    ],
  });

  const { spec, provenance } = loadSavedWorkflow({
    name: "ratio",
    inputs: { ratio: "0.75" },
    workspace,
  });
  assert.equal(spec.objective, "Tune to 0.75");
  assert.equal(provenance.inputs.ratio, 0.75);

  assert.throws(
    () => loadSavedWorkflow({ name: "ratio", inputs: { ratio: "Infinity" }, workspace }),
    (error) => error instanceof WorkflowError && /declared type/.test(error.message),
  );
});

test("unknown inputs are rejected", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  assert.throws(
    () => planSaved(workspace, { inputs: { target: "lib", bogus: "x" } }),
    (error) => error instanceof WorkflowError && /Unknown input "bogus"/.test(error.message),
  );
});

test("required inputs missing after defaults are rejected", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  assert.throws(
    () => planSaved(workspace, { inputs: {} }),
    (error) => error instanceof WorkflowError && /Required input "target" is missing/.test(error.message),
  );
});

test("referencing an undeclared input is rejected", () => {
  const workspace = makeTempWorkspace();
  const template = reviewTemplate();
  template.tasks[0].prompt_template = "Analyze {{inputs.mystery}}.";
  writeTemplate(workspace, "review.json", template);

  assert.throws(
    () => planSaved(workspace, { inputs: { target: "lib" } }),
    (error) => error instanceof WorkflowError && /input "mystery"/.test(error.message),
  );
});

test("template names with traversal or invalid characters are rejected", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  for (const name of ["../x", "..", "a/b", ".hidden", ""]) {
    assert.throws(
      () => planWorkflow({ workflow: name, workspace, runRoot: path.join(workspace, "runs") }),
      (error) => error instanceof WorkflowError && /name must match/.test(error.message),
      `expected rejection for name ${JSON.stringify(name)}`,
    );
  }
});

test("missing templates report the searched paths", () => {
  const workspace = makeTempWorkspace();

  assert.throws(
    () => planSaved(workspace, {}),
    (error) =>
      error instanceof WorkflowError &&
      /Saved workflow not found/.test(error.message) &&
      error.details.searched.length === 3,
  );
});

test("template objectives allow {{inputs.*}} references only", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(
    workspace,
    "review.json",
    reviewTemplate({ objective: "Review {{inputs.target}} after {{tasks.analyze.result.summary}}" }),
  );

  // Semantics spec §3.2: the objective is inputs-only; any other namespace is
  // a plan-time error rather than a silent pass-through.
  assert.throws(
    () => planSaved(workspace, { inputs: { target: "lib" } }),
    (error) =>
      error instanceof WorkflowError &&
      error.message.includes(
        "Saved workflow objective allows {{inputs.*}} references only; found {{tasks.analyze.result.summary}}",
      ),
  );

  // {{inputs.*}} substitution in the objective keeps working...
  writeTemplate(workspace, "review.json", reviewTemplate());
  const result = planSaved(workspace, { inputs: { target: "lib" } });
  assert.equal(result.objective, "Review lib");
  // ...and so does the --objective override path.
  const overridden = planSaved(workspace, {
    inputs: { target: "lib" },
    objective: "Overridden objective",
    runId: "objective-override-run",
  });
  assert.equal(overridden.objective, "Overridden objective");
});

test("an explicit objective overrides the expanded template objective", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  const result = planSaved(workspace, {
    inputs: { target: "lib" },
    objective: "Custom objective",
  });
  assert.equal(result.objective, "Custom objective");
  assert.equal(storedSpec(result).objective, "Custom objective");
});

test("templates without an objective are rejected", () => {
  const workspace = makeTempWorkspace();
  const template = reviewTemplate();
  delete template.objective;
  writeTemplate(workspace, "review.json", template);

  assert.throws(
    () => planSaved(workspace, { inputs: { target: "lib" }, objective: "Even with override" }),
    (error) => error instanceof WorkflowError && /must declare an objective/.test(error.message),
  );
});

test("YAML templates are accepted and .json wins lookup order", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.yaml", reviewTemplate({ objective: "From YAML {{inputs.target}}" }));

  const yamlResult = planSaved(workspace, { inputs: { target: "lib" } });
  assert.equal(yamlResult.objective, "From YAML lib");

  writeTemplate(workspace, "review.json", reviewTemplate());
  const jsonResult = planSaved(workspace, { inputs: { target: "lib" }, runId: "second-run" });
  assert.equal(jsonResult.objective, "Review lib");
});

test("workflow and spec are mutually exclusive; inputs require workflow", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  assert.throws(
    () => planSaved(workspace, { spec: reviewTemplate(), inputs: { target: "lib" } }),
    (error) => error instanceof WorkflowError && /mutually exclusive/.test(error.message),
  );
  assert.throws(
    () => planWorkflow({ inputs: { target: "lib" }, workspace, runRoot: path.join(workspace, "runs") }),
    (error) => error instanceof WorkflowError && /inputs require a saved workflow/.test(error.message),
  );
});

test("CCDW_HOME relocates the workflows directory", () => {
  const workspace = makeTempWorkspace();
  const customHome = fs.mkdtempSync(path.join(os.tmpdir(), "dw-saved-wf-home-"));
  fs.mkdirSync(path.join(customHome, "workflows"), { recursive: true });
  const original = process.env.CCDW_HOME;
  process.env.CCDW_HOME = customHome;
  try {
    fs.writeFileSync(
      path.join(customHome, "workflows", "review.json"),
      `${JSON.stringify(reviewTemplate(), null, 2)}\n`,
      "utf8",
    );
    const result = planSaved(workspace, { inputs: { target: "lib" } });
    assert.equal(result.objective, "Review lib");
    assert.equal(
      result.approval.summary.workflow_template.template_path,
      path.join(customHome, "workflows", "review.json"),
    );
  } finally {
    if (original == null) {
      delete process.env.CCDW_HOME;
    } else {
      process.env.CCDW_HOME = original;
    }
  }
});

test("CLI plan --workflow with repeatable --input plans end-to-end", () => {
  const workspace = makeTempWorkspace();
  writeTemplate(workspace, "review.json", reviewTemplate());

  const stdout = execFileSync(
    process.execPath,
    [
      cliPath,
      "plan",
      "--workflow", "review",
      "--input", "target=src/main=entry.js",
      "--input", "count=9",
      "--workspace", workspace,
      "--run-root", path.join(workspace, "runs"),
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, CCDW_HOME: "" } },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.status, "awaiting_approval");
  // Values keep their own "=" intact.
  assert.equal(result.objective, "Review src/main=entry.js");
  const spec = storedSpec(result);
  assert.equal(
    taskById(spec, "analyze").prompt_template,
    "Analyze src/main=entry.js with count 9 strict false.",
  );

  // Malformed --input values are rejected.
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        cliPath,
        "plan",
        "--workflow", "review",
        "--input", "no-separator",
        "--workspace", workspace,
        "--run-root", path.join(workspace, "runs"),
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CCDW_HOME: "" } },
    ),
  );
});
