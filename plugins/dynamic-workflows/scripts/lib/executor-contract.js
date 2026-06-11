export const MODEL_VALUE_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$";
export const MODEL_VALUE_PATTERN = new RegExp(MODEL_VALUE_PATTERN_SOURCE);
export const ARGV_SAFE_VALUE_PATTERN = /^[^\s\x00-\x1f\x7f-\x9f-][^\s\x00-\x1f\x7f-\x9f]{0,511}$/;
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export const EXECUTOR_FIELD_CONTRACT = {
  model: { codex: true, claude: true, local: false },
  effort: { codex: false, claude: true, local: false },
  profile: { codex: true, claude: false, local: false },
};

export const EXECUTOR_KIND_MATCHERS = {
  codex: "^codex",
  claude: "^claude",
  local: "^(?!codex|claude)",
};

export function pushSafeWorkerArg(args, flag, value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  if (!ARGV_SAFE_VALUE_PATTERN.test(value)) {
    throw new Error(`${label} must be argv-safe: non-empty, no leading "-", no whitespace/control characters, max 512 chars`);
  }
  args.push(flag, value);
  return true;
}
