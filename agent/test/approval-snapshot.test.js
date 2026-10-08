import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { OperationJournal } from "../src/journal/operation-journal.js";
import { executeRegisteredCommand } from "../src/execution/agent-runtime.js";
import { createCopyFileTool } from "../src/tools/copy-file.js";

function command(tool, args, suffix = "1") {
  return {
    command_id: "cmd-snapshot-" + suffix,
    operation_id: "op-snapshot-" + suffix,
    device_id: "device-1",
    tool,
    tool_version: "1",
    protocol_version: 1,
    created_at: "2026-10-07T00:00:00.000Z",
    expires_at: "2099-10-07T00:00:00.000Z",
    args
  };
}

test("approved state mutation is rejected before tool execution", async () => {
  const registry = new ToolRegistry();
  const journal = new OperationJournal(":memory:");
  let sourceIdentity = "first";
  let executions = 0;

  registry.register({
    name: "mutation_probe",
    version: "1",
    capability: "mutation.test",
    risk: "medium",
    confirmation: "required",
    approvalSummary: () => ({
      source_identity: sourceIdentity,
      destination: "safe"
    }),
    execute: async () => {
      executions += 1;
      return { ok: true };
    }
  });

  try {
    await assert.rejects(
      executeRegisteredCommand({
        registry,
        journal,
        command: command("mutation_probe", {}),
        approvalProvider: {
          async requestApproval({ summary }) {
            assert.equal(summary.source_identity, "first");
            sourceIdentity = "substituted";
            return "approved";
          }
        },
        now: new Date("2026-10-07T01:00:00.000Z")
      }),
      { code: "APPROVED_STATE_CHANGED" }
    );

    assert.equal(executions, 0);
    assert.equal(journal.getOperation("op-snapshot-1").status, "FAILED");
  } finally {
    journal.close();
  }
});

test("approval provider cannot alter the retained snapshot", async () => {
  const registry = new ToolRegistry();
  const journal = new OperationJournal(":memory:");
  let executions = 0;

  registry.register({
    name: "mutation_probe",
    version: "1",
    capability: "mutation.test",
    risk: "medium",
    confirmation: "required",
    approvalSummary: () => ({ source_identity: "original" }),
    execute: async () => {
      executions += 1;
      return { ok: true };
    }
  });

  try {
    const result = await executeRegisteredCommand({
      registry,
      journal,
      command: command("mutation_probe", {}, "2"),
      approvalProvider: {
        async requestApproval(request) {
          request.summary.source_identity = "tampered preview";
          return "approved";
        }
      },
      now: new Date("2026-10-07T01:00:00.000Z")
    });

    assert.equal(result.executed, true);
    assert.equal(executions, 1);
  } finally {
    journal.close();
  }
});

test("copy_file refuses source content changes made during approval", {
  skip: process.platform !== "win32"
}, async () => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "pc-agent-approval-copy-"))
  );
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "copy.txt");
  const original = "first contents";
  const changed = "different contents";
  const registry = new ToolRegistry();
  const journal = new OperationJournal(":memory:");

  writeFileSync(source, original, "utf8");
  registry.register(createCopyFileTool({ allowedRoots: [root] }));

  try {
    await assert.rejects(
      executeRegisteredCommand({
        registry,
        journal,
        command: command(
          "copy_file",
          { source_path: source, destination_path: destination },
          "3"
        ),
        approvalProvider: {
          async requestApproval({ summary }) {
            assert.equal(summary.action, "copy_file");
            writeFileSync(source, changed, "utf8");
            return "approved";
          }
        },
        now: new Date("2026-10-07T01:00:00.000Z")
      }),
      { code: "APPROVED_STATE_CHANGED" }
    );

    assert.equal(existsSync(destination), false);
    assert.equal(readFileSync(source, "utf8"), changed);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
