import test from "node:test";
import assert from "node:assert/strict";
import { validateCommandEnvelope } from "../src/protocol/command-envelope.js";

const now = new Date("2026-10-07T04:00:00.000Z");

function validCommand(overrides = {}) {
  return {
    command_id: "cmd-1",
    operation_id: "op-1",
    device_id: "device-1",
    tool: "system_info",
    tool_version: "1",
    protocol_version: 1,
    created_at: "2026-10-07T03:59:00.000Z",
    expires_at: "2026-10-07T04:01:00.000Z",
    args: {},
    ...overrides
  };
}

test("accepts a valid command envelope", () => {
  const result = validateCommandEnvelope(validCommand(), { now });

  assert.equal(result.operation_id, "op-1");
  assert.equal(result.device_id, "device-1");
  assert.equal(result.tool_version, "1");
});

test("rejects expired commands", () => {
  assert.throws(
    () => validateCommandEnvelope(validCommand({
      created_at: "2026-10-07T03:58:00.000Z",
      expires_at: "2026-10-07T03:59:00.000Z"
    }), { now }),
    /expired/i
  );
});

test("rejects missing operation_id", () => {
  const command = validCommand();
  delete command.operation_id;

  assert.throws(
    () => validateCommandEnvelope(command, { now }),
    /operation_id/i
  );
});

test("rejects missing device_id", () => {
  const command = validCommand();
  delete command.device_id;

  assert.throws(
    () => validateCommandEnvelope(command, { now }),
    /device_id/i
  );
});

test("rejects missing tool_version", () => {
  const command = validCommand();
  delete command.tool_version;

  assert.throws(
    () => validateCommandEnvelope(command, { now }),
    /tool_version/i
  );
});
