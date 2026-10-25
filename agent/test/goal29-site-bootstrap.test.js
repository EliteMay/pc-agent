import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { OperationJournal } from "../src/journal/operation-journal.js";
import { runQueueOnce } from "../src/queue/run-queue-once.js";
import { createPingTool } from "../src/tools/ping.js";
import {
  resolveClientPolicy,
  isToolAllowed,
  visibleTools,
} from "../../gateway/oauth-pc-agent/client-policy.mjs";

// Entirely offline: no Supabase/Cloudflare/Sites requests and no Windows calls.
// This checks the shared bootstrap contract, NOT a live ChatGPT -> Agent E2E.
const config = { siteClientId: "test-sites-client", privilegedClientIds: "test-privileged-client" };

function fakeEnvelope(tool, id) {
  return {
    command_id: "cmd-" + id,
    operation_id: "op-" + id,
    device_id: "test-device",
    tool,
    tool_version: "1",
    protocol_version: 1,
    created_at: "2026-10-24T00:00:00.000Z",
    expires_at: "2099-10-24T00:00:00.000Z",
    args: {},
  };
}

async function simulatedBootstrapCall(claims, toolName) {
  const policy = resolveClientPolicy(claims, config);
  const queued = [];
  const delivered = [];
  if (!isToolAllowed(policy, toolName)) {
    return { denied: true, queued, delivered };
  }
  queued.push(fakeEnvelope(toolName, "offline-" + queued.length));
  const client = {
    async poll() { return queued.shift() ?? null; },
    async submitResult(result) { delivered.push(result); },
  };
  const registry = new ToolRegistry();
  registry.register(createPingTool());
  const journal = new OperationJournal(":memory:");
  try {
    const result = await runQueueOnce({ client, registry, journal });
    return { denied: false, result, delivered };
  } finally {
    journal.close();
  }
}

test("Site-scoped bearer cannot enqueue even a mock read-only ping", async () => {
  const reply = await simulatedBootstrapCall({ client_id: config.siteClientId }, "ping");
  assert.equal(reply.denied, true);
  assert.deepEqual(reply.queued, []);
  assert.deepEqual(reply.delivered, []);
});

test("Explicitly privileged OAuth client can complete mock ping through real Agent queue runner", async () => {
  const reply = await simulatedBootstrapCall({ client_id: "test-privileged-client" }, "ping");
  assert.equal(reply.denied, false);
  assert.equal(reply.result.status, "SUCCEEDED");
  assert.equal(reply.result.result.message, "pong");
  assert.equal(reply.result.result.transport, "pc-agent-v1");
  assert.equal(reply.delivered.length, 1);
  assert.equal(reply.delivered[0].status, "succeeded");
  assert.equal(reply.delivered[0].result.message, "pong");
});

test("Unauthorized Site tools are rejected before a mock command is enqueued", async () => {
  for (const tool of [
    "relay_ping", "ping", "capture_notepad", "notepad_gui", "read_text_file",
    "write_text_file", "run_development_command", "task_step",
  ]) {
    const reply = await simulatedBootstrapCall({ client_id: config.siteClientId }, tool);
    assert.equal(reply.denied, true, tool);
    assert.deepEqual(reply.queued, [], tool);
    assert.deepEqual(reply.delivered, [], tool);
  }
});

test("Forged HTTP identity without verified OAuth client claim cannot enqueue", async () => {
  const reply = await simulatedBootstrapCall({
    "oai-authenticated-user-id": "owner",
    email: "owner@example.test",
  }, "ping");
  assert.equal(reply.denied, true);
  assert.deepEqual(reply.queued, []);
  assert.deepEqual(reply.delivered, []);
});

test("Bootstrap Site tool list matches the exact allowed contract", () => {
  const policy = resolveClientPolicy({ client_id: config.siteClientId }, config);
  const tools = ["gateway_probe", "relay_ping", "ping", "capture_notepad", "notepad_gui", "task_step"]
    .map((name) => ({ name }));
  assert.deepEqual(visibleTools(tools, policy).map((tool) => tool.name), [
    "gateway_probe",
  ]);
});
