import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  planWorkflow,
  readRunState,
  runWorkflow,
  statusWorkflow,
  validateRunDirectory,
} from "../scripts/lib/core.js";
import {
  synthesizeWorkerSchema,
  validateOutputSchemaDecl,
  validateValueAgainstSchema,
  WORKER_OUTPUT_SCHEMA,
} from "../scripts/lib/output-schema.js";
import { validateWorkerResult } from "../scripts/lib/run-state.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodexBin = path.join(pluginRoot, "tests", "fixtures", "fake-codex.js");
const fakeClaudeBin = path.join(pluginRoot, "tests", "fixtures", "fake-claude.js");

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-typed-test-"));
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

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function singleTaskSpec(taskOverrides = {}, specOverrides = {}) {
  return {
    name: "typed output workflow",
    objective: "Exercise typed worker output",
    phases: [{ phase_id: "p1", tasks: ["t1"] }],
    tasks: [
      {
        task_id: "t1",
        phase_id: "p1",
        kind: "codex_agent",
        role: "tester",
        prompt_template: "Run task one.",
        ...taskOverrides,
      },
    ],
    max_concurrency: 1,
    ...specOverrides,
  };
}

const verdictSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    score: { type: "number" },
  },
};

function flagValueIn(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// --- Subset validation and normalization -------------------------------------

test("validateOutputSchemaDecl normalizes a valid schema and re-validates as a fixpoint", () => {
  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      score: { type: "number" },
      notes: { type: ["string", "null"] },
      files: {
        type: "array",
        items: { type: "object", properties: { file_path: { type: "string", description: "repo path" } } },
      },
    },
  };

  const { errors, normalized } = validateOutputSchemaDecl(schema);
  assert.deepEqual(errors, []);
  assert.deepEqual(normalized.required, ["verdict", "score", "notes", "files"]);
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.properties.files.items.required, ["file_path"]);
  assert.equal(normalized.properties.files.items.additionalProperties, false);
  assert.equal(normalized.properties.files.items.properties.file_path.description, "repo path");

  const second = validateOutputSchemaDecl(normalized);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.normalized, normalized);
});

test("output_schema root must be a type object schema", () => {
  for (const schema of [
    { type: "array", items: { type: "string" } },
    { type: "string" },
    "not an object",
    null,
    [],
  ]) {
    const { errors, normalized } = validateOutputSchemaDecl(schema);
    assert.ok(errors.length > 0, JSON.stringify(schema));
    assert.equal(normalized, null);
  }
});

test("nesting depth 4 is accepted and depth 5 is rejected", () => {
  const depth4 = {
    type: "object",
    properties: {
      a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string" } } } } },
    },
  };
  assert.deepEqual(validateOutputSchemaDecl(depth4).errors, []);

  const depth5 = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: { c: { type: "object", properties: { d: { type: "string" } } } },
          },
        },
      },
    },
  };
  const { errors } = validateOutputSchemaDecl(depth5);
  assert.ok(errors.some((message) => message.includes("nesting depth")));
});

test("forbidden and unsupported keywords are rejected at plan time", () => {
  const cases = [
    [{ minLength: 1 }, /forbidden keyword "minLength"/],
    [{ pattern: "^a" }, /forbidden keyword "pattern"/],
    [{ format: "uri" }, /forbidden keyword "format"/],
    [{ const: "x" }, /forbidden keyword "const"/],
    [{ default: "x" }, /forbidden keyword "default"/],
    [{ examples: ["x"] }, /unsupported keyword "examples"/],
  ];
  for (const [extra, expected] of cases) {
    const { errors } = validateOutputSchemaDecl({
      type: "object",
      properties: { field: { type: "string", ...extra } },
    });
    assert.ok(errors.some((message) => expected.test(message)), JSON.stringify(extra));
  }
  const root = validateOutputSchemaDecl({
    type: "object",
    properties: { field: { type: "string" } },
    oneOf: [],
  });
  assert.ok(root.errors.some((message) => /forbidden keyword "oneOf"/.test(message)));
});

test("user-written required and additionalProperties are rejected", () => {
  const partialRequired = validateOutputSchemaDecl({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"],
  });
  assert.ok(partialRequired.errors.some((message) => message.includes('must not declare "required"')));

  const additional = validateOutputSchemaDecl({
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: true,
  });
  assert.ok(additional.errors.some((message) => message.includes('must not declare "additionalProperties"')));
});

