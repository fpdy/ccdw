import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OPENCODE_CONFIG_FILE,
  OPENCODE_XDG_CONFIG_DIR,
  buildAcpWorkerEnv,
  buildOpencodeWorkerConfig,
  extractFinalMessageText,
  normalizeAcpUsage,
  probeOpencodeVersion,
  resolveOpencodeBin,
} from "../scripts/lib/acp-executor.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeAcpBin = path.join(pluginRoot, "tests", "fixtures", "fake-acp-agent.js");

const RECIPE_DISABLE_KEYS = [
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
];

test("artifact name constants match the run-dir layout contract", () => {
  assert.equal(OPENCODE_CONFIG_FILE, "opencode-config.json");
  assert.equal(OPENCODE_XDG_CONFIG_DIR, "opencode-xdg-config");
});

test("extractFinalMessageText strips a json-tagged fence", () => {
  const input = '```json\n{"status":"succeeded","summary":"done"}\n```';
  assert.equal(extractFinalMessageText(input), '{"status":"succeeded","summary":"done"}');
});

test("extractFinalMessageText strips a bare fence and preserves inner newlines", () => {
  const input = '```\n{\n  "a": 1\n}\n```';
  assert.equal(extractFinalMessageText(input), '{\n  "a": 1\n}');
});

test("extractFinalMessageText tolerates surrounding and closing-fence whitespace", () => {
  const input = '\n  ```json\n{"a":1}\n```   \n';
  assert.equal(extractFinalMessageText(input), '{"a":1}');
});

test("extractFinalMessageText returns trimmed input when unfenced", () => {
  assert.equal(extractFinalMessageText('  {"a":1}\n'), '{"a":1}');
});

test("extractFinalMessageText handles a leading fence with no closing fence", () => {
  assert.equal(extractFinalMessageText('```json\n{"a":1}'), '{"a":1}');
});

test("extractFinalMessageText handles fence-only input", () => {
  assert.equal(extractFinalMessageText("```"), "");
  assert.equal(extractFinalMessageText("```json\n```"), "");
});

test("normalizeAcpUsage maps the full PromptResponse.usage shape (D7-r2)", () => {
  const usage = normalizeAcpUsage({
    inputTokens: 100,
    cachedWriteTokens: 20,
    cachedReadTokens: 30,
    outputTokens: 40,
    thoughtTokens: 5,
    totalTokens: 195,
  });
  assert.deepEqual(usage, {
    input_tokens: 120,
    cached_input_tokens: 30,
    output_tokens: 40,
    reasoning_output_tokens: 5,
  });
});

test("normalizeAcpUsage defaults missing fields to 0", () => {
  assert.deepEqual(normalizeAcpUsage({ inputTokens: 10, outputTokens: 7 }), {
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 7,
    reasoning_output_tokens: 0,
  });
});

test("normalizeAcpUsage zeroes garbage and absent usage", () => {
  const zero = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  assert.deepEqual(
    normalizeAcpUsage({ inputTokens: "abc", cachedWriteTokens: {}, outputTokens: null, thoughtTokens: NaN }),
    zero,
  );
  assert.deepEqual(normalizeAcpUsage(undefined), zero);
  assert.deepEqual(normalizeAcpUsage(null), zero);
  assert.deepEqual(normalizeAcpUsage("garbage"), zero);
});

test("buildOpencodeWorkerConfig write scope allows edit/bash and denies the rest", () => {
  const config = buildOpencodeWorkerConfig({
    workflow: { workspace_policy: { write_scope: ["workspace"] } },
  });
  assert.deepEqual(config, {
    $schema: "https://opencode.ai/config.json",
    permission: {
      "*": "deny",
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
      glob: "allow",
      grep: "allow",
      lsp: "allow",
      edit: "allow",
      bash: "allow",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      skill: "deny",
      question: "deny",
      external_directory: { "*": "deny" },
      doom_loop: "deny",
    },
  });
  // opencode permission rules are last-match-wins: the "*" catch-all must be
  // the FIRST key so explicit allows below it win.
  assert.equal(Object.keys(config.permission)[0], "*");
  assert.equal(Object.keys(config.permission.read)[0], "*");
});

