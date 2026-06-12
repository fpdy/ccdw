import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  planWorkflow,
  readRunState,
  resumeWorkflow,
  runWorkflow,
} from "../scripts/lib/core.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodexBin = path.join(pluginRoot, "tests", "fixtures", "fake-codex.js");

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-foreach-test-"));
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
  const eventPath = path.join(runDir, "events.ndjson");
  if (!fs.existsSync(eventPath)) {
    return [];
  }
  const content = fs.readFileSync(eventPath, "utf8").trim();
  return content === "" ? [] : content.split("\n").map((line) => JSON.parse(line));
}

function attemptDirFor(runDir, state, taskId, attemptIndex) {
  const attemptId = state.tasks[taskId].attempts[attemptIndex];
  return path.join(runDir, state.attempts[attemptId].artifact_dir);
}

// The fake codex worker writes trace.json ({start, end, prompt}) into its
// attempt directory; tests read it to assert rendered prompts and timing.
function attemptTrace(runDir, state, taskId, attemptIndex = 0) {
  return readJsonFile(path.join(attemptDirFor(runDir, state, taskId, attemptIndex), "trace.json"));
}

const ITEMS = [
  { file: "a.js", description: "fix a" },
  { file: "b.js", description: "fix b" },
  { file: "c.js", description: "fix c" },
];

// E2E producer schema: every property is required in the normalized form, so
// it declares exactly what the fake worker emits ({items: [...]}).
const producerSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

// Plan-time producer schema (never executed): output.name exercises non-array
// reference rejections and item.notes the nullable-leaf rejection.
const richProducerSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
          notes: { type: ["string", "null"] },
        },
      },
    },
  },
};

// All tasks live in one phase; dependencies sequence them.
function pipelineSpec(tasks, specOverrides = {}) {
  return {
    name: "foreach workflow",
    objective: "Exercise foreach fan-out",
    phases: [{ phase_id: "p1", tasks: tasks.map((task) => task.task_id) }],
    tasks: tasks.map((task) => ({ phase_id: "p1", kind: "codex_agent", role: "tester", ...task })),
    max_concurrency: 1,
    ...specOverrides,
  };
}

// producer (typed array output) -> foreach parent -> downstream consumer.
function fanoutTasks({ foreach = {}, parentOverrides = {}, withConsumer = true } = {}) {
  const tasks = [
    { task_id: "plan", prompt_template: "Plan the work.", output_schema: producerSchema },
    {
      task_id: "fix-each",
      prompt_template: "Fix: {{item.description}} ({{item.file}})",
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.items}}", max_items: 5, ...foreach },
      ...parentOverrides,
    },
  ];
  if (withConsumer) {
    tasks.push({
      task_id: "report",
      prompt_template: "Report on {{tasks.fix-each.result.output.results}}",
      depends_on: ["fix-each"],
    });
  }
  return tasks;
}

function planErrors(tasks, specOverrides = {}) {
  const result = planWorkflow({
    workspace: makeTempWorkspace(),
    dryRun: true,
    spec: pipelineSpec(tasks, specOverrides),
  });
  return result.errors;
}

const itemsEnv = (items = ITEMS) => ({
  CCDW_CODEX_BIN: fakeCodexBin,
  CCDW_FAKE_TYPED_OUTPUT: JSON.stringify({ items }),
});

// --- E2E: expansion, ordered aggregate, downstream consumption ----------------------

