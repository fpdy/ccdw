import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applySpecDefaults,
  planWorkflow,
  readRunState,
  resumeWorkflow,
  runWorkflow,
  validateWorkflowSpec,
} from "../scripts/lib/core.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodexBin = path.join(pluginRoot, "tests", "fixtures", "fake-codex.js");
const fakeClaudeBin = path.join(pluginRoot, "tests", "fixtures", "fake-claude.js");

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-route-test-"));
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

// All tasks live in one phase; dependencies sequence them.
function pipelineSpec(tasks, specOverrides = {}) {
  return {
    name: "route workflow",
    objective: "Exercise route branching",
    phases: [{ phase_id: "p1", tasks: tasks.map((task) => task.task_id) }],
    tasks: tasks.map((task) => ({ phase_id: "p1", kind: "codex_agent", role: "tester", ...task })),
    max_concurrency: 1,
    ...specOverrides,
  };
}

function planErrors(tasks, specOverrides = {}) {
  const result = planWorkflow({
    workspace: makeTempWorkspace(),
    dryRun: true,
    spec: pipelineSpec(tasks, specOverrides),
  });
  return result.errors;
}

// The spec's F4 acceptance example: review routes; land depends on review AND
// fix, so the approve resolution exercises R2 (skipped_by_route satisfies
// dependencies); reject has no case entry and falls through to default.
function reviewRouteTasks() {
  return [
    {
      task_id: "review",
      prompt_template: "Review the change.",
      route: {
        values: ["approve", "minor_fix", "reject"],
        cases: { approve: ["land"], minor_fix: ["fix", "land"] },
        default: ["escalate"],
      },
    },
    { task_id: "fix", prompt_template: "Fix it.", depends_on: ["review"] },
    { task_id: "land", prompt_template: "Land it.", depends_on: ["review", "fix"] },
    { task_id: "escalate", prompt_template: "Escalate to a human.", depends_on: ["review"] },
  ];
}

// --- Plan-time validation -------------------------------------------------------

test("plan rejects route on local tasks", () => {
  const errors = planErrors([
    {
      task_id: "t1",
      kind: "local_analysis",
      prompt_template: "local work",
      route: { values: ["a", "b"], cases: { a: ["t2"] }, default: [] },
    },
    { task_id: "t2", prompt_template: "branch", depends_on: ["t1"] },
  ]);
  assert.ok(
    errors.some((message) => message.includes("task t1 route is not supported for local tasks")),
    errors.join(" | "),
  );
});

test("plan rejects malformed route declarations", () => {
  const cases = [
    [{ route: [] }, "route must be an object with values, cases, and default"],
    [{ route: { values: ["a", "b"], cases: {}, default: [], extra: 1 } }, "route has unsupported key: extra"],
    [{ route: { values: ["a"], cases: {}, default: [] } }, "route.values must be an array of at least 2 strings"],
    [{ route: { values: "a,b", cases: {}, default: [] } }, "route.values must be an array of at least 2 strings"],
    [
      { route: { values: Array.from({ length: 21 }, (_, i) => `v${i}`), cases: {}, default: [] } },
      "route.values has 21 values; limit is 20",
    ],
    [{ route: { values: ["a", ""], cases: {}, default: [] } }, "route.values entries must be non-empty strings"],
    [{ route: { values: ["a", 7], cases: {}, default: [] } }, "route.values entries must be non-empty strings"],
    [
      { route: { values: ["a", "x".repeat(65)], cases: {}, default: [] } },
      "route.values entries must be at most 64 characters",
    ],
    [{ route: { values: ["a", "a"], cases: {}, default: [] } }, "route.values must be distinct"],
    [{ route: { values: ["a", "b"], cases: ["t2"], default: [] } }, "route.cases must be an object mapping route values to task id arrays"],
    // V1: cases keys must be a subset of values.
    [{ route: { values: ["a", "b"], cases: { bogus: [] }, default: [] } }, 'route.cases key "bogus" is not in route.values'],
    [{ route: { values: ["a", "b"], cases: { a: "t2" }, default: [] } }, "route.cases.a must be an array of task ids"],
    // V1: default is required.
    [{ route: { values: ["a", "b"], cases: {} } }, "route.default is required"],
    [{ route: { values: ["a", "b"], cases: {}, default: "t2" } }, "route.default must be an array of task ids"],
    // V5: the routing task must not list itself.
    [{ route: { values: ["a", "b"], cases: { a: ["t1"] }, default: [] } }, "route.cases.a must not list the routing task itself"],
    [{ route: { values: ["a", "b"], cases: {}, default: ["t1"] } }, "route.default must not list the routing task itself"],
  ];
  for (const [taskFields, expected] of cases) {
    const errors = planErrors([{ task_id: "t1", prompt_template: "route it", ...taskFields }]);
    assert.ok(
      errors.some((message) => message.includes(`task t1 ${expected}`)),
      `${expected} :: ${errors.join(" | ")}`,
    );
  }
});

