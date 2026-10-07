import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { OperationJournal } from "../src/journal/operation-journal.js";
import {
  SupabaseQueueClient,
  QueueClientError
} from "../src/cloud/supabase-queue-client.js";
import { runQueueOnce } from "../src/queue/run-queue-once.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function queuedCommand(overrides = {}) {
  return {
    command_id: commandId,
    operation_id: operationId,
    device_id: deviceId,
    tool: "system_info",
    tool_version: "1",
    protocol_version: 1,
    created_at: "2026-10-07T04:00:00.000Z",
    expires_at: "2099-10-07T04:01:00.000Z",
    args: {},
    request_metadata: {},
    ...overrides
  };
}

test("queue client polls with device bearer auth and returns the command envelope", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ success: true, command: queuedCommand() });
  };

  const client = new SupabaseQueueClient({
    endpointUrl: "https://example.test/functions/v1/pc-agent-device",
    deviceToken: "device-secret",
    deviceId,
    agentVersion: "0.1.0",
    fetchImpl
  });

  const command = await client.poll({ waitMs: 1234 });

  assert.equal(command.operation_id, operationId);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.test/functions/v1/pc-agent-device/poll"
  );
  assert.equal(
    requests[0].init.headers.authorization,
    "Bearer device-secret"
  );
  assert.deepEqual(
    JSON.parse(requests[0].init.body),
    { wait_ms: 1234, agent_version: "0.1.0" }
  );
});

test("queue client rejects a command for a different device", async () => {
  const client = new SupabaseQueueClient({
    endpointUrl: "https://example.test/functions/v1/pc-agent-device",
    deviceToken: "device-secret",
    deviceId,
    fetchImpl: async () => jsonResponse({
      success: true,
      command: queuedCommand({ device_id: "other-device" })
    })
  });

  await assert.rejects(
    client.poll(),
    (error) => error instanceof QueueClientError
      && error.code === "DEVICE_ID_MISMATCH"
  );
});

test("runQueueOnce executes a registered tool and posts a success result", async () => {
  const posted = [];
  let polls = 0;

  const client = new SupabaseQueueClient({
    endpointUrl: "https://example.test/functions/v1/pc-agent-device",
    deviceToken: "device-secret",
    deviceId,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/poll")) {
        polls += 1;
        return jsonResponse({ success: true, command: queuedCommand() });
      }

      posted.push(JSON.parse(init.body));
      return jsonResponse({ success: true });
    }
  });

  const registry = new ToolRegistry();
  registry.register({
    name: "system_info",
    version: "1",
    capability: "system.inspect",
    risk: "low",
    confirmation: "none",
    execute: async () => ({ platform: "win32" })
  });
  const journal = new OperationJournal(":memory:");

  try {
    const result = await runQueueOnce({
      client,
      registry,
      journal,
      now: new Date("2026-10-07T04:00:30.000Z")
    });

    assert.equal(polls, 1);
    assert.equal(result.status, "SUCCEEDED");
    assert.deepEqual(posted, [{
      command_id: commandId,
      operation_id: operationId,
      status: "succeeded",
      result: { platform: "win32" }
    }]);
  } finally {
    journal.close();
  }
});

test("runQueueOnce reports local tool failures without leaking a stack", async () => {
  const posted = [];
  const client = new SupabaseQueueClient({
    endpointUrl: "https://example.test/functions/v1/pc-agent-device",
    deviceToken: "device-secret",
    deviceId,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/poll")) {
        return jsonResponse({ success: true, command: queuedCommand() });
      }

      posted.push(JSON.parse(init.body));
      return jsonResponse({ success: true });
    }
  });

  const registry = new ToolRegistry();
  registry.register({
    name: "system_info",
    version: "1",
    capability: "system.inspect",
    risk: "low",
    confirmation: "none",
    execute: async () => {
      const error = new Error("simulated failure");
      error.code = "SIMULATED";
      throw error;
    }
  });
  const journal = new OperationJournal(":memory:");

  try {
    const result = await runQueueOnce({
      client,
      registry,
      journal,
      now: new Date("2026-10-07T04:00:30.000Z")
    });

    assert.equal(result.status, "FAILED");
    assert.equal(posted[0].status, "failed");
    assert.equal(posted[0].error.code, "SIMULATED");
    assert.equal(posted[0].error.message, "simulated failure");
    assert.equal("stack" in posted[0].error, false);
  } finally {
    journal.close();
  }
});

test("runQueueOnce reports duplicate operations without re-executing", async () => {
  let executions = 0;
  const posts = [];
  const commands = [
    queuedCommand(),
    queuedCommand({ command_id: "44444444-4444-4444-8444-444444444444" })
  ];

  const client = new SupabaseQueueClient({
    endpointUrl: "https://example.test/functions/v1/pc-agent-device",
    deviceToken: "device-secret",
    deviceId,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/poll")) {
        return jsonResponse({ success: true, command: commands.shift() ?? null });
      }

      posts.push(JSON.parse(init.body));
      return jsonResponse({ success: true });
    }
  });

  const registry = new ToolRegistry();
  registry.register({
    name: "system_info",
    version: "1",
    capability: "system.inspect",
    risk: "low",
    confirmation: "none",
    execute: async () => {
      executions += 1;
      return { ok: true };
    }
  });
  const journal = new OperationJournal(":memory:");

  try {
    await runQueueOnce({
      client,
      registry,
      journal,
      now: new Date("2026-10-07T04:00:30.000Z")
    });
    const duplicate = await runQueueOnce({
      client,
      registry,
      journal,
      now: new Date("2026-10-07T04:00:31.000Z")
    });

    assert.equal(executions, 1);
    assert.equal(duplicate.status, "DUPLICATE");
    assert.equal(posts[1].status, "failed");
    assert.equal(posts[1].error.code, "DUPLICATE_OPERATION");
  } finally {
    journal.close();
  }
});