test("foreach expands a producer array into ordered children and an aggregate", async () => {
  const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(fanoutTasks()) });
  const completed = await withEnvAsync(itemsEnv(), () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");

  const state = readRunState(planned.run_dir);
  // The parent expanded instead of launching a worker: no attempt consumed.
  assert.equal(state.tasks["fix-each"].status, "succeeded");
  assert.equal(state.tasks["fix-each"].attempts.length, 0);
  assert.equal(state.expanded_tasks.length, 3);
  for (const [index, child] of state.expanded_tasks.entries()) {
    assert.equal(child.task_id, `fix-each.${index}`);
    assert.equal(child.parent_task_id, "fix-each");
    assert.equal(child.item_index, index);
    assert.equal(child.kind, "codex_agent");
    assert.equal(child.phase_id, "p1");
    assert.deepEqual(child.depends_on, []);
    assert.deepEqual(child.item, ITEMS[index]);
    assert.equal(state.tasks[child.task_id].status, "succeeded");
    assert.equal(state.tasks[child.task_id].attempts.length, 1);
  }
  // {{item.<path>}} rendered per child.
  assert.ok(
    attemptTrace(planned.run_dir, state, "fix-each.0").prompt.includes("Fix: fix a (a.js)"),
  );
  assert.ok(
    attemptTrace(planned.run_dir, state, "fix-each.2").prompt.includes("Fix: fix c (c.js)"),
  );

  // Order-preserving aggregate written as the parent's result.json.
  assert.equal(state.tasks["fix-each"].result_path, "artifacts/fix-each/result.json");
  const aggregate = readJsonFile(path.join(planned.run_dir, state.tasks["fix-each"].result_path));
  assert.equal(aggregate.task_id, "fix-each");
  assert.equal(aggregate.attempt_id, "aggregate");
  assert.equal(aggregate.status, "succeeded");
  assert.equal(aggregate.summary, "3 items: 3 succeeded, 0 failed");
  assert.deepEqual(aggregate.errors, []);
  assert.deepEqual(
    aggregate.output.results,
    ITEMS.map((_, index) => ({
      index,
      task_id: `fix-each.${index}`,
      status: "succeeded",
      output: null,
    })),
  );

  // The downstream consumer rendered the whole aggregate array and ran.
  assert.equal(state.tasks.report.status, "succeeded");
  const reportPrompt = attemptTrace(planned.run_dir, state, "report").prompt;
  assert.ok(reportPrompt.includes('"task_id":"fix-each.1"'), reportPrompt);
  assert.ok(reportPrompt.includes('"status":"succeeded"'), reportPrompt);

  assert.equal(state.phases.p1.status, "succeeded");
  const expandedEvents = readEvents(planned.run_dir).filter((event) => event.type === "tasks_expanded");
  assert.equal(expandedEvents.length, 1);
  assert.equal(expandedEvents[0].payload.task_id, "fix-each");
  assert.equal(expandedEvents[0].payload.count, 3);
  assert.deepEqual(expandedEvents[0].payload.items, ITEMS);
  assert.deepEqual(expandedEvents[0].payload.expanded_ids, ["fix-each.0", "fix-each.1", "fix-each.2"]);
});

test("typed children inherit the parent schema and carry output into the aggregate", async () => {
  const parentSchema = { type: "object", properties: { fixed: { type: "string" } } };
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec(fanoutTasks({ parentOverrides: { output_schema: parentSchema }, withConsumer: false })),
  });
  const byMatch = [
    { match: "Plan the work.", output: { items: ITEMS } },
    { match: "(a.js)", output: { fixed: "a" } },
    { match: "(b.js)", output: { fixed: "b" } },
    { match: "(c.js)", output: { fixed: "c" } },
  ];
  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TYPED_OUTPUT_BY_MATCH: JSON.stringify(byMatch) },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");

  const state = readRunState(planned.run_dir);
  // Each child got the synthesized typed worker schema of the inherited def.
  const childSchema = readJsonFile(
    path.join(attemptDirFor(planned.run_dir, state, "fix-each.0", 0), "worker-output.schema.json"),
  );
  assert.deepEqual(childSchema.properties.output.required, ["fixed"]);
  // The aggregate preserves order and embeds each child's typed output.
  const aggregate = readJsonFile(path.join(planned.run_dir, state.tasks["fix-each"].result_path));
  assert.deepEqual(
    aggregate.output.results.map((entry) => entry.output),
    [{ fixed: "a" }, { fixed: "b" }, { fixed: "c" }],
  );
});

// --- E2E: bounds (zero items, max_items, 256 KiB) ------------------------------------

