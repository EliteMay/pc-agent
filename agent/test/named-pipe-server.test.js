import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createNamedPipeServer } from "../src/host/named-pipe-server.js";

function request(pipeName, method, params = null) {
  const pipePath = "\\\\.\\pipe\\" + pipeName;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let data = "";

    socket.setEncoding("utf8");

    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
    });

    socket.on("end", () => {
      try {
        resolve(JSON.parse(data.trim()));
      } catch (error) {
        reject(error);
      }
    });

    socket.once("connect", () => {
      socket.write(JSON.stringify({
        id: "test-1",
        method,
        params
      }) + "\n");
    });
  });
}

test("named pipe exposes pending approval and accepts local decision", {
  skip: process.platform !== "win32"
}, async () => {
  const pipeName = "PcAgent-Test-" + randomUUID();
  let approval = {
    command_id: "cmd-1",
    operation_id: "op-1",
    approval_nonce: "f".repeat(32),
    tool: "write_text_file",
    risk: "medium",
    summary: {
      action: "write_text_file",
      path: "D:\\AI\\test.txt"
    },
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30000).toISOString()
  };

  const decisions = [];
  const approvalSecret = "a".repeat(64);
  let shutdownRequests = 0;

  const server = createNamedPipeServer({
    pipeName,
    approvalSecret,
    onPrepareShutdown() {
      shutdownRequests += 1;
    },
    getHealth: () => ({
      version: "0.4.0",
      protocol_version: 1
    }),
    getPendingApproval: () => approval,
    onApprovalResponse(operationId, decision, approvalNonce) {
      decisions.push({ operationId, decision, approvalNonce });

      if (operationId !== approval.operation_id) {
        return {
          accepted: false,
          code: "APPROVAL_OPERATION_MISMATCH"
        };
      }

      if (approvalNonce !== approval.approval_nonce) {
        return { accepted: false, code: "APPROVAL_NONCE_MISMATCH" };
      }

      approval = null;
      return { accepted: true };
    }
  });

  await server.listen();

  try {
    const blockedPending = await request(
      pipeName,
      "get_pending_approval"
    );
    assert.equal(blockedPending.ok, false);
    assert.equal(blockedPending.error.code, "LOCAL_IPC_AUTH_REQUIRED");

    const pending = await request(
      pipeName,
      "get_pending_approval",
      { auth_token: approvalSecret }
    );

    assert.equal(pending.ok, true);
    assert.equal(
      pending.result.operation_id,
      "op-1"
    );
    assert.equal(
      pending.result.summary.path,
      "D:\\AI\\test.txt"
    );

    const withoutAuth = await request(
      pipeName,
      "respond_approval",
      { operation_id: "op-1", decision: "approved" }
    );
    assert.equal(withoutAuth.ok, false);
    assert.equal(withoutAuth.error.code, "LOCAL_IPC_AUTH_REQUIRED");
    assert.equal(decisions.length, 0);

    const incorrectAuth = await request(
      pipeName,
      "respond_approval",
      { operation_id: "op-1", decision: "approved", auth_token: "b".repeat(64) }
    );
    assert.equal(incorrectAuth.ok, false);
    assert.equal(incorrectAuth.error.code, "LOCAL_IPC_AUTH_REQUIRED");
    assert.equal(decisions.length, 0);

    const withoutShutdownAuth = await request(
      pipeName,
      "prepare_shutdown"
    );
    assert.equal(withoutShutdownAuth.ok, false);
    assert.equal(withoutShutdownAuth.error.code, "LOCAL_IPC_AUTH_REQUIRED");
    assert.equal(shutdownRequests, 0);

    const staleChallenge = await request(
      pipeName,
      "respond_approval",
      {
        operation_id: "op-1",
        decision: "approved",
        approval_nonce: "0".repeat(32),
        auth_token: approvalSecret
      }
    );
    assert.equal(staleChallenge.ok, true);
    assert.equal(staleChallenge.result.accepted, false);
    assert.equal(staleChallenge.result.code, "APPROVAL_NONCE_MISMATCH");

    const response = await request(
      pipeName,
      "respond_approval",
      {
        operation_id: "op-1",
        decision: "approved",
        approval_nonce: approval.approval_nonce,
        auth_token: approvalSecret
      }
    );

    assert.equal(response.ok, true);
    assert.deepEqual(
      response.result,
      { accepted: true }
    );
    assert.deepEqual(
      decisions,
      [{
        operationId: "op-1",
        decision: "approved",
        approvalNonce: "0".repeat(32)
      }, {
        operationId: "op-1",
        decision: "approved",
        approvalNonce: "f".repeat(32)
      }]
    );

    const cleared = await request(
      pipeName,
      "get_pending_approval",
      { auth_token: approvalSecret }
    );

    assert.equal(cleared.ok, true);
    assert.equal(cleared.result, null);

    const authorizedStop = await request(
      pipeName,
      "prepare_shutdown",
      { auth_token: approvalSecret }
    );
    assert.equal(authorizedStop.ok, true);
    assert.equal(shutdownRequests, 1);
  } finally {
    await server.close();
  }
});


test("privileged IPC fails closed when no Manager launch credential was configured", {
  skip: process.platform !== "win32"
}, async () => {
  const pipeName = "PcAgent-NoApprovalSecret-" + randomUUID();
  let responses = 0;
  let shutdowns = 0;
  const server = createNamedPipeServer({
    pipeName,
    getHealth: () => ({ version: "0.11.0", protocol_version: 1 }),
    getPendingApproval: () => ({ operation_id: "op-private" }),
    onApprovalResponse() {
      responses += 1;
      return { accepted: true };
    },
    onPrepareShutdown() {
      shutdowns += 1;
    }
  });

  await server.listen();
  try {
    for (const method of [
      "get_pending_approval",
      "respond_approval",
      "prepare_shutdown"
    ]) {
      const result = await request(pipeName, method, {
        auth_token: "a".repeat(64),
        operation_id: "op-private",
        decision: "approved"
      });

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "LOCAL_IPC_AUTH_REQUIRED");
    }

    assert.equal(responses, 0);
    assert.equal(shutdowns, 0);
  } finally {
    await server.close();
  }
});
