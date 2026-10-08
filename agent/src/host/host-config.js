import path from "node:path";

export class HostConfigurationError extends Error {
  constructor(message, code = "HOST_CONFIGURATION_ERROR") {
    super(message);
    this.name = "HostConfigurationError";
    this.code = code;
  }
}

function required(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HostConfigurationError(
      key + " is required.",
      "MISSING_" + key
    );
  }
  return value.trim();
}

function parseAllowedRoots(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new HostConfigurationError(
      "PC_AGENT_ALLOWED_ROOTS_JSON must be valid JSON.",
      "INVALID_ALLOWED_ROOTS"
    );
  }

  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((entry) => typeof entry !== "string" || !path.win32.isAbsolute(entry))
  ) {
    throw new HostConfigurationError(
      "PC_AGENT_ALLOWED_ROOTS_JSON must contain at least one absolute Windows path.",
      "INVALID_ALLOWED_ROOTS"
    );
  }

  return Object.freeze([...new Set(parsed.map((entry) => path.win32.normalize(entry)))]);
}

export function loadHostConfiguration(env = process.env) {
  const endpointUrl = required(env, "PC_AGENT_ENDPOINT");
  const deviceId = required(env, "PC_AGENT_DEVICE_ID");
  const deviceToken = required(env, "PC_AGENT_DEVICE_TOKEN");
  const journalPath = required(env, "PC_AGENT_JOURNAL_PATH");
  const pipeName = required(env, "PC_AGENT_PIPE_NAME");
  const localApprovalSecret = required(env, "PC_AGENT_LOCAL_APPROVAL_SECRET");
  const allowedRoots = parseAllowedRoots(required(env, "PC_AGENT_ALLOWED_ROOTS_JSON"));

  if (!/^[a-f0-9]{64}$/i.test(localApprovalSecret)) {
    throw new HostConfigurationError(
      "PC_AGENT_LOCAL_APPROVAL_SECRET must be a 32-byte hex key.",
      "INVALID_LOCAL_APPROVAL_SECRET"
    );
  }

  let endpoint;
  try {
    endpoint = new URL(endpointUrl);
  } catch (error) {
    throw new HostConfigurationError(
      "PC_AGENT_ENDPOINT must be a valid HTTPS URL.",
      "INVALID_ENDPOINT"
    );
  }

  if (endpoint.protocol !== "https:") {
    throw new HostConfigurationError(
      "PC_AGENT_ENDPOINT must use HTTPS.",
      "INVALID_ENDPOINT"
    );
  }

  return Object.freeze({
    endpointUrl: endpoint.toString().replace(/\/$/, ""),
    deviceId,
    deviceToken,
    journalPath,
    pipeName,
    localApprovalSecret,
    allowedRoots,
    version: env.PC_AGENT_VERSION?.trim() || "0.3.0"
  });
}