test("zero items fold the parent to succeeded immediately and downstream still runs", async () => {
  const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(fanoutTasks()) });
  const completed = await withEnvAsync(itemsEnv([]), () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks["fix-each"].status, "succeeded");
  assert.equal(state.tasks["fix-each"].attempts.length, 0);
  assert.deepEqual(state.expanded_tasks, []);
  const aggregate = readJsonFile(path.join(planned.run_dir, state.tasks["fix-each"].result_path));
  assert.equal(aggregate.summary, "0 items: 0 succeeded, 0 failed");
  assert.deepEqual(aggregate.output.results, []);
  assert.equal(state.tasks.report.status, "succeeded");
  assert.ok(attemptTrace(planned.run_dir, state, "report").prompt.includes("Report on []"));
  assert.deepEqual(readEvents(planned.run_dir).filter((event) => event.type === "tasks_expanded"), []);
});

test("more items than max_items fails the parent without truncation", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec(fanoutTasks({ foreach: { max_items: 2 } })),
  });
  const failed = await withEnvAsync(itemsEnv(), () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks["fix-each"].status, "failed");
  assert.equal(state.tasks["fix-each"].attempts.length, 0);
  assert.deepEqual(state.expanded_tasks, []);
  assert.equal(state.phases.p1.status, "failed");
  const failure = readEvents(planned.run_dir).find(
    (event) =>
      event.type === "task_status_changed" &&
      event.payload.task_id === "fix-each" &&
      event.payload.status === "failed",
  );
  assert.equal(failure.payload.reason, "foreach_max_items_exceeded");
  assert.equal(failure.payload.item_count, 3);
  assert.equal(failure.payload.max_items, 2);
});

test("items serializing to more than 256 KiB fail the parent closed without expansion", async () => {
  const workspace = makeTempWorkspace();
  // 100 Ki three-byte characters: ~100 KiB in UTF-16 code units but ~300 KiB
  // in UTF-8 bytes, so this only trips a byte-measured bound (spec §6.2). The
  // payload travels via a file because it exceeds OS env size limits.
  const items = [{ file: "a.js", description: "あ".repeat(100 * 1024) }];
  const payloadPath = path.join(workspace, "typed-output.json");
  fs.writeFileSync(payloadPath, JSON.stringify({ items }), "utf8");
  const planned = planWorkflow({ workspace, spec: pipelineSpec(fanoutTasks()) });
  const failed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TYPED_OUTPUT_FILE: payloadPath },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks["fix-each"].status, "failed");
  assert.equal(state.tasks["fix-each"].attempts.length, 0);
  assert.deepEqual(state.expanded_tasks, []);
  assert.equal(state.phases.p1.status, "failed");
  const events = readEvents(planned.run_dir);
  assert.deepEqual(events.filter((event) => event.type === "tasks_expanded"), []);
  const failure = events.find(
    (event) =>
      event.type === "task_status_changed" &&
      event.payload.task_id === "fix-each" &&
      event.payload.status === "failed",
  );
  assert.equal(failure.payload.reason, "foreach_items_too_large");
  assert.equal(failure.payload.limit, 256 * 1024);
  assert.ok(failure.payload.serialized_bytes > 256 * 1024, String(failure.payload.serialized_bytes));
});

// --- E2E: tolerated_failure_count and child retries -----------------------------------

test("a tolerated child failure still folds the parent to succeeded", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec(fanoutTasks({ foreach: { tolerated_failure_count: 1 } })),
  });
  const completed = await withEnvAsync(
    { ...itemsEnv(), CCDW_FAKE_FAIL_IF_PROMPT_INCLUDES: "(b.js)" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  // The run completes; the tolerated child failure is reported honestly.
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "partial");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks["fix-each"].status, "succeeded");
  assert.equal(state.tasks["fix-each.1"].status, "failed");
  assert.equal(state.phases.p1.status, "succeeded");
  const aggregate = readJsonFile(path.join(planned.run_dir, state.tasks["fix-each"].result_path));
  assert.equal(aggregate.summary, "3 items: 2 succeeded, 1 failed");
  assert.deepEqual(
    aggregate.output.results.map((entry) => entry.status),
    ["succeeded", "failed", "succeeded"],
  );
  assert.equal(state.tasks.report.status, "succeeded");
});

