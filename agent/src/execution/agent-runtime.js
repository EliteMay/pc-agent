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

  return executeOnce({
    journal,
    command: validatedCommand,
    tool
  });
}
