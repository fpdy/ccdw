import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveWorkflow,
  cancelWorkflow,
  detachWorkflowRun,
  listWorkflowRuns,
  planWorkflow,
  readRunState,
  readWorkflowEvents,
  resumeWorkflow,
  runWorkflow,
  statusWorkflow,
  validatePluginLayout,
  validateRunDirectory,
} from "../scripts/lib/core.js";
import { ACP_CLIENT_VERSION } from "../scripts/lib/acp-executor.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodexBin = path.join(pluginRoot, "tests", "fixtures", "fake-codex.js");

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-test-"));
}

function withEnv(name, value, callback) {
  const original = process.env[name];
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    if (original == null) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
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

function codexSpec({ tasks, phases, ...overrides }) {
  return {
    name: "test workflow",
    objective: "Exercise the codex executor with a fake binary",
    phases,
    tasks,
    max_concurrency: 1,
    ...overrides,
  };
}

function singleCodexTaskSpec(taskOverrides = {}, specOverrides = {}) {
  return codexSpec({
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
    ...specOverrides,
  });
}

async function pollUntil(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashFileForTest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function mutateWorkflowFile(runDir, mutator) {
  const specPath = path.join(runDir, "workflow.yaml");
  const spec = readJsonFile(specPath);
  mutator(spec);
  writeJsonFile(specPath, spec);
  return spec;
}

function refreshStoredSpecHash(runDir) {
  const statePath = path.join(runDir, "run.json");
  const state = readJsonFile(statePath);
  state.spec_hash = hashFileForTest(path.join(runDir, "workflow.yaml"));
  writeJsonFile(statePath, state);
}

function workflowEventTypes(runDir) {
  return readWorkflowEvents({ runDir }).events.map((event) => event.type);
}

test("planWorkflow creates an approval-gated run directory", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    objective: "Review the local workflow contract",
    workspace,
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.required, true);
  assert.ok(result.spec_hash);
  assert.ok(Array.isArray(result.approval.summary.phases));
  assert.ok(Array.isArray(result.approval.summary.tasks));
  assert.equal(result.approval.summary.max_concurrency, 1);
  assert.ok(fs.existsSync(result.paths.workflow_spec));
  assert.ok(fs.existsSync(result.paths.run_state));
  assert.ok(fs.existsSync(result.paths.event_log));
  assert.ok(fs.existsSync(result.paths.artifacts));
  assert.equal(validateRunDirectory({ runDir: result.run_dir }).valid, true);
});

test("planWorkflow stores runs under workspace .ccdw by default", () => {
  const workspace = makeTempWorkspace();
  const result = withEnv("CCDW_HOME", null, () =>
    planWorkflow({
      objective: "Use the default ccdw home",
      workspace,
      runId: "default-run",
    }),
  );

  assert.equal(result.run_dir, path.join(workspace, ".ccdw", "dynamic-workflows", "runs", "default-run"));
});

test("planWorkflow honors CCDW_HOME when no run root is provided", () => {
  const workspace = makeTempWorkspace();
  const ccdwHome = path.join(makeTempWorkspace(), "state");
  const result = withEnv("CCDW_HOME", ccdwHome, () =>
    planWorkflow({
      objective: "Use an environment configured ccdw home",
      workspace,
      runId: "env-run",
    }),
  );

  assert.equal(result.run_dir, path.join(ccdwHome, "dynamic-workflows", "runs", "env-run"));
});

test("planWorkflow resolves relative CCDW_HOME from the workspace root", () => {
  const workspace = makeTempWorkspace();
  const result = withEnv("CCDW_HOME", "custom-ccdw", () =>
    planWorkflow({
      objective: "Use a relative environment configured ccdw home",
      workspace,
      runId: "relative-env-run",
    }),
  );

  assert.equal(result.run_dir, path.join(workspace, "custom-ccdw", "dynamic-workflows", "runs", "relative-env-run"));
});

test("planWorkflow prefers explicit runRoot over CCDW_HOME", () => {
  const workspace = makeTempWorkspace();
  const ccdwHome = path.join(workspace, "ignored-home");
  const result = withEnv("CCDW_HOME", ccdwHome, () =>
    planWorkflow({
      objective: "Use the explicit run root",
      workspace,
      runRoot: "explicit-runs",
      runId: "explicit-run",
    }),
  );

  assert.equal(result.run_dir, path.join(workspace, "explicit-runs", "explicit-run"));
});

test("planWorkflow rejects runId path traversal", () => {
  const workspace = makeTempWorkspace();
  assert.throws(
    () =>
      planWorkflow({
        objective: "Escape the run root",
        workspace,
        runId: "../evil",
      }),
    /runId/,
  );
});

test("planWorkflow rejects unsafe phase and task ids before artifact paths can escape", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: codexSpec({
      objective: "Reject unsafe ids",
      phases: [{ phase_id: "../phase", tasks: ["../../../escape-task"] }],
      tasks: [
        {
          task_id: "../../../escape-task",
          phase_id: "../phase",
          kind: "local_analysis",
          role: "w",
          prompt_template: "x",
        },
      ],
    }),
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes("phase.phase_id")));
  assert.ok(result.errors.some((message) => message.includes("task.task_id")));
  assert.ok(!fs.existsSync(path.join(workspace, ".ccdw")));
});

test("planWorkflow rejects invalid retry policies", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: singleCodexTaskSpec({
      retry_policy: { retryable: true, max_attempts: 2, backoff_ms: "bad" },
    }),
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes("retry_policy.backoff_ms")));
});

test("planWorkflow rejects unsupported workspace permissions instead of showing them as approved", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: singleCodexTaskSpec(
      {},
      {
        workspace_policy: {
          shell: true,
          mcp_write: true,
        },
      },
    ),
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes("workspace_policy.shell")));
  assert.ok(result.errors.some((message) => message.includes("workspace_policy.mcp_write")));
});

test("planWorkflow rejects workflow specs with dependency cycles", () => {
  const workspace = makeTempWorkspace();
  assert.throws(
    () =>
      planWorkflow({
        workspace,
        spec: codexSpec({
          phases: [
            { phase_id: "a", depends_on: ["b"], tasks: ["ta"] },
            { phase_id: "b", depends_on: ["a"], tasks: ["tb"] },
          ],
          tasks: [
            { task_id: "ta", phase_id: "a", kind: "local_analysis", role: "w", prompt_template: "x" },
            { task_id: "tb", phase_id: "b", kind: "local_analysis", role: "w", prompt_template: "y" },
          ],
        }),
      }),
    (error) => error.details.errors.some((message) => message.includes("cycle")),
  );
});

test("planWorkflow dryRun validates a spec without creating a run", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: singleCodexTaskSpec(),
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.ok(!fs.existsSync(path.join(workspace, ".ccdw")));
});

test("planWorkflow force replaces stale run state and artifacts", () => {
  const workspace = makeTempWorkspace();
  const first = planWorkflow({
    objective: "First plan",
    workspace,
    runId: "force-run",
  });
  const staleArtifact = path.join(first.run_dir, "artifacts", "stale.txt");
  fs.writeFileSync(staleArtifact, "stale\n");

  const second = planWorkflow({
    objective: "Second plan",
    workspace,
    runId: "force-run",
    force: true,
  });

  assert.equal(second.run_dir, first.run_dir);
  assert.equal(second.objective, "Second plan");
  assert.equal(second.event_count, 1);
  assert.equal(fs.readFileSync(second.paths.event_log, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(staleArtifact), false);
});

test("approval summary reports only enforced execution sandbox permissions", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Inspect approval summary",
    workspace,
  });

  assert.equal(planned.approval.summary.shell, undefined);
  assert.equal(planned.approval.summary.mcp_write, undefined);
  assert.deepEqual(planned.approval.summary.execution_sandbox, {
    mode: "read-only",
    write_scope: ["run_dir"],
    network_access: false,
    unsupported_permissions_rejected: ["shell", "mcp_write"],
  });
});

test("runWorkflow enforces approval and completes all local tasks", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Execute a deterministic workflow",
    workspace,
  });

  await assert.rejects(() => runWorkflow({ runDir: planned.run_dir }), /awaiting approval/);

  const completed = await runWorkflow({
    runDir: planned.run_dir,
    approve: true,
    approvedBy: "test",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");
  assert.equal(completed.tasks["explore-objective"].status, "succeeded");
  assert.equal(completed.tasks["verify-findings"].status, "succeeded");
  assert.equal(completed.tasks["synthesize-result"].status, "succeeded");
  assert.ok(completed.artifacts.includes("artifacts/synthesis.md"));
  assert.ok(completed.event_count >= 10);
  assert.equal(completed.runner.active, false);
});