test("child failures beyond tolerated_failure_count fail the parent", async () => {
  const items = [
    { file: "a.bad", description: "fix a" },
    { file: "b.bad", description: "fix b" },
    { file: "c.js", description: "fix c" },
  ];
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec(fanoutTasks({ foreach: { tolerated_failure_count: 1 } })),
  });
  const failed = await withEnvAsync(
    { ...itemsEnv(items), CCDW_FAKE_FAIL_IF_PROMPT_INCLUDES: ".bad)" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");

  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks["fix-each"].status, "failed");
  assert.equal(state.phases.p1.status, "failed");
  const failure = readEvents(planned.run_dir).find(
    (event) =>
      event.type === "task_status_changed" &&
      event.payload.task_id === "fix-each" &&
      event.payload.status === "failed",
  );
  assert.equal(failure.payload.reason, "foreach_children_failed");
  assert.equal(failure.payload.failed_children, 2);
  assert.equal(failure.payload.tolerated_failure_count, 1);
});

test("a child that fails once and then succeeds folds the parent to succeeded", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "fail-once.marker");
  const planned = planWorkflow({
    workspace,
    spec: pipelineSpec(
      fanoutTasks({
        parentOverrides: { retry_policy: { retryable: true, max_attempts: 2 } },
      }),
    ),
  });
  const completed = await withEnvAsync(
    { ...itemsEnv(), CCDW_FAKE_FAIL_MARKER: marker, CCDW_FAKE_FAIL_ONCE_MATCH: "(b.js)" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");

  const state = readRunState(planned.run_dir);
  // The crashing child inherited the parent retry_policy and retried once.
  assert.equal(state.tasks["fix-each.1"].status, "succeeded");
  assert.equal(state.tasks["fix-each.1"].attempts.length, 2);
  assert.equal(state.tasks["fix-each.0"].attempts.length, 1);
  assert.equal(state.tasks["fix-each.2"].attempts.length, 1);
  assert.equal(state.tasks["fix-each"].status, "succeeded");
  const aggregate = readJsonFile(path.join(planned.run_dir, state.tasks["fix-each"].result_path));
  assert.equal(aggregate.summary, "3 items: 3 succeeded, 0 failed");
});

// --- E2E: per-parent concurrency ------------------------------------------------------

test("foreach.concurrency=1 serializes children even with run concurrency available", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec(fanoutTasks({ foreach: { concurrency: 1 }, withConsumer: false }), {
      max_concurrency: 2,
    }),
  });
  const completed = await withEnvAsync(
    { ...itemsEnv(), CCDW_FAKE_SLEEP_MS: "60" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");

  const state = readRunState(planned.run_dir);
  const traces = ["fix-each.0", "fix-each.1", "fix-each.2"]
    .map((taskId) => attemptTrace(planned.run_dir, state, taskId))
    .sort((a, b) => a.start - b.start);
  for (let index = 1; index < traces.length; index += 1) {
    // Deterministic non-overlap: each child process started only after the
    // previous one had exited (start/end markers written by the fake worker).
    assert.ok(
      traces[index].start >= traces[index - 1].end,
      `children overlapped: ${JSON.stringify(traces)}`,
    );
  }
});

// --- E2E: resume ----------------------------------------------------------------------