test("nullable union limits and forms are enforced", () => {
  const buildUnionSchema = (count) => {
    const properties = {};
    for (let index = 0; index < count; index += 1) {
      properties[`p${index}`] = { type: ["string", "null"] };
    }
    return { type: "object", properties };
  };
  assert.deepEqual(validateOutputSchemaDecl(buildUnionSchema(8)).errors, []);
  const nine = validateOutputSchemaDecl(buildUnionSchema(9));
  assert.ok(nine.errors.some((message) => message.includes("nullable unions")));

  for (const badUnion of [["object", "null"], ["string", "number"], ["null", "string"], ["string"]]) {
    const { errors } = validateOutputSchemaDecl({
      type: "object",
      properties: { field: { type: badUnion } },
    });
    assert.ok(errors.some((message) => message.includes("type union")), JSON.stringify(badUnion));
  }
});

test("serialized size, property count, name, and enum limits are enforced", () => {
  const oversized = validateOutputSchemaDecl({
    type: "object",
    properties: { a: { type: "string", description: "x".repeat(33000) } },
  });
  assert.ok(oversized.errors.some((message) => message.includes("bytes")));

  const manyProperties = {};
  for (let index = 0; index < 65; index += 1) {
    manyProperties[`p${index}`] = { type: "string" };
  }
  const tooMany = validateOutputSchemaDecl({ type: "object", properties: manyProperties });
  assert.ok(tooMany.errors.some((message) => message.includes("properties; limit is 64")));

  const badName = validateOutputSchemaDecl({
    type: "object",
    properties: { "bad-name": { type: "string" } },
  });
  assert.ok(badName.errors.some((message) => message.includes('property name "bad-name"')));

  const tooManyEnum = validateOutputSchemaDecl({
    type: "object",
    properties: { e: { type: "string", enum: Array.from({ length: 21 }, (_, index) => `v${index}`) } },
  });
  assert.ok(tooManyEnum.errors.some((message) => message.includes("enum has 21 values")));

  const longEnum = validateOutputSchemaDecl({
    type: "object",
    properties: { e: { type: "string", enum: ["x".repeat(65)] } },
  });
  assert.ok(longEnum.errors.some((message) => message.includes("64 characters")));

  const numericEnum = validateOutputSchemaDecl({
    type: "object",
    properties: { e: { type: "number", enum: [1, 2] } },
  });
  assert.ok(numericEnum.errors.some((message) => message.includes('enum is only supported on type "string"')));
});

// --- Envelope synthesis -------------------------------------------------------

test("synthesizeWorkerSchema returns the default form without output_schema", () => {
  assert.deepEqual(synthesizeWorkerSchema({ task_id: "t1" }), WORKER_OUTPUT_SCHEMA);
});

test("synthesizeWorkerSchema returns the slim typed form with output_schema", () => {
  const { normalized } = validateOutputSchemaDecl(verdictSchema);
  const schema = synthesizeWorkerSchema({ task_id: "t1", output_schema: normalized });

  assert.deepEqual(Object.keys(schema.properties), ["status", "summary", "errors", "output"]);
  assert.deepEqual(schema.required, ["status", "summary", "errors", "output"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.status.enum, ["succeeded", "failed"]);
  assert.deepEqual(schema.properties.output, normalized);
  assert.equal(schema.properties.findings, undefined);
});

test("synthesizeWorkerSchema supports extraProperties and identity injection", () => {
  const { normalized } = validateOutputSchemaDecl(verdictSchema);
  const routed = synthesizeWorkerSchema(
    { task_id: "t1", output_schema: normalized },
    { extraProperties: { route: { type: "string", enum: ["approve", "fix"] } } },
  );
  assert.deepEqual(Object.keys(routed.properties), ["status", "summary", "errors", "route", "output"]);
  assert.ok(routed.required.includes("route"));

  const envelope = synthesizeWorkerSchema(
    { task_id: "t1", output_schema: normalized },
    { includeIdentity: true },
  );
  assert.deepEqual(envelope.required, ["task_id", "attempt_id", "status", "summary", "errors", "output"]);
});

// --- Value interpreter --------------------------------------------------------

test("validateValueAgainstSchema enforces the subset semantics", () => {
  const { normalized } = validateOutputSchemaDecl({
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      score: { type: "number" },
      count: { type: "integer" },
      notes: { type: ["string", "null"] },
      done: { type: "boolean" },
      files: { type: "array", items: { type: "object", properties: { file_path: { type: "string" } } } },
    },
  });

  const good = {
    verdict: "pass",
    score: 0.5,
    count: 3,
    notes: null,
    done: true,
    files: [{ file_path: "a.js" }],
  };
  assert.deepEqual(validateValueAgainstSchema(good, normalized), { valid: true, errors: [] });

  const cases = [
    [{ ...good, verdict: "maybe" }, /verdict must be one of/],
    [{ ...good, score: "high" }, /score must be a finite number/],
    [{ ...good, count: 1.5 }, /count must be an integer/],
    [{ ...good, notes: 5 }, /notes must be a string/],
    [{ ...good, done: "yes" }, /done must be a boolean/],
    [{ ...good, files: [{ file_path: 1 }] }, /files\[0\]\.file_path must be a string/],
    [{ ...good, extra: 1 }, /extra is not declared in the schema/],
    [(({ verdict, ...rest }) => rest)(good), /verdict is required/],
    ["not an object", /must be an object/],
  ];
  for (const [value, expected] of cases) {
    const { valid, errors } = validateValueAgainstSchema(value, normalized);
    assert.equal(valid, false, JSON.stringify(value));
    assert.ok(errors.some((message) => expected.test(message)), `${expected} in ${errors.join(" | ")}`);
  }
});