test("runWorkflow rejects invalid maxTasks without approving the run", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Reject invalid maxTasks",
    workspace,
  });

  await assert.rejects(
    () => runWorkflow({ runDir: planned.run_dir, approve: true, maxTasks: "bad" }),
    /maxTasks/,
  );
  assert.equal(statusWorkflow({ runDir: planned.run_dir }).status, "awaiting_approval");
});

test("ready-queue scheduler completes phases declared out of dependency order", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: codexSpec({
      objective: "Out-of-order phase declarations must still execute",
      phases: [
        { phase_id: "second", depends_on: ["first"], tasks: ["t2"] },
        { phase_id: "first", tasks: ["t1"] },
      ],
      tasks: [
        { task_id: "t2", phase_id: "second", kind: "local_analysis", role: "w", prompt_template: "later" },
        { task_id: "t1", phase_id: "first", kind: "local_analysis", role: "w", prompt_template: "earlier" },
      ],
    }),
  });
  const completed = await runWorkflow({ runDir: planned.run_dir, approve: true });

  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.status, "success");
  assert.equal(completed.tasks.t1.status, "succeeded");
  assert.equal(completed.tasks.t2.status, "succeeded");
  assert.equal(completed.phases.first.status, "succeeded");
  assert.equal(completed.phases.second.status, "succeeded");
});

test("codex executor runs a worker through the fake codex binary", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleCodexTaskSpec() });

  const completed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  assert.equal(completed.budget_usage.tokens, 150);

  const resultPath = path.join(planned.run_dir, "artifacts", "t1", "result.json");
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(result.task_id, "t1");
  assert.equal(result.status, "succeeded");

  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.match(state.attempts[attemptId].thread_id, /^fake-thread-/);
  const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
  const writtenSchema = readJsonFile(path.join(attemptDir, "worker-output.schema.json"));
  assert.deepEqual(writtenSchema, WORKER_OUTPUT_SCHEMA);
});

test("scheduler runs codex tasks concurrently up to max_concurrency", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: codexSpec({
      phases: [{ phase_id: "p1", tasks: ["a", "b"] }],
      tasks: [
        { task_id: "a", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "task a" },
        { task_id: "b", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "task b" },
      ],
      max_concurrency: 2,
    }),
  });

  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_SLEEP_MS: "600" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(completed.status, "completed");

  const state = readRunState(planned.run_dir);
  const traces = ["a", "b"].map((taskId) => {
    const attemptId = state.tasks[taskId].attempts[0];
    const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
    return JSON.parse(fs.readFileSync(path.join(attemptDir, "trace.json"), "utf8"));
  });
  const overlapStart = Math.max(traces[0].start, traces[1].start);
  const overlapEnd = Math.min(traces[0].end, traces[1].end);
  assert.ok(overlapStart < overlapEnd, "expected concurrent execution windows to overlap");
});

test("worker timeout kills the codex worker and fails the run fail-closed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: singleCodexTaskSpec({ timeout_ms: 300 }),
  });

  const result = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_SLEEP_MS: "30000" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "timed_out");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "timed_out");
});

test("invalid worker output is quarantined as a schema violation", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleCodexTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_INVALID_JSON: "1" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "schema_violation");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "quarantined");
  const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
  assert.ok(fs.existsSync(path.join(attemptDir, "rejected-result.json")));
});

test("retry policy relaunches a failed codex worker", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "fail-once.marker");
  const planned = planWorkflow({
    workspace,
    spec: singleCodexTaskSpec({
      retry_policy: { retryable: true, max_attempts: 2, backoff_ms: 10 },
    }),
  });

  const result = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_FAIL_MARKER: marker },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tasks.t1.status, "succeeded");
  assert.equal(result.tasks.t1.attempts.length, 2);
});

test("resume --resume-failed retries failed tasks and completes", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "fail-once.marker");
  const planned = planWorkflow({ workspace, spec: singleCodexTaskSpec() });

  await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_FAIL_MARKER: marker }, async () => {
    const failed = await runWorkflow({ runDir: planned.run_dir, approve: true });
    assert.equal(failed.status, "failed");
    assert.equal(failed.tasks.t1.status, "failed");

    const resumed = await resumeWorkflow({ runDir: planned.run_dir, resumeFailed: true });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.tasks.t1.status, "succeeded");
  });
});

function skipChainSpec() {
  // t2 is skipped when its blocker t1 fails; t3 sits in a fail phase so the
  // whole run fails while a skipped task exists.
  return codexSpec({
    phases: [
      { phase_id: "p1", tasks: ["t1", "t2"], on_failure: "continue" },
      { phase_id: "p2", tasks: ["t3"], on_failure: "fail" },
    ],
    tasks: [
      { task_id: "t1", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "one" },
      { task_id: "t2", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "two", depends_on: ["t1"] },
      { task_id: "t3", phase_id: "p2", kind: "codex_agent", role: "w", prompt_template: "three" },
    ],
    max_concurrency: 1,
  });
}

test("resume --resume-failed requeues skipped tasks once their blocker recovers", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: skipChainSpec() });

  const failed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_RESULT_STATUS: "failed" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.tasks.t1.status, "failed");
  assert.equal(failed.tasks.t2.status, "skipped");
  assert.equal(failed.tasks.t3.status, "failed");

  const resumed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    resumeWorkflow({ runDir: planned.run_dir, resumeFailed: true }),
  );
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.outcome.status, "success");
  assert.equal(resumed.tasks.t1.status, "succeeded");
  assert.equal(resumed.tasks.t2.status, "succeeded");
  assert.equal(resumed.tasks.t3.status, "succeeded");
});

test("resume --resume-failed re-skips tasks whose blocker fails again", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: skipChainSpec() });

  await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_RESULT_STATUS: "failed" }, async () => {
    const failed = await runWorkflow({ runDir: planned.run_dir, approve: true });
    assert.equal(failed.status, "failed");
    assert.equal(failed.tasks.t2.status, "skipped");

    const resumed = await resumeWorkflow({ runDir: planned.run_dir, resumeFailed: true });
    assert.equal(resumed.status, "failed");
    assert.equal(resumed.tasks.t1.status, "failed");
    assert.equal(resumed.tasks.t2.status, "skipped");
  });
});

test("resume --resume-failed recovers a completed run with a partial outcome", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "fail-once.marker");
  const planned = planWorkflow({
    workspace,
    spec: codexSpec({
      phases: [{ phase_id: "p1", tasks: ["t1", "t2"], on_failure: "continue" }],
      tasks: [
        { task_id: "t1", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "one" },
        { task_id: "t2", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "two", depends_on: ["t1"] },
      ],
      max_concurrency: 1,
    }),
  });

  await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_FAIL_MARKER: marker }, async () => {
    const partial = await runWorkflow({ runDir: planned.run_dir, approve: true });
    assert.equal(partial.status, "completed");
    assert.equal(partial.outcome.status, "partial");
    assert.equal(partial.tasks.t1.status, "failed");
    assert.equal(partial.tasks.t2.status, "skipped");

    const resumed = await resumeWorkflow({ runDir: planned.run_dir, resumeFailed: true });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.outcome.status, "success");
    assert.equal(resumed.tasks.t1.status, "succeeded");
    assert.equal(resumed.tasks.t2.status, "succeeded");
  });

  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const resumeEvent = events.find((event) => event.type === "resume_requested");
  assert.equal(resumeEvent.payload.from_status, "completed");
  assert.equal(resumeEvent.payload.resume_failed, true);
});

test("resume --resume-failed stays a noop for completed runs with a success outcome", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ objective: "Fully successful run", workspace });
  const completed = await runWorkflow({ runDir: planned.run_dir, approve: true });
  assert.equal(completed.outcome.status, "success");

  const resumed = await resumeWorkflow({ runDir: planned.run_dir, resumeFailed: true });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.outcome.status, "success");

  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  assert.ok(events.some((event) => event.type === "resume_noop"));
});

test("token budget is enforced fail-closed between launches", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: codexSpec({
      phases: [{ phase_id: "p1", tasks: ["t1", "t2"] }],
      tasks: [
        { task_id: "t1", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "first" },
        {
          task_id: "t2",
          phase_id: "p1",
          kind: "codex_agent",
          role: "w",
          prompt_template: "second",
          depends_on: ["t1"],
        },
      ],
      max_tokens: 100,
    }),
  });

  const result = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TOKENS: "5000" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.match(result.outcome.summary, /max_tokens/);
  assert.equal(result.tasks.t2.status, "queued");
});

