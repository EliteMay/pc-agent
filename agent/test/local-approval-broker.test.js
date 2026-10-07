import test from "node:test";
import assert from "node:assert/strict";
import { LocalApprovalBroker } from "../src/approval/local-approval-broker.js";

test("approval broker exposes one pending request and resolves approval", async () => {
  const broker = new LocalApprovalBroker({ maxWaitMs: 5000 });

  const pending = broker.requestApproval({
    command_id: "cmd-1",
    operation_id: "op-1",
    tool: "write_text_file",
    risk: "medium",
    summary: { path: "D:\\AI\\test.txt" },
    expires_at: new Date(Date.now() + 5000).toISOString()
  });

  const request = broker.getPendingApproval();
  assert.equal(request.operation_id, "op-1");
  assert.equal(request.tool, "write_text_file");

  assert.deepEqual(
    broker.respond("op-1", "approved"),
    { accepted: true }
  );

  assert.equal(await pending, "approved");
  assert.equal(broker.getPendingApproval(), null);
});

test("approval broker rejects stale or mismatched responses", async () => {
  const broker = new LocalApprovalBroker({ maxWaitMs: 5000 });

  const pending = broker.requestApproval({
    command_id: "cmd-2",
    operation_id: "op-2",
    tool: "create_directory",
    risk: "medium",
    summary: { path: "D:\\AI\\folder" },
    expires_at: new Date(Date.now() + 5000).toISOString()
  });

  assert.deepEqual(
    broker.respond("wrong-op", "approved"),
    { accepted: false, code: "APPROVAL_OPERATION_MISMATCH" }
  );

  broker.respond("op-2", "denied");
  assert.equal(await pending, "denied");
});
