import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCopyFileTool } from "../src/tools/copy-file.js";
import { createMovePathTool } from "../src/tools/move-path.js";

const windowsOnly = {
  skip: process.platform !== "win32"
};

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "pc-agent-path-ops-"));
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("copy_file copies a file without removing its source", windowsOnly, () =>
  withFixture(async (root) => {
    const source = path.join(root, "original.txt");
    const destination = path.join(root, "copy.txt");
    const bytes = Buffer.from("hello from v0.12\n", "utf8");
    writeFileSync(source, bytes);
    const tool = createCopyFileTool({ allowedRoots: [root] });
    const args = { source_path: source, destination_path: destination };

    const summary = tool.approvalSummary(args);
    assert.equal(summary.action, "copy_file");
    assert.equal(summary.bytes, bytes.length);
    assert.equal(summary.source_sha256, sha256(bytes));

    const result = await tool.execute(args);
    assert.equal(result.verified, true);
    assert.equal(result.sha256, sha256(bytes));
    assert.deepEqual(readFileSync(source), bytes);
    assert.deepEqual(readFileSync(destination), bytes);
  }));

test("copy_file refuses an existing destination and keeps both files intact", windowsOnly, () =>
  withFixture(async (root) => {
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    writeFileSync(source, "source");
    writeFileSync(destination, "do not overwrite");
    const tool = createCopyFileTool({ allowedRoots: [root] });
    const args = { source_path: source, destination_path: destination };

    await assert.rejects(() => tool.execute(args), { code: "TARGET_EXISTS" });
    assert.equal(readFileSync(source, "utf8"), "source");
    assert.equal(readFileSync(destination, "utf8"), "do not overwrite");
  }));

test("copy_file refuses a source above the configured byte limit", windowsOnly, () =>
  withFixture((root) => {
    const source = path.join(root, "large.txt");
    writeFileSync(source, "too many bytes");
    const tool = createCopyFileTool({
      allowedRoots: [root],
      maxCopyFileBytes: 4
    });
    assert.throws(
      () => tool.approvalSummary({
        source_path: source,
        destination_path: path.join(root, "small.txt")
      }),
      { code: "FILE_TOO_LARGE" }
    );
  }));

test("copy_file refuses to copy a directory as a file", windowsOnly, () =>
  withFixture((root) => {
    const directory = path.join(root, "folder");
    mkdirSync(directory);
    const tool = createCopyFileTool({ allowedRoots: [root] });

    assert.throws(
      () => tool.approvalSummary({
        source_path: directory,
        destination_path: path.join(root, "copy")
      }),
      { code: "NOT_A_FILE" }
    );
  }));

test("move_path moves one file and retains its contents", windowsOnly, () =>
  withFixture(async (root) => {
    const source = path.join(root, "old.txt");
    const destination = path.join(root, "new.txt");
    writeFileSync(source, "unchanged contents");
    const tool = createMovePathTool({ allowedRoots: [root] });
    const args = { source_path: source, destination_path: destination };

    const summary = tool.approvalSummary(args);
    assert.equal(summary.action, "move_path");
    assert.equal(summary.source_type, "file");

    const result = await tool.execute(args);
    assert.equal(result.verified, true);
    assert.equal(result.source_type, "file");
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(destination, "utf8"), "unchanged contents");
  }));

test("move_path moves a directory together with its contents", windowsOnly, () =>
  withFixture(async (root) => {
    const source = path.join(root, "old-folder");
    const destination = path.join(root, "new-folder");
    mkdirSync(source);
    writeFileSync(path.join(source, "inside.txt"), "keep me");
    const tool = createMovePathTool({ allowedRoots: [root] });
    const args = { source_path: source, destination_path: destination };

    const summary = tool.approvalSummary(args);
    assert.equal(summary.source_type, "directory");

    const result = await tool.execute(args);
    assert.equal(result.verified, true);
    assert.equal(result.source_type, "directory");
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(path.join(destination, "inside.txt"), "utf8"), "keep me");
  }));

test("move_path refuses an existing destination without replacing it", windowsOnly, () =>
  withFixture(async (root) => {
    const source = path.join(root, "old.txt");
    const destination = path.join(root, "taken.txt");
    writeFileSync(source, "original source");
    writeFileSync(destination, "protected destination");
    const tool = createMovePathTool({ allowedRoots: [root] });

    await assert.rejects(
      () => tool.execute({ source_path: source, destination_path: destination }),
      { code: "TARGET_EXISTS" }
    );
    assert.equal(readFileSync(source, "utf8"), "original source");
    assert.equal(readFileSync(destination, "utf8"), "protected destination");
  }));

test("move_path refuses moving a directory inside itself", windowsOnly, () =>
  withFixture((root) => {
    const source = path.join(root, "parent");
    mkdirSync(source);
    const tool = createMovePathTool({ allowedRoots: [root] });

    assert.throws(
      () => tool.approvalSummary({
        source_path: source,
        destination_path: path.join(source, "child")
      }),
      { code: "DESTINATION_INSIDE_SOURCE" }
    );
  }));

test("move_path refuses moving the allowed root", windowsOnly, () =>
  withFixture((root) => {
    const tool = createMovePathTool({ allowedRoots: [root] });

    assert.throws(
      () => tool.approvalSummary({
        source_path: root,
        destination_path: path.join(root, "moved-root")
      }),
      { code: "ROOT_MOVE_NOT_ALLOWED" }
    );
  }));
