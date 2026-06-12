// Standalone template engine for the {{...}} reference grammar (spec §3.1 / §3.4).
// Pure module: no imports from other lib files.

const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SPEC_ID_PATTERN = /^(?!\.+$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPEN = "{{";
const CLOSE = "}}";
const RESULT_SEPARATOR = ".result.";

export const TEMPLATE_NAMESPACES = Object.freeze(
  new Set(["objective", "inputs", "tasks", "item", "gate_feedback"]),
);

export class TemplateSyntaxError extends Error {
  constructor(message, index, details = {}) {
    super(message);
    this.name = "TemplateSyntaxError";
    this.index = index;
    this.details = details;
  }
}

export class TemplateRenderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TemplateRenderError";
    this.details = details;
  }
}

export function parseTemplate(str) {
  if (typeof str !== "string") {
    throw new TemplateSyntaxError("Template must be a string.", 0);
  }
  const segments = [];
  let cursor = 0;
  while (cursor < str.length) {
    const openIndex = str.indexOf(OPEN, cursor);
    if (openIndex === -1) {
      segments.push({ type: "text", value: str.slice(cursor) });
      break;
    }
    if (openIndex > cursor) {
      segments.push({ type: "text", value: str.slice(cursor, openIndex) });
    }
    const closeIndex = str.indexOf(CLOSE, openIndex + OPEN.length);
    if (closeIndex === -1) {
      throw new TemplateSyntaxError(
        `Unterminated template reference: "${OPEN}" at index ${openIndex} has no matching "${CLOSE}".`,
        openIndex,
      );
    }
    const body = str.slice(openIndex + OPEN.length, closeIndex);
    segments.push({ type: "ref", ref: parseRefBody(body, openIndex) });
    cursor = closeIndex + CLOSE.length;
  }
  return segments;
}

export function listRefs(str) {
  return parseTemplate(str)
    .filter((segment) => segment.type === "ref")
    .map((segment) => segment.ref);
}

export function renderTemplate(str, context = {}) {
  const segments = parseTemplate(str);
  let output = "";
  for (const segment of segments) {
    if (segment.type === "text") {
      output += segment.value;
    } else {
      output += serializeValue(resolveRef(segment.ref, context), segment.ref);
    }
  }
  return output;
}

function parseRefBody(body, index) {
  if (body === "") {
    throw new TemplateSyntaxError("Empty template reference.", index);
  }
  if (/\s/.test(body)) {
    throw new TemplateSyntaxError(
      `Whitespace is not allowed inside a template reference: "${OPEN}${body}${CLOSE}".`,
      index,
    );
  }
  if (body === "objective") {
    return { ns: "objective" };
  }
  if (body === "gate_feedback") {
    return { ns: "gate_feedback" };
  }
  if (body === "item") {
    return { ns: "item", path: [] };
  }
  if (body.startsWith("item.")) {
    return { ns: "item", path: parseDotpath(body.slice("item.".length), body, index) };
  }
  if (body.startsWith("inputs.")) {
    const key = body.slice("inputs.".length);
    if (!IDENT_PATTERN.test(key)) {
      throw new TemplateSyntaxError(
        `Invalid inputs reference "${OPEN}${body}${CLOSE}": key must be a single identifier matching ${IDENT_PATTERN}.`,
        index,
      );
    }
    return { ns: "inputs", key };
  }
  if (body.startsWith("tasks.")) {
    return parseTasksRef(body, index);
  }
  const head = body.split(".", 1)[0];
  if (TEMPLATE_NAMESPACES.has(head)) {
    throw new TemplateSyntaxError(
      `Incomplete "${head}" reference: "${OPEN}${body}${CLOSE}" does not match the template grammar.`,
      index,
    );
  }
  throw new TemplateSyntaxError(
    `Unknown template namespace "${head}" in "${OPEN}${body}${CLOSE}". Valid namespaces: ${[...TEMPLATE_NAMESPACES].join(", ")}.`,
    index,
  );
}

function parseTasksRef(body, index) {
  const rest = body.slice("tasks.".length);
  const separatorIndex = rest.indexOf(RESULT_SEPARATOR);
  if (separatorIndex === -1) {
    if (rest === "result" || rest.endsWith(".result")) {
      throw new TemplateSyntaxError(
        `Invalid tasks reference "${OPEN}${body}${CLOSE}": a non-empty dotpath is required after ".result".`,
        index,
      );
    }
    throw new TemplateSyntaxError(
      `Invalid tasks reference "${OPEN}${body}${CLOSE}": expected the form tasks.<taskId>.result.<dotpath>.`,
      index,
    );
  }
  const taskId = rest.slice(0, separatorIndex);
  if (!SPEC_ID_PATTERN.test(taskId)) {
    throw new TemplateSyntaxError(
      `Invalid tasks reference "${OPEN}${body}${CLOSE}": task id "${taskId}" does not match ${SPEC_ID_PATTERN}.`,
      index,
    );
  }
  const path = parseDotpath(rest.slice(separatorIndex + RESULT_SEPARATOR.length), body, index);
  return { ns: "tasks", taskId, path };
}

function parseDotpath(raw, body, index) {
  const path = raw.split(".");
  for (const segment of path) {
    if (!IDENT_PATTERN.test(segment)) {
      throw new TemplateSyntaxError(
        `Invalid dotpath segment "${segment}" in "${OPEN}${body}${CLOSE}": segments must match ${IDENT_PATTERN}.`,
        index,
      );
    }
  }
  return path;
}

function resolveRef(ref, context) {
  switch (ref.ns) {
    case "objective":
      return requireValue(context.objective, ref, "objective");
    case "gate_feedback":
      return requireValue(context.gate_feedback, ref, "gate_feedback");
    case "inputs": {
      const inputs = context.inputs;
      if (inputs == null || typeof inputs !== "object" || !Object.hasOwn(inputs, ref.key)) {
        throw unresolved(ref, `inputs.${ref.key}`);
      }
      return requireValue(inputs[ref.key], ref, `inputs.${ref.key}`);
    }
    case "item":
      return walkPath(requireValue(context.item, ref, "item"), ref.path, ref, "item");
    case "tasks": {
      const tasks = context.tasks;
      if (tasks == null || typeof tasks !== "object" || !Object.hasOwn(tasks, ref.taskId)) {
        throw unresolved(ref, `tasks.${ref.taskId}`);
      }
      const root = requireValue(tasks[ref.taskId], ref, `tasks.${ref.taskId}`);
      return walkPath(root, ref.path, ref, `tasks.${ref.taskId}.result`);
    }
    default:
      throw new TemplateRenderError(`Unknown reference namespace "${ref.ns}".`, { ref });
  }
}

function walkPath(root, path, ref, label) {
  let current = root;
  let where = label;
  for (const segment of path) {
    if (current == null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      throw unresolved(ref, `${where}.${segment}`);
    }
    current = current[segment];
    where = `${where}.${segment}`;
  }
  return requireValue(current, ref, where);
}

function requireValue(value, ref, label) {
  if (value == null) {
    throw unresolved(ref, label);
  }
  return value;
}

function unresolved(ref, label) {
  return new TemplateRenderError(
    `Template reference "${label}" resolved to a missing or null value (contract violation).`,
    { ref },
  );
}

function serializeValue(value, ref) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  throw new TemplateRenderError(
    `Template reference resolved to an unserializable ${typeof value} value.`,
    { ref },
  );
}
