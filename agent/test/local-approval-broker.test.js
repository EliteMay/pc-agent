import test from "node:test";
import assert from "node:assert/strict";
import { LocalApprovalBroker } from "../src/approval/local-approval-broker.js";

test("approval broker exposes one pending request and resolves approval", async () => {
  const broker = new LocalApprovalBroker({ maxWaitMs: 5000 });

  const waiting = broker.requestApproval({
    command_id: "cmd-1",
    operation_id: "op-1",
    tool: "mutation_probe",
    risk: "medium",
    summary: { target: "sample" },
    expires_at: new Date(Date.now() + 5000).toISOString()
  });

  const pending = broker.getPendingApproval();
  assert.equal(pending.operation_id, "op-1");
  assert.equal(pending.tool, "mutation_probe");
  assert.match(pending.approval_nonce, /^[a-f0-9]{32}$/);

  assert.deepEqual(
    broker.respond("op-1", "approved", pending.approval_nonce),
    { accepted: true }
  );

  assert.equal(await waiting, "approved");
  assert.equal(broker.getPendingApproval(), null);
});

test("approval broker rejects mismatched responses and supports denial", async () => {
  const broker = new LocalApprovalBroker({ maxWaitMs: 5000 });

  const waiting = broker.requestApproval({
    command_id: "cmd-2",
    operation_id: "op-2",
    tool: "mutation_probe",
    risk: "medium",
    summary: { target: "sample" },
    expires_at: new Date(Date.now() + 5000).toISOString()
  });

  assert.deepEqual(
    broker.respond("wrong", "approved", "not-the-right-nonce"),
    { accepted: false, code: "APPROVAL_OPERATION_MISMATCH" }
  );

  assert.deepEqual(
    broker.respond("op-2", "approved", "0".repeat(32)),
    { accepted: false, code: "APPROVAL_NONCE_MISMATCH" }
  );

  assert.deepEqual(
    broker.respond("op-2", "approved"),
    { accepted: false, code: "APPROVAL_NONCE_MISMATCH" }
  );

  assert.deepEqual(
    broker.respond("op-2", "denied", broker.getPendingApproval().approval_nonce),
    { accepted: true }
  );

  assert.equal(await waiting, "denied");
});


test("old approval challenge never approves a later dialog reusing an operation ID", async () => {
  const broker = new LocalApprovalBroker({ maxWaitMs: 5000 });
  const request = {
    command_id: "cmd-dialog",
    operation_id: "op-reused",
    tool: "mutation_probe",
    risk: "medium",
    summary: { path: "D:\\\\AI\\\\approved.txt" },
    expires_at: new Date(Date.now() + 5000).toISOString()
  };

  const firstWaiting = broker.requestApproval(request);
  const first = broker.getPendingApproval();
  assert.deepEqual(
    broker.respond(request.operation_id, "denied", first.approval_nonce),
    { accepted: true }
  );
  assert.equal(await firstWaiting, "denied");

  const secondWaiting = broker.requestApproval(request);
  const second = broker.getPendingApproval();
  assert.notEqual(second.approval_nonce, first.approval_nonce);

  assert.deepEqual(
    broker.respond(request.operation_id, "approved", first.approval_nonce),
    { accepted: false, code: "APPROVAL_NONCE_MISMATCH" }
  );
  assert.equal(broker.getPendingApproval().approval_nonce, second.approval_nonce);

  assert.deepEqual(
    broker.respond(request.operation_id, "approved", second.approval_nonce),
    { accepted: true }
  );
  assert.equal(await secondWaiting, "approved");
});
