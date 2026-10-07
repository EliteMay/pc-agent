import { isSensitivePath } from "../security/path-policy.js";

export class ReadOnlyToolError extends Error {
  constructor(message, code = "READ_ONLY_TOOL_ERROR", options = undefined) {
    super(message, options);
    this.name = "ReadOnlyToolError";
    this.code = code;
  }
}

export function requireObjectArgs(args, allowedKeys) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ReadOnlyToolError("Tool args must be an object.", "INVALID_ARGUMENTS");
  }

  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(args).filter((key) => !allowed.has(key));

  if (unexpected.length > 0) {
    throw new ReadOnlyToolError(
      "Unexpected tool args: " + unexpected.join(", "),
      "INVALID_ARGUMENTS"
    );
  }

  return args;
}

export function requirePathArg(args) {
  requireObjectArgs(args, ["path"]);

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    throw new ReadOnlyToolError("path must be a non-empty string.", "INVALID_ARGUMENTS");
  }

  return args.path;
}

export function requireWindows() {
  if (process.platform !== "win32") {
    throw new ReadOnlyToolError(
      "This PC Agent build currently supports Windows only.",
      "UNSUPPORTED_PLATFORM"
    );
  }
}

export function requirePositiveInteger(value, { name, defaultValue, maximum }) {
  const resolved = value ?? defaultValue;

  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new ReadOnlyToolError(
      name + " must be an integer between 1 and " + maximum + ".",
      "INVALID_CONFIGURATION"
    );
  }

  return resolved;
}

export function assertNonSensitivePath(requestedPath, canonicalPath) {
  if (isSensitivePath(requestedPath) || isSensitivePath(canonicalPath)) {
    throw new ReadOnlyToolError(
      "Sensitive paths are not available to read-only tools.",
      "SENSITIVE_PATH"
    );
  }
}