test("resume replays a tasks_expanded event whose state write was lost", async () => {
  const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(fanoutTasks()) });
  const paused = await withEnvAsync(itemsEnv(), () =>
    runWorkflow({ runDir: planned.run_dir, approve: true, maxTasks: 1 }),
  );
  assert.equal(paused.status, "paused");
  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.plan.status, "succeeded");
  assert.equal(state.tasks["fix-each"].status, "queued");
  assert.deepEqual(state.expanded_tasks, []);

  // Simulate the crash window (spec §6.2): the tasks_expanded event reached
  // the log but the expansion never reached run.json.
  const forged = {
    schema_version: "dynamic-workflows.v2",
    timestamp: new Date().toISOString(),
    run_id: state.run_id,
    type: "tasks_expanded",
    payload: {
      task_id: "fix-each",
      count: 3,
      items: ITEMS,
      expanded_ids: ["fix-each.0", "fix-each.1", "fix-each.2"],
    },
  };
  fs.appendFileSync(path.join(planned.run_dir, "events.ndjson"), `${JSON.stringify(forged)}\n`);

  const resumed = await withEnvAsync(itemsEnv(), () => resumeWorkflow({ runDir: planned.run_dir }));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.outcome.status, "success");

  const recovered = readRunState(planned.run_dir);
  assert.equal(recovered.expanded_tasks.length, 3);
  assert.deepEqual(recovered.expanded_tasks.map((child) => child.item), ITEMS);
  assert.equal(recovered.tasks["fix-each"].status, "succeeded");
  assert.equal(recovered.tasks["fix-each"].attempts.length, 0);
  assert.equal(recovered.tasks.report.status, "succeeded");
  for (const childId of ["fix-each.0", "fix-each.1", "fix-each.2"]) {
    assert.equal(recovered.tasks[childId].status, "succeeded");
    assert.equal(recovered.tasks[childId].attempts.length, 1);
  }
  const events = readEvents(planned.run_dir);
  // The expansion was reconstructed, not repeated.
  assert.equal(events.filter((event) => event.type === "tasks_expanded").length, 1);
  assert.equal(events.filter((event) => event.type === "tasks_expanded_replayed").length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "task_status_changed" &&
        event.payload.task_id === "fix-each" &&
        event.payload.reason === "foreach_reexpanded",
    ),
  );
});

test("an unfolded parent with terminal children is folded at resume startup", async () => {
  const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(fanoutTasks()) });
  // maxTasks 4 = producer + all three children; the run pauses before report.
  const paused = await withEnvAsync(itemsEnv(), () =>
    runWorkflow({ runDir: planned.run_dir, approve: true, maxTasks: 4 }),
  );
  assert.equal(paused.status, "paused");

  // Simulate the crash window between the last child fold and the parent
  // fold: the children are terminal but the parent is still "expanded" and
  // the aggregate was never written.
  const statePath = path.join(planned.run_dir, "run.json");
  const state = readJsonFile(statePath);
  assert.equal(state.tasks["fix-each"].status, "succeeded");
  fs.rmSync(path.join(planned.run_dir, state.tasks["fix-each"].result_path));
  state.artifacts = state.artifacts.filter((entry) => entry !== state.tasks["fix-each"].result_path);
  state.tasks["fix-each"].status = "expanded";
  state.tasks["fix-each"].result_path = null;
  state.status = "running";
  state.outcome = null;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const resumed = await withEnvAsync(itemsEnv(), () => resumeWorkflow({ runDir: planned.run_dir }));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.outcome.status, "success");
  const recovered = readRunState(planned.run_dir);
  assert.equal(recovered.tasks["fix-each"].status, "succeeded");
  const aggregate = readJsonFile(path.join(planned.run_dir, recovered.tasks["fix-each"].result_path));
  assert.equal(aggregate.summary, "3 items: 3 succeeded, 0 failed");
  assert.equal(recovered.tasks.report.status, "succeeded");
  // The fold was re-applied, not the expansion.
  assert.equal(
    readEvents(planned.run_dir).filter((event) => event.type === "tasks_expanded").length,
    1,
  );
});

