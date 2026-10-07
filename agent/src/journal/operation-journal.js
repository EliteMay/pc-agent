import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VALID_STATUSES = new Set([
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN_OUTCOME"
]);

export class OperationJournalError extends Error {
  constructor(message, code = "OPERATION_JOURNAL_ERROR") {
    super(message);
    this.name = "OperationJournalError";
    this.code = code;
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OperationJournalError(
      fieldName + " must be a non-empty string.",
      "INVALID_" + fieldName.toUpperCase()
    );
  }

  return value;
}

function toIsoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new OperationJournalError("Timestamp is invalid.", "INVALID_TIMESTAMP");
  }

  return date.toISOString();
}

function canonicalize(value, seen = new WeakSet()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }

  if (typeof value === "undefined") {
    return { $undefined: true };
  }

  if (typeof value === "function") {
    return { $function: value.name || "anonymous" };
  }

  if (typeof value === "symbol") {
    return { $symbol: String(value.description ?? "") };
  }

  if (value instanceof Error) {
    return {
      $error: value.name,
      code: typeof value.code === "string" ? value.code : null,
      message: value.message
    };
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return { $circular: true };
    }

    seen.add(value);

    try {
      if (Array.isArray(value)) {
        return value.map((entry) => canonicalize(entry, seen));
      }

      const result = {};
      for (const key of Object.keys(value).sort()) {
        result[key] = canonicalize(value[key], seen);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return String(value);
}

export function hashResult(value) {
  const canonicalJson = JSON.stringify(canonicalize(value));
  return createHash("sha256").update(canonicalJson).digest("hex");
}

function mapRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

export class OperationJournal {
  #database;
  #closed = false;

  constructor(databasePath) {
    requireNonEmptyString(databasePath, "databasePath");

    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }

    this.#database = new DatabaseSync(databasePath);
    this.#initialize();
    this.recoverInterruptedOperations();
  }

  #initialize() {
    this.#database.exec([
      "PRAGMA foreign_keys = ON;",
      "PRAGMA busy_timeout = 5000;",
      "PRAGMA synchronous = FULL;",
      "",
      "CREATE TABLE IF NOT EXISTS operations (",
      "  operation_id TEXT PRIMARY KEY,",
      "  command_id TEXT NOT NULL UNIQUE,",
      "  tool_name TEXT NOT NULL,",
      "  status TEXT NOT NULL CHECK (",
      "    status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN_OUTCOME')",
      "  ),",
      "  started_at TEXT NOT NULL,",
      "  completed_at TEXT,",
      "  result_hash TEXT,",
      "  error_code TEXT",
      ") STRICT;",
      "",
      "CREATE INDEX IF NOT EXISTS idx_operations_command_id",
      "  ON operations(command_id);",
      "",
      "CREATE INDEX IF NOT EXISTS idx_operations_status",
      "  ON operations(status);"
    ].join("\n"));
  }

  #assertOpen() {
    if (this.#closed) {
      throw new OperationJournalError("Operation journal is closed.", "JOURNAL_CLOSED");
    }
  }

  beginOperation({
    commandId,
    operationId,
    toolName,
    now = new Date()
  }) {
    this.#assertOpen();

    const command = requireNonEmptyString(commandId, "commandId");
    const operation = requireNonEmptyString(operationId, "operationId");
    const tool = requireNonEmptyString(toolName, "toolName");
    const startedAt = toIsoTimestamp(now);

    this.#database.exec("BEGIN IMMEDIATE");

    try {
      const existingOperation = this.#database
        .prepare([
          "SELECT",
          "  operation_id, command_id, tool_name, status,",
          "  started_at, completed_at, result_hash, error_code",
          "FROM operations",
          "WHERE operation_id = ?"
        ].join("\n"))
        .get(operation);

      if (existingOperation) {
        this.#database.exec("COMMIT");
        return Object.freeze({
          accepted: false,
          record: mapRow(existingOperation)
        });
      }

      const commandConflict = this.#database
        .prepare([
          "SELECT operation_id",
          "FROM operations",
          "WHERE command_id = ?"
        ].join("\n"))
        .get(command);

      if (commandConflict) {
        throw new OperationJournalError(
          "command_id \"" + command + "\" is already associated with operation_id \"" +
            commandConflict.operation_id + "\".",
          "COMMAND_ID_CONFLICT"
        );
      }

      this.#database
        .prepare([
          "INSERT INTO operations (",
          "  operation_id, command_id, tool_name, status, started_at",
          ")",
          "VALUES (?, ?, ?, 'RUNNING', ?)"
        ].join("\n"))
        .run(operation, command, tool, startedAt);

      const record = this.getOperation(operation);
      this.#database.exec("COMMIT");

      return Object.freeze({
        accepted: true,
        record
      });
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  getOperation(operationId) {
    this.#assertOpen();
    const operation = requireNonEmptyString(operationId, "operationId");

    return mapRow(
      this.#database
        .prepare([
          "SELECT",
          "  operation_id, command_id, tool_name, status,",
          "  started_at, completed_at, result_hash, error_code",
          "FROM operations",
          "WHERE operation_id = ?"
        ].join("\n"))
        .get(operation)
    );
  }

  markSucceeded(operationId, result, { now = new Date() } = {}) {
    this.#assertOpen();
    const operation = requireNonEmptyString(operationId, "operationId");
    const completedAt = toIsoTimestamp(now);
    const resultHash = hashResult(result);

    const update = this.#database
      .prepare([
        "UPDATE operations",
        "SET status = 'SUCCEEDED',",
        "    completed_at = ?,",
        "    result_hash = ?,",
        "    error_code = NULL",
        "WHERE operation_id = ?",
        "  AND status = 'RUNNING'"
      ].join("\n"))
      .run(completedAt, resultHash, operation);

    if (Number(update.changes) !== 1) {
      throw new OperationJournalError(
        "Cannot transition operation \"" + operation + "\" to SUCCEEDED.",
        "INVALID_STATUS_TRANSITION"
      );
    }

    return this.getOperation(operation);
  }

  markFailed(operationId, errorCode = "TOOL_FAILED", { now = new Date() } = {}) {
    this.#assertOpen();
    const operation = requireNonEmptyString(operationId, "operationId");
    const code = requireNonEmptyString(errorCode, "errorCode");
    const completedAt = toIsoTimestamp(now);

    const update = this.#database
      .prepare([
        "UPDATE operations",
        "SET status = 'FAILED',",
        "    completed_at = ?,",
        "    result_hash = NULL,",
        "    error_code = ?",
        "WHERE operation_id = ?",
        "  AND status = 'RUNNING'"
      ].join("\n"))
      .run(completedAt, code, operation);

    if (Number(update.changes) !== 1) {
      throw new OperationJournalError(
        "Cannot transition operation \"" + operation + "\" to FAILED.",
        "INVALID_STATUS_TRANSITION"
      );
    }

    return this.getOperation(operation);
  }

  recoverInterruptedOperations() {
    this.#assertOpen();

    const update = this.#database
      .prepare([
        "UPDATE operations",
        "SET status = 'UNKNOWN_OUTCOME',",
        "    completed_at = NULL,",
        "    result_hash = NULL,",
        "    error_code = 'INTERRUPTED'",
        "WHERE status = 'RUNNING'"
      ].join("\n"))
      .run();

    return Number(update.changes);
  }

  listByStatus(status) {
    this.#assertOpen();

    if (!VALID_STATUSES.has(status)) {
      throw new OperationJournalError(
        "Unknown journal status \"" + String(status) + "\".",
        "INVALID_JOURNAL_STATUS"
      );
    }

    return this.#database
      .prepare([
        "SELECT",
        "  operation_id, command_id, tool_name, status,",
        "  started_at, completed_at, result_hash, error_code",
        "FROM operations",
        "WHERE status = ?",
        "ORDER BY started_at ASC"
      ].join("\n"))
      .all(status)
      .map(mapRow);
  }

  close() {
    if (this.#closed) {
      return;
    }

    this.#database.close();
    this.#closed = true;
  }
}

export const JournalStatus = Object.freeze({
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  UNKNOWN_OUTCOME: "UNKNOWN_OUTCOME"
});
