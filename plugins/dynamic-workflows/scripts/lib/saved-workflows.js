// Spec-file reading (JSON/YAML, F1) and saved workflow templates with typed
// inputs (F5). Saved workflows live under <CCDW_HOME>/workflows and expand
// {{inputs.*}} references before entering the normal spec pipeline.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import {
  CCDW_HOME_ENV,
  DEFAULT_CCDW_HOME,
  WorkflowError,
} from "./constants.js";
import { hashBytes, isPlainObject, resolveWorkspacePath } from "./util.js";
import { parseTemplate } from "./template.js";

export const MAX_SPEC_FILE_BYTES = 1024 * 1024;
const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INPUT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INPUT_TYPES = new Set(["string", "integer", "number", "boolean"]);
// Lookup order is significant: ambiguity resolves to the first match.
const SAVED_WORKFLOW_EXTENSIONS = [".json", ".yaml", ".yml"];

// --- Spec file reading (shared by `plan --spec-file` and saved workflows) ----

export function readSpecFile(specFile) {
  const resolved = path.resolve(specFile);
  let size;
  try {
    size = fs.statSync(resolved).size;
  } catch (error) {
    throw new WorkflowError(`Could not read spec file: ${error.message}`, { specFile: resolved });
  }
  if (size > MAX_SPEC_FILE_BYTES) {
    throw new WorkflowError("Spec file exceeds the 1 MiB size limit.", {
      specFile: resolved,
      size_bytes: size,
      limit_bytes: MAX_SPEC_FILE_BYTES,
    });
  }
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new WorkflowError(`Could not read spec file: ${error.message}`, { specFile: resolved });
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension === ".yaml" || extension === ".yml") {
    return parseYamlSpec(raw, resolved);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new WorkflowError(`Spec file is not valid JSON: ${error.message}`, {
      specFile: resolved,
      hint: "The workflow spec must be a JSON object (phases[], tasks[], budgets).",
    });
  }
}

function parseYamlSpec(raw, resolved) {
  try {
    return parseYaml(raw, {
      version: "1.2",
      uniqueKeys: true,
      maxAliasCount: 0,
      prettyErrors: true,
    });
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const position = error.linePos?.[0];
      throw new WorkflowError(
        `${resolved}:${position?.line ?? 0}:${position?.col ?? 0}: ${error.message}`,
        {
          specFile: resolved,
          code: error.code,
          hint: "The workflow spec must be a YAML mapping (phases[], tasks[], budgets).",
        },
      );
    }
    // Alias resolution is disabled (maxAliasCount: 0) and surfaces as a
    // ReferenceError rather than a YAMLParseError.
    throw new WorkflowError(`Spec file is not valid YAML: ${error.message}`, {
      specFile: resolved,
      hint: "Anchors and aliases are not allowed in workflow specs.",
    });
  }
}

// --- Saved workflow loading --------------------------------------------------

export function loadSavedWorkflow({ name, inputs, workspace } = {}) {
  if (typeof name !== "string" || !SAVED_WORKFLOW_NAME_PATTERN.test(name)) {
    throw new WorkflowError("Saved workflow name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.", {
      workflow: name ?? null,
    });
  }
  const workflowsDir = resolveSavedWorkflowsDir(workspace);
  const templatePath = findTemplatePath(workflowsDir, name);
  const template = readSpecFile(templatePath);
  if (!isPlainObject(template)) {
    throw new WorkflowError("Saved workflow template must be an object.", {
      workflow: name,
      template_path: templatePath,
    });
  }
  const declarations = validateInputsDeclaration(template.inputs, name);
  const resolvedInputs = resolveInputs(declarations, inputs ?? {}, name);
  const spec = expandSavedWorkflowSpec(template, resolvedInputs, name);
  if (typeof spec.objective !== "string" || spec.objective.trim() === "") {
    throw new WorkflowError("Saved workflow template must declare an objective.", {
      workflow: name,
      template_path: templatePath,
    });
  }
  return {
    spec,
    provenance: {
      workflow_template: name,
      template_path: templatePath,
      template_hash: hashBytes(fs.readFileSync(templatePath)),
      inputs: resolvedInputs,
    },
  };
}

