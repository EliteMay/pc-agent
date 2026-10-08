import test from "node:test";
import assert from "node:assert/strict";
import { loadHostConfiguration } from "../src/host/host-config.js";

function fixture(overrides = {}) {
  return {
    PC_AGENT_ENDPOINT: "https://example.test/functions/v1/agent",
    PC_AGENT_DEVICE_ID: "test-device",
    PC_AGENT_DEVICE_TOKEN: "device-token-not-for-ipc",
    PC_AGENT_ALLOWED_ROOTS_JSON: JSON.stringify(["D:\\AI"]),
    PC_AGENT_JOURNAL_PATH: "D:\\AI\\journal.sqlite",
    PC_AGENT_PIPE_NAME: "PcAgent-Test-Private",
    PC_AGENT_LOCAL_APPROVAL_SECRET: "a".repeat(64),
    ...overrides
  };
}

test("Agent requires a separate per-launch local Manager IPC secret", () => {
  const env = fixture();
  delete env.PC_AGENT_LOCAL_APPROVAL_SECRET;

  assert.throws(
    () => loadHostConfiguration(env),
    { code: "MISSING_PC_AGENT_LOCAL_APPROVAL_SECRET" }
  );
});

test("Agent refuses malformed local Manager IPC keys", () => {
  for (const key of ["abc", "0".repeat(63), "z".repeat(64)]) {
    assert.throws(
      () => loadHostConfiguration(fixture({
        PC_AGENT_LOCAL_APPROVAL_SECRET: key
      })),
      { code: "INVALID_LOCAL_APPROVAL_SECRET" }
    );
  }
});

test("Agent retains an explicit local IPC key separate from its device token", () => {
  const config = loadHostConfiguration(fixture());
  assert.equal(config.localApprovalSecret, "a".repeat(64));
  assert.notEqual(config.localApprovalSecret, config.deviceToken);
  assert.equal(config.pipeName, "PcAgent-Test-Private");
});