test("validateWorkerResult is task-aware for typed and default forms", () => {
  const { normalized } = validateOutputSchemaDecl(verdictSchema);
  const typedTask = { task_id: "t1", kind: "codex_agent", output_schema: normalized };
  const typedResult = {
    task_id: "t1",
    attempt_id: "a1",
    status: "succeeded",
    summary: "ok",
    errors: [],
    output: { verdict: "pass", score: 1 },
  };
  assert.deepEqual(validateWorkerResult(typedResult, typedTask), []);

  const withDefaultFields = { ...typedResult, findings: [] };
  assert.ok(validateWorkerResult(withDefaultFields, typedTask).length > 0);
  const badOutput = { ...typedResult, output: { verdict: "maybe", score: 1 } };
  assert.ok(validateWorkerResult(badOutput, typedTask).some((message) => message.includes("verdict")));
  const missingOutput = (({ output, ...rest }) => rest)(typedResult);
  assert.ok(validateWorkerResult(missingOutput, typedTask).some((message) => message.includes("output")));

  const defaultResult = {
    task_id: "t1",
    attempt_id: "a1",
    status: "succeeded",
    summary: "ok",
    findings: [],
    errors: [],
    evidence: [],
    modified_files: [],
    commands_run: [],
    artifacts: [],
  };
  assert.deepEqual(validateWorkerResult(defaultResult, { task_id: "t1", kind: "codex_agent" }), []);
  assert.deepEqual(validateWorkerResult(defaultResult), []);
});

// --- Plan-time integration ----------------------------------------------------

test("plan validates output_schema and stores the normalized form", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleTaskSpec({ output_schema: verdictSchema }) });

  const stored = readJsonFile(path.join(planned.run_dir, "workflow.yaml"));
  assert.equal(stored.schema_version, "dynamic-workflows.v2");
  assert.deepEqual(stored.tasks[0].output_schema.required, ["verdict", "score"]);
  assert.equal(stored.tasks[0].output_schema.additionalProperties, false);
  assert.equal(validateRunDirectory({ runDir: planned.run_dir }).valid, true);
});

test("plan rejects invalid output_schema declarations with task-scoped errors", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: singleTaskSpec({
      output_schema: {
        type: "object",
        properties: { verdict: { type: "string", minLength: 1 } },
      },
    }),
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((message) =>
      message.includes('task t1 output_schema.verdict uses forbidden keyword "minLength"'),
    ),
  );
});

test("plan rejects output_schema on local tasks", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: singleTaskSpec({ kind: "local_analysis", output_schema: verdictSchema }),
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((message) => message.includes("task t1 output_schema is not supported for local tasks")),
  );
});

// --- E2E through the fake executors -------------------------------------------