test("resume after partial child completion only runs the remaining children", async () => {
  const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(fanoutTasks()) });
  // maxTasks 3 = producer + two children (the expansion consumes no launch).
  const paused = await withEnvAsync(itemsEnv(), () =>
    runWorkflow({ runDir: planned.run_dir, approve: true, maxTasks: 3 }),
  );
  assert.equal(paused.status, "paused");
  const midState = readRunState(planned.run_dir);
  assert.equal(midState.tasks["fix-each"].status, "expanded");
  assert.equal(midState.tasks["fix-each.0"].status, "succeeded");
  assert.equal(midState.tasks["fix-each.1"].status, "succeeded");
  assert.equal(midState.tasks["fix-each.2"].status, "queued");
  assert.equal(midState.tasks.report.status, "queued");

  const resumed = await withEnvAsync(itemsEnv(), () => resumeWorkflow({ runDir: planned.run_dir }));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.outcome.status, "success");

  const state = readRunState(planned.run_dir);
  // Completed children were not re-run; only the remaining child launched.
  assert.equal(state.tasks["fix-each.0"].attempts.length, 1);
  assert.equal(state.tasks["fix-each.1"].attempts.length, 1);
  assert.equal(state.tasks["fix-each.2"].attempts.length, 1);
  assert.equal(state.tasks["fix-each"].status, "succeeded");
  assert.equal(state.tasks.report.status, "succeeded");
  const events = readEvents(planned.run_dir);
  assert.equal(events.filter((event) => event.type === "tasks_expanded").length, 1);
  assert.equal(events.filter((event) => event.type === "tasks_expanded_replayed").length, 0);
});

// --- Plan-time validation -------------------------------------------------------------

function producerTask() {
  return { task_id: "plan", prompt_template: "Plan the work.", output_schema: richProducerSchema };
}

test("plan rejects malformed foreach declarations", () => {
  const validItems = "{{tasks.plan.result.output.items}}";
  const cases = [
    [{ foreach: [] }, "foreach must be an object with items and max_items"],
    [{ foreach: { items: validItems } }, "foreach.max_items must be a positive integer"],
    [{ foreach: { items: validItems, max_items: 0 } }, "foreach.max_items must be a positive integer"],
    [{ foreach: { items: validItems, max_items: 1.5 } }, "foreach.max_items must be a positive integer"],
    [{ foreach: { items: 7, max_items: 2 } }, "foreach.items must be a non-empty string"],
    [{ foreach: { items: "", max_items: 2 } }, "foreach.items must be a non-empty string"],
    [{ foreach: { items: validItems, max_items: 2, extra: 1 } }, "foreach has unsupported key: extra"],
    [{ foreach: { items: validItems, max_items: 2, concurrency: 0 } }, "foreach.concurrency must be a positive integer"],
    [
      { foreach: { items: validItems, max_items: 2, tolerated_failure_count: -1 } },
      "foreach.tolerated_failure_count must be a non-negative integer",
    ],
  ];
  for (const [taskFields, expected] of cases) {
    const errors = planErrors([
      producerTask(),
      { task_id: "fan", prompt_template: "Fix things.", depends_on: ["plan"], ...taskFields },
    ]);
    assert.ok(
      errors.some((message) => message.includes(`task fan ${expected}`)),
      `${expected} :: ${errors.join(" | ")}`,
    );
  }
});

test("plan rejects items that are not exactly one whole-field producer reference", () => {
  const cases = [
    ["Process {{tasks.plan.result.output.items}} now", "must be exactly one {{tasks.<id>.result.<dotpath>}} reference"],
    ["{{objective}}", "must be exactly one {{tasks.<id>.result.<dotpath>}} reference"],
    ["{{item}}", "must be exactly one {{tasks.<id>.result.<dotpath>}} reference"],
    [
      "{{tasks.plan.result.output.items}}{{tasks.plan.result.output.items}}",
      "must be exactly one {{tasks.<id>.result.<dotpath>}} reference",
    ],
    ["{{tasks.plan.result.output.items", "foreach.items: Unterminated template reference"],
  ];
  for (const [items, expected] of cases) {
    const errors = planErrors([
      producerTask(),
      { task_id: "fan", prompt_template: "Fix things.", depends_on: ["plan"], foreach: { items, max_items: 2 } },
    ]);
    assert.ok(
      errors.some((message) => message.includes("task fan") && message.includes(expected)),
      `${expected} :: ${errors.join(" | ")}`,
    );
  }
});

