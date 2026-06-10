#!/usr/bin/env node
// Test double for the codex CLI. Mimics the `codex exec --json` JSONL contract
// observed on codex-cli 0.137.0: thread.started -> turn.started ->
// item.completed(agent_message) -> turn.completed(usage), plus the
// --output-last-message file written by the CLI process itself.
import fs from "node:fs";
import path from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

const lastMessagePath = argValue("--output-last-message");
const prompt = process.argv[process.argv.length - 1];
const sleepMs = Number(process.env.CCDW_FAKE_SLEEP_MS ?? 0);
const outputTokens = Number(process.env.CCDW_FAKE_TOKENS ?? 50);
const resultStatus = process.env.CCDW_FAKE_RESULT_STATUS ?? "succeeded";
const failMarker = process.env.CCDW_FAKE_FAIL_MARKER;
const invalidJson = process.env.CCDW_FAKE_INVALID_JSON === "1";

const traceDir = lastMessagePath ? path.dirname(lastMessagePath) : null;
const startedAt = Date.now();

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function writeTrace() {
  if (!traceDir) {
    return;
  }
  fs.writeFileSync(
    path.join(traceDir, "trace.json"),
    JSON.stringify({ start: startedAt, end: Date.now(), prompt }),
  );
}

emit({ type: "thread.started", thread_id: `fake-thread-${process.pid}` });
emit({ type: "turn.started" });

if (failMarker && !fs.existsSync(failMarker)) {
  // Simulate a worker crash on the first attempt: no turn.completed, exit 1.
  fs.writeFileSync(failMarker, "failed-once\n");
  writeTrace();
  process.exit(1);
}

setTimeout(() => {
  const message = invalidJson
    ? "this is not json"
    : JSON.stringify({
        status: resultStatus,
        summary: `fake worker handled: ${prompt.slice(0, 60)}`,
        findings: [],
        errors: resultStatus === "failed" ? ["fake failure"] : [],
        evidence: [],
        modified_files: [],
        commands_run: [],
        artifacts: [],
      });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: message } });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 0,
    },
  });
  if (lastMessagePath) {
    fs.writeFileSync(lastMessagePath, message);
  }
  writeTrace();
  process.exit(0);
}, sleepMs);