test("typed codex worker output is accepted and written per attempt schema", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleTaskSpec({ output_schema: verdictSchema }) });

  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TYPED_OUTPUT: '{"verdict":"pass","score":0.9}' },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");

  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.equal(result.task_id, "t1");
  assert.deepEqual(result.output, { verdict: "pass", score: 0.9 });
  assert.equal(result.findings, undefined);

  const state = readRunState(planned.run_dir);
  const attemptDir = path.join(planned.run_dir, state.attempts[state.tasks.t1.attempts[0]].artifact_dir);
  const writtenSchema = readJsonFile(path.join(attemptDir, "worker-output.schema.json"));
  const stored = readJsonFile(path.join(planned.run_dir, "workflow.yaml"));
  assert.deepEqual(writtenSchema, synthesizeWorkerSchema(stored.tasks[0]));
  assert.deepEqual(Object.keys(writtenSchema.properties), ["status", "summary", "errors", "output"]);
});

test("typed codex worker output violating the schema is quarantined", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleTaskSpec({ output_schema: verdictSchema }) });

  const result = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TYPED_OUTPUT: '{"verdict":"maybe","score":0.9}' },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "schema_violation");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "quarantined");
  const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
  const rejected = readJsonFile(path.join(attemptDir, "rejected-result.json"));
  assert.ok(rejected.validation_errors.some((message) => message.includes("verdict")));
  assert.ok(!fs.existsSync(path.join(planned.run_dir, "artifacts", "t1", "result.json")));
});

test("default-form output on a typed task is quarantined", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleTaskSpec({ output_schema: verdictSchema }) });

  const result = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "schema_violation");
});

test("typed claude worker passes the synthesized schema inline and is accepted", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "claude-typed-trace.jsonl");
  const planned = planWorkflow({
    workspace,
    spec: singleTaskSpec({ kind: "claude_agent", output_schema: verdictSchema }),
  });

  const completed = await withEnvAsync(
    {
      CCDW_CLAUDE_BIN: fakeClaudeBin,
      CCDW_FAKE_TYPED_OUTPUT: '{"verdict":"fail","score":0.1}',
      CCDW_FAKE_TRACE_PATH: tracePath,
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.deepEqual(result.output, { verdict: "fail", score: 0.1 });

  const trace = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
  const inlineSchema = JSON.parse(flagValueIn(trace.argv, "--json-schema"));
  const stored = readJsonFile(path.join(planned.run_dir, "workflow.yaml"));
  assert.deepEqual(inlineSchema, synthesizeWorkerSchema(stored.tasks[0]));
});

// --- Result identity injection --------------------------------------------------

test("worker-emitted task_id/attempt_id never override the runner identity (codex)", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleTaskSpec() });

  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_SPOOF_IDS: "1" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  const state = readRunState(planned.run_dir);
  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  // The fake worker emitted task_id "spoofed-task" / attempt_id
  // "spoofed-attempt"; the persisted result must carry the runner ids.
  assert.equal(result.task_id, "t1");
  assert.equal(result.attempt_id, state.tasks.t1.attempts[0]);
});

test("worker-emitted task_id/attempt_id never override the runner identity (claude)", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleTaskSpec({ kind: "claude_agent" }) });

  const completed = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_SPOOF_IDS: "1" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  const state = readRunState(planned.run_dir);
  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.equal(result.task_id, "t1");
  assert.equal(result.attempt_id, state.tasks.t1.attempts[0]);
});

// --- Compatibility removal ----------------------------------------------------

test("old schema_version run dirs fail with an explicit re-plan error", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleTaskSpec() });

  const specPath = path.join(planned.run_dir, "workflow.yaml");
  const spec = readJsonFile(specPath);
  spec.schema_version = "dynamic-workflows.v1";
  writeJsonFile(specPath, spec);
  const statePath = path.join(planned.run_dir, "run.json");
  const state = readJsonFile(statePath);
  state.schema_version = "dynamic-workflows.v1";
  // A genuine v1 run dir has a hash that matches its own spec bytes: the
  // version check, not the tamper check, must produce the error.
  state.spec_hash = crypto.createHash("sha256").update(fs.readFileSync(specPath)).digest("hex");
  writeJsonFile(statePath, state);

  await assert.rejects(
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
    (error) => {
      assert.match(error.message, /unsupported schema_version; re-plan required/);
      assert.equal(error.details.found, "dynamic-workflows.v1");
      assert.equal(error.details.expected, "dynamic-workflows.v2");
      return true;
    },
  );

  assert.throws(
    () => statusWorkflow({ runDir: planned.run_dir }),
    (error) =>
      error.details.errors.some((message) => /unsupported schema_version: dynamic-workflows\.v1/.test(message)),
  );

  const validation = validateRunDirectory({ runDir: planned.run_dir });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("re-plan required")));
});
