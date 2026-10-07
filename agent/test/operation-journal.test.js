import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OperationJournal,
  OperationJournalError
} from "../src/journal/operation-journal.js";
import { executeOnce } from "../src/execution/execute-once.js";

function createTempJournal() {
  const directory = mkdtempSync(join(tmpdir(), "pc-agent-journal-"));
  const databasePath = join(directory, "journal.sqlite");
  const journal = new OperationJournal(databasePath);
  return {
    directory,
    databasePath,
    journal,
    cleanup() {
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("first operation is accepted and duplicate operation_id is not re-accepted", () => {
  const fixture = createTempJournal();

  try {
    const first = fixture.journal.beginOperation({
      commandId: "cmd-1",
      operationId: "op-1",
      toolName: "system_info"
    });

    const duplicate = fixture.journal.beginOperation({
      commandId: "cmd-2",
      operationId: "op-1",
      toolName: "system_info"
    });

    assert.equal(first.accepted, true);
    assert.equal(first.record.status, "RUNNING");
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.record.operation_id, "op-1");
    assert.equal(duplicate.record.command_id, "cmd-1");
  } finally {
    fixture.cleanup();
  }
});

test("same command_id cannot be reused for a different operation_id", () => {
  const fixture = createTempJournal();

  try {
    fixture.journal.beginOperation({
      commandId: "cmd-1",
      operationId: "op-1",
      toolName: "system_info"
    });

    assert.throws(
      () => fixture.journal.beginOperation({
        commandId: "cmd-1",
        operationId: "op-2",
        toolName: "system_info"
      }),
      (error) => error instanceof OperationJournalError
        && error.code === "COMMAND_ID_CONFLICT"
    );
  } finally {
    fixture.cleanup();
  }
});

test("executeOnce executes a logical operation only once", async () => {
  const fixture = createTempJournal();
  let executions = 0;
  const tool = {
    execute: async (args) => {
      executions += 1;
      return { echoed: args.value };
    }
  };

  const baseCommand = {
    operation_id: "op-once",
    tool: "echo",
    args: { value: 42 }
  };

  try {
    const first = await executeOnce({
      journal: fixture.journal,
      command: { ...baseCommand, command_id: "cmd-a" },
      tool
    });

    const duplicate = await executeOnce({
      journal: fixture.journal,
      command: { ...baseCommand, command_id: "cmd-b" },
      tool
    });

    assert.equal(executions, 1);
    assert.equal(first.executed, true);
    assert.deepEqual(first.result, { echoed: 42 });
    assert.equal(duplicate.executed, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.operation.status, "SUCCEEDED");
    assert.match(duplicate.operation.result_hash, /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test("unfinished RUNNING operations become UNKNOWN_OUTCOME after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "pc-agent-journal-restart-"));
  const databasePath = join(directory, "journal.sqlite");

  try {
    const firstJournal = new OperationJournal(databasePath);
    firstJournal.beginOperation({
      commandId: "cmd-crash",
      operationId: "op-crash",
      toolName: "write_text_file"
    });
    firstJournal.close();

    const reopened = new OperationJournal(databasePath);
    try {
      const record = reopened.getOperation("op-crash");
      assert.equal(record.status, "UNKNOWN_OUTCOME");

      const duplicate = reopened.beginOperation({
        commandId: "cmd-retry",
        operationId: "op-crash",
        toolName: "write_text_file"
      });
      assert.equal(duplicate.accepted, false);
      assert.equal(duplicate.record.status, "UNKNOWN_OUTCOME");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed operations are journaled and are not automatically retried", async () => {
  const fixture = createTempJournal();
  let executions = 0;
  const expected = Object.assign(new Error("boom"), { code: "TEST_FAILURE" });
  const tool = {
    execute: async () => {
      executions += 1;
      throw expected;
    }
  };
  const command = {
    command_id: "cmd-fail-1",
    operation_id: "op-fail",
    tool: "test_tool",
    args: {}
  };

  try {
    await assert.rejects(
      executeOnce({ journal: fixture.journal, command, tool }),
      (error) => error === expected
    );

    const record = fixture.journal.getOperation("op-fail");
    assert.equal(record.status, "FAILED");
    assert.equal(record.error_code, "TEST_FAILURE");

    const duplicate = await executeOnce({
      journal: fixture.journal,
      command: { ...command, command_id: "cmd-fail-2" },
      tool
    });

    assert.equal(executions, 1);
    assert.equal(duplicate.executed, false);
    assert.equal(duplicate.operation.status, "FAILED");
  } finally {
    fixture.cleanup();
  }
});


test("journal success-write failure does not rewrite an executed operation as FAILED", async () => {
  let markFailedCalls = 0;

  const journal = {
    beginOperation() {
      return {
        accepted: true,
        record: {
          operation_id: "op-journal-failure",
          status: "RUNNING"
        }
      };
    },
    markSucceeded() {
      throw new OperationJournalError(
        "simulated journal persistence failure",
        "JOURNAL_WRITE_FAILED"
      );
    },
    markFailed() {
      markFailedCalls += 1;
    }
  };

  const tool = {
    execute: async () => ({ changed: true })
  };

  await assert.rejects(
    executeOnce({
      journal,
      command: {
        command_id: "cmd-journal-failure",
        operation_id: "op-journal-failure",
        tool: "write_text_file",
        args: {}
      },
      tool
    }),
    (error) => error instanceof OperationJournalError
      && error.code === "JOURNAL_WRITE_FAILED"
  );

  assert.equal(markFailedCalls, 0);
});