test("buildOpencodeWorkerConfig read-only scope denies edit and bash", () => {
  for (const workflow of [
    { workspace_policy: { write_scope: [] } },
    { workspace_policy: {} },
    {},
  ]) {
    const config = buildOpencodeWorkerConfig({ workflow });
    assert.equal(config.permission["*"], "deny");
    assert.equal(config.permission.edit, "deny");
    assert.equal(config.permission.bash, "deny");
    assert.equal(config.permission.webfetch, "deny");
    assert.equal(config.permission.websearch, "deny");
    assert.deepEqual(config.permission.read, { "*": "allow", "*.env": "deny", "*.env.*": "deny" });
    assert.equal(Object.keys(config.permission)[0], "*");
  }
});

test("buildAcpWorkerEnv scrubs inherited OPENCODE_* and applies the isolation recipe", () => {
  const baseEnv = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    OPENAI_API_KEY: "sk-test",
    OPENROUTER_API_KEY: "or-test",
    OPENCODE_CONFIG_DIR: "/home/user/.config/opencode",
    OPENCODE_CONFIG: "/ambient/opencode.json",
    OPENCODE_THEME: "dark",
    XDG_CONFIG_HOME: "/home/user/.config",
  };
  const workerEnv = buildAcpWorkerEnv({
    env: baseEnv,
    configPath: "/run/dir/opencode-config.json",
    xdgConfigDir: "/run/dir/opencode-xdg-config",
  });

  // Inherited OPENCODE_* keys are gone (OPENCODE_CONFIG_DIR would pull in
  // ambient plugins); only the recipe keys remain.
  assert.equal(workerEnv.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(workerEnv.OPENCODE_THEME, undefined);
  const opencodeKeys = Object.keys(workerEnv).filter((key) => key.startsWith("OPENCODE_")).sort();
  assert.deepEqual(opencodeKeys, ["OPENCODE_CONFIG", ...RECIPE_DISABLE_KEYS].sort());

  assert.equal(workerEnv.XDG_CONFIG_HOME, "/run/dir/opencode-xdg-config");
  assert.equal(workerEnv.OPENCODE_CONFIG, "/run/dir/opencode-config.json");
  for (const key of RECIPE_DISABLE_KEYS) {
    assert.equal(workerEnv[key], "true");
  }

  // Provider API keys and unrelated env are inherited untouched.
  assert.equal(workerEnv.OPENAI_API_KEY, "sk-test");
  assert.equal(workerEnv.OPENROUTER_API_KEY, "or-test");
  assert.equal(workerEnv.PATH, "/usr/bin");
  assert.equal(workerEnv.HOME, "/home/user");

  // The input env is not mutated.
  assert.equal(baseEnv.OPENCODE_THEME, "dark");
  assert.equal(baseEnv.OPENCODE_CONFIG, "/ambient/opencode.json");
  assert.equal(baseEnv.XDG_CONFIG_HOME, "/home/user/.config");
});

test("resolveOpencodeBin honors CCDW_OPENCODE_BIN and falls back to opencode", () => {
  assert.equal(resolveOpencodeBin({}), "opencode");
  assert.equal(resolveOpencodeBin({ CCDW_OPENCODE_BIN: "/abs/path/opencode" }), "/abs/path/opencode");
  assert.equal(resolveOpencodeBin({ CCDW_OPENCODE_BIN: "  /abs/path/opencode  " }), "/abs/path/opencode");
  assert.equal(resolveOpencodeBin({ CCDW_OPENCODE_BIN: "   " }), "opencode");
  assert.equal(resolveOpencodeBin({ CCDW_OPENCODE_BIN: "" }), "opencode");
});

test("probeOpencodeVersion reports timeout with a hung binary", async () => {
  const result = await probeOpencodeVersion({
    bin: fakeAcpBin,
    env: { ...process.env, FAKE_ACP_VERSION_MODE: "hang" },
    timeoutMs: 25,
  });
  assert.deepEqual(result, { version: null, status: "timeout" });
});

test("probeOpencodeVersion reports empty_output for a quiet success", async () => {
  const result = await probeOpencodeVersion({
    bin: fakeAcpBin,
    env: { ...process.env, FAKE_ACP_VERSION_MODE: "empty" },
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { version: null, status: "empty_output" });
});

test("probeOpencodeVersion reports spawn_error for a missing binary", async () => {
  const result = await probeOpencodeVersion({
    bin: "/nonexistent-ccdw-opencode-version-bin",
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { version: null, status: "spawn_error" });
});
