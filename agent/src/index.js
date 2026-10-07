export { ToolRegistry, ToolRegistryError } from "./tools/tool-registry.js";
export {
  assertPathWithinAllowedRoots,
  isSensitivePath
} from "./security/path-policy.js";
export { Capabilities, PolicyDecision } from "./security/capabilities.js";
export {
  validateCommandEnvelope,
  CommandEnvelopeError,
  protocolVersion
} from "./protocol/command-envelope.js";
