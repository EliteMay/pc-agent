const PROTOCOL_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class CommandEnvelopeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CommandEnvelopeError";
    this.code = code;
  }
}

function requireId(value, fieldName) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new CommandEnvelopeError(
      `${fieldName} is required and must be a valid identifier.`,
      `INVALID_${fieldName.toUpperCase()}`
    );
  }

  return value;
}

function parseTimestamp(value, fieldName) {
  if (typeof value !== "string") {
    throw new CommandEnvelopeError(
      `${fieldName} must be an ISO timestamp.`,
      `INVALID_${fieldName.toUpperCase()}`
    );
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new CommandEnvelopeError(
      `${fieldName} must be an ISO timestamp.`,
      `INVALID_${fieldName.toUpperCase()}`
    );
  }

  return timestamp;
}

export function validateCommandEnvelope(command, { now = new Date() } = {}) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new CommandEnvelopeError("Command must be an object.", "INVALID_COMMAND");
  }

  const commandId = requireId(command.command_id, "command_id");
  const operationId = requireId(command.operation_id, "operation_id");

  if (typeof command.tool !== "string" || !TOOL_PATTERN.test(command.tool)) {
    throw new CommandEnvelopeError("tool is invalid.", "INVALID_TOOL");
  }

  if (command.protocol_version !== PROTOCOL_VERSION) {
    throw new CommandEnvelopeError(
      `Unsupported protocol_version: ${String(command.protocol_version)}`,
      "UNSUPPORTED_PROTOCOL_VERSION"
    );
  }

  if (!command.args || typeof command.args !== "object" || Array.isArray(command.args)) {
    throw new CommandEnvelopeError("args must be an object.", "INVALID_ARGS");
  }

  const createdAt = parseTimestamp(command.created_at, "created_at");
  const expiresAt = parseTimestamp(command.expires_at, "expires_at");

  if (createdAt > expiresAt) {
    throw new CommandEnvelopeError(
      "created_at must not be after expires_at.",
      "INVALID_TIME_WINDOW"
    );
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);

  if (!Number.isFinite(nowMs)) {
    throw new TypeError("now must be a valid Date or timestamp.");
  }

  if (expiresAt <= nowMs) {
    throw new CommandEnvelopeError("Command has expired.", "COMMAND_EXPIRED");
  }

  return Object.freeze({
    command_id: commandId,
    operation_id: operationId,
    tool: command.tool,
    protocol_version: PROTOCOL_VERSION,
    created_at: command.created_at,
    expires_at: command.expires_at,
    args: Object.freeze({ ...command.args })
  });
}

export const protocolVersion = PROTOCOL_VERSION;
