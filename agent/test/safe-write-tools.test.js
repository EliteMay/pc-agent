import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  registerSafeWriteTools,
  SafeWriteToolError
} from "../src/tools/safe-write-tools.js";

function hashText(value) {
  return createHash("sha256")
    .update(Buffer.from(value, "utf8"))
    .digest("hex");
}

function createFixture(options = {}) {
  const root = mkdtempSync(
    path.join(tmpdir(), "pc-agent-safe-write-")
  );
  const registry = new ToolRegistry();

  registerSafeWriteTools(registry, {
    allowedRoots: [root],
    maxTextFileBytes: 64 * 1024,
    ...options
  });

  return {
    root,
    registry,
    cleanup() {
      rmSync(root, {
        recursive: true,
        force: true
      });
    }
  };
}

test("safe write tools require local confirmation", () => {
  const fixture = createFixture();

  try {
    const tools = fixture.registry
      .list()
      .sort((a, b) => a.name.localeCompare(b.name));

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["create_directory", "write_text_file"]
    );

    for (const tool of tools) {
      assert.equal(tool.capability, "file.write");
      assert.equal(tool.risk, "medium");
      assert.equal(tool.confirmation, "required");
      assert.equal(typeof tool.approvalSummary, "function");
    }
  } finally {
    fixture.cleanup();
  }
});

test("create_directory creates and verifies a directory", async () => {
  const fixture = createFixture();
  const target = path.join(
    fixture.root,
    "generated",
    "nested"
  );

  try {
    const tool = fixture.registry.require(
      "create_directory"
    );

    const summary = tool.approvalSummary({
      path: target
    });

    assert.equal(
      summary.action,
      "create_directory"
    );

    const result = await tool.execute({
      path: target
    });

    assert.equal(result.created, true);
    assert.equal(result.verified, true);
  } finally {
    fixture.cleanup();
  }
});

test("create_directory rejects sensitive destinations", async () => {
  const fixture = createFixture();

  try {
    await assert.rejects(
      fixture.registry
        .require("create_directory")
        .execute({
          path: path.join(
            fixture.root,
            ".ssh",
            "generated"
          )
        }),
      (error) =>
        error instanceof SafeWriteToolError
        && error.code === "SENSITIVE_PATH"
    );
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file safely creates a new UTF-8 file", async () => {
  const fixture = createFixture();
  const target = path.join(
    fixture.root,
    "hello.txt"
  );

  try {
    const result = await fixture.registry
      .require("write_text_file")
      .execute({
        path: target,
        text: "hello world",
        expected_sha256: null
      });

    assert.equal(
      readFileSync(target, "utf8"),
      "hello world"
    );
    assert.equal(
      result.sha256,
      hashText("hello world")
    );
    assert.equal(result.previous_sha256, null);
    assert.equal(result.backup_path, null);
    assert.equal(result.verified, true);
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file requires the current hash before replacement", async () => {
  const fixture = createFixture();
  const target = path.join(
    fixture.root,
    "replace.txt"
  );

  try {
    writeFileSync(target, "old", "utf8");

    await assert.rejects(
      fixture.registry
        .require("write_text_file")
        .execute({
          path: target,
          text: "new",
          expected_sha256: null
        }),
      (error) =>
        error instanceof SafeWriteToolError
        && error.code === "EXPECTED_HASH_REQUIRED"
    );

    await assert.rejects(
      fixture.registry
        .require("write_text_file")
        .execute({
          path: target,
          text: "new",
          expected_sha256: "0".repeat(64)
        }),
      (error) =>
        error instanceof SafeWriteToolError
        && error.code === "EXPECTED_HASH_MISMATCH"
    );

    const result = await fixture.registry
      .require("write_text_file")
      .execute({
        path: target,
        text: "new",
        expected_sha256: hashText("old")
      });

    assert.equal(
      readFileSync(target, "utf8"),
      "new"
    );
    assert.equal(
      result.previous_sha256,
      hashText("old")
    );
    assert.ok(result.backup_path);
    assert.equal(
      readFileSync(result.backup_path, "utf8"),
      "old"
    );
  } finally {
    fixture.cleanup();
  }
});

test("write_text_file rejects sensitive and oversized targets", async () => {
  const fixture = createFixture({
    maxTextFileBytes: 8
  });

  try {
    await assert.rejects(
      fixture.registry
        .require("write_text_file")
        .execute({
          path: path.join(
            fixture.root,
            ".env"
          ),
          text: "x",
          expected_sha256: null
        }),
      (error) =>
        error instanceof SafeWriteToolError
        && error.code === "SENSITIVE_PATH"
    );

    await assert.rejects(
      fixture.registry
        .require("write_text_file")
        .execute({
          path: path.join(
            fixture.root,
            "large.txt"
          ),
          text: "123456789",
          expected_sha256: null
        }),
      (error) =>
        error instanceof SafeWriteToolError
        && error.code === "FILE_TOO_LARGE"
    );
  } finally {
    fixture.cleanup();
  }
});
