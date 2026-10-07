import { createHash } from "node:crypto";
import { isSensitivePath } from "../security/path-policy.js";

export class SafeWriteToolError extends Error {
  constructor(message, code = "SAFE_WRITE_TOOL_ERROR", options = undefined) {
    super(message, options);
    this.name = "SafeWriteToolError";
    this.code = code;
  }
}

export function requireWriteArgs(args, allowedKeys) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new SafeWriteToolError(
      "Tool args must be an object.",
      "INVALID_ARGUMENTS"
    );
  }

  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(args).filter((key) => !allowed.has(key));

  if (unexpected.length > 0) {
    throw new SafeWriteToolError(
      "Unexpected tool args: " + unexpected.join(", "),
      "INVALID_ARGUMENTS"
    );
  }

  return args;
}

export function requireWritePath(args, allowedKeys = ["path"]) {
  requireWriteArgs(args, allowedKeys);

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    throw new SafeWriteToolError(
      "path must be a non-empty string.",
      "INVALID_ARGUMENTS"
    );
  }

  return args.path;
}

export function requireWindowsForWrite() {
  if (process.platform !== "win32") {
    throw new SafeWriteToolError(
      "Safe write tools currently support Windows only.",
      "UNSUPPORTED_PLATFORM"
    );
  }
}

export function assertWritableNonSensitivePath(requestedPath, canonicalPath) {
  if (isSensitivePath(requestedPath) || isSensitivePath(canonicalPath)) {
    throw new SafeWriteToolError(
      "Sensitive paths cannot be modified.",
      "SENSITIVE_PATH"
    );
  }
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function validateExpectedSha256(value, { allowNull = true } = {}) {
  if (allowNull && value === null) {
    return null;
  }

  if (
    typeof value !== "string"
    || !/^[a-f0-9]{64}$/i.test(value)
  ) {
    throw new SafeWriteToolError(
      "expected_sha256 must be a 64-character SHA-256 hex string.",
      "INVALID_EXPECTED_HASH"
    );
  }

  return value.toLowerCase();
}