test("cancelWorkflow signals a live orchestrator through the control channel", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleCodexTaskSpec() });

  await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_SLEEP_MS: "30000" }, async () => {
    const runPromise = runWorkflow({ runDir: planned.run_dir, approve: true });
    const started = await pollUntil(() => {
      try {
        return readRunState(planned.run_dir).status === "running";
      } catch {
        return false;
      }
    });
    assert.ok(started, "run never reached running status");

    const cancelResult = cancelWorkflow({ runDir: planned.run_dir, reason: "test cancellation" });
    assert.equal(cancelResult.cancel_requested, true);

    const final = await runPromise;
    assert.equal(final.status, "cancelled");
    assert.equal(final.outcome.status, "cancelled");
    assert.equal(final.outcome.summary, "test cancellation");
    assert.ok(!fs.existsSync(path.join(planned.run_dir, "control", "cancel.json")));
  });
});

test("detached runs execute in a background process", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Run detached through the CLI runner",
    workspace,
  });

  const detached = await detachWorkflowRun({ runDir: planned.run_dir, approve: true });
  assert.equal(detached.detached, true);
  assert.ok(detached.runner_pid);

  const finished = await pollUntil(() => {
    try {
      return readRunState(planned.run_dir).status === "completed";
    } catch {
      return false;
    }
  });
  assert.ok(finished, "detached run never completed");
  const status = statusWorkflow({ runDir: planned.run_dir });
  assert.equal(status.status, "completed");
  assert.equal(status.runner.active, false);
  assert.ok(fs.existsSync(path.join(planned.run_dir, "runner.log")));
});

test("resumeWorkflow leaves terminal runs terminal and records a noop event", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Resume a completed workflow",
    workspace,
  });
  const completed = await runWorkflow({ runDir: planned.run_dir, approve: true });
  const resumed = await resumeWorkflow({ runDir: completed.run_dir });

  assert.equal(resumed.status, "completed");
  assert.ok(resumed.event_count > completed.event_count);
});

test("cancelWorkflow cancels non-terminal runs", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    objective: "Cancel before execution",
    workspace,
  });
  const cancelled = cancelWorkflow({
    runDir: planned.run_dir,
    reason: "test cancellation",
  });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(statusWorkflow({ runDir: planned.run_dir }).status, "cancelled");
});

test("listWorkflowRuns discovers runs newest first", () => {
  const workspace = makeTempWorkspace();
  planWorkflow({ objective: "First run", workspace, runId: "run-one" });
  planWorkflow({ objective: "Second run", workspace, runId: "run-two" });

  const listing = listWorkflowRuns({ workspace });
  assert.equal(listing.runs.length, 2);
  assert.ok(listing.runs.every((run) => run.status === "awaiting_approval"));
  assert.ok(listing.runs.every((run) => run.task_counts.queued === 3));

  const filtered = listWorkflowRuns({ workspace, status: "completed" });
  assert.equal(filtered.runs.length, 0);
});

test("readWorkflowEvents returns incremental events with a byte cursor", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ objective: "Tail events", workspace });

  const first = readWorkflowEvents({ runDir: planned.run_dir });
  assert.ok(first.events.length >= 1);
  assert.equal(first.events[0].type, "workflow_planned");
  assert.ok(first.next_offset > 0);

  const second = readWorkflowEvents({ runDir: planned.run_dir, sinceOffset: first.next_offset });
  assert.equal(second.events.length, 0);
  assert.equal(second.next_offset, first.next_offset);
});

test("CLI plan and run commands work with JSON output", () => {
  const workspace = makeTempWorkspace();
  const cli = path.join(pluginRoot, "scripts", "dynamic-workflows.js");
  const planOutput = execFileSync(
    "node",
    [cli, "plan", "--objective", "Run through the CLI", "--workspace", workspace, "--json"],
    { encoding: "utf8" },
  );
  const planned = JSON.parse(planOutput);
  const runOutput = execFileSync(
    "node",
    [cli, "run", "--run-dir", planned.run_dir, "--approve", "--json"],
    { encoding: "utf8" },
  );
  const completed = JSON.parse(runOutput);

  assert.equal(completed.status, "completed");
});

test("CLI plan accepts a caller-authored spec file", () => {
  const workspace = makeTempWorkspace();
  const cli = path.join(pluginRoot, "scripts", "dynamic-workflows.js");
  const specPath = path.join(workspace, "spec.json");
  fs.writeFileSync(
    specPath,
    JSON.stringify(
      codexSpec({
        objective: "Caller-authored plan via spec file",
        phases: [{ phase_id: "only", tasks: ["solo"] }],
        tasks: [
          { task_id: "solo", phase_id: "only", kind: "local_analysis", role: "w", prompt_template: "inspect" },
        ],
      }),
    ),
  );

  const planned = JSON.parse(
    execFileSync(
      "node",
      [cli, "plan", "--spec-file", specPath, "--workspace", workspace, "--json"],
      { encoding: "utf8" },
    ),
  );
  assert.equal(planned.status, "awaiting_approval");
  assert.equal(planned.objective, "Caller-authored plan via spec file");

  const completed = JSON.parse(
    execFileSync("node", [cli, "run", "--run-dir", planned.run_dir, "--approve", "--json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.solo.status, "succeeded");
});

test("CLI keeps digit-only string arguments as strings", () => {
  const workspace = makeTempWorkspace();
  const cli = path.join(pluginRoot, "scripts", "dynamic-workflows.js");
  const planned = JSON.parse(
    execFileSync(
      "node",
      [cli, "plan", "--objective", "Numeric run id", "--workspace", workspace, "--run-id", "123", "--json"],
      { encoding: "utf8" },
    ),
  );

  assert.equal(planned.run_id, "123");
  assert.equal(path.basename(planned.run_dir), "123");
});

test("CLI rejects non-numeric values for numeric flags via core validation", () => {
  const workspace = makeTempWorkspace();
  const cli = path.join(pluginRoot, "scripts", "dynamic-workflows.js");
  const planned = planWorkflow({ objective: "Invalid maxTasks over the CLI", workspace });

  assert.throws(
    () =>
      execFileSync(
        "node",
        [cli, "run", "--run-dir", planned.run_dir, "--approve", "--max-tasks", "abc", "--json"],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ),
    (error) => /maxTasks/.test(error.stderr),
  );
  assert.equal(statusWorkflow({ runDir: planned.run_dir }).status, "awaiting_approval");
});

test("validatePluginLayout sees the expected plugin files", () => {
  const result = validatePluginLayout({ pluginRoot });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});

test("MCP server initializes, lists tools, and plans a workflow", async (t) => {
  const workspace = makeTempWorkspace();
  const server = spawn("node", [path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server);

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");

  const listed = await client.request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.ok(listed.result.tools.some((tool) => tool.name === "dynamic_workflows_plan"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "dynamic_workflows_list"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "dynamic_workflows_events"));

  const planned = await client.request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "dynamic_workflows_plan",
      arguments: {
        objective: "Plan through MCP",
        workspace,
      },
    },
  });
  const payload = JSON.parse(planned.result.content[0].text);
  assert.equal(payload.status, "awaiting_approval");
  assert.ok(fs.existsSync(payload.paths.run_state));
});

test("MCP tool errors are returned as isError results with the request id", async (t) => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ objective: "Approval gate over MCP", workspace });
  const server = spawn("node", [path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server);

  await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });

  const response = await client.request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "dynamic_workflows_run",
      arguments: { runDir: planned.run_dir },
    },
  });
  assert.equal(response.id, 2);
  assert.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.match(payload.error, /approval/i);
});

test("MCP config starts from the plugin root", async (t) => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const serverConfig = config.mcpServers["dynamic-workflows"];

  assert.equal(serverConfig.cwd, ".");

  const server = spawn(serverConfig.command, serverConfig.args, {
    cwd: path.resolve(pluginRoot, serverConfig.cwd),
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server);

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });

  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");
});

test("MCP server accepts LF-only stdio headers", { timeout: 3000 }, async (t) => {
  const server = spawn("node", [path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server, { requestDelimiter: "\n\n" });

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });

  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");
});

test("MCP server accepts Codex newline-delimited JSON framing", { timeout: 3000 }, async (t) => {
  const server = spawn("node", [path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  const client = createMcpClient(server, { framing: "jsonl" });

  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: {
        name: "codex-mcp-client",
        title: "Codex",
        version: "0.137.0",
      },
    },
  });
  assert.equal(initialized.result.serverInfo.name, "dynamic-workflows");

  const listed = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  assert.ok(listed.result.tools.some((tool) => tool.name === "dynamic_workflows_plan"));
});

