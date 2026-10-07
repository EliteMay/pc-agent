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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pc-agent-write-tools-"));
  const registry = new ToolRegistry();
  registerSafeWriteTools(registry, {
    allowedRoots: [root],
    maxTextFileBytes: 64 * 1024
  });

  return {
    root,
    registry,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("safe write registry exposes only confirmation-required write tools", () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.registry.list().map((tool) => tool.name).sort(),
      ["create_directory", "write_text_file"]
    );

    for (const tool of f.registry.list()) {
      assert.equal(tool.confirmation, "required");
      assert.equal(tool.capability, "file.write");
      assert.equal(tool.risk, "medium");
    }
  } finally {
    f.cleanup();
  }
});

test("create_directory creates and verifies a nested directory", {
  skip: process.platform !== "win32"
}, async () => {
  const f = fixture();
  const target = path.join(f.root, "new", "nested");

  try {
    const tool = f.registry.require("create_directory");
    const summary = tool.approvalSummary({ path: target });

    assert.equal(summary.path.endsWith("\\new\\nested"), true);

    const result = await tool.execute({ path: target });

    assert.equal(result.created, true);
    assert.equal(result.verified, true);
  } finally {
    f.cleanup();
  }
});

test("create_directory refuses sensitive destinations", {
  skip: process.platform !== "win32"
}, async () => {
  const f = fixture();

  try {
    await assert.rejects(
      f.registry.require("create_directory").execute({
        path: path.join(f.root, ".ssh", "new")
      }),
      (error) => error instanceof SafeWriteToolError
        && error.code === "SENSITIVE_PATH"
    );
  } finally {
    f.cleanup();
  }
});

test("write_text_file creates a new UTF-8 file only when expected_sha256 is null", {
  skip: process.platform !== "win32"
}, async () => {
  const f = fixture();
  const target = path.join(f.root, "hello.txt");

  try {
    const result = await f.registry.require("write_text_file").execute({
      path: target,
      text: "hello world",
      expected_sha256: null
    });

    assert.equal(readFileSync(target, "utf8"), "hello world");
    assert.equal(result.sha256, sha256("hello world"));
    assert.equal(result.previous_sha256, null);
    assert.equal(result.verified, true);
    assert.equal(result.backup_path, null);
  } finally {
    f.cleanup();
  }
});

test("write_text_file requires the current hash before replacing an existing file", {
  skip: process.platform !== "win32"
}, async () => {
  const f = fixture();
  const target = path.join(f.root, "replace.txt");

  try {
    writeFileSync(target, "old", "utf8");

    await assert.rejects(
      f.registry.require("write_text_file").execute({
        path: target,
        text: "new",
        expected_sha256: null
      }),
      (error) => error instanceof SafeWriteToolError
        && error.code === "EXPECTED_HASH_REQUIRED"
    );

    await assert.rejects(
      f.registry.require("write_text_file").execute({
        path: target,
        text: "new",
        expected_sha256: "0".repeat(64)
      }),
      (error) => error instanceof SafeWriteToolError
        && error.code === "EXPECTED_HASH_MISMATCH"
    );

    const result = await f.registry.require("write_text_file").execute({
      path: target,
      text: "new",
      expected_sha256: sha256("old")
    });

    assert.equal(readFileSync(target, "utf8"), "new");
    assert.equal(result.previous_sha256, sha256("old"));
    assert.match(result.backup_path, /\.pc-agent-backups/i);
    assert.equal(readFileSync(result.backup_path, "utf8"), "old");
  } finally {
    f.cleanup();
  }
});

test("write_text_file refuses sensitive files and oversized content", {
  skip: process.platform !== "win32"
}, async () => {
  const f = fixture();

  try {
    await assert.rejects(
      f.registry.require("write_text_file").execute({
        path: path.join(f.root, ".env"),
        text: "SECRET=x",
        expected_sha256: null
      }),
      (error) => error instanceof SafeWriteToolError
        && error.code === "SENSITIVE_PATH"
    );

    await assert.rejects(
      f.registry.require("write_text_file").execute({
        path: path.join(f.root, "large.txt"),
        text: "x".repeat(64 * 1024 + 1),
        expected_sha256: null
      }),
      (error) => error instanceof SafeWriteToolError
        && error.code === "FILE_TOO_LARGE"
    );
  } finally {
    f.cleanup();
  }
});