function resolveSavedWorkflowsDir(workspace) {
  const workspaceRoot = path.resolve(workspace ?? process.cwd());
  const configuredHome = process.env[CCDW_HOME_ENV]?.trim();
  const ccdwHome = configuredHome || DEFAULT_CCDW_HOME;
  return path.join(resolveWorkspacePath(ccdwHome, workspaceRoot), "workflows");
}

function findTemplatePath(workflowsDir, name) {
  const root = path.resolve(workflowsDir);
  const candidates = [];
  for (const extension of SAVED_WORKFLOW_EXTENSIONS) {
    const candidate = path.resolve(root, `${name}${extension}`);
    // Defense in depth: the name pattern already excludes separators, but the
    // resolved path must stay inside the workflows directory regardless.
    if (candidate === root || !candidate.startsWith(root + path.sep)) {
      throw new WorkflowError("Saved workflow name escapes the workflows directory.", {
        workflow: name,
        workflows_dir: root,
      });
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    candidates.push(candidate);
  }
  throw new WorkflowError("Saved workflow not found.", {
    workflow: name,
    searched: candidates,
  });
}

// --- Typed inputs -------------------------------------------------------------

function validateInputsDeclaration(declared, name) {
  if (declared === undefined) {
    return {};
  }
  if (!isPlainObject(declared)) {
    throw new WorkflowError("Saved workflow inputs declaration must be an object.", {
      workflow: name,
    });
  }
  const declarations = {};
  for (const [key, declaration] of Object.entries(declared)) {
    if (!INPUT_KEY_PATTERN.test(key)) {
      throw new WorkflowError(`Saved workflow input key "${key}" must match ^[A-Za-z_][A-Za-z0-9_]*$.`, {
        workflow: name,
      });
    }
    if (!isPlainObject(declaration)) {
      throw new WorkflowError(`Saved workflow input "${key}" declaration must be an object.`, {
        workflow: name,
      });
    }
    const { type, required, default: defaultValue, ...rest } = declaration;
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      throw new WorkflowError(`Saved workflow input "${key}" declaration has unsupported keys: ${unknownKeys.join(", ")}.`, {
        workflow: name,
      });
    }
    if (!INPUT_TYPES.has(type)) {
      throw new WorkflowError(`Saved workflow input "${key}" type must be one of: ${[...INPUT_TYPES].join(", ")}.`, {
        workflow: name,
        type: type ?? null,
      });
    }
    if (required !== undefined && typeof required !== "boolean") {
      throw new WorkflowError(`Saved workflow input "${key}" required must be a boolean.`, {
        workflow: name,
      });
    }
    if (defaultValue !== undefined && !matchesInputType(defaultValue, type)) {
      throw new WorkflowError(`Saved workflow input "${key}" default must match declared type "${type}".`, {
        workflow: name,
        default: defaultValue,
      });
    }
    declarations[key] = {
      type,
      required: required === true,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    };
  }
  return declarations;
}

function resolveInputs(declarations, provided, name) {
  if (!isPlainObject(provided)) {
    throw new WorkflowError("Saved workflow inputs must be an object of input values.", {
      workflow: name,
    });
  }
  const resolved = {};
  for (const [key, value] of Object.entries(provided)) {
    if (!Object.hasOwn(declarations, key)) {
      throw new WorkflowError(`Unknown input "${key}" for saved workflow.`, {
        workflow: name,
        declared: Object.keys(declarations),
      });
    }
    resolved[key] = coerceInputValue(key, value, declarations[key].type, name);
  }
  for (const [key, declaration] of Object.entries(declarations)) {
    if (Object.hasOwn(resolved, key)) {
      continue;
    }
    if (declaration.default !== undefined) {
      resolved[key] = declaration.default;
      continue;
    }
    if (declaration.required) {
      throw new WorkflowError(`Required input "${key}" is missing.`, { workflow: name });
    }
  }
  return resolved;
}