test("plan rejects route references to missing tasks", () => {
  const errors = planErrors([
    {
      task_id: "t1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases: { a: ["ghost"] }, default: [] },
    },
  ]);
  assert.ok(
    errors.some((message) => message.includes("task t1 route references missing task ghost")),
    errors.join(" | "),
  );
});

test("plan enforces V2: case tasks must transitively depend on the routing task", () => {
  const errors = planErrors([
    {
      task_id: "t1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases: { a: ["t2"] }, default: [] },
    },
    // No depends_on path back to t1.
    { task_id: "t2", prompt_template: "branch" },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task t2 is listed in task t1 route but does not include t1 in its depends_on transitive closure"),
    ),
    errors.join(" | "),
  );

  // A transitive path satisfies V2.
  const transitive = planErrors([
    {
      task_id: "t1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases: { a: ["t3"] }, default: [] },
    },
    { task_id: "t2", prompt_template: "middle", depends_on: ["t1"] },
    { task_id: "t3", prompt_template: "branch", depends_on: ["t2"] },
  ]);
  assert.deepEqual(transitive, []);
});

test("plan enforces V3: only case tasks of the same route may depend on a case task", () => {
  const errors = planErrors([
    {
      task_id: "t1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases: { a: ["t2"] }, default: [] },
    },
    { task_id: "t2", prompt_template: "branch", depends_on: ["t1"] },
    // t3 is not a case task of t1's route but depends directly on case task t2.
    { task_id: "t3", prompt_template: "downstream", depends_on: ["t2"] },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task t3 depends on case task t2 of routing task t1; only case tasks of the same route may depend on a case task"),
    ),
    errors.join(" | "),
  );
});

test("plan enforces V4: a task may be a case task of at most one routing task", () => {
  const errors = planErrors([
    {
      task_id: "r1",
      prompt_template: "route one",
      route: { values: ["a", "b"], cases: { a: ["shared"] }, default: [] },
    },
    {
      task_id: "r2",
      prompt_template: "route two",
      route: { values: ["x", "y"], cases: { x: ["shared"] }, default: [] },
    },
    { task_id: "shared", prompt_template: "branch", depends_on: ["r1", "r2"] },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task shared is listed in the route of more than one routing task (r1, r2)"),
    ),
    errors.join(" | "),
  );
});

test("plan allows the same case task under multiple values of one routing task", () => {
  const errors = planErrors([
    {
      task_id: "t1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases: { a: ["t2"], b: ["t2"] }, default: [] },
    },
    { task_id: "t2", prompt_template: "branch", depends_on: ["t1"] },
  ]);
  assert.deepEqual(errors, []);
});

