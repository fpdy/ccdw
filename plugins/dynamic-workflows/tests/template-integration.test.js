import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planWorkflow, readRunState, runWorkflow } from "../scripts/lib/core.js";
import { applySpecDefaults, validateWorkflowSpec } from "../scripts/lib/spec.js";
import { buildTemplateContext, renderTaskPrompt } from "../scripts/lib/scheduler.js";
import { TemplateRenderError } from "../scripts/lib/template.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodexBin = path.join(pluginRoot, "tests", "fixtures", "fake-codex.js");
const fakeClaudeBin = path.join(pluginRoot, "tests", "fixtures", "fake-claude.js");

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-template-test-"));
}

async function withEnvAsync(pairs, callback) {
  const originals = new Map();
  for (const [name, value] of Object.entries(pairs)) {
    originals.set(name, process.env[name]);
    if (value == null) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await callback();
  } finally {
    for (const [name, original] of originals) {
      if (original == null) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readEvents(runDir) {
  return fs
    .readFileSync(path.join(runDir, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// All tasks live in one phase; dependencies sequence them.
function pipelineSpec(tasks, specOverrides = {}) {
  return {
    name: "template integration workflow",
    objective: "Exercise template integration",
    phases: [{ phase_id: "p1", tasks: tasks.map((task) => task.task_id) }],
    tasks: tasks.map((task) => ({ phase_id: "p1", kind: "codex_agent", role: "tester", ...task })),
    max_concurrency: 1,
    ...specOverrides,
  };
}

function planErrors(tasks) {
  const result = planWorkflow({
    workspace: makeTempWorkspace(),
    dryRun: true,
    spec: pipelineSpec(tasks),
  });
  return result.errors;
}

// Rich producer schema used by the static-validation tests (never executed).
const producerSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    score: { type: "number" },
    notes: { type: ["string", "null"] },
    items: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" } } },
    },
  },
};

// Minimal schema shared by both E2E tasks so a single CCDW_FAKE_TYPED_OUTPUT
// payload validates for the producer and the consumer alike.
const e2eSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    score: { type: "number" },
  },
};

// --- Plan-time rejections ------------------------------------------------------

test("plan rejects prompt_template syntax errors with the task id", () => {
  const errors = planErrors([
    { task_id: "t1", prompt_template: "do {{objective" },
  ]);
  assert.ok(
    errors.some((message) => message.includes("task t1 prompt_template") && /Unterminated/.test(message)),
    errors.join(" | "),
  );
});

test("plan rejects references to unknown tasks", () => {
  const errors = planErrors([
    { task_id: "t1", prompt_template: "use {{tasks.ghost.result.summary}}" },
  ]);
  assert.ok(errors.some((message) => message.includes("task ghost does not exist")), errors.join(" | "));
});

test("plan rejects references outside the depends_on closure", () => {
  const errors = planErrors([
    { task_id: "t1", prompt_template: "produce" },
    { task_id: "t2", prompt_template: "use {{tasks.t1.result.summary}}" },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task t1 is not in the depends_on transitive closure of task t2"),
    ),
    errors.join(" | "),
  );
});

test("plan accepts references satisfied through the transitive closure", () => {
  const result = planWorkflow({
    workspace: makeTempWorkspace(),
    dryRun: true,
    spec: pipelineSpec([
      { task_id: "t1", prompt_template: "produce" },
      { task_id: "t2", prompt_template: "relay", depends_on: ["t1"] },
      { task_id: "t3", prompt_template: "use {{tasks.t1.result.summary}}", depends_on: ["t2"] },
    ]),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("plan rejects dotpaths that do not resolve in the producer schema", () => {
  const typed = planErrors([
    { task_id: "t1", prompt_template: "produce", output_schema: producerSchema },
    { task_id: "t2", prompt_template: "use {{tasks.t1.result.output.bogus}}", depends_on: ["t1"] },
  ]);
  assert.ok(
    typed.some((message) =>
      message.includes('"bogus" is not a declared property in task t1\'s worker result schema'),
    ),
    typed.join(" | "),
  );

  // Default-form producers have no `output` envelope property at all.
  const defaultForm = planErrors([
    { task_id: "t1", prompt_template: "produce" },
    { task_id: "t2", prompt_template: "use {{tasks.t1.result.output.verdict}}", depends_on: ["t1"] },
  ]);
  assert.ok(
    defaultForm.some((message) => message.includes('"output" is not a declared property')),
    defaultForm.join(" | "),
  );
});

test("plan rejects dotpaths that walk into array interiors", () => {
  const typed = planErrors([
    { task_id: "t1", prompt_template: "produce", output_schema: producerSchema },
    { task_id: "t2", prompt_template: "use {{tasks.t1.result.output.items.title}}", depends_on: ["t1"] },
  ]);
  assert.ok(
    typed.some((message) => message.includes('segment "title" paths into an array property')),
    typed.join(" | "),
  );

  // Same rule against the default-form envelope (findings is an array).
  const defaultForm = planErrors([
    { task_id: "t1", prompt_template: "produce" },
    { task_id: "t2", prompt_template: "use {{tasks.t1.result.findings.claim}}", depends_on: ["t1"] },
  ]);
  assert.ok(
    defaultForm.some((message) => message.includes('segment "claim" paths into an array property')),
    defaultForm.join(" | "),
  );
});

test("plan rejects references resolving to nullable union properties", () => {
  const errors = planErrors([
    { task_id: "t1", prompt_template: "produce", output_schema: producerSchema },
    { task_id: "t2", prompt_template: "use {{tasks.t1.result.output.notes}}", depends_on: ["t1"] },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes('resolves to a nullable (["string","null"]) property'),
    ),
    errors.join(" | "),
  );
});

test("plan rejects leftover {{inputs.*}} references", () => {
  const errors = planErrors([
    { task_id: "t1", prompt_template: "checkout {{inputs.branch}}" },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task t1 prompt_template contains an unresolved input reference {{inputs.branch}}"),
    ),
    errors.join(" | "),
  );
});

test("plan rejects {{item}} references without a foreach declaration", () => {
  const errors = planErrors([
    { task_id: "t1", prompt_template: "fix {{item}} named {{item.name}}" },
  ]);
  const itemErrors = errors.filter((message) => message.includes("but the task declares no foreach"));
  assert.equal(itemErrors.length, 2, errors.join(" | "));
  assert.ok(itemErrors.some((message) => message.includes("{{item}}")));
  assert.ok(itemErrors.some((message) => message.includes("{{item.name}}")));
});

test("plan rejects {{gate_feedback}} without a gates declaration", () => {
  const errors = planErrors([
    { task_id: "t1", prompt_template: "retry context: {{gate_feedback}}" },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task t1 prompt_template uses {{gate_feedback}} but the task declares no gates"),
    ),
    errors.join(" | "),
  );
});

// Forward-compatible checks: gates/foreach are not spec fields yet (F3/F6), so
// these run validateWorkflowSpec directly on a defaulted workflow with the
// future fields injected. They must start passing untouched when the features land.
test("validateWorkflowSpec handles future gates/foreach declarations generically", () => {
  const workspace = makeTempWorkspace();
  const defaults = { workspace, runId: "run-1", workflowId: "wf-1", createdAt: "2026-06-12T00:00:00Z" };

  const withGates = applySpecDefaults(
    pipelineSpec([{ task_id: "t1", prompt_template: "fix it; feedback: {{gate_feedback}}" }]),
    defaults,
  );
  withGates.tasks[0].gates = [{ command: ["echo", "{{objective}}"], timeout_ms: 1000 }];
  const gateErrors = validateWorkflowSpec(withGates);
  // Template syntax in gate argv is an injection channel and always rejected.
  assert.ok(
    gateErrors.some((message) =>
      message.includes('task t1 gates[0].command[1] must not contain template syntax ("{{")'),
    ),
    gateErrors.join(" | "),
  );
  // ...but {{gate_feedback}} is now legal because the task declares gates.
  assert.ok(!gateErrors.some((message) => message.includes("declares no gates")), gateErrors.join(" | "));

  const withForeach = applySpecDefaults(
    pipelineSpec([{ task_id: "t1", prompt_template: "handle {{item}}" }]),
    defaults,
  );
  withForeach.tasks[0].foreach = { items: "{{tasks.x.result.output.items}}", max_items: 4 };
  const foreachErrors = validateWorkflowSpec(withForeach);
  assert.ok(!foreachErrors.some((message) => message.includes("declares no foreach")), foreachErrors.join(" | "));
});

test("plan accepts the full set of valid reference shapes", () => {
  const result = planWorkflow({
    workspace: makeTempWorkspace(),
    dryRun: true,
    spec: pipelineSpec([
      { task_id: "t1", prompt_template: "produce for {{objective}}", output_schema: producerSchema },
      {
        task_id: "t2",
        depends_on: ["t1"],
        prompt_template: [
          "objective: {{objective}}",
          "scalar: {{tasks.t1.result.output.verdict}} / {{tasks.t1.result.output.score}}",
          "whole object: {{tasks.t1.result.output}}",
          "whole array: {{tasks.t1.result.output.items}}",
          "envelope: {{tasks.t1.result.summary}} by {{tasks.t1.result.task_id}}",
        ].join("\n"),
      },
    ]),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

// --- E2E: rendered prompts reach the workers ------------------------------------

test("codex consumer worker receives the rendered prompt", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      { task_id: "t1", prompt_template: "Produce a verdict.", output_schema: e2eSchema },
      {
        task_id: "t2",
        depends_on: ["t1"],
        output_schema: e2eSchema,
        prompt_template:
          "Verdict was {{tasks.t1.result.output.verdict}} with score {{tasks.t1.result.output.score}}; full output {{tasks.t1.result.output}}.",
      },
    ]),
  });

  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TYPED_OUTPUT: '{"verdict":"pass","score":0.9}' },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t2.status, "succeeded");

  // fake-codex writes trace.json (including the full prompt) into the attempt dir.
  const state = readRunState(planned.run_dir);
  const attemptDir = path.join(planned.run_dir, state.attempts[state.tasks.t2.attempts[0]].artifact_dir);
  const trace = readJsonFile(path.join(attemptDir, "trace.json"));
  assert.ok(
    trace.prompt.includes(
      'Verdict was pass with score 0.9; full output {"verdict":"pass","score":0.9}.',
    ),
    trace.prompt,
  );
  assert.ok(!trace.prompt.includes("{{"), trace.prompt);
});

test("claude consumer worker receives the rendered prompt", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "claude-template-trace.jsonl");
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      { task_id: "t1", kind: "claude_agent", prompt_template: "Produce a verdict.", output_schema: e2eSchema },
      {
        task_id: "t2",
        kind: "claude_agent",
        depends_on: ["t1"],
        output_schema: e2eSchema,
        prompt_template: "Verdict was {{tasks.t1.result.output.verdict}}.",
      },
    ]),
  });

  const completed = await withEnvAsync(
    {
      CCDW_CLAUDE_BIN: fakeClaudeBin,
      CCDW_FAKE_TYPED_OUTPUT: '{"verdict":"pass","score":0.9}',
      CCDW_FAKE_TRACE_PATH: tracePath,
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  // The prompt is the final argv element recorded by the fake at spawn time.
  const traces = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(traces.length, 2);
  const consumerPrompt = traces[1].argv.at(-1);
  assert.ok(consumerPrompt.includes("Verdict was pass."), consumerPrompt);
  assert.ok(!consumerPrompt.includes("{{"), consumerPrompt);
});

