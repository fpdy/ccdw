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
// When set (JSON string), emit the typed-form envelope v2 with this payload as
// `output` instead of the default-form fields. The typed form is only emitted
// when the synthesized schema handed via --output-schema actually declares an
// `output` property, so mixed typed/default runs (F6 foreach) stay valid.
const typedOutputJson = process.env.CCDW_FAKE_TYPED_OUTPUT;
// Per-worker typed payloads for runs with several typed tasks (JSON array of
// {match, output}): the first entry whose `match` substring appears in the
// prompt wins; CCDW_FAKE_TYPED_OUTPUT is the fallback.
const typedOutputByMatchJson = process.env.CCDW_FAKE_TYPED_OUTPUT_BY_MATCH;
// When set, read the typed payload JSON from this file instead of the env
// value (payloads above the OS env size limits, e.g. the 256 KiB foreach
// items bound).
const typedOutputFile = process.env.CCDW_FAKE_TYPED_OUTPUT_FILE;
// When "1", emit worker-chosen task_id/attempt_id fields in the envelope:
// the runner-injected identity must win over them (C-1 spoofing guard).
const spoofIds = process.env.CCDW_FAKE_SPOOF_IDS === "1";
// When set, the crash-once marker (CCDW_FAKE_FAIL_MARKER) only fires for
// prompts containing this substring (e.g. a single foreach child).
const failOnceMatch = process.env.CCDW_FAKE_FAIL_ONCE_MATCH;
// When set, workers whose prompt contains this substring report status
// "failed" (worker_reported_failure) while the rest keep CCDW_FAKE_RESULT_STATUS.
const failStatusMatch = process.env.CCDW_FAKE_FAIL_IF_PROMPT_INCLUDES;
// When set, add a `route` field with this value to the envelope (F4 routing
// tasks). Non-route tasks in the same run ignore the extra field harmlessly.
const routeValue = process.env.CCDW_FAKE_ROUTE_VALUE;
const tracePath = process.env.CCDW_FAKE_TRACE_PATH;
const requestedModel = argValue("--model");
const requestedProfile = argValue("--profile");

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

function appendStartTrace() {
  if (!tracePath) {
    return;
  }
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.appendFileSync(
    tracePath,
    `${JSON.stringify({ event: "start", kind: "codex", pid: process.pid, argv: process.argv.slice(2) })}\n`,
  );
}

appendStartTrace();

emit({ type: "thread.started", thread_id: `fake-thread-${process.pid}` });
emit({ type: "turn.started" });

if (failMarker && !fs.existsSync(failMarker) && (!failOnceMatch || prompt.includes(failOnceMatch))) {
  // Simulate a worker crash on the first attempt: no turn.completed, exit 1.
  fs.writeFileSync(failMarker, "failed-once\n");
  writeTrace();
  process.exit(1);
}

// The runner writes the per-attempt synthesized worker schema before spawning;
// a declared `output` property marks the typed envelope form.
function schemaDeclaresTypedOutput() {
  const schemaPath = argValue("--output-schema");
  if (!schemaPath) {
    return false;
  }
  try {
    return JSON.parse(fs.readFileSync(schemaPath, "utf8"))?.properties?.output != null;
  } catch {
    return false;
  }
}

function resolveTypedPayloadJson() {
  if (typedOutputByMatchJson) {
    try {
      const entry = JSON.parse(typedOutputByMatchJson).find((candidate) => prompt.includes(candidate.match));
      if (entry) {
        return JSON.stringify(entry.output);
      }
    } catch {
      // Fall through to the static payload.
    }
  }
  if (typedOutputFile) {
    return fs.readFileSync(typedOutputFile, "utf8");
  }
  return typedOutputJson ?? null;
}

setTimeout(() => {
  const routeFields = routeValue != null ? { route: routeValue } : {};
  const spoofFields = spoofIds
    ? { task_id: "spoofed-task", attempt_id: "spoofed-attempt" }
    : {};
  const effectiveStatus = failStatusMatch && prompt.includes(failStatusMatch) ? "failed" : resultStatus;
  const typedPayloadJson = resolveTypedPayloadJson();
  const message = invalidJson
    ? "this is not json"
    : typedPayloadJson != null && schemaDeclaresTypedOutput()
      ? JSON.stringify({
          ...spoofFields,
          status: effectiveStatus,
          summary: `fake worker handled: ${prompt.slice(0, 60)} model=${requestedModel ?? ""} profile=${requestedProfile ?? ""}`,
          errors: effectiveStatus === "failed" ? ["fake failure"] : [],
          ...routeFields,
          output: JSON.parse(typedPayloadJson),
        })
      : JSON.stringify({
          ...spoofFields,
          status: effectiveStatus,
          summary: `fake worker handled: ${prompt.slice(0, 60)} model=${requestedModel ?? ""} profile=${requestedProfile ?? ""}`,
          findings: [],
          errors: effectiveStatus === "failed" ? ["fake failure"] : [],
          evidence: [],
          modified_files: [],
          commands_run: [],
          artifacts: [],
          ...routeFields,
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
  // Natural exit (no process.exit): an agent_message larger than the pipe
  // buffer (e.g. the 256 KiB foreach-bound payload) would be truncated by
  // process.exit before the pending stdout writes drain.
  process.exitCode = 0;
}, sleepMs);
