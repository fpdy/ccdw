import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialRunState } from "../scripts/lib/approval.js";

// Approval-summary disclosure for acp_opencode workers (design §4.6, R3a/R3b)
// and the R5 byte-identity guard for acp-free specs.

function makeWorkflow({ tasks, writeScope }) {
  return {
    run_id: "run-fixture",
    objective: "fixture objective",
    phases: [
      {
        phase_id: "p1",
        name: "phase one",
        depends_on: [],
        tasks: tasks.map((task) => task.task_id),
      },
    ],
    tasks,
    max_agents: 4,
    max_concurrency: 2,
    max_tokens: 1000,
    max_duration_ms: 60000,
    required_capabilities: [],
    stop_conditions: [],
    workspace_policy: {
      workspace_root: "/tmp/ws",
      write_scope: writeScope,
      network: false,
    },
  };
}

function sandboxSummaryFor(workflow) {
  const state = buildInitialRunState({
    workflow,
    goalId: "g1",
    createdAt: "2026-06-13T00:00:00.000Z",
    specHash: "hash",
  });
  return state.approval.summary.execution_sandbox;
}

const codexTask = {
  task_id: "t-codex",
  phase_id: "p1",
  kind: "codex_exec",
  role: "worker",
  prompt_template: "do codex work",
};
const claudeTask = {
  task_id: "t-claude",
  phase_id: "p1",
  kind: "claude_code",
  role: "worker",
  prompt_template: "do claude work",
};
const acpTask = {
  task_id: "t-acp",
  phase_id: "p1",
  kind: "acp_opencode",
  role: "worker",
  model: "openrouter/anthropic/claude-haiku-4.5",
  prompt_template: "do acp work",
};

// R5 byte-identity guard. The expected literals below were captured by running
// the PRE-CHANGE buildExecutionSandboxSummary (via buildInitialRunState with
// these exact fixtures, `node -e` against the unmodified approval.js) BEFORE
// the acp branch was added. Asserting deep equality against these frozen
// snapshots proves JSON.stringify of the summary is byte-identical to the
// pre-change output for specs without acp tasks.
test("acp-free codex+claude summary stays byte-identical to the pre-acp output", () => {
  const preChangeWriteSnapshot = {
    mode: "workspace-write",
    write_scope: ["workspace"],
    network_access: false,
    unsupported_permissions_rejected: ["shell", "mcp_write"],
    executors: {
      codex: { sandbox: "workspace-write" },
      claude: {
        permission_mode: "dontAsk",
        tools: "write set",
        os_sandbox: "settings (allow write /tmp/ws / no network)",
        setting_sources: "none (all ambient excluded)",
        customizations: "disabled (--safe-mode)",
      },
    },
  };
  const preChangeReadOnlySnapshot = {
    mode: "read-only",
    write_scope: ["run_dir"],
    network_access: false,
    unsupported_permissions_rejected: ["shell", "mcp_write"],
    executors: {
      codex: { sandbox: "read-only" },
      claude: {
        permission_mode: "default",
        tools: "read-only set",
        os_sandbox: "settings (deny write /tmp/ws / no network)",
        setting_sources: "none (all ambient excluded)",
        customizations: "disabled (--safe-mode)",
      },
    },
  };

  const writeSummary = sandboxSummaryFor(
    makeWorkflow({ tasks: [codexTask, claudeTask], writeScope: ["workspace"] }),
  );
  assert.equal(writeSummary.executors.acp, undefined);
  assert.deepEqual(writeSummary, preChangeWriteSnapshot);
  // Byte-level comparison including key order, not just structural equality.
  assert.equal(JSON.stringify(writeSummary), JSON.stringify(preChangeWriteSnapshot));

  const readOnlySummary = sandboxSummaryFor(
    makeWorkflow({ tasks: [codexTask, claudeTask], writeScope: ["run_dir"] }),
  );
  assert.equal(readOnlySummary.executors.acp, undefined);
  assert.deepEqual(readOnlySummary, preChangeReadOnlySnapshot);
  assert.equal(JSON.stringify(readOnlySummary), JSON.stringify(preChangeReadOnlySnapshot));
});

test("acp task (write scope) discloses the injected config and guarantee gaps", () => {
  const summary = sandboxSummaryFor(
    makeWorkflow({ tasks: [acpTask], writeScope: ["workspace"] }),
  );
  const acp = summary.executors.acp;
  assert.ok(acp, "acp executor block must be present");

  // Injected permission JSON is transcribed verbatim (write scope: bash+edit allowed).
  const permission = acp.enforcement.injected_permission_config.permission;
  assert.equal(permission.bash, "allow");
  assert.equal(permission.edit, "allow");
  assert.equal(permission["*"], "deny");
  assert.equal(permission.webfetch, "deny");

  // Network isolation is disclosed as not guaranteed (R3a).
  assert.match(acp.network_isolation, /NOT guaranteed/);
  assert.match(acp.network_isolation, /regardless of the task network field/);

  // Model pinning via session/set_model and model-required are disclosed.
  assert.match(acp.ambient_isolation, /session\/set_model/);
  assert.match(acp.ambient_isolation, /required for acp tasks/);

  // No OS sandbox; the second app layer is the reject-all permission responder.
  assert.match(acp.os_sandbox, /none/);
  assert.match(acp.enforcement.permission_requests, /reject/);
  assert.match(acp.enforcement.permission_requests, /no allow_always/);

  // R3 completeness (red-team follow-up): the four residual-risk facts.
  // (a) Filesystem containment is not guaranteed in write scope.
  assert.match(acp.filesystem_containment, /NOT guaranteed/);
  assert.match(acp.filesystem_containment, /write outside the workspace root/);
  assert.match(acp.filesystem_containment, /external_directory deny is app-layer only/);
  // (b) Inherited environment exposes secrets via bash in write scope.
  assert.match(acp.env_exposure, /inherits the parent environment/);
  assert.match(acp.env_exposure, /minus OPENCODE_\*/);
  assert.match(acp.env_exposure, /inherited secrets \(e\.g\. provider API keys\) via bash/);
  // (c) Both app layers are self-enforced by the opencode process.
  assert.match(acp.os_sandbox, /enforced by the opencode process itself/);
  assert.match(acp.os_sandbox, /no protection against a compromised binary or PATH wrapper/);
  // (d) Attempt artifacts are sensitive.
  assert.match(acp.artifact_sensitivity, /prompt\.txt, acp-frames\.jsonl/);
  assert.match(acp.artifact_sensitivity, /treat the run dir as sensitive/);
  // token_budget discloses that usage is worker-reported.
  assert.match(acp.token_budget, /worker-reported/);
  assert.match(acp.token_budget, /not trustworthy against a compromised binary/);
});

test("acp task (read-only scope) embeds a config with bash and edit denied", () => {
  const summary = sandboxSummaryFor(
    makeWorkflow({ tasks: [acpTask], writeScope: ["run_dir"] }),
  );
  const permission = summary.executors.acp.enforcement.injected_permission_config.permission;
  assert.equal(permission.bash, "deny");
  assert.equal(permission.edit, "deny");
});

test("mixed codex+acp spec surfaces both blocks with the codex block unchanged", () => {
  const summary = sandboxSummaryFor(
    makeWorkflow({ tasks: [codexTask, acpTask], writeScope: ["workspace"] }),
  );
  // Codex entry must match the test-1 snapshot expectation exactly.
  assert.deepEqual(summary.executors.codex, { sandbox: "workspace-write" });
  assert.ok(summary.executors.acp);
  assert.equal(summary.executors.claude, undefined);
});
