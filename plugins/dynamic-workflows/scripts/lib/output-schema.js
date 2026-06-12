import { isPlainObject } from "./util.js";

// Restricted output_schema DSL (v2). The accepted subset is the intersection
// of codex --output-schema (OpenAI strict mode) and claude --json-schema
// (StructuredOutput tool): whitelist keywords only, runner-generated
// required/additionalProperties, and conservative size limits.

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const NODE_TYPES = new Set(["object", "array", ...SCALAR_TYPES]);
const PROPERTY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_NESTING_DEPTH = 4;
const MAX_TOTAL_PROPERTIES = 64;
const MAX_NULLABLE_UNIONS = 8;
const MAX_SERIALIZED_BYTES = 32 * 1024;
const MAX_ENUM_VALUES = 20;
const MAX_ENUM_VALUE_LENGTH = 64;

const FORBIDDEN_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "const",
  "pattern",
  "format",
  "default",
  "contains",
  "patternProperties",
  "propertyNames",
]);
const FORBIDDEN_KEYWORD_PREFIXES = ["min", "max", "unique", "unevaluated", "dependent"];
// required and additionalProperties are runner-generated: they are accepted
// only in the exact normalized form so stored (already normalized) specs
// re-validate cleanly; any other user-written value is rejected.
const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "items",
  "enum",
  "description",
  "title",
  "required",
  "additionalProperties",
]);

// Strict-mode schema for the model's final message: codex exec --output-schema
// requires additionalProperties:false and every property listed in required.
// task_id and attempt_id are injected by the runner, never trusted from the model.
export const WORKER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "findings",
    "errors",
    "evidence",
    "modified_files",
    "commands_run",
    "artifacts",
  ],
  properties: {
    status: { type: "string", enum: ["succeeded", "failed"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "claim",
          "evidence",
          "source_files",
          "confidence",
          "severity",
          "verification_status",
          "verifier_notes",
          "rejection_reason",
        ],
        properties: {
          claim: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          source_files: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          severity: { type: "string" },
          verification_status: {
            type: "string",
            enum: ["unverified", "verified", "rejected", "unresolved"],
          },
          verifier_notes: { type: "string" },
          rejection_reason: { type: ["string", "null"] },
        },
      },
    },
    errors: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    modified_files: { type: "array", items: { type: "string" } },
    commands_run: { type: "array", items: { type: "string" } },
    artifacts: { type: "array", items: { type: "string" } },
  },
};