test("plan enforces V5: route and foreach are mutually exclusive", () => {
  const workflow = applySpecDefaults(
    pipelineSpec([
      {
        task_id: "t1",
        prompt_template: "route it",
        route: { values: ["a", "b"], cases: { a: ["t2"] }, default: [] },
      },
      { task_id: "t2", prompt_template: "branch", depends_on: ["t1"] },
    ]),
    { workspace: makeTempWorkspace(), runId: "route-v5", workflowId: "wf-route-v5", createdAt: new Date().toISOString() },
  );
  // foreach is not authored yet (F6); validation is forward-compatible.
  workflow.tasks[0].foreach = { items: "{{tasks.t0.result.output.items}}" };
  const errors = validateWorkflowSpec(workflow);
  assert.ok(
    errors.some((message) => message.includes("task t1 cannot declare both route and foreach")),
    errors.join(" | "),
  );
});

test("plan enforces V7: a non-case task may not template-reference a case producer", () => {
  const errors = planErrors([
    {
      task_id: "r1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases: { a: ["p"] }, default: [] },
    },
    { task_id: "p", prompt_template: "produce", depends_on: ["r1"] },
    { task_id: "x", prompt_template: "Use {{tasks.p.result.summary}}", depends_on: ["p"] },
  ]);
  assert.ok(
    errors.some((message) =>
      message.includes("task p is a case task of routing task r1; only case tasks of the same route may reference it"),
    ),
    errors.join(" | "),
  );
});

test("plan enforces V7: every resolution activating the consumer must activate the producer", () => {
  const tasks = (cases) => [
    {
      task_id: "r1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases, default: [] },
    },
    { task_id: "p", prompt_template: "produce", depends_on: ["r1"] },
    { task_id: "c", prompt_template: "Use {{tasks.p.result.summary}}", depends_on: ["r1", "p"] },
  ];
  // Resolution "b" activates c without p: rendering c would hit a producer
  // that was skipped_by_route.
  const errors = planErrors(tasks({ a: ["p", "c"], b: ["c"] }));
  assert.ok(
    errors.some((message) =>
      message.includes('routing task r1 resolution "b" activates task c without activating producer p'),
    ),
    errors.join(" | "),
  );
  // Co-activated under every resolution: valid.
  assert.deepEqual(planErrors(tasks({ a: ["p", "c"], b: [] })), []);
});

test("V7 ignores the default resolution when every value has an explicit case", () => {
  // Reviewer's example: values ["a","b"] both have explicit cases, so default
  // can never be selected at runtime. Task c references producer p, and both
  // are co-activated only by case "a"; case "b" activates neither. Default
  // (which would activate c without p) is unreachable and must NOT be checked.
  const tasks = [
    {
      task_id: "r",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases: { a: ["p", "c"], b: [] }, default: ["c"] },
    },
    { task_id: "p", prompt_template: "produce", depends_on: ["r"] },
    { task_id: "c", prompt_template: "Use {{tasks.p.result.summary}}", depends_on: ["r", "p"] },
  ];
  assert.deepEqual(planErrors(tasks), []);
});

test("plan enforces V6: a case task listed in no reachable resolution is rejected", () => {
  const tasks = (cases) => [
    {
      task_id: "r1",
      prompt_template: "route it",
      route: { values: ["a", "b"], cases, default: ["dead"] },
    },
    { task_id: "dead", prompt_template: "never selected", depends_on: ["r1"] },
  ];
  // Every value has an explicit case, so route.default can never be selected
  // and its only task can never launch.
  const errors = planErrors(tasks({ a: [], b: [] }));
  assert.ok(
    errors.some((message) =>
      message.includes(
        "task r1 route lists task dead in no reachable resolution; route.default is only selected when some route value lacks an explicit case",
      ),
    ),
    errors.join(" | "),
  );
  // Value "b" lacks an explicit case, so default (and the task) is reachable.
  assert.deepEqual(planErrors(tasks({ a: [] })), []);
});

// --- Approval disclosure ---------------------------------------------------------