// --- E2E: render failure fails the task permanently ------------------------------

test("a render failure fails the task permanently without spawning a worker", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec([
      { task_id: "t1", prompt_template: "Produce a verdict.", output_schema: e2eSchema },
      {
        task_id: "t2",
        depends_on: ["t1"],
        output_schema: e2eSchema,
        prompt_template: "Verdict was {{tasks.t1.result.output.verdict}}.",
        retry_policy: { retryable: true, max_attempts: 3 },
      },
    ]),
  });

  const env = { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TYPED_OUTPUT: '{"verdict":"pass","score":0.9}' };
  const paused = await withEnvAsync(env, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true, maxTasks: 1 }),
  );
  assert.equal(paused.status, "paused");
  assert.equal(paused.tasks.t1.status, "succeeded");

  // Corrupt the producer result on disk: the consumer's statically validated
  // reference no longer resolves, which is exactly the defensive runtime path.
  const resultPath = path.join(planned.run_dir, "artifacts", "t1", "result.json");
  const result = readJsonFile(resultPath);
  delete result.output.verdict;
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");

  const failed = await withEnvAsync(env, () => runWorkflow({ runDir: planned.run_dir }));
  assert.equal(failed.status, "failed");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.t2.status, "failed");
  // No worker was spawned and no retry happened despite retryable: true.
  assert.equal(state.tasks.t2.attempts.length, 0);
  assert.equal(state.tasks.t1.attempts.length, 1);

  const templateEvents = readEvents(planned.run_dir).filter(
    (event) => event.type === "template_resolution_failed",
  );
  assert.equal(templateEvents.length, 1);
  assert.equal(templateEvents[0].payload.task_id, "t2");
  assert.match(templateEvents[0].payload.message, /verdict/);
});

