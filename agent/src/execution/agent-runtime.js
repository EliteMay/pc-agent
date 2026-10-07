import { validateCommandEnvelope } from "../protocol/command-envelope.js";
import { executeOnce } from "./execute-once.js";

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

  return executeOnce({
    journal,
    command: validatedCommand,
    tool
  });
}