test("approval summary discloses the full route declaration", () => {
  const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(reviewRouteTasks()) });
  const tasks = Object.fromEntries(planned.approval.summary.tasks.map((task) => [task.task_id, task]));
  assert.deepEqual(tasks.review.route, {
    values: ["approve", "minor_fix", "reject"],
    cases: { approve: ["land"], minor_fix: ["fix", "land"] },
    default: ["escalate"],
  });
  assert.equal(tasks.fix.route, undefined);
});

// --- E2E: route resolution per value -----------------------------------------------

const ROUTE_EXPECTATIONS = {
  // R2 acceptance case: fix is skipped_by_route, land still runs.
  approve: { succeeded: ["land", "review"], routedSkipped: ["escalate", "fix"], selected: ["land"] },
  minor_fix: { succeeded: ["fix", "land", "review"], routedSkipped: ["escalate"], selected: ["fix", "land"] },
  // reject has no case entry and resolves to default.
  reject: { succeeded: ["escalate", "review"], routedSkipped: ["fix", "land"], selected: ["escalate"] },
};

for (const [value, expected] of Object.entries(ROUTE_EXPECTATIONS)) {
  test(`route resolution "${value}" activates ${JSON.stringify(expected.selected)} and skips the rest`, async () => {
    const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(reviewRouteTasks()) });
    const completed = await withEnvAsync(
      { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_ROUTE_VALUE: value },
      () => runWorkflow({ runDir: planned.run_dir, approve: true }),
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.outcome.status, "success");

    const state = readRunState(planned.run_dir);
    for (const taskId of expected.succeeded) {
      assert.equal(state.tasks[taskId].status, "succeeded", taskId);
      assert.equal(state.tasks[taskId].attempts.length, 1, taskId);
    }
    for (const taskId of expected.routedSkipped) {
      assert.equal(state.tasks[taskId].status, "skipped_by_route", taskId);
      // Skipped case tasks never consume an attempt.
      assert.equal(state.tasks[taskId].attempts.length, 0, taskId);
    }
    // R3: the phase folds to succeeded, R4: the run outcome is success with
    // the route skips reported separately.
    assert.equal(state.phases.p1.status, "succeeded");
    assert.equal(state.outcome.routed_skipped, expected.routedSkipped.length);
    assert.ok(state.outcome.summary.includes("skipped by route"), state.outcome.summary);
    // The accepted route value is persisted on the routing task's state entry.
    assert.equal(state.tasks.review.route_value, value);
    assert.equal(state.tasks.review.route_resolved, true);

    const events = readEvents(planned.run_dir);
    const resolved = events.filter((event) => event.type === "route_resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].payload.task_id, "review");
    assert.equal(resolved[0].payload.value, value);
    assert.deepEqual([...resolved[0].payload.selected].sort(), expected.selected);
    assert.deepEqual([...resolved[0].payload.skipped].sort(), expected.routedSkipped);
    const skipEvents = events.filter(
      (event) => event.type === "task_status_changed" && event.payload.status === "skipped_by_route",
    );
    assert.deepEqual(skipEvents.map((event) => event.payload.task_id).sort(), expected.routedSkipped);
    for (const event of skipEvents) {
      assert.equal(event.payload.reason, "route_not_selected");
      assert.equal(event.payload.routing_task_id, "review");
      assert.equal(event.payload.route_value, value);
    }
  });
}

test("the routing task's worker schema gains the route enum; case tasks do not", async () => {
  const planned = planWorkflow({ workspace: makeTempWorkspace(), spec: pipelineSpec(reviewRouteTasks()) });
  await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_ROUTE_VALUE: "approve" }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  const state = readRunState(planned.run_dir);
  const reviewSchema = readJsonFile(
    path.join(attemptDirFor(planned.run_dir, state, "review", 0), "worker-output.schema.json"),
  );
  assert.deepEqual(reviewSchema.properties.route, {
    type: "string",
    enum: ["approve", "minor_fix", "reject"],
  });
  assert.ok(reviewSchema.required.includes("route"));
  const landSchema = readJsonFile(
    path.join(attemptDirFor(planned.run_dir, state, "land", 0), "worker-output.schema.json"),
  );
  assert.equal(landSchema.properties.route, undefined);
  assert.ok(!landSchema.required.includes("route"));
});

