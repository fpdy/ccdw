import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planWorkflow, resolveExecutorKind } from "../scripts/lib/core.js";

const ACP_MODEL = "openrouter/anthropic/claude-haiku-4.5";

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-acp-spec-test-"));
}

function acpSpec({ tasks, phases, ...overrides }) {
  return {
    name: "acp spec workflow",
    objective: "Exercise acp plan-time validation",
    phases,
    tasks,
    max_concurrency: 1,
    ...overrides,
  };
}

function singleAcpTaskSpec(taskOverrides = {}, specOverrides = {}) {
  return acpSpec({
    phases: [{ phase_id: "p1", tasks: ["t1"] }],
    tasks: [
      {
        task_id: "t1",
        phase_id: "p1",
        kind: "acp_opencode",
        role: "tester",
        prompt_template: "Run task one.",
        model: ACP_MODEL,
        ...taskOverrides,
      },
    ],
    ...specOverrides,
  });
}

function planSpec(spec) {
  return planWorkflow({ workspace: makeTempWorkspace(), dryRun: true, spec });
}

function assertHasError(result, fragment) {
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((message) => message.includes(fragment)),
    `expected an error containing ${JSON.stringify(fragment)}; got:\n${result.errors.join("\n")}`,
  );
}

// --- Kind vocabulary --------------------------------------------------------

test("resolveExecutorKind maps acp kinds to acp and unknown kinds to local", () => {
  assert.equal(resolveExecutorKind("acp_opencode"), "acp");
  assert.equal(resolveExecutorKind("acp"), "acp");
  assert.equal(resolveExecutorKind("codex_agent"), "codex");
  assert.equal(resolveExecutorKind("claude_agent"), "claude");
  assert.equal(resolveExecutorKind("mystery_kind"), "local");
});

test("plan rejects acp kinds other than acp_opencode", () => {
  const result = planSpec(singleAcpTaskSpec({ kind: "acp_other" }));
  assertHasError(result, "Unsupported acp kind: acp_other. Supported: acp_opencode");
});

// --- Valid acp specs --------------------------------------------------------

test("plan accepts an acp_opencode task with a model and no forbidden fields", () => {
  const result = planSpec(singleAcpTaskSpec());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("plan accepts acp tasks with gates and as foreach expansion parents", () => {
  const result = planSpec(
    acpSpec({
      phases: [{ phase_id: "p1", tasks: ["gen", "fan"] }],
      tasks: [
        {
          task_id: "gen",
          phase_id: "p1",
          kind: "codex_agent",
          role: "tester",
          prompt_template: "Produce items.",
          output_schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "object", properties: { name: { type: "string" } } },
              },
            },
          },
        },
        {
          task_id: "fan",
          phase_id: "p1",
          kind: "acp_opencode",
          role: "tester",
          prompt_template: "Process {{item.name}}.",
          model: ACP_MODEL,
          depends_on: ["gen"],
          foreach: { items: "{{tasks.gen.result.output.items}}", max_items: 2 },
          gates: [{ command: ["true"], timeout_ms: 1000 }],
          timeout_ms: 60000,
          retry_policy: { retryable: true, max_attempts: 2 },
        },
      ],
    }),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

// --- Required model ----------------------------------------------------------

test("plan rejects acp tasks without a model", () => {
  const result = planSpec(singleAcpTaskSpec({ model: undefined }));
  assertHasError(
    result,
    'task t1 acp tasks require model (ACP model id, e.g. "openrouter/anthropic/claude-haiku-4.5")',
  );
});

test("acp model values are checked against the shared model pattern", () => {
  const result = planSpec(singleAcpTaskSpec({ model: "-bad" }));
  assertHasError(result, "task t1 model must match");
  // The ACP namespace form passes the same pattern (covered by the valid test
  // above, restated here against a second namespace-style id).
  const ok = planSpec(singleAcpTaskSpec({ model: "openrouter/openai/gpt-5.1" }));
  assert.deepEqual(ok.errors, []);
});

// --- Forbidden fields ---------------------------------------------------------

test("plan rejects output_schema on acp tasks", () => {
  const result = planSpec(
    singleAcpTaskSpec({
      output_schema: { type: "object", properties: { answer: { type: "string" } } },
    }),
  );
  assertHasError(result, "task t1 output_schema is not supported for acp tasks");
});

test("plan rejects route on acp tasks", () => {
  const result = planSpec(
    acpSpec({
      phases: [{ phase_id: "p1", tasks: ["t1", "t2"] }],
      tasks: [
        {
          task_id: "t1",
          phase_id: "p1",
          kind: "acp_opencode",
          role: "tester",
          prompt_template: "Decide.",
          model: ACP_MODEL,
          route: { values: ["a", "b"], cases: { a: ["t2"] }, default: [] },
        },
        {
          task_id: "t2",
          phase_id: "p1",
          kind: "codex_agent",
          role: "tester",
          prompt_template: "Branch.",
          depends_on: ["t1"],
        },
      ],
    }),
  );
  assertHasError(result, "task t1 route is not supported for acp tasks");
});

test("plan rejects network: true when the spec contains acp tasks", () => {
  const result = planSpec(
    singleAcpTaskSpec({}, { workspace_policy: { write_scope: ["workspace"], network: true } }),
  );
  assertHasError(
    result,
    "workspace_policy.network: true is not supported for acp tasks (no enforceable network sandbox)",
  );
});

test("plan rejects effort and profile on acp tasks", () => {
  const effortResult = planSpec(singleAcpTaskSpec({ effort: "low" }));
  assertHasError(effortResult, "task t1 effort is not supported for acp tasks");

  const profileResult = planSpec(singleAcpTaskSpec({ profile: "locked" }));
  assertHasError(profileResult, "task t1 profile is not supported for acp tasks");
});

// --- Foreach producer restriction ----------------------------------------------

test("plan rejects foreach expansions whose items producer is an acp task", () => {
  // result.findings is array-typed in the default worker envelope, so without
  // the explicit acp producer check this spec would validate.
  const result = planSpec(
    acpSpec({
      phases: [{ phase_id: "p1", tasks: ["t1", "t2"] }],
      tasks: [
        {
          task_id: "t1",
          phase_id: "p1",
          kind: "acp_opencode",
          role: "tester",
          prompt_template: "Produce findings.",
          model: ACP_MODEL,
        },
        {
          task_id: "t2",
          phase_id: "p1",
          kind: "codex_agent",
          role: "tester",
          prompt_template: "Process one finding.",
          depends_on: ["t1"],
          foreach: { items: "{{tasks.t1.result.findings}}", max_items: 2 },
        },
      ],
    }),
  );
  assertHasError(
    result,
    "task t1 is an acp task; acp tasks have no typed output and cannot be a foreach items producer",
  );
});

// --- Non-acp regression guard ---------------------------------------------------

test("codex and claude specs are unaffected by the acp rules", () => {
  const result = planSpec(
    acpSpec({
      phases: [{ phase_id: "p1", tasks: ["cx", "cl"] }],
      tasks: [
        { task_id: "cx", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "codex task" },
        { task_id: "cl", phase_id: "p1", kind: "claude_agent", role: "w", prompt_template: "claude task" },
      ],
    }),
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});