export function validateOutputSchemaDecl(schema) {
  const errors = [];
  if (!isPlainObject(schema)) {
    return { errors: ["output_schema must be a JSON object"], normalized: null };
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
  if (serializedBytes > MAX_SERIALIZED_BYTES) {
    return {
      errors: [`output_schema serializes to ${serializedBytes} bytes; limit is ${MAX_SERIALIZED_BYTES}`],
      normalized: null,
    };
  }
  if (schema.type !== "object") {
    errors.push('output_schema root must declare type: "object"');
  }
  const counters = { properties: 0, nullableUnions: 0 };
  validateNode(schema, "output_schema", 1, counters, errors);
  if (counters.properties > MAX_TOTAL_PROPERTIES) {
    errors.push(`output_schema declares ${counters.properties} properties; limit is ${MAX_TOTAL_PROPERTIES}`);
  }
  if (counters.nullableUnions > MAX_NULLABLE_UNIONS) {
    errors.push(`output_schema declares ${counters.nullableUnions} nullable unions; limit is ${MAX_NULLABLE_UNIONS}`);
  }
  if (errors.length > 0) {
    return { errors, normalized: null };
  }
  return { errors, normalized: normalizeNode(schema) };
}

function validateNode(node, label, depth, counters, errors) {
  if (!isPlainObject(node)) {
    errors.push(`${label} must be a schema object`);
    return;
  }
  if (depth > MAX_NESTING_DEPTH) {
    errors.push(`${label} exceeds the maximum nesting depth of ${MAX_NESTING_DEPTH}`);
    return;
  }
  for (const keyword of Object.keys(node)) {
    if (ALLOWED_KEYWORDS.has(keyword)) {
      continue;
    }
    if (
      FORBIDDEN_KEYWORDS.has(keyword) ||
      FORBIDDEN_KEYWORD_PREFIXES.some((prefix) => keyword.startsWith(prefix))
    ) {
      errors.push(`${label} uses forbidden keyword "${keyword}"`);
    } else {
      errors.push(`${label} uses unsupported keyword "${keyword}"`);
    }
  }
  const type = node.type;
  let resolvedType;
  if (Array.isArray(type)) {
    if (type.length === 2 && SCALAR_TYPES.has(type[0]) && type[1] === "null") {
      counters.nullableUnions += 1;
      resolvedType = type[0];
    } else {
      errors.push(`${label} type union must have the form ["<scalar>", "null"]`);
      return;
    }
  } else if (typeof type === "string" && NODE_TYPES.has(type)) {
    resolvedType = type;
  } else {
    errors.push(
      `${label} type must be one of: object, array, string, number, integer, boolean (or a ["<scalar>", "null"] union)`,
    );
    return;
  }
  if (node.description !== undefined && typeof node.description !== "string") {
    errors.push(`${label} description must be a string`);
  }
  if (node.title !== undefined && typeof node.title !== "string") {
    errors.push(`${label} title must be a string`);
  }
  if (node.enum !== undefined) {
    if (Array.isArray(type) || resolvedType !== "string") {
      errors.push(`${label} enum is only supported on type "string"`);
    } else if (!Array.isArray(node.enum) || node.enum.length === 0) {
      errors.push(`${label} enum must be a non-empty array of strings`);
    } else {
      if (node.enum.length > MAX_ENUM_VALUES) {
        errors.push(`${label} enum has ${node.enum.length} values; limit is ${MAX_ENUM_VALUES}`);
      }
      for (const value of node.enum) {
        if (typeof value !== "string") {
          errors.push(`${label} enum values must be strings`);
          break;
        }
        if (value.length > MAX_ENUM_VALUE_LENGTH) {
          errors.push(`${label} enum values must be at most ${MAX_ENUM_VALUE_LENGTH} characters`);
          break;
        }
      }
    }
  }
  if (resolvedType === "object" && !Array.isArray(type)) {
    if (!isPlainObject(node.properties) || Object.keys(node.properties).length === 0) {
      errors.push(`${label} of type object must declare a non-empty properties object`);
    } else {
      const names = Object.keys(node.properties);
      counters.properties += names.length;
      for (const name of names) {
        if (!PROPERTY_NAME_PATTERN.test(name)) {
          errors.push(`${label} property name "${name}" must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
        }
        validateNode(node.properties[name], `${label}.${name}`, depth + 1, counters, errors);
      }
      if (node.required !== undefined && !isCanonicalRequired(node.required, names)) {
        errors.push(`${label} must not declare "required"; the runner generates it from the property names`);
      }
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      errors.push(`${label} must not declare "additionalProperties"; the runner injects false`);
    }
    if (node.items !== undefined) {
      errors.push(`${label} items is only supported on type "array"`);
    }
  } else {
    for (const keyword of ["properties", "required", "additionalProperties"]) {
      if (node[keyword] !== undefined) {
        errors.push(`${label} ${keyword} is only supported on type "object"`);
      }
    }
    if (resolvedType === "array") {
      if (node.items === undefined) {
        errors.push(`${label} of type array must declare items`);
      } else if (Array.isArray(node.items)) {
        errors.push(`${label} items must be a single schema (tuple form is not supported)`);
      } else {
        validateNode(node.items, `${label}.items`, depth + 1, counters, errors);
      }
    } else if (node.items !== undefined) {
      errors.push(`${label} items is only supported on type "array"`);
    }
  }
}

function isCanonicalRequired(required, names) {
  return (
    Array.isArray(required) &&
    required.length === names.length &&
    [...required].sort().join("\n") === [...names].sort().join("\n")
  );
}

function normalizeNode(node) {
  const type = node.type;
  const resolvedType = Array.isArray(type) ? type[0] : type;
  const normalized = {
    type: Array.isArray(type) ? [...type] : type,
    ...(node.title !== undefined ? { title: node.title } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
  };
  if (node.enum !== undefined) {
    normalized.enum = [...node.enum];
  }
  if (resolvedType === "object" && !Array.isArray(type)) {
    const properties = {};
    for (const [name, child] of Object.entries(node.properties)) {
      properties[name] = normalizeNode(child);
    }
    normalized.properties = properties;
    normalized.required = Object.keys(properties);
    normalized.additionalProperties = false;
  } else if (resolvedType === "array") {
    normalized.items = normalizeNode(node.items);
  }
  return normalized;
}

// Per-task worker schema synthesis (envelope v2). Tasks without output_schema
// keep the fixed default form; tasks with a (normalized) output_schema get the
// slim typed form. The worker-facing schema never includes task_id/attempt_id
// (the runner injects them); includeIdentity adds them for envelope validation
// of the merged result. extraProperties lets later features inject additional
// envelope fields without rewriting the synthesis; route tasks (F4, spec §2.2)
// gain a required `route` string enum that way, derived from the task itself
// so every synthesis site (executors, result validation, template-ref
// validation) agrees on the envelope shape.
export function synthesizeWorkerSchema(task, options = {}) {
  const routeProperties = isPlainObject(task?.route) && Array.isArray(task.route.values)
    ? { route: { type: "string", enum: [...task.route.values] } }
    : {};
  const extraProperties = { ...routeProperties, ...(options.extraProperties ?? {}) };
  const identity = options.includeIdentity === true
    ? { task_id: { type: "string" }, attempt_id: { type: "string" } }
    : {};
  const properties = task?.output_schema != null
    ? {
        ...identity,
        status: { type: "string", enum: ["succeeded", "failed"] },
        summary: { type: "string" },
        errors: { type: "array", items: { type: "string" } },
        ...extraProperties,
        output: task.output_schema,
      }
    : {
        ...identity,
        ...WORKER_OUTPUT_SCHEMA.properties,
        ...extraProperties,
      };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

// Small recursive interpreter for the restricted subset above; used by the
// runner to double-validate worker output against the normalized schema.
export function validateValueAgainstSchema(value, schema, label = "value") {
  const errors = [];
  checkValue(value, schema, label, errors);
  return { valid: errors.length === 0, errors };
}

function checkValue(value, schema, label, errors) {
  if (!isPlainObject(schema)) {
    errors.push(`${label} has no schema to validate against`);
    return;
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    if (value === null) {
      return;
    }
    checkScalar(value, schema, type[0], label, errors);
    return;
  }
  if (type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : Object.keys(properties);
    for (const name of required) {
      if (!(name in value)) {
        errors.push(`${label}.${name} is required`);
      }
    }
    for (const [name, entry] of Object.entries(value)) {
      if (!(name in properties)) {
        errors.push(`${label}.${name} is not declared in the schema`);
        continue;
      }
      checkValue(entry, properties[name], `${label}.${name}`, errors);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${label} must be an array`);
      return;
    }
    value.forEach((entry, index) => checkValue(entry, schema.items, `${label}[${index}]`, errors));
    return;
  }
  checkScalar(value, schema, type, label, errors);
}

function checkScalar(value, schema, scalarType, label, errors) {
  switch (scalarType) {
    case "string":
      if (typeof value !== "string") {
        errors.push(`${label} must be a string`);
      } else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`${label} must be one of: ${schema.enum.join(", ")}`);
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${label} must be a finite number`);
      }
      return;
    case "integer":
      if (!Number.isInteger(value)) {
        errors.push(`${label} must be an integer`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`${label} must be a boolean`);
      }
      return;
    default:
      errors.push(`${label} has unsupported schema type: ${scalarType}`);
  }
}