test("a typed routing task carries route next to output", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec([
      {
        task_id: "review",
        prompt_template: "Review and emit a verdict.",
        output_schema: { type: "object", properties: { verdict: { type: "string" } } },
        route: { values: ["pass", "fail"], cases: { pass: [], fail: [] }, default: [] },
      },
    ]),
  });
  const completed = await withEnvAsync(
    {
      CCDW_CODEX_BIN: fakeCodexBin,
      CCDW_FAKE_ROUTE_VALUE: "pass",
      CCDW_FAKE_TYPED_OUTPUT: '{"verdict":"looks good"}',
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");
  const state = readRunState(planned.run_dir);
  const result = readJsonFile(path.join(planned.run_dir, state.tasks.review.result_path));
  assert.equal(result.route, "pass");
  assert.deepEqual(result.output, { verdict: "looks good" });
  const resolved = readEvents(planned.run_dir).filter((event) => event.type === "route_resolved");
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0].payload.selected, []);
  assert.deepEqual(resolved[0].payload.skipped, []);
});

test("a route value outside the enum is quarantined as schema_violation", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec([
      {
        task_id: "review",
        prompt_template: "Review the change.",
        route: { values: ["go", "stop"], cases: { go: [] }, default: [] },
      },
    ]),
  });
  const failed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_ROUTE_VALUE: "bogus" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");
  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.review.status, "schema_violation");
  const rejected = readJsonFile(
    path.join(attemptDirFor(planned.run_dir, state, "review", 0), "rejected-result.json"),
  );
  assert.ok(
    rejected.validation_errors.some((message) => message.includes("route")),
    rejected.validation_errors.join(" | "),
  );
  assert.deepEqual(readEvents(planned.run_dir).filter((event) => event.type === "route_resolved"), []);
});

test("claude routing tasks resolve routes too", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec([
      {
        task_id: "review",
        kind: "claude_agent",
        prompt_template: "Review the change.",
        route: { values: ["go", "stop"], cases: { go: ["land"] }, default: [] },
      },
      { task_id: "land", kind: "claude_agent", prompt_template: "Land it.", depends_on: ["review"] },
    ]),
  });
  const completed = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_ROUTE_VALUE: "stop" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");
  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.review.route_value, "stop");
  assert.equal(state.tasks.land.status, "skipped_by_route");
  assert.equal(state.phases.p1.status, "succeeded");
});

// --- E2E: finalize counting and resume ----------------------------------------------

test("partial outcomes count routed skips separately from failures", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: {
      name: "route partial workflow",
      objective: "Route plus an unrelated failure",
      phases: [
        { phase_id: "p1", tasks: ["review", "fix"] },
        { phase_id: "p2", tasks: ["doomed"], on_failure: "continue" },
      ],
      tasks: [
        {
          task_id: "review",
          phase_id: "p1",
          kind: "codex_agent",
          role: "tester",
          prompt_template: "Review the change.",
          route: { values: ["ok", "fix_needed"], cases: { ok: [] }, default: ["fix"] },
        },
        {
          task_id: "fix",
          phase_id: "p1",
          kind: "codex_agent",
          role: "tester",
          prompt_template: "Fix it.",
          depends_on: ["review"],
        },
        // Unknown local kind: fails deterministically without a worker binary.
        {
          task_id: "doomed",
          phase_id: "p2",
          kind: "local_bogus",
          role: "tester",
          prompt_template: "Always fails.",
        },
      ],
      max_concurrency: 1,
    },
  });
  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_ROUTE_VALUE: "ok" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "partial");
  assert.equal(completed.outcome.routed_skipped, 1);
  assert.equal(
    completed.outcome.summary,
    "Workflow completed with failures: 1 failed, 0 skipped, 1 skipped by route.",
  );
  const state = readRunState(planned.run_dir);
  assert.equal(state.tasks.fix.status, "skipped_by_route");
  assert.equal(state.tasks.doomed.status, "failed");
  assert.equal(state.phases.p1.status, "succeeded");
  assert.equal(state.phases.p2.status, "failed");

  // R5: resume --resume-failed requeues the failure but never the routed skip.
  const resumed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_ROUTE_VALUE: "ok" },
    () => resumeWorkflow({ runDir: planned.run_dir, resumeFailed: true }),
  );
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.outcome.status, "partial");
  const resumedState = readRunState(planned.run_dir);
  assert.equal(resumedState.tasks.fix.status, "skipped_by_route");
  assert.equal(resumedState.tasks.fix.attempts.length, 0);
  // The routing task was not re-run; the failed task was.
  assert.equal(resumedState.tasks.review.attempts.length, 1);
  assert.equal(resumedState.tasks.doomed.attempts.length, 2);
  // The original resolution was not replayed.
  assert.equal(
    readEvents(planned.run_dir).filter((event) => event.type === "route_resolved").length,
    1,
  );
});

