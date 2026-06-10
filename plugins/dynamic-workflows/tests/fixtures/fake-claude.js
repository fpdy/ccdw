#!/usr/bin/env node
// Test double for the claude CLI. Mimics the `claude -p --output-format
// stream-json --verbose` NDJSON contract observed on claude CLI 2.1.170:
// system/init (session_id) -> assistant (usage telemetry) -> result
// (structured_output, usage, total_cost_usd, is_error, subtype). Unlike
// fake-codex there is no --output-last-message flag, so no trace file is
// written; the result event is the whole contract.
import fs from "node:fs";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

const prompt = process.argv[process.argv.length - 1];
const sleepMs = Number(process.env.CCDW_FAKE_SLEEP_MS ?? 0);
const outputTokens = Number(process.env.CCDW_FAKE_TOKENS ?? 50);
const resultStatus = process.env.CCDW_FAKE_RESULT_STATUS ?? "succeeded";
const failMarker = process.env.CCDW_FAKE_FAIL_MARKER;
const invalidJson = process.env.CCDW_FAKE_INVALID_JSON === "1";
const isError = process.env.CCDW_FAKE_IS_ERROR === "1";
const schemaRetryExhausted = process.env.CCDW_FAKE_SCHEMA_RETRY_EXHAUSTED === "1";
const totalCostUsd = Number(process.env.CCDW_FAKE_TOTAL_COST ?? 0.0123);
const cacheCreationTokens = Number(process.env.CCDW_FAKE_CACHE_CREATION ?? 0);

const sessionId = `fake-claude-session-${process.pid}`;
const tools = (argValue("--tools") ?? "Read,Glob,Grep,Bash").split(",");

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  tools,
  model: "fake-model",
  claude_code_version: "2.1.170",
});

if (failMarker && !fs.existsSync(failMarker)) {
  // Simulate a worker crash on the first attempt: no result event, exit 1.
  fs.writeFileSync(failMarker, "failed-once\n");
  process.exit(1);
}

setTimeout(() => {
  // Telemetry-only usage on the assistant event: the runner must record it in
  // claude-events.jsonl but never add it to the budget (the result event is
  // the single accounting point).
  emit({
    type: "assistant",
    message: { usage: { input_tokens: 100, output_tokens: outputTokens } },
  });

  const base = {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    num_turns: 1,
    total_cost_usd: totalCostUsd,
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: cacheCreationTokens,
      output_tokens: outputTokens,
    },
  };

  if (schemaRetryExhausted) {
    // The CLI gave up forcing the model output into --json-schema: no
    // structured_output is present and the subtype flags the exhaustion.
    emit({
      ...base,
      subtype: "error_max_structured_output_retries",
      is_error: true,
      result: "fake schema retries exhausted",
    });
  } else if (isError) {
    // Verified auth-failure shape: exit 0, subtype "success", is_error true.
    emit({
      ...base,
      is_error: true,
      result: "fake auth failure: Invalid API key",
    });
  } else if (invalidJson) {
    // No structured_output at all; the human text is not parseable JSON.
    emit({ ...base, result: "this is not json" });
  } else {
    const structuredOutput = {
      status: resultStatus,
      summary: `fake claude worker handled: ${prompt.slice(0, 60)}`,
      findings: [],
      errors: resultStatus === "failed" ? ["fake failure"] : [],
      evidence: [],
      modified_files: [],
      commands_run: [],
      artifacts: [],
    };
    emit({
      ...base,
      result: structuredOutput.summary,
      structured_output: structuredOutput,
    });
  }
  process.exit(0);
}, sleepMs);