// --- Context builder unit coverage ----------------------------------------------

test("buildTemplateContext loads only referenced producer results lazily", () => {
  const runDir = makeTempWorkspace();
  fs.mkdirSync(path.join(runDir, "artifacts", "t1"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "artifacts", "t1", "result.json"),
    JSON.stringify({ task_id: "t1", summary: "done", output: { verdict: "pass" } }),
    "utf8",
  );
  const workflow = { objective: "the objective" };
  const state = {
    tasks: {
      t1: { status: "succeeded", result_path: "artifacts/t1/result.json" },
      // t9 succeeded too, but the template never references it; a missing
      // result_path must not matter for unreferenced tasks.
      t9: { status: "succeeded", result_path: null },
    },
  };
  const task = {
    task_id: "t2",
    prompt_template: "{{objective}} / {{tasks.t1.result.output.verdict}} / fb:{{gate_feedback}}",
  };

  const context = buildTemplateContext(runDir, workflow, state, task);
  assert.deepEqual(Object.keys(context.tasks), ["t1"]);
  assert.equal(context.gate_feedback, "");

  assert.equal(
    renderTaskPrompt(runDir, workflow, state, task),
    "the objective / pass / fb:",
  );
  assert.equal(
    renderTaskPrompt(runDir, workflow, state, task, { gateFeedback: "gate 0 failed" }),
    "the objective / pass / fb:gate 0 failed",
  );
});

test("renderTaskPrompt wraps missing or unreadable producer results in TemplateRenderError", () => {
  const runDir = makeTempWorkspace();
  const workflow = { objective: "obj" };
  const task = { task_id: "t2", prompt_template: "{{tasks.t1.result.summary}}" };

  assert.throws(
    () => renderTaskPrompt(runDir, workflow, { tasks: { t1: { status: "succeeded", result_path: null } } }, task),
    (error) => error instanceof TemplateRenderError && /no recorded result/.test(error.message),
  );
  assert.throws(
    () =>
      renderTaskPrompt(
        runDir,
        workflow,
        { tasks: { t1: { status: "succeeded", result_path: "artifacts/t1/result.json" } } },
        task,
      ),
    (error) => error instanceof TemplateRenderError && /could not be read/.test(error.message),
  );
});