test("an unapplied route resolution is re-derived from route_value on resume", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec([
      {
        task_id: "review",
        prompt_template: "Review the change.",
        route: { values: ["go", "stop"], cases: { go: ["land"] }, default: [] },
      },
      { task_id: "land", prompt_template: "Land it.", depends_on: ["review"] },
    ]),
  });
  const env = { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_ROUTE_VALUE: "stop" };
  const completed = await withEnvAsync(env, () => runWorkflow({ runDir: planned.run_dir, approve: true }));
  assert.equal(completed.status, "completed");

  // Simulate the crash window: the routing task folded to succeeded and its
  // accepted route_value was persisted, but the orchestrator died before the
  // resolution was applied (and before anything downstream happened).
  const statePath = path.join(planned.run_dir, "run.json");
  const state = readJsonFile(statePath);
  delete state.tasks.review.route_resolved;
  state.tasks.land.status = "queued";
  state.phases.p1.status = "running";
  state.status = "approved";
  state.outcome = null;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  // The scheduler must re-apply the resolution instead of launching land.
  const rerun = await withEnvAsync(env, () => runWorkflow({ runDir: planned.run_dir }));
  assert.equal(rerun.status, "completed");
  assert.equal(rerun.outcome.status, "success");
  const recovered = readRunState(planned.run_dir);
  assert.equal(recovered.tasks.land.status, "skipped_by_route");
  assert.equal(recovered.tasks.land.attempts.length, 0);
  assert.equal(recovered.tasks.review.route_resolved, true);
  assert.equal(
    readEvents(planned.run_dir).filter((event) => event.type === "route_resolved").length,
    2,
  );
});

test("resume of a completed run is a noop for skipped_by_route tasks", async () => {
  const planned = planWorkflow({
    workspace: makeTempWorkspace(),
    spec: pipelineSpec([
      {
        task_id: "review",
        prompt_template: "Review the change.",
        route: { values: ["go", "stop"], cases: { go: ["land"] }, default: [] },
      },
      { task_id: "land", prompt_template: "Land it.", depends_on: ["review"] },
    ]),
  });
  const env = { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_ROUTE_VALUE: "stop" };
  const completed = await withEnvAsync(env, () => runWorkflow({ runDir: planned.run_dir, approve: true }));
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");

  // Success outcomes are terminal even with resumeFailed: nothing requeues.
  for (const options of [{}, { resumeFailed: true }]) {
    const resumed = await withEnvAsync(env, () =>
      resumeWorkflow({ runDir: planned.run_dir, ...options }),
    );
    assert.equal(resumed.status, "completed");
    const state = readRunState(planned.run_dir);
    assert.equal(state.tasks.land.status, "skipped_by_route");
    assert.equal(state.tasks.land.attempts.length, 0);
    assert.equal(state.tasks.review.attempts.length, 1);
  }
  assert.ok(readEvents(planned.run_dir).some((event) => event.type === "resume_noop"));
});