test("plan rejects items references that do not resolve to a producer array", () => {
  const fan = (items, depends = ["plan"]) => [
    producerTask(),
    { task_id: "fan", prompt_template: "Fix things.", depends_on: depends, foreach: { items, max_items: 2 } },
  ];

  const notArray = planErrors(fan("{{tasks.plan.result.output.name}}"));
  assert.ok(
    notArray.some((message) =>
      message.includes("must resolve to an array-typed property in task plan's worker result schema"),
    ),
    notArray.join(" | "),
  );

  const missingProperty = planErrors(fan("{{tasks.plan.result.output.bogus}}"));
  assert.ok(
    missingProperty.some((message) =>
      message.includes('"bogus" is not a declared property in task plan\'s worker result schema'),
    ),
    missingProperty.join(" | "),
  );

  const missingProducer = planErrors(fan("{{tasks.ghost.result.output.items}}"));
  assert.ok(
    missingProducer.some((message) => message.includes("task ghost does not exist")),
    missingProducer.join(" | "),
  );

  const outsideClosure = planErrors(fan("{{tasks.plan.result.output.items}}", []));
  assert.ok(
    outsideClosure.some((message) =>
      message.includes("task plan is not in the depends_on transitive closure of task fan"),
    ),
    outsideClosure.join(" | "),
  );
});

test("plan validates {{item.<path>}} against the items element schema", () => {
  const scalarProducer = {
    task_id: "plan",
    prompt_template: "Plan the work.",
    output_schema: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    },
  };
  const scalarItems = planErrors([
    scalarProducer,
    {
      task_id: "fan",
      prompt_template: "Fix {{item.name}}",
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.tags}}", max_items: 2 },
    },
  ]);
  assert.ok(
    scalarItems.some((message) =>
      message.includes('{{item.name}}: segment "name" paths into a "string" property'),
    ),
    scalarItems.join(" | "),
  );

  // Bare {{item}} works for any element type.
  const bareItem = planErrors([
    scalarProducer,
    {
      task_id: "fan",
      prompt_template: "Fix {{item}}",
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.tags}}", max_items: 2 },
    },
  ]);
  assert.deepEqual(bareItem, []);

  const objectFan = (prompt) => [
    producerTask(),
    {
      task_id: "fan",
      prompt_template: prompt,
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.items}}", max_items: 2 },
    },
  ];
  const undeclared = planErrors(objectFan("Fix {{item.bogus}}"));
  assert.ok(
    undeclared.some((message) =>
      message.includes('"bogus" is not a declared property in the foreach items schema of task fan'),
    ),
    undeclared.join(" | "),
  );
  const nullable = planErrors(objectFan("Fix {{item.notes}}"));
  assert.ok(
    nullable.some((message) =>
      message.includes('{{item.notes}}: resolves to a nullable (["string","null"]) property'),
    ),
    nullable.join(" | "),
  );
});

test("plan rejects task ids colliding with reserved child ids", () => {
  const errors = planErrors([
    producerTask(),
    {
      task_id: "fan",
      prompt_template: "Fix {{item}}",
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.items}}", max_items: 2 },
    },
    { task_id: "fan.0", prompt_template: "I collide.", depends_on: [] },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task fan.0 collides with the expanded child ids of foreach task fan"),
    ),
    errors.join(" | "),
  );
});

test("plan enforces the max_agents foreach budget precondition", () => {
  // 3 spec tasks + max_items 5 = 8 > max_agents 4.
  const errors = planErrors(fanoutTasks(), { max_agents: 4 });
  assert.ok(
    errors.some((message) =>
      message.includes(
        "foreach budget precondition failed: 3 spec tasks + 5 max expanded children (sum of max_items) exceeds max_agents 4",
      ),
    ),
    errors.join(" | "),
  );
  // Exactly fitting the budget passes.
  assert.deepEqual(planErrors(fanoutTasks(), { max_agents: 8 }), []);
});

test("plan rejects foreach on local tasks and together with route", () => {
  const localErrors = planErrors([
    producerTask(),
    {
      task_id: "fan",
      kind: "local_analysis",
      prompt_template: "Fix things.",
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.items}}", max_items: 2 },
    },
  ]);
  assert.ok(
    localErrors.some((message) => message.includes("task fan foreach is not supported for local tasks")),
    localErrors.join(" | "),
  );

  const routeErrors = planErrors([
    producerTask(),
    {
      task_id: "fan",
      prompt_template: "Fix things.",
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.items}}", max_items: 2 },
      route: { values: ["a", "b"], cases: {}, default: [] },
    },
  ]);
  assert.ok(
    routeErrors.some((message) => message.includes("task fan cannot declare both route and foreach")),
    routeErrors.join(" | "),
  );
});

