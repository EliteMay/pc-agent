import { OperationJournalError } from "../journal/operation-journal.js";

function requireCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new TypeError("command must be an object.");
  }

  for (const field of ["command_id", "operation_id", "tool"]) {
    if (typeof command[field] !== "string" || command[field].trim().length === 0) {
      throw new TypeError("command." + field + " must be a non-empty string.");
    }
  }

  if (!command.args || typeof command.args !== "object" || Array.isArray(command.args)) {
    throw new TypeError("command.args must be an object.");
  }
}

function requireTool(tool) {
  if (!tool || typeof tool !== "object" || typeof tool.execute !== "function") {
    throw new TypeError("tool.execute must be a function.");
  }
}

function recordToolFailure(journal, operationId, error) {
  const errorCode = typeof error?.code === "string" && error.code.length > 0
    ? error.code
    : "TOOL_FAILED";

  try {
    journal.markFailed(operationId, errorCode);
  } catch (journalError) {
    if (!(journalError instanceof OperationJournalError)) {
      throw journalError;
    }

    // Leave RUNNING in place if the failure record cannot be persisted.
    // On restart it becomes UNKNOWN_OUTCOME, preventing blind re-execution.
  }
}

export async function executeOnce({
  journal,
  command,
  tool
}) {
  if (!journal || typeof journal.beginOperation !== "function") {
    throw new TypeError("journal must be an OperationJournal-compatible object.");
  }

  requireCommand(command);
  requireTool(tool);

  const claim = journal.beginOperation({
    commandId: command.command_id,
    operationId: command.operation_id,
    toolName: command.tool
  });

  if (!claim.accepted) {
    return Object.freeze({
      executed: false,
      duplicate: true,
      operation: claim.record
    });
  }

  let result;

  try {
    result = await tool.execute(command.args, {
      command
    });
  } catch (error) {
    recordToolFailure(journal, command.operation_id, error);
    throw error;
  }

  // Important: do not treat a journal persistence error as a tool failure.
  // The tool has already executed. If persisting SUCCEEDED fails, the journal
  // stays RUNNING/UNKNOWN_OUTCOME so a retry cannot execute the side effect again.
  const operation = journal.markSucceeded(command.operation_id, result);

  return Object.freeze({
    executed: true,
    duplicate: false,
    result,
    operation
  });
}
