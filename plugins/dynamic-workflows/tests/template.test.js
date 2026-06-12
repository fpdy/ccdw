import assert from "node:assert/strict";
import test from "node:test";
import {
  TEMPLATE_NAMESPACES,
  TemplateRenderError,
  TemplateSyntaxError,
  listRefs,
  parseTemplate,
  renderTemplate,
} from "../scripts/lib/template.js";

test("plain text passes through unchanged", () => {
  const text = "no references here, just text.";
  assert.deepEqual(parseTemplate(text), [{ type: "text", value: text }]);
  assert.equal(renderTemplate(text, {}), text);
});

test("objective namespace parses and renders", () => {
  assert.deepEqual(parseTemplate("{{objective}}"), [
    { type: "ref", ref: { ns: "objective" } },
  ]);
  assert.equal(renderTemplate("goal: {{objective}}", { objective: "ship it" }), "goal: ship it");
});

test("inputs namespace parses and renders", () => {
  assert.deepEqual(parseTemplate("{{inputs.target_branch}}"), [
    { type: "ref", ref: { ns: "inputs", key: "target_branch" } },
  ]);
  assert.equal(
    renderTemplate("branch={{inputs.target_branch}}", { inputs: { target_branch: "main" } }),
    "branch=main",
  );
});

test("tasks namespace parses and renders a result dotpath", () => {
  assert.deepEqual(parseTemplate("{{tasks.analyze.result.output.summary}}"), [
    { type: "ref", ref: { ns: "tasks", taskId: "analyze", path: ["output", "summary"] } },
  ]);
  assert.equal(
    renderTemplate("{{tasks.analyze.result.output.summary}}", {
      tasks: { analyze: { output: { summary: "looks good" } } },
    }),
    "looks good",
  );
});

test("item namespace supports whole-item and dotpath references", () => {
  assert.deepEqual(parseTemplate("{{item}}"), [{ type: "ref", ref: { ns: "item", path: [] } }]);
  assert.deepEqual(parseTemplate("{{item.name}}"), [
    { type: "ref", ref: { ns: "item", path: ["name"] } },
  ]);
  assert.equal(renderTemplate("{{item}}", { item: "alpha" }), "alpha");
  assert.equal(renderTemplate("{{item.name}}", { item: { name: "alpha" } }), "alpha");
});

test("gate_feedback namespace parses and renders", () => {
  assert.deepEqual(parseTemplate("{{gate_feedback}}"), [
    { type: "ref", ref: { ns: "gate_feedback" } },
  ]);
  assert.equal(renderTemplate("fb:{{gate_feedback}}", { gate_feedback: "" }), "fb:");
  assert.equal(renderTemplate("{{gate_feedback}}", { gate_feedback: "exit 1" }), "exit 1");
});

test("taskId containing dots splits at the first .result. occurrence", () => {
  assert.deepEqual(listRefs("{{tasks.build.v1.result.output.value}}"), [
    { ns: "tasks", taskId: "build.v1", path: ["output", "value"] },
  ]);
  // "result" is also a valid dotpath ident after the separator.
  assert.deepEqual(listRefs("{{tasks.a.result.b.result.c}}"), [
    { ns: "tasks", taskId: "a", path: ["b", "result", "c"] },
  ]);
});

test("tasks reference without a dotpath after result is a syntax error", () => {
  assert.throws(() => parseTemplate("{{tasks.x.result}}"), TemplateSyntaxError);
  assert.throws(() => parseTemplate("{{tasks.x.result.}}"), TemplateSyntaxError);
  assert.throws(() => parseTemplate("{{tasks.x}}"), TemplateSyntaxError);
});

test("whitespace inside a reference is rejected", () => {
  assert.throws(() => parseTemplate("{{ objective }}"), TemplateSyntaxError);
  assert.throws(() => parseTemplate("{{objective }}"), TemplateSyntaxError);
  assert.throws(() => parseTemplate("{{tasks.a .result.b}}"), TemplateSyntaxError);
});

test("unknown namespaces are rejected", () => {
  assert.throws(() => parseTemplate("{{output}}"), TemplateSyntaxError);
  assert.throws(() => parseTemplate("{{env.HOME}}"), TemplateSyntaxError);
  assert.throws(() => parseTemplate("{{inputs}}"), TemplateSyntaxError);
  assert.throws(() => parseTemplate("{{}}"), TemplateSyntaxError);
});

test("unterminated {{ is a syntax error with the opener index", () => {
  assert.throws(() => parseTemplate("hello {{objective"), (error) => {
    assert.ok(error instanceof TemplateSyntaxError);
    assert.equal(error.index, 6);
    assert.match(error.message, /Unterminated/);
    return true;
  });
});

test("lone braces and }} without an opener stay plain text", () => {
  const text = "a { b } c }} d {e}";
  assert.deepEqual(parseTemplate(text), [{ type: "text", value: text }]);
  assert.equal(renderTemplate(text, {}), text);
});

test("render serializes number, boolean, object, and array per spec", () => {
  const context = {
    tasks: {
      t: { output: { count: 3, ok: true, meta: { a: 1 }, list: [1, "x"] } },
    },
  };
  assert.equal(renderTemplate("{{tasks.t.result.output.count}}", context), "3");
  assert.equal(renderTemplate("{{tasks.t.result.output.ok}}", context), "true");
  assert.equal(renderTemplate("{{tasks.t.result.output.meta}}", context), '{"a":1}');
  assert.equal(renderTemplate("{{tasks.t.result.output.list}}", context), '[1,"x"]');
});

test("null or missing values throw TemplateRenderError", () => {
  assert.throws(() => renderTemplate("{{objective}}", {}), TemplateRenderError);
  assert.throws(
    () => renderTemplate("{{inputs.key}}", { inputs: { key: null } }),
    TemplateRenderError,
  );
  assert.throws(
    () => renderTemplate("{{tasks.t.result.missing}}", { tasks: { t: { other: 1 } } }),
    TemplateRenderError,
  );
});

test("unresolved task throws TemplateRenderError", () => {
  assert.throws(
    () => renderTemplate("{{tasks.ghost.result.output}}", { tasks: {} }),
    TemplateRenderError,
  );
  assert.throws(() => renderTemplate("{{tasks.ghost.result.output}}", {}), TemplateRenderError);
});

test("listRefs returns refs in order and TEMPLATE_NAMESPACES is complete", () => {
  assert.deepEqual(listRefs("{{objective}} and {{inputs.a}} and {{item}}"), [
    { ns: "objective" },
    { ns: "inputs", key: "a" },
    { ns: "item", path: [] },
  ]);
  assert.deepEqual(
    [...TEMPLATE_NAMESPACES].sort(),
    ["gate_feedback", "inputs", "item", "objective", "tasks"],
  );
});
