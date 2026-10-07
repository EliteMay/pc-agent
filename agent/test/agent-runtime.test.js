import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { registerReadOnlyTools } from "../src/tools/read-only-tools.js";
import { OperationJournal } from "../src/journal/operation-journal.js";
import { executeRegisteredCommand } from "../src/execution/agent-runtime.js";

function command(overrides = {}) {
  return {
    command_id: "cmd-read-1",
    operation_id: "op-read-1",
    device_id: "device-1",
    tool: "read_text_file",
    tool_version: "1",
    protocol_version: 1,
    created_at: "2026-10-07T00:00:00.000Z",
    expires_at: "2099-10-07T00:00:00.000Z",
    args: {},
    ...overrides
  };
}

test("validated command flows through registry, path policy, execution, and journal", {
  skip: process.platform !== "win32"
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pc-agent-runtime-"));
  const file = path.join(root, "message.txt");
  const registry = new ToolRegistry();
  const journal = new OperationJournal(":memory:");

  try {
    writeFileSync(file, "first", "utf8");
    registerReadOnlyTools(registry, { allowedRoots: [root] });

    const first = await executeRegisteredCommand({
      registry,
      journal,
      command: command({ args: { path: file } }),
      now: new Date("2026-10-07T01:00:00.000Z")
    });

    assert.equal(first.executed, true);
    assert.equal(first.result.text, "first");
    assert.equal(first.operation.status, "SUCCEEDED");

    writeFileSync(file, "second", "utf8");

    const duplicate = await executeRegisteredCommand({
      registry,
      journal,
      command: command({
        command_id: "cmd-read-retry",
        args: { path: file }
      }),
      now: new Date("2026-10-07T01:01:00.000Z")
    });

    assert.equal(duplicate.executed, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.operation.status, "SUCCEEDED");
    assert.equal("result" in duplicate, false);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime rejects an unknown tool before execution", async () => {
  const registry = new ToolRegistry();
  const journal = new OperationJournal(":memory:");

  try {
    await assert.rejects(
      executeRegisteredCommand({
        registry,
        journal,
        command: command({
          tool: "does_not_exist",
          args: {}
        }),
        now: new Date("2026-10-07T01:00:00.000Z")
      }),
      (error) => error?.code === "UNKNOWN_TOOL"
    );

    assert.equal(journal.getOperation("op-read-1"), null);
  } finally {
    journal.close();
  }
});


test("runtime rejects a tool version mismatch before journaling", async () => {
  const registry = new ToolRegistry();
  const journal = new OperationJournal(":memory:");

  try {
    registry.register({
      name: "system_info",
      version: "2",
      capability: "system.inspect",
      risk: "low",
      confirmation: "none",
      execute: async () => ({ ok: true })
    });

    await assert.rejects(
      executeRegisteredCommand({
        registry,
        journal,
        command: command({
          tool: "system_info",
          tool_version: "1",
          args: {}
        }),
        now: new Date("2026-10-07T01:00:00.000Z")
      }),
      (error) => error?.code === "TOOL_VERSION_MISMATCH"
    );

    assert.equal(journal.getOperation("op-read-1"), null);
  } finally {
    journal.close();
  }
});