test("plan strictly rejects conditions the engine does not implement", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: codexSpec({
      objective: "Reject spec fields that contradict the engine",
      phases: [
        { phase_id: "p1", tasks: ["t1"] },
        {
          phase_id: "p2",
          depends_on: ["p1"],
          entry_condition: "always",
          completion_condition: "any",
          tasks: ["t2"],
        },
      ],
      tasks: [
        { task_id: "t1", phase_id: "p1", kind: "local_analysis", role: "w", prompt_template: "x" },
        {
          task_id: "t2",
          phase_id: "p2",
          kind: "local_analysis",
          role: "w",
          prompt_template: "y",
          depends_on: ["t1"],
          condition: "always",
          stop_condition: "never",
          fanout_source: "findings",
        },
      ],
    }),
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes('phase p2 entry_condition "always"')));
  assert.ok(result.errors.some((message) => message.includes("phase p2 completion_condition")));
  assert.ok(result.errors.some((message) => message.includes('task t2 condition "always"')));
  assert.ok(result.errors.some((message) => message.includes("task t2 stop_condition")));
  assert.ok(result.errors.some((message) => message.includes("task t2 fanout_source")));
});

test("approval summary reports advisory fields and only enforced budgets", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ objective: "Advisory fields surface in the summary", workspace });

  const summary = planned.approval.summary;
  assert.deepEqual(summary.budget, { max_tokens: 100000, max_duration_ms: 300000 });
  assert.deepEqual(summary.advisory_fields.fields, ["max_cost", "max_retries", "max_no_progress_iterations"]);
});

test("stored specs are re-validated strictly on every read", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ objective: "Stored specs stay strict", workspace });

  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.phases[0].completion_condition = "any";
    spec.tasks[0].stop_condition = "never";
  });

  assert.throws(() => statusWorkflow({ runDir: planned.run_dir }), /Run directory validation failed/);
  const validation = validateRunDirectory({ runDir: planned.run_dir });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("completion_condition")));
  assert.ok(validation.errors.some((message) => message.includes("stop_condition")));
});

test("plan rejects spec fields removed in schema v2 with per-field errors", () => {
  const workspace = makeTempWorkspace();
  const result = planWorkflow({
    workspace,
    dryRun: true,
    spec: codexSpec({
      objective: "Reject removed v1 fields",
      phases: [{ phase_id: "p1", tasks: ["t1"], verification_required: true }],
      tasks: [
        {
          task_id: "t1",
          phase_id: "p1",
          kind: "codex_agent",
          role: "w",
          prompt_template: "x",
          verification_required: false,
          expected_output_schema: "WorkerResult",
          fanout_source: null,
        },
      ],
      verification_policy: { required: false },
    }),
  });

  assert.equal(result.valid, false);
  for (const fragment of [
    "workflow.verification_policy was removed in schema v2",
    "phase p1 verification_required was removed in schema v2",
    "task t1 verification_required was removed in schema v2",
    "task t1 expected_output_schema was removed in schema v2",
    "task t1 fanout_source was removed in schema v2",
  ]) {
    assert.ok(result.errors.some((message) => message.includes(fragment)), fragment);
  }
});

test("input_source outside the run and workspace records an audit warning event", async () => {
  const workspace = makeTempWorkspace();
  const outside = path.join(makeTempWorkspace(), "external-input.json");
  fs.writeFileSync(outside, "{}\n", "utf8");
  const planned = planWorkflow({ workspace, spec: singleCodexTaskSpec({ input_source: outside }) });

  const completed = await withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const warning = events.find((event) => event.type === "input_path_warning");
  assert.ok(warning, "expected an input_path_warning event");
  assert.equal(warning.payload.task_id, "t1");
  assert.equal(warning.payload.input_path, outside);
});

test("detach surfaces a runner that dies before executing the run", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ objective: "Detach a dead-on-arrival runner", workspace });

  // A run marked running with no live lock passes the detach prechecks, but
  // the spawned child refuses it and exits non-zero immediately.
  const statePath = path.join(planned.run_dir, "run.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.status = "running";
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(() => detachWorkflowRun({ runDir: planned.run_dir }), /runner log/);
});

test("CLI run --detach prints the detach summary before the process exits", async () => {
  // Regression: the detach poll awaited an unref'd timer, so a bare CLI
  // process (no other ref'd handles) exited 0 with empty stdout before the
  // summary was printed. Only a real CLI subprocess reproduces this; inside
  // the test process other handles keep the event loop alive.
  const workspace = makeTempWorkspace();
  const cli = path.join(pluginRoot, "scripts", "dynamic-workflows.js");
  const planned = planWorkflow({ objective: "Detach through the CLI", workspace });

  const output = execFileSync(
    "node",
    [cli, "run", "--run-dir", planned.run_dir, "--detach", "--approve", "--json"],
    { encoding: "utf8" },
  );

  assert.ok(output.length > 0, "expected the detach summary on stdout");
  const detached = JSON.parse(output);
  assert.equal(detached.detached, true);
  assert.equal(detached.run_dir, planned.run_dir);

  const finished = await pollUntil(
    () => readRunState(planned.run_dir).status === "completed",
  );
  assert.ok(finished, "expected the detached run to complete");
});

test("plan strictly rejects malformed input_source values", () => {
  const workspace = makeTempWorkspace();
  const dryRun = (inputSource) =>
    planWorkflow({
      workspace,
      dryRun: true,
      spec: singleCodexTaskSpec({ input_source: inputSource }),
    });

  const malformedInputs = [[123], {}, [""], ["   "], ["ok.json", ""], ["ok.json", "   "], [], 5, "", "   "];
  for (const malformed of malformedInputs) {
    const result = dryRun(malformed);
    assert.equal(result.valid, false, `expected ${JSON.stringify(malformed)} to be rejected`);
    assert.ok(result.errors.some((message) => message.includes("task t1 input_source")));
  }

  const acceptedInputs = [null, "objective", "accepted_worker_results", "inputs/seed.json", ["a.json", "b.json"]];
  for (const accepted of acceptedInputs) {
    const result = dryRun(accepted);
    assert.equal(result.valid, true, `expected ${JSON.stringify(accepted)} to be accepted`);
  }

  assert.equal(dryRun(null).workflow.tasks[0].input_source, "objective");
  assert.equal(planWorkflow({
    workspace,
    dryRun: true,
    spec: singleCodexTaskSpec(),
  }).workflow.tasks[0].input_source, "objective");
});

test("workflow schema documents normalized input_source forms", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(pluginRoot, "schemas", "workflow.schema.json"), "utf8"));
  const inputSource = schema.$defs.task.properties.input_source;

  assert.ok(inputSource.anyOf.some((entry) =>
    entry.type === "string" && entry.enum?.includes("objective") && entry.enum?.includes("accepted_worker_results"),
  ));
  assert.ok(inputSource.anyOf.some((entry) =>
    entry.type === "string" && entry.minLength === 1 && entry.pattern === "\\S",
  ));
  assert.ok(inputSource.anyOf.some((entry) =>
    entry.type === "array" &&
      entry.minItems === 1 &&
      entry.items?.type === "string" &&
      entry.items?.minLength === 1 &&
      entry.items?.pattern === "\\S",
  ));
});

function createMcpClient(child, options = {}) {
  const framing = options.framing ?? "headers";
  const requestDelimiter = options.requestDelimiter ?? "\r\n\r\n";
  let buffer = Buffer.alloc(0);
  const pending = [];
  const queued = [];

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });

  child.stderr.on("data", (chunk) => {
    if (pending.length > 0) {
      pending.shift().reject(new Error(chunk.toString("utf8")));
    }
  });

  function request(message) {
    writeMcpMessage(child.stdin, message, { framing, delimiter: requestDelimiter });
    if (queued.length > 0) {
      return Promise.resolve(queued.shift());
    }
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  }

  function drain() {
    if (framing === "jsonl") {
      drainJsonLines();
      return;
    }
    drainHeaders();
  }

  function drainHeaders() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      assert.ok(lengthMatch, `invalid MCP header: ${header}`);
      const contentLength = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }
      const raw = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);
      const parsed = JSON.parse(raw);
      deliver(parsed);
    }
  }

  function drainJsonLines() {
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      const raw = buffer.slice(0, lineEnd).toString("utf8").trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!raw) {
        continue;
      }
      deliver(JSON.parse(raw));
    }
  }

  function deliver(message) {
    if (pending.length > 0) {
      pending.shift().resolve(message);
    } else {
      queued.push(message);
    }
  }

  return { request };
}

