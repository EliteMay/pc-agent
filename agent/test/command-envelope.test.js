import test from "node:test";
import assert from "node:assert/strict";
import { validateCommandEnvelope } from "../src/protocol/command-envelope.js";

const now = new Date("2026-10-07T04:00:00.000Z");

test("accepts a valid command envelope", () => {
  const result = validateCommandEnvelope({
    command_id: "cmd-1",
    operation_id: "op-1",
    tool: "system_info",
    protocol_version: 1,
    created_at: "2026-10-07T03:59:00.000Z",
    expires_at: "2026-10-07T04:01:00.000Z",
    args: {}
  }, { now });

  assert.equal(result.operation_id, "op-1");
});

test("rejects expired commands", () => {
  assert.throws(() => validateCommandEnvelope({
    command_id: "cmd-1",
    operation_id: "op-1",
    tool: "system_info",
    protocol_version: 1,
    created_at: "2026-10-07T03:58:00.000Z",
    expires_at: "2026-10-07T03:59:00.000Z",
    args: {}
  }, { now }), /expired/i);
});

test("rejects missing operation_id", () => {
  assert.throws(() => validateCommandEnvelope({
    command_id: "cmd-1",
    tool: "system_info",
    protocol_version: 1,
    created_at: "2026-10-07T03:59:00.000Z",
    expires_at: "2026-10-07T04:01:00.000Z",
    args: {}
  }, { now }), /operation_id/i);
});
