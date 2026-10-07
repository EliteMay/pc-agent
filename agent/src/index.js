export { ToolRegistry, ToolRegistryError } from "./tools/tool-registry.js";
export {
  assertPathWithinAllowedRoots,
  resolveExistingPathWithinAllowedRoots,
  resolveNewPathWithinAllowedRoots,
  revalidateNewPathBeforeWrite,
  isSensitivePath,
  PathPolicyError
} from "./security/path-policy.js";
export { Capabilities, PolicyDecision } from "./security/capabilities.js";
export {
  validateCommandEnvelope,
  CommandEnvelopeError,
  protocolVersion
} from "./protocol/command-envelope.js";
export {
  OperationJournal,
  OperationJournalError,
  JournalStatus,
  hashResult
} from "./journal/operation-journal.js";
export { executeOnce } from "./execution/execute-once.js";
