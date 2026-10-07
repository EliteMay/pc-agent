export const Capabilities = Object.freeze({
  FILE_READ: "file.read",
  FILE_WRITE: "file.write",
  FILE_DELETE: "file.delete",
  PROCESS_INSPECT: "process.inspect",
  PROCESS_START: "process.start",
  PROCESS_STOP: "process.stop",
  COMMAND_DEVELOPMENT: "command.development",
  SYSTEM_INSPECT: "system.inspect",
  SYSTEM_MODIFY: "system.modify"
});

export const PolicyDecision = Object.freeze({
  ALLOW: "ALLOW",
  CONFIRM: "CONFIRM",
  DENY: "DENY"
});