// CLI values arrive as strings and are coerced by declared type; MCP values
// arrive typed and are validated without coercion. The two paths are told
// apart by the runtime type of the provided value.
function coerceInputValue(key, value, type, name) {
  if (typeof value === "string" && type !== "string") {
    switch (type) {
      case "integer": {
        const parsed = value.trim() === "" ? NaN : Number(value);
        if (!Number.isInteger(parsed)) {
          throw inputTypeMismatch(key, type, value, name);
        }
        return parsed;
      }
      case "number": {
        const parsed = value.trim() === "" ? NaN : Number(value);
        if (!Number.isFinite(parsed)) {
          throw inputTypeMismatch(key, type, value, name);
        }
        return parsed;
      }
      case "boolean": {
        if (value === "true") {
          return true;
        }
        if (value === "false") {
          return false;
        }
        throw inputTypeMismatch(key, type, value, name);
      }
      default:
        throw inputTypeMismatch(key, type, value, name);
    }
  }
  if (!matchesInputType(value, type)) {
    throw inputTypeMismatch(key, type, value, name);
  }
  return value;
}

function inputTypeMismatch(key, type, value, name) {
  return new WorkflowError(`Input "${key}" must match declared type "${type}".`, {
    workflow: name,
    value,
  });
}

function matchesInputType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}

// --- Expansion ----------------------------------------------------------------

// Substitute only {{inputs.*}} references in the objective and the per-task
// prompt_template fields. In prompt_template every other reference is
// re-emitted verbatim so the normal plan-time validation and runtime
// rendering still see it; the objective allows {{inputs.*}} ONLY (semantics
// spec §3.2), so any other namespace there is a plan-time error. The `inputs`
// declaration is stripped: the engine spec has no such field.
function expandSavedWorkflowSpec(template, resolvedInputs, name) {
  const spec = { ...template };
  delete spec.inputs;
  if (typeof spec.objective === "string") {
    spec.objective = expandInputsRefs(spec.objective, resolvedInputs, "objective", name, {
      inputsOnly: true,
    });
  }
  if (Array.isArray(spec.tasks)) {
    spec.tasks = spec.tasks.map((task) => {
      if (!isPlainObject(task) || typeof task.prompt_template !== "string") {
        return task;
      }
      return {
        ...task,
        prompt_template: expandInputsRefs(
          task.prompt_template,
          resolvedInputs,
          `task ${task.task_id} prompt_template`,
          name,
        ),
      };
    });
  }
  return spec;
}

function expandInputsRefs(text, resolvedInputs, label, name, { inputsOnly = false } = {}) {
  let segments;
  try {
    segments = parseTemplate(text);
  } catch (error) {
    throw new WorkflowError(`Saved workflow ${label} is not a valid template: ${error.message}`, {
      workflow: name,
    });
  }
  let output = "";
  for (const segment of segments) {
    if (segment.type === "text") {
      output += segment.value;
      continue;
    }
    if (segment.ref.ns !== "inputs") {
      if (inputsOnly) {
        throw new WorkflowError(
          `Saved workflow ${label} allows {{inputs.*}} references only; found ${refSourceText(segment.ref)}.`,
          { workflow: name },
        );
      }
      output += refSourceText(segment.ref);
      continue;
    }
    const key = segment.ref.key;
    if (!Object.hasOwn(resolvedInputs, key)) {
      throw new WorkflowError(
        `Saved workflow ${label} references input "${key}" which is undeclared or has no value.`,
        { workflow: name, input: key },
      );
    }
    output += serializeInputValue(resolvedInputs[key]);
  }
  return output;
}

// The grammar admits exactly one source text per parsed reference (no
// whitespace or alternate spellings), so reconstruction is byte-identical.
function refSourceText(ref) {
  switch (ref.ns) {
    case "objective":
      return "{{objective}}";
    case "gate_feedback":
      return "{{gate_feedback}}";
    case "item":
      return ref.path.length === 0 ? "{{item}}" : `{{item.${ref.path.join(".")}}}`;
    case "tasks":
      return `{{tasks.${ref.taskId}.result.${ref.path.join(".")}}}`;
    default:
      throw new WorkflowError(`Unknown template namespace "${ref.ns}" during expansion.`, { ref });
  }
}

function serializeInputValue(value) {
  return typeof value === "string" ? value : String(value);
}
