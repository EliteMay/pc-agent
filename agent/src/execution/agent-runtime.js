import { validateCommandEnvelope } from "../protocol/command-envelope.js";
import { executeOnce } from "./execute-once.js";

export class AgentRuntimeError extends Error {
  constructor(message, code = "AGENT_RUNTIME_ERROR") {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
  }
}

export async function executeRegisteredCommand({
  registry,
  journal,
  command,
  approvalProvider,
  now = new Date()
}) {
  if (!registry || typeof registry.require !== "function") {
    throw new TypeError("registry must provide require(name).");
  }

  if (!journal || typeof journal.beginOperation !== "function") {
    throw new TypeError("journal must be an OperationJournal-compatible object.");
  }

  const validatedCommand = validateCommandEnvelope(command, { now });
  const tool = registry.require(validatedCommand.tool);

  if (tool.version !== validatedCommand.tool_version) {
    throw new AgentRuntimeError(
      `Queued tool version ${validatedCommand.tool_version} does not match registered version ${tool.version} for ${tool.name}.`,
      "TOOL_VERSION_MISMATCH"
    );
  }

  if (tool.confirmation === "required") {
    if (
      !approvalProvider
      || typeof approvalProvider.requestApproval !== "function"
    ) {
      throw new AgentRuntimeError(
        "This operation requires explicit local approval.",
        "LOCAL_APPROVAL_REQUIRED"
      );
    }

    const decision = await approvalProvider.requestApproval({
      command_id: validatedCommand.command_id,
      operation_id: validatedCommand.operation_id,
      tool: tool.name,
      risk: tool.risk,
      summary: tool.approvalSummary(validatedCommand.args),
      expires_at: validatedCommand.expires_at
    });

    if (decision !== "approved") {
      const code = decision === "denied"
        ? "LOCAL_APPROVAL_DENIED"
        : decision === "expired"
          ? "LOCAL_APPROVAL_EXPIRED"
          : "LOCAL_APPROVAL_TIMEOUT";

      throw new AgentRuntimeError(
        "Local approval was not granted.",
        code
      );
    }
  }

  return executeOnce({
    journal,
    command: validatedCommand,
    tool
  });
}
