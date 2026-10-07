import { executeRegisteredCommand } from "../execution/agent-runtime.js";

function remoteError(error) {
  const code =
    typeof error?.code === "string" && error.code.length > 0
      ? error.code
      : "TOOL_FAILED";

  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message.slice(0, 1000)
      : "Local tool execution failed.";

  return Object.freeze({
    code,
    message,
    retryable: false
  });
}

export async function runQueueOnce({
  client,
  registry,
  journal,
  now = new Date(),
  waitMs,
  onCommand,
  approvalProvider
}) {
  if (!client || typeof client.poll !== "function" || typeof client.submitResult !== "function") {
    throw new TypeError("client must provide poll() and submitResult().");
  }

  const command = await client.poll(
    waitMs === undefined ? {} : { waitMs }
  );

  if (!command) {
    return Object.freeze({ status: "IDLE" });
  }

  if (onCommand !== undefined && typeof onCommand !== "function") {
    throw new TypeError("onCommand must be a function when provided.");
  }

  if (onCommand) {
    onCommand(command);
  }

  let execution;

  try {
    execution = await executeRegisteredCommand({
      registry,
      journal,
      command,
      approvalProvider,
      now
    });
  } catch (error) {
    const normalized = remoteError(error);

    await client.submitResult({
      commandId: command.command_id,
      operationId: command.operation_id,
      status: "failed",
      error: normalized
    });

    return Object.freeze({
      status: "FAILED",
      command_id: command.command_id,
      operation_id: command.operation_id,
      error: normalized
    });
  }

  if (!execution.executed) {
    const duplicateError = Object.freeze({
      code: "DUPLICATE_OPERATION",
      message:
        "This operation_id already exists in the local journal with status " +
        String(execution.operation?.status ?? "UNKNOWN") +
        "; the Agent will not execute it again.",
      retryable: false
    });

    await client.submitResult({
      commandId: command.command_id,
      operationId: command.operation_id,
      status: "failed",
      error: duplicateError
    });

    return Object.freeze({
      status: "DUPLICATE",
      command_id: command.command_id,
      operation_id: command.operation_id,
      journal_status: execution.operation?.status ?? null
    });
  }

  await client.submitResult({
    commandId: command.command_id,
    operationId: command.operation_id,
    status: "succeeded",
    result: execution.result
  });

  return Object.freeze({
    status: "SUCCEEDED",
    command_id: command.command_id,
    operation_id: command.operation_id,
    result: execution.result,
    operation: execution.operation
  });
}

export const queueRunnerInternals = Object.freeze({
  remoteError
});