function writeMcpMessage(stdin, message, options = {}) {
  const framing = options.framing ?? "headers";
  const delimiter = options.delimiter ?? "\r\n\r\n";
  const json = JSON.stringify(message);
  if (framing === "jsonl") {
    stdin.write(`${json}\n`);
    return;
  }
  stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}${delimiter}${json}`);
}

// --- Claude executor (claude-* task kinds) ----------------------------------
// Case numbers refer to section 6 (テスト計画) of
// docs/local/dynamic-workflows-claude-worker-dispatch-design.md.
// Case 9 (process-runner extraction keeps codex behavior) has no dedicated
// test: the pre-existing codex suite above passing unchanged is the guarantee.
// Cancellation (case 6's cancel half) also rides the shared process-runner
// escalation already pinned by the codex cancelWorkflow test.

import {
  buildClaudeExecArgs,
  buildClaudeSandboxSettings,
  resolveClaudeBin,
} from "../scripts/lib/claude-executor.js";
import { buildCodexExecArgs, WORKER_OUTPUT_SCHEMA } from "../scripts/lib/codex-executor.js";
import {
  CLAUDE_EFFORT_LEVELS,
  EXECUTOR_FIELD_CONTRACT,
  EXECUTOR_KIND_MATCHERS,
  MODEL_VALUE_PATTERN_SOURCE,
  pushSafeWorkerArg,
} from "../scripts/lib/executor-contract.js";

const fakeClaudeBin = path.join(pluginRoot, "tests", "fixtures", "fake-claude.js");

function singleClaudeTaskSpec(taskOverrides = {}, specOverrides = {}) {
  return codexSpec({
    objective: "Exercise the claude executor with a fake binary",
    phases: [{ phase_id: "p1", tasks: ["t1"] }],
    tasks: [
      {
        task_id: "t1",
        phase_id: "p1",
        kind: "claude_agent",
        role: "tester",
        prompt_template: "Run task one.",
        ...taskOverrides,
      },
    ],
    ...specOverrides,
  });
}

function mixedExecutorSpec(specOverrides = {}) {
  return codexSpec({
    objective: "Route each task kind to its own executor",
    phases: [{ phase_id: "p1", tasks: ["cx", "cl"] }],
    tasks: [
      { task_id: "cx", phase_id: "p1", kind: "codex_agent", role: "w", prompt_template: "codex task" },
      { task_id: "cl", phase_id: "p1", kind: "claude_agent", role: "w", prompt_template: "claude task" },
    ],
    ...specOverrides,
  });
}

function flagValueIn(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function singleLocalTaskSpec(taskOverrides = {}, specOverrides = {}) {
  return codexSpec({
    objective: "Exercise the local executor",
    phases: [{ phase_id: "p1", tasks: ["t1"] }],
    tasks: [
      {
        task_id: "t1",
        phase_id: "p1",
        kind: "local_analysis",
        role: "tester",
        prompt_template: "Run task one.",
        ...taskOverrides,
      },
    ],
    ...specOverrides,
  });
}

test("executor field contract rejects unsupported and malformed new plans", () => {
  const workspace = makeTempWorkspace();
  const cases = [
    {
      name: "codex effort",
      spec: singleCodexTaskSpec({ effort: "high" }),
      message: "effort is not supported for codex tasks",
    },
    {
      name: "claude profile",
      spec: singleClaudeTaskSpec({ profile: "locked" }),
      message: "profile is not supported for claude tasks",
    },
    {
      name: "claude effort enum",
      spec: singleClaudeTaskSpec({ effort: "extreme" }),
      message: "effort must be one of",
    },
    {
      name: "codex malformed model",
      spec: singleCodexTaskSpec({ model: "gpt 5" }),
      message: "model must match",
    },
    {
      name: "codex hostile profile",
      spec: singleCodexTaskSpec({ profile: "-hostile" }),
      message: "profile must match",
    },
    {
      name: "local model",
      spec: singleLocalTaskSpec({ model: "gpt-5" }),
      message: "model is not supported for local tasks",
    },
    {
      name: "local effort",
      spec: singleLocalTaskSpec({ effort: "low" }),
      message: "effort is not supported for local tasks",
    },
    {
      name: "local profile",
      spec: singleLocalTaskSpec({ profile: "p1" }),
      message: "profile is not supported for local tasks",
    },
  ];

  for (const entry of cases) {
    const result = planWorkflow({ workspace, dryRun: true, spec: entry.spec });
    assert.equal(result.valid, false, entry.name);
    assert.ok(
      result.errors.some((message) => message.includes(entry.message)),
      `${entry.name}: ${result.errors.join("\n")}`,
    );
  }
});

test("executor fields are summarized only for tasks that declare them", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: codexSpec({
      objective: "Summarize executor fields",
      phases: [{ phase_id: "p1", tasks: ["cx", "cl", "lo"] }],
      tasks: [
        {
          task_id: "cx",
          phase_id: "p1",
          kind: "codex_agent",
          role: "w",
          prompt_template: "codex",
          model: "gpt-5.1",
          profile: "locked/profile",
        },
        {
          task_id: "cl",
          phase_id: "p1",
          kind: "claude_agent",
          role: "w",
          prompt_template: "claude",
          model: "claude-sonnet-4-5",
          effort: "max",
        },
        {
          task_id: "lo",
          phase_id: "p1",
          kind: "local_analysis",
          role: "w",
          prompt_template: "local",
        },
      ],
    }),
  });

  const tasks = Object.fromEntries(planned.approval.summary.tasks.map((task) => [task.task_id, task]));
  assert.equal(tasks.cx.model, "gpt-5.1");
  assert.equal(tasks.cx.profile, "locked/profile");
  assert.equal(tasks.cx.effort, undefined);
  assert.equal(tasks.cl.model, "claude-sonnet-4-5");
  assert.equal(tasks.cl.effort, "max");
  assert.equal(tasks.cl.profile, undefined);
  assert.equal(tasks.lo.model, undefined);
  assert.equal(tasks.lo.effort, undefined);
  assert.equal(tasks.lo.profile, undefined);
});

test("approval summary task entries have exactly the base key-set when no executor fields are declared", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleLocalTaskSpec() });

  for (const entry of planned.approval.summary.tasks) {
    assert.deepStrictEqual(Object.keys(entry), ["task_id", "role", "kind", "prompt_summary"]);
  }
});

test("stored executor field tampering is rejected by strict re-validation", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleCodexTaskSpec() });
  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.tasks[0].effort = "high";
  });

  assert.throws(() => statusWorkflow({ runDir: planned.run_dir }), /Run directory validation failed/);
  const validation = validateRunDirectory({ runDir: planned.run_dir });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("effort is not supported for codex tasks")));
});

test("hash-only spec tamper is still observable and cancellable", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleLocalTaskSpec() });
  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.objective = "Changed after plan";
  });

  assert.equal(statusWorkflow({ runDir: planned.run_dir }).status, "awaiting_approval");
  const cancelled = cancelWorkflow({ runDir: planned.run_dir, reason: "stop tampered run" });
  assert.equal(cancelled.status, "cancelled");
});

test("approval refuses tampered specs without mutating approval state", () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleLocalTaskSpec() });
  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.objective = "Changed before approval";
  });

  assert.throws(() => approveWorkflow({ runDir: planned.run_dir }), /Workflow spec changed/);
  assert.equal(readRunState(planned.run_dir).status, "awaiting_approval");
  assert.ok(!workflowEventTypes(planned.run_dir).includes("approval_granted"));
});

test("run --approve refuses tampered specs before approval or run events", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleLocalTaskSpec() });
  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.objective = "Changed before run approve";
  });

  await assert.rejects(() => runWorkflow({ runDir: planned.run_dir, approve: true }), /Workflow spec changed/);
  assert.equal(readRunState(planned.run_dir).status, "awaiting_approval");
  const eventTypes = workflowEventTypes(planned.run_dir);
  assert.ok(!eventTypes.includes("approval_granted"));
  assert.ok(!eventTypes.includes("run_started"));
});

test("approved-then-tampered run rejection leaves no lock or corrupted state behind", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleLocalTaskSpec() });
  approveWorkflow({ runDir: planned.run_dir });
  const statusAfterApproval = readRunState(planned.run_dir).status;

  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.objective = "Tampered after approval";
  });

  await assert.rejects(() => runWorkflow({ runDir: planned.run_dir }), /Workflow spec changed since plan/);
  assert.ok(!workflowEventTypes(planned.run_dir).includes("run_started"));
  assert.ok(!fs.existsSync(path.join(planned.run_dir, "orchestrator.lock")));
  assert.equal(readRunState(planned.run_dir).status, statusAfterApproval);

  refreshStoredSpecHash(planned.run_dir);
  const recovered = await runWorkflow({ runDir: planned.run_dir });
  assert.equal(recovered.status, "completed");
});

test("terminal run and resume noops are behind the L2 spec guard", async () => {
  const workspace = makeTempWorkspace();
  const runPlanned = planWorkflow({ workspace, runId: "run-noop-tamper", spec: singleLocalTaskSpec() });
  await runWorkflow({ runDir: runPlanned.run_dir, approve: true });
  const runEventCount = readWorkflowEvents({ runDir: runPlanned.run_dir }).events.length;
  mutateWorkflowFile(runPlanned.run_dir, (spec) => {
    spec.objective = "Changed before completed run noop";
  });

  await assert.rejects(() => runWorkflow({ runDir: runPlanned.run_dir }), /Workflow spec changed/);
  assert.equal(readWorkflowEvents({ runDir: runPlanned.run_dir }).events.length, runEventCount);
  assert.ok(!workflowEventTypes(runPlanned.run_dir).includes("run_noop"));

  const resumePlanned = planWorkflow({ workspace, runId: "resume-noop-tamper", spec: singleLocalTaskSpec() });
  await runWorkflow({ runDir: resumePlanned.run_dir, approve: true });
  const resumeEventCount = readWorkflowEvents({ runDir: resumePlanned.run_dir }).events.length;
  mutateWorkflowFile(resumePlanned.run_dir, (spec) => {
    spec.objective = "Changed before resume noop";
  });

  await assert.rejects(() => resumeWorkflow({ runDir: resumePlanned.run_dir }), /Workflow spec changed/);
  assert.equal(readWorkflowEvents({ runDir: resumePlanned.run_dir }).events.length, resumeEventCount);
  assert.ok(!workflowEventTypes(resumePlanned.run_dir).includes("resume_noop"));
});

test("detach refuses tampered specs before runner log or child spawn", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleLocalTaskSpec() });
  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.objective = "Changed before detach";
  });

  await assert.rejects(() => detachWorkflowRun({ runDir: planned.run_dir, approve: true }), /Workflow spec changed/);
  assert.ok(!fs.existsSync(path.join(planned.run_dir, "runner.log")));
  assert.ok(!workflowEventTypes(planned.run_dir).includes("approval_granted"));
});

test("pushSafeWorkerArg skips blank legacy values and rejects argv-unsafe classes", () => {
  const args = [];
  assert.equal(pushSafeWorkerArg(args, "--model", undefined, "model"), false);
  assert.equal(pushSafeWorkerArg(args, "--model", "", "model"), false);
  assert.equal(pushSafeWorkerArg(args, "--model", "   ", "model"), false);
  assert.deepEqual(args, []);

  assert.equal(pushSafeWorkerArg(args, "--model", "gpt-5.1", "model"), true);
  assert.deepEqual(args, ["--model", "gpt-5.1"]);

  for (const value of ["-gpt-5", "gpt 5", "gpt\n5", "\x7fbad", "a".repeat(513)]) {
    assert.throws(() => pushSafeWorkerArg([], "--model", value, "model"), /argv-safe/);
  }
});

test("executor argv builders route model profile and effort by executor", () => {
  const workflow = { workspace_policy: { workspace_root: "/tmp/dw-workspace", write_scope: ["run_dir"], network: false } };
  const codexArgs = buildCodexExecArgs({
    workflow,
    task: { task_id: "cx", model: "gpt-5.1", profile: "locked/profile" },
    lastMessagePath: "/tmp/dw-run/last-message.txt",
    schemaPath: "/tmp/dw-run/worker-output.schema.json",
  });
  assert.equal(flagValueIn(codexArgs, "--model"), "gpt-5.1");
  assert.equal(flagValueIn(codexArgs, "--profile"), "locked/profile");
  assert.equal(flagValueIn(codexArgs, "--effort"), undefined);
  assert.throws(
    () =>
      buildCodexExecArgs({
        workflow,
        task: { task_id: "cx", effort: "high" },
        lastMessagePath: "/tmp/dw-run/last-message.txt",
        schemaPath: "/tmp/dw-run/worker-output.schema.json",
      }),
    /effort is only supported/,
  );
  assert.throws(
    () =>
      buildCodexExecArgs({
        workflow,
        task: { task_id: "cx", model: "gpt 5" },
        lastMessagePath: "/tmp/dw-run/last-message.txt",
        schemaPath: "/tmp/dw-run/worker-output.schema.json",
      }),
    /argv-safe/,
  );
  assert.throws(
    () =>
      buildCodexExecArgs({
        workflow,
        task: { task_id: "cx", model: "a".repeat(513) },
        lastMessagePath: "/tmp/dw-run/last-message.txt",
        schemaPath: "/tmp/dw-run/worker-output.schema.json",
      }),
    /argv-safe/,
  );
  assert.throws(
    () =>
      buildCodexExecArgs({
        workflow,
        task: { task_id: "cx", profile: "a".repeat(513) },
        lastMessagePath: "/tmp/dw-run/last-message.txt",
        schemaPath: "/tmp/dw-run/worker-output.schema.json",
      }),
    /argv-safe/,
  );

  const claudeArgs = buildClaudeExecArgs({
    workflow,
    task: { task_id: "cl", model: "claude-sonnet-4-5", effort: "max", profile: "ignored-profile" },
    settingsPath: "/tmp/dw-run/claude-settings.json",
  });
  assert.equal(flagValueIn(claudeArgs, "--model"), "claude-sonnet-4-5");
  assert.equal(flagValueIn(claudeArgs, "--effort"), "max");
  assert.equal(flagValueIn(claudeArgs, "--profile"), undefined);
  assert.throws(
    () =>
      buildClaudeExecArgs({
        workflow,
        task: { task_id: "cl", effort: "extreme" },
        settingsPath: "/tmp/dw-run/claude-settings.json",
      }),
    /effort must be one/,
  );
  assert.throws(
    () =>
      buildClaudeExecArgs({
        workflow,
        task: { task_id: "cl", model: "a".repeat(513) },
        settingsPath: "/tmp/dw-run/claude-settings.json",
      }),
    /argv-safe/,
  );
});

test("stored unsafe codex model is rejected by strict re-validation before any spawn", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleCodexTaskSpec() });
  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.tasks[0].model = "-hostile";
  });
  refreshStoredSpecHash(planned.run_dir);
  const tracePath = path.join(workspace, "codex-spawn-trace.jsonl");

  await assert.rejects(
    () =>
      withEnvAsync({ CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TRACE_PATH: tracePath }, () =>
        runWorkflow({ runDir: planned.run_dir, approve: true }),
      ),
    (error) => error.details.errors.some((message) => message.includes("task t1 model must match")),
  );

  assert.ok(!fs.existsSync(tracePath));
  assert.equal(readRunState(planned.run_dir).status, "awaiting_approval");
  const eventTypes = workflowEventTypes(planned.run_dir);
  assert.ok(!eventTypes.includes("launch_requested"));
  assert.ok(!eventTypes.includes("run_started"));
});

test("stored invalid claude effort is rejected by strict re-validation before any spawn", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleClaudeTaskSpec({ effort: "high" }) });
  mutateWorkflowFile(planned.run_dir, (spec) => {
    spec.tasks[0].effort = "extreme";
  });
  refreshStoredSpecHash(planned.run_dir);
  const tracePath = path.join(workspace, "claude-spawn-trace.jsonl");

  await assert.rejects(
    () =>
      withEnvAsync({ CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_TRACE_PATH: tracePath }, () =>
        runWorkflow({ runDir: planned.run_dir, approve: true }),
      ),
    (error) => error.details.errors.some((message) => message.includes("task t1 effort must be one of")),
  );

  assert.ok(!fs.existsSync(tracePath));
  assert.ok(!fs.existsSync(path.join(planned.run_dir, "claude-settings.json")));
  assert.equal(readRunState(planned.run_dir).status, "awaiting_approval");
  const eventTypes = workflowEventTypes(planned.run_dir);
  assert.ok(!eventTypes.includes("launch_requested"));
  assert.ok(!eventTypes.includes("run_started"));
});

test("codex model and profile flow from spec to argv and normalized result", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "codex-model-trace.jsonl");
  const planned = planWorkflow({
    workspace,
    spec: singleCodexTaskSpec({ model: "gpt-5.1", profile: "locked/profile" }),
  });

  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_FAKE_TRACE_PATH: tracePath },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  const trace = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
  assert.equal(flagValueIn(trace.argv, "--model"), "gpt-5.1");
  assert.equal(flagValueIn(trace.argv, "--profile"), "locked/profile");

  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.match(result.summary, /model=gpt-5\.1/);
  assert.match(result.summary, /profile=locked\/profile/);
});

test("claude model and effort flow to argv while models_used records raw result usage keys", async () => {
  const workspace = makeTempWorkspace();
  const tracePath = path.join(workspace, "claude-model-trace.jsonl");
  const planned = planWorkflow({
    workspace,
    spec: singleClaudeTaskSpec({ model: "claude-sonnet-4-5", effort: "max" }),
  });

  const completed = await withEnvAsync(
    {
      CCDW_CLAUDE_BIN: fakeClaudeBin,
      CCDW_FAKE_TRACE_PATH: tracePath,
      CCDW_FAKE_MULTI_MODEL_USAGE: "1",
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  const trace = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
  assert.equal(flagValueIn(trace.argv, "--model"), "claude-sonnet-4-5");
  assert.equal(flagValueIn(trace.argv, "--effort"), "max");

  const result = readJsonFile(path.join(planned.run_dir, "artifacts", "t1", "result.json"));
  assert.match(result.summary, /model=claude-sonnet-4-5/);
  assert.match(result.summary, /effort=max/);

  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.deepEqual(state.attempts[attemptId].models_used, ["claude-sonnet-4-5", "fake-secondary-model"]);

  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const started = events.find((event) => event.type === "worker_thread_started");
  assert.equal(started.payload.model, "claude-sonnet-4-5");
  const progress = events.find((event) => event.type === "progress" && event.payload.models_used);
  assert.deepEqual(progress.payload.models_used, ["claude-sonnet-4-5", "fake-secondary-model"]);
});

test("workflow schema executor contract stays pinned to shared constants", () => {
  const schema = readJsonFile(path.join(pluginRoot, "schemas", "workflow.schema.json"));
  const taskSchema = schema.$defs.task;

  assert.deepEqual(EXECUTOR_FIELD_CONTRACT, {
    model: { codex: true, claude: true, acp: true, local: false },
    effort: { codex: false, claude: true, acp: false, local: false },
    profile: { codex: true, claude: false, acp: false, local: false },
  });
  assert.equal(schema.$defs.modelValue.pattern, MODEL_VALUE_PATTERN_SOURCE);
  assert.equal(taskSchema.properties.model.$ref, "#/$defs/modelValue");
  assert.equal(taskSchema.properties.profile.$ref, "#/$defs/modelValue");
  assert.deepEqual(taskSchema.properties.effort.enum, CLAUDE_EFFORT_LEVELS);
  assert.deepEqual(taskSchema.allOf, [
    {
      if: {
        properties: { kind: { pattern: EXECUTOR_KIND_MATCHERS.codex } },
        required: ["kind"],
      },
      then: { not: { required: ["effort"] } },
    },
    {
      if: {
        properties: { kind: { pattern: EXECUTOR_KIND_MATCHERS.claude } },
        required: ["kind"],
      },
      then: { not: { required: ["profile"] } },
    },
    {
      if: {
        properties: { kind: { pattern: EXECUTOR_KIND_MATCHERS.acp } },
        required: ["kind"],
      },
      then: {
        required: ["model"],
        not: {
          anyOf: [
            { required: ["effort"] },
            { required: ["profile"] },
            { required: ["output_schema"] },
            { required: ["route"] },
          ],
        },
      },
    },
    {
      if: {
        properties: { kind: { pattern: EXECUTOR_KIND_MATCHERS.local } },
        required: ["kind"],
      },
      then: {
        not: {
          anyOf: [
            { required: ["model"] },
            { required: ["effort"] },
            { required: ["profile"] },
            { required: ["output_schema"] },
            { required: ["gates"] },
            { required: ["gate_feedback_tail_bytes"] },
            { required: ["route"] },
            { required: ["foreach"] },
          ],
        },
      },
    },
  ]);
});

test("dynamic workflows release version surfaces are aligned", () => {
  const packageJson = readJsonFile(path.join(pluginRoot, "package.json"));
  const pluginJson = readJsonFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  const mcpSource = fs.readFileSync(path.join(pluginRoot, "scripts", "dynamic-workflows-mcp.js"), "utf8");

  assert.equal(packageJson.version, "0.7.0");
  assert.equal(pluginJson.version, "0.7.0");
  assert.match(mcpSource, /version: "0\.7\.0"/);
  // The ACP initialize clientInfo.version must track the release version too.
  assert.equal(ACP_CLIENT_VERSION, packageJson.version);
});

// Case 1: dispatch routing.
test("scheduler dispatches codex and claude tasks to their own executors", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: mixedExecutorSpec() });

  const completed = await withEnvAsync(
    { CCDW_CODEX_BIN: fakeCodexBin, CCDW_CLAUDE_BIN: fakeClaudeBin },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.cx.status, "succeeded");
  assert.equal(completed.tasks.cl.status, "succeeded");

  const state = readRunState(planned.run_dir);
  assert.match(state.attempts[state.tasks.cx.attempts[0]].thread_id, /^fake-thread-/);
  assert.match(state.attempts[state.tasks.cl.attempts[0]].thread_id, /^fake-claude-session-/);
});

// Case 2: success path (result.json, session_id as thread id, tokens and cost).
test("claude executor runs a worker through the fake claude binary", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleClaudeTaskSpec() });

  const completed = await withEnvAsync({ CCDW_CLAUDE_BIN: fakeClaudeBin }, () =>
    runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.tasks.t1.status, "succeeded");
  assert.equal(completed.budget_usage.tokens, 150);
  assert.equal(completed.budget_usage.cost, 0.0123);

  const resultPath = path.join(planned.run_dir, "artifacts", "t1", "result.json");
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(result.task_id, "t1");
  assert.equal(result.status, "succeeded");

  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.match(state.attempts[attemptId].thread_id, /^fake-claude-session-/);
  assert.ok(fs.existsSync(path.join(planned.run_dir, "claude-settings.json")));
  const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
  assert.ok(fs.existsSync(path.join(attemptDir, "claude-events.jsonl")));

  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const launch = events.find((event) => event.type === "launch_started");
  assert.match(launch.payload.worker_id, /^claude:/);
});

// Case 3: exit 0 + is_error:true must fail as worker_failed (verified trap).
test("claude result with exit 0 and is_error true fails the task as worker_failed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleClaudeTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_IS_ERROR: "1" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "failed");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "failed");

  const { events } = readWorkflowEvents({ runDir: planned.run_dir });
  const failure = events.find(
    (event) =>
      event.type === "task_status_changed" &&
      event.payload.task_id === "t1" &&
      event.payload.status === "failed",
  );
  assert.equal(failure.payload.reason, "worker_failed");
});

// Case 4: schema-violating structured_output -> quarantine + schema_violation.
test("schema-violating claude structured output is quarantined as a schema violation", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleClaudeTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_RESULT_STATUS: "not-a-valid-status" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "schema_violation");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "quarantined");
  const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
  assert.ok(fs.existsSync(path.join(attemptDir, "rejected-result.json")));
});

// Case 4 (fallback half): result without structured_output falls back to the
// human text, which is not JSON -> same quarantine path as codex invalid JSON.
test("claude result without structured output is quarantined as a schema violation", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleClaudeTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_INVALID_JSON: "1" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "schema_violation");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "quarantined");
  const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
  assert.ok(fs.existsSync(path.join(attemptDir, "rejected-result.json")));
});

// Case 5: error_max_structured_output_retries -> quarantine path.
test("claude structured output retry exhaustion is quarantined as a schema violation", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleClaudeTaskSpec() });

  const result = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_SCHEMA_RETRY_EXHAUSTED: "1" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "schema_violation");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "quarantined");
  const attemptDir = path.join(planned.run_dir, state.attempts[attemptId].artifact_dir);
  assert.ok(fs.existsSync(path.join(attemptDir, "rejected-result.json")));
});

// Case 6: per-task timeout applies to claude workers (mirror of the codex test).
test("worker timeout kills the claude worker and fails the run fail-closed", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({
    workspace,
    spec: singleClaudeTaskSpec({ timeout_ms: 300 }),
  });

  const result = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_SLEEP_MS: "30000" },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.tasks.t1.status, "timed_out");
  const state = readRunState(planned.run_dir);
  const attemptId = state.tasks.t1.attempts[0];
  assert.equal(state.attempts[attemptId].status, "timed_out");
});

// Case 7: retry policy relaunches claude workers (fail-marker first attempt).
test("retry policy relaunches a failed claude worker", async () => {
  const workspace = makeTempWorkspace();
  const marker = path.join(workspace, "fail-once.marker");
  const planned = planWorkflow({
    workspace,
    spec: singleClaudeTaskSpec({
      retry_policy: { retryable: true, max_attempts: 2, backoff_ms: 10 },
    }),
  });

  const result = await withEnvAsync(
    { CCDW_CLAUDE_BIN: fakeClaudeBin, CCDW_FAKE_FAIL_MARKER: marker },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.tasks.t1.status, "succeeded");
  assert.equal(result.tasks.t1.attempts.length, 2);
});

// Case 8: CCDW_CLAUDE_BIN resolution. The integration tests above also prove
// the override end-to-end (they all select the fake binary through it).
test("resolveClaudeBin honors CCDW_CLAUDE_BIN", () => {
  assert.equal(resolveClaudeBin({ CCDW_CLAUDE_BIN: "/tmp/claude-test-bin" }), "/tmp/claude-test-bin");
  assert.equal(resolveClaudeBin({}), "claude");
  assert.equal(resolveClaudeBin({ CCDW_CLAUDE_BIN: "   " }), "claude");
});

// Case 10: approval summary shows claude executor enforcement per executor.
test("approval summary surfaces claude executor enforcement only when claude tasks exist", () => {
  const workspace = makeTempWorkspace();

  const claudePlan = planWorkflow({ workspace, runId: "claude-summary", spec: singleClaudeTaskSpec() });
  const claudeSandbox = claudePlan.approval.summary.execution_sandbox;
  const claudeEntry = claudeSandbox.executors.claude;
  assert.equal(claudeEntry.permission_mode, "default");
  assert.equal(claudeEntry.setting_sources, "none (all ambient excluded)");
  assert.equal(claudeEntry.customizations, "disabled (--safe-mode)");
  assert.ok(typeof claudeEntry.tools === "string" && claudeEntry.tools.length > 0);
  assert.ok(typeof claudeEntry.os_sandbox === "string" && claudeEntry.os_sandbox.length > 0);
  assert.equal(claudeSandbox.executors.codex, undefined);

  const mixedPlan = planWorkflow({ workspace, runId: "mixed-summary", spec: mixedExecutorSpec() });
  const mixedExecutors = mixedPlan.approval.summary.execution_sandbox.executors;
  assert.deepEqual(Object.keys(mixedExecutors).sort(), ["claude", "codex"]);
  assert.ok(mixedExecutors.codex);

  const codexPlan = planWorkflow({ workspace, runId: "codex-summary", spec: singleCodexTaskSpec() });
  assert.equal(codexPlan.approval.summary.execution_sandbox.executors, undefined);
});

// Case 11: budget is added once from the result event; the assistant event
// carries the same usage as telemetry and must not be double-counted.
test("claude budget counts result usage once despite assistant usage telemetry", async () => {
  const workspace = makeTempWorkspace();
  const planned = planWorkflow({ workspace, spec: singleClaudeTaskSpec() });

  const completed = await withEnvAsync(
    {
      CCDW_CLAUDE_BIN: fakeClaudeBin,
      CCDW_FAKE_TOKENS: "70",
      CCDW_FAKE_TOTAL_COST: "0.25",
      // Anthropic input_tokens excludes cache_creation; the runner must charge
      // cache_creation as fresh input (only cache READS stay uncounted).
      CCDW_FAKE_CACHE_CREATION: "1000",
    },
    () => runWorkflow({ runDir: planned.run_dir, approve: true }),
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.budget_usage.tokens, 1170);
  assert.equal(completed.budget_usage.cost, 0.25);

  const state = readRunState(planned.run_dir);
  const attemptDir = path.join(planned.run_dir, state.attempts[state.tasks.t1.attempts[0]].artifact_dir);
  const workerEvents = fs
    .readFileSync(path.join(attemptDir, "claude-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    workerEvents.some(
      (event) => event.type === "assistant" && event.message?.usage?.output_tokens === 70,
    ),
    "expected the fake worker to stream assistant usage telemetry",
  );
});

// Case 12: generated sandbox settings are fail-closed in both modes. Unknown
// --settings keys are silently ignored by the CLI, so key-name typos can only
// be caught here.
test("buildClaudeSandboxSettings emits fail-closed sandbox settings in both modes", () => {
  const workspaceRoot = "/tmp/dw-claude-workspace";

  const readOnly = buildClaudeSandboxSettings({
    workflow: { workspace_policy: { workspace_root: workspaceRoot, write_scope: ["run_dir"], network: false } },
  });
  assert.equal(readOnly.sandbox.enabled, true);
  assert.equal(readOnly.sandbox.failIfUnavailable, true);
  assert.equal(readOnly.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(readOnly.sandbox.filesystem.denyWrite, [workspaceRoot]);
  assert.deepEqual(readOnly.sandbox.network.allowedDomains, []);

  const workspaceWrite = buildClaudeSandboxSettings({
    workflow: { workspace_policy: { workspace_root: workspaceRoot, write_scope: ["workspace"], network: false } },
  });
  assert.equal(workspaceWrite.sandbox.enabled, true);
  assert.equal(workspaceWrite.sandbox.failIfUnavailable, true);
  assert.equal(workspaceWrite.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(workspaceWrite.sandbox.filesystem.allowWrite, [workspaceRoot]);
  assert.deepEqual(workspaceWrite.sandbox.network.allowedDomains, []);

  // network:true still yields an empty allowlist: there is no enforceable
  // allow-all network sandbox, and plan-time validation rejects the combination.
  for (const writeScope of [["run_dir"], ["workspace"]]) {
    const networkTrue = buildClaudeSandboxSettings({
      workflow: { workspace_policy: { workspace_root: workspaceRoot, write_scope: writeScope, network: true } },
    });
    assert.deepEqual(networkTrue.sandbox.network.allowedDomains, []);
  }
});

// Case 12 (argv half): mode-specific args stay fail-closed and never widen.
test("buildClaudeExecArgs builds mode-specific fail-closed argv", () => {
  const settingsPath = "/tmp/dw-claude-run/claude-settings.json";
  const workspaceRoot = "/tmp/dw-claude-workspace";

  const readOnlyArgs = buildClaudeExecArgs({
    workflow: { workspace_policy: { workspace_root: workspaceRoot, write_scope: ["run_dir"], network: false } },
    task: { task_id: "t1" },
    settingsPath,
  });
  assert.equal(flagValueIn(readOnlyArgs, "--setting-sources"), "");
  assert.equal(flagValueIn(readOnlyArgs, "--tools"), "Read,Glob,Grep,Bash");
  assert.equal(flagValueIn(readOnlyArgs, "--allowedTools"), "Read,Glob,Grep,Bash");
  assert.equal(flagValueIn(readOnlyArgs, "--disallowedTools"), "Edit,Write,NotebookEdit,WebFetch,WebSearch,mcp__*");
  assert.equal(flagValueIn(readOnlyArgs, "--permission-mode"), "default");
  assert.equal(flagValueIn(readOnlyArgs, "--settings"), settingsPath);
  assert.equal(String(flagValueIn(readOnlyArgs, "--max-turns")), "50");
  assert.deepEqual(JSON.parse(flagValueIn(readOnlyArgs, "--json-schema")), WORKER_OUTPUT_SCHEMA);
  assert.ok(readOnlyArgs.includes("--safe-mode"));
  assert.ok(readOnlyArgs.includes("--no-session-persistence"));
  assert.ok(!readOnlyArgs.includes("--bare"));
  assert.ok(!readOnlyArgs.includes("--model"));

  const writeArgs = buildClaudeExecArgs({
    workflow: { workspace_policy: { workspace_root: workspaceRoot, write_scope: ["workspace"], network: false } },
    task: { task_id: "t1", model: "fake-model-x" },
    settingsPath,
  });
  assert.equal(flagValueIn(writeArgs, "--tools"), "Edit,Write,Read,Glob,Grep,Bash");
  assert.equal(flagValueIn(writeArgs, "--allowedTools"), "Edit,Write,Read,Glob,Grep,Bash");
  assert.equal(flagValueIn(writeArgs, "--disallowedTools"), "NotebookEdit,WebFetch,WebSearch,mcp__*");
  assert.equal(flagValueIn(writeArgs, "--permission-mode"), "dontAsk");
  assert.equal(flagValueIn(writeArgs, "--model"), "fake-model-x");
  assert.ok(writeArgs.includes("--safe-mode"));
  assert.ok(writeArgs.includes("--no-session-persistence"));
  assert.ok(!writeArgs.includes("--bare"));
});

// Case 13: plan-time rejection of claude tasks with network:true; the codex
// equivalent stays valid (the general constraint still requires
// workspace-write, which both specs satisfy here).
test("plan rejects claude tasks that request workspace network access", () => {
  const workspace = makeTempWorkspace();

  const claudeResult = planWorkflow({
    workspace,
    dryRun: true,
    spec: singleClaudeTaskSpec(
      {},
      { workspace_policy: { write_scope: ["workspace"], network: true } },
    ),
  });
  assert.equal(claudeResult.valid, false);
  assert.ok(
    claudeResult.errors.some((message) =>
      message.includes("workspace_policy.network: true is not supported for claude tasks"),
    ),
  );

  const codexResult = planWorkflow({
    workspace,
    dryRun: true,
    spec: singleCodexTaskSpec(
      {},
      { workspace_policy: { write_scope: ["workspace"], network: true } },
    ),
  });
  assert.equal(codexResult.valid, true);
  assert.deepEqual(codexResult.errors, []);
});