test("plan restricts downstream references to the foreach aggregate array", () => {
  const tasks = fanoutTasks({ withConsumer: false });
  for (const badRef of [
    "{{tasks.fix-each.result.summary}}",
    "{{tasks.fix-each.result.output}}",
    "{{tasks.fix-each.result.output.results.status}}",
  ]) {
    const errors = planErrors([
      ...tasks,
      { task_id: "report", prompt_template: `Report on ${badRef}`, depends_on: ["fix-each"] },
    ]);
    assert.ok(
      errors.some((message) =>
        message.includes(
          "task fix-each declares foreach; only the aggregate {{tasks.fix-each.result.output.results}} may be referenced",
        ),
      ),
      `${badRef} :: ${errors.join(" | ")}`,
    );
  }
  // The whole-aggregate reference is the valid form.
  assert.deepEqual(planErrors(fanoutTasks()), []);
});

test("plan applies the V7 co-activation rule to foreach.items producers", () => {
  const tasks = (cases) => [
    {
      task_id: "r1",
      prompt_template: "Route the work.",
      route: { values: ["a", "b"], cases, default: [] },
    },
    { ...producerTask(), depends_on: ["r1"] },
    {
      task_id: "fan",
      prompt_template: "Fix {{item.file}}",
      depends_on: ["r1", "plan"],
      foreach: { items: "{{tasks.plan.result.output.items}}", max_items: 2 },
    },
  ];
  // Resolution "b" activates the foreach parent while route-skipping its
  // items producer: the expansion would fail at runtime
  // (template_resolution_failed), so the plan is rejected instead.
  const errors = planErrors(tasks({ a: ["plan", "fan"], b: ["fan"] }));
  assert.ok(
    errors.some((message) =>
      message.includes(
        'task fan foreach.items reference {{tasks.plan.result.output.items}}: routing task r1 resolution "b" activates task fan without activating producer plan',
      ),
    ),
    errors.join(" | "),
  );
  // Producer and parent co-activated in every resolution: valid.
  assert.deepEqual(planErrors(tasks({ a: ["plan", "fan"], b: [] })), []);
});

test("plan accepts foreach on claude tasks", () => {
  const errors = planErrors([
    producerTask(),
    {
      task_id: "fan",
      kind: "claude_agent",
      prompt_template: "Fix: {{item.description}}",
      depends_on: ["plan"],
      foreach: { items: "{{tasks.plan.result.output.items}}", max_items: 3 },
    },
  ]);
  assert.deepEqual(errors, []);
});

// --- Approval disclosure ---------------------------------------------------------------

test("approval summary discloses the foreach declaration, budget estimate, and full template", () => {
  const longTemplate = `Fix: {{item.description}} in {{item.file}} ${"carefully and thoroughly ".repeat(8)}`;
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec(fanoutTasks({ parentOverrides: { prompt_template: longTemplate } })),
  });
  const tasks = Object.fromEntries(planned.approval.summary.tasks.map((task) => [task.task_id, task]));
  assert.deepEqual(tasks["fix-each"].foreach, {
    items: "{{tasks.plan.result.output.items}}",
    max_items: 5,
    concurrency: null,
    tolerated_failure_count: 0,
  });
  // foreach tasks disclose the full template (every child renders from it).
  assert.ok(longTemplate.length > 120);
  assert.equal(tasks["fix-each"].prompt_summary, longTemplate);
  assert.equal(tasks.plan.foreach, undefined);
  assert.deepEqual(planned.approval.summary.foreach_budget, {
    static_task_count: 3,
    max_expanded_children: 5,
    estimated_max_total_tasks: 8,
    max_agents: 32,
  });

  // Fan-out-free specs keep the existing summary shape.
  const plain = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec([{ task_id: "t1", prompt_template: "Run it." }]),
  });
  assert.equal(plain.approval.summary.foreach_budget, undefined);
});
