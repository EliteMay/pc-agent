import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { OperationJournal } from "../src/journal/operation-journal.js";
import { runQueueOnce } from "../src/queue/run-queue-once.js";
import { createNotepadGuiTool } from "../src/tools/notepad-gui.js";
import { createCaptureNotepadTool } from "../src/tools/capture-notepad.js";

function envelope(tool, args, id) {
  return {
    command_id: "command-" + id,
    operation_id: "operation-" + id,
    device_id: "test-device",
    tool,
    tool_version: "1",
    protocol_version: 1,
    created_at: "2026-10-07T00:00:00.000Z",
    expires_at: "2099-10-07T00:00:00.000Z",
    args
  };
}

function fakeClient(command) {
  const results = [];
  return {
    results,
    async poll() { return command; },
    async submitResult(result) { results.push(result); }
  };
}

function fixture(command) {
  const journal = new OperationJournal(":memory:");
  const registry = new ToolRegistry();
  const client = fakeClient(command);
  return { journal, registry, client, close: () => journal.close() };
}

test("queued Notepad click requires an explicit local approval before any input", async () => {
  const f = fixture(envelope("notepad_gui", { action: "click", x: 90, y: 160 }, "click-denied"));
  let dispatched = 0;
  f.registry.register(createNotepadGuiTool({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
    runCommand: async () => {
      dispatched += 1;
      return { stdout: '{"target":"notepad","action":"click","dispatched":true,"verified":false}', stderr: "" };
    }
  }));
  try {
    const missing = await runQueueOnce({
      client: f.client, registry: f.registry, journal: f.journal
    });
    assert.equal(missing.status, "FAILED");
    assert.equal(missing.error.code, "LOCAL_APPROVAL_REQUIRED");
    assert.equal(dispatched, 0);
    assert.equal(f.journal.getOperation("operation-click-denied"), null);

    const denied = await runQueueOnce({
      client: f.client, registry: f.registry, journal: f.journal,
      approvalProvider: {
        async requestApproval(request) {
          assert.equal(request.tool, "notepad_gui");
          assert.equal(request.risk, "high");
          assert.equal(request.summary.operation, "click");
          return "denied";
        }
      }
    });
    assert.equal(denied.status, "FAILED");
    assert.equal(denied.error.code, "LOCAL_APPROVAL_DENIED");
    assert.equal(dispatched, 0);
    assert.equal(f.journal.getOperation("operation-click-denied"), null);
    assert.deepEqual(f.client.results.map((r) => r.status), ["failed", "failed"]);
  } finally {
    f.close();
  }
});

test("approved queued Notepad click is dispatched exactly once and remains unverified", async () => {
  const f = fixture(envelope("notepad_gui", { action: "click", x: 100, y: 140 }, "click-approved"));
  let dispatched = 0;
  f.registry.register(createNotepadGuiTool({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
    runCommand: async () => {
      dispatched += 1;
      return { stdout: '{"target":"notepad","action":"click","dispatched":true,"verified":false}', stderr: "" };
    }
  }));
  const consent = {
    async requestApproval(request) {
      assert.equal(request.summary.operation, "click");
      return "approved";
    }
  };
  try {
    const first = await runQueueOnce({
      client: f.client, registry: f.registry, journal: f.journal,
      approvalProvider: consent
    });
    assert.equal(first.status, "SUCCEEDED");
    assert.equal(first.result.action, "click");
    assert.equal(first.result.verified, false);
    assert.equal(f.journal.getOperation("operation-click-approved").status, "SUCCEEDED");
    assert.equal(dispatched, 1);

    const replay = await runQueueOnce({
      client: f.client, registry: f.registry, journal: f.journal,
      approvalProvider: consent
    });
    assert.equal(replay.status, "DUPLICATE");
    assert.equal(dispatched, 1);
    assert.equal(f.client.results.at(-1).error.code, "DUPLICATE_OPERATION");
  } finally {
    f.close();
  }
});

test("queued screenshot passes only with consent and stores a result hash, not image bytes", async () => {
  const f = fixture(envelope("capture_notepad", {}, "capture-approved"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  let captures = 0;
  f.registry.register(createCaptureNotepadTool({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
    runCapture: async () => {
      captures += 1;
      return {
        stdout: JSON.stringify({
          target: "notepad",
          mime_type: "image/jpeg",
          image_base64: jpeg,
          width: 1,
          height: 1
        }), stderr: ""
      };
    }
  }));
  try {
    const result = await runQueueOnce({
      client: f.client, registry: f.registry, journal: f.journal,
      approvalProvider: {
        async requestApproval(request) {
          assert.equal(request.tool, "capture_notepad");
          assert.equal(request.summary.action, "capture_notepad");
          assert.equal(request.risk, "medium");
          return "approved";
        }
      }
    });
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(captures, 1);
    assert.equal(result.result.mime_type, "image/jpeg");
    assert.equal(result.result.image_base64, jpeg);
    assert.equal(f.journal.getOperation("operation-capture-approved").result_hash.length, 64);
    assert.equal("image_base64" in f.journal.getOperation("operation-capture-approved"), false);
  } finally {
    f.close();
  }
});
