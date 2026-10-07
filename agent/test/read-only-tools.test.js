import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  registerReadOnlyTools,
  ReadOnlyToolError
} from "../src/tools/read-only-tools.js";
import { parseTasklistCsv } from "../src/tools/list-processes.js";

function createFixture(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pc-agent-read-tools-"));
  const registry = new ToolRegistry();

  registerReadOnlyTools(registry, {
    allowedRoots: [root],
    maxTextFileBytes: 64 * 1024,
    maxDirectoryEntries: 100,
    ...options
  });

  return {
    root,
    registry,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("registers the five read-only tools including v1 ping", () => {
  const fixture = createFixture();

  try {
    assert.deepEqual(
      fixture.registry.list().map((tool) => tool.name).sort(),
      [
        "list_directory",
        "ping",
        "list_processes",
        "read_text_file",
        "system_info"
      ]
    );

    assert.equal(
      fixture.registry.require("ping").capability,
      "system.inspect"
    );
    assert.equal(
      fixture.registry.require("read_text_file").capability,
      "file.read"
    );
    assert.equal(
      fixture.registry.require("list_processes").capability,
      "process.inspect"
    );
    assert.equal(
      fixture.registry.require("system_info").capability,
      "system.inspect"
    );
  } finally {
    fixture.cleanup();
  }
});

test("ping returns a bounded v1 pong", async () => {
  const fixture = createFixture();

  try {
    const result = await fixture.registry
      .require("ping")
      .execute({});

    assert.deepEqual(result, {
      success: true,
      message: "pong",
      transport: "pc-agent-v1"
    });

    await assert.rejects(
      fixture.registry.require("ping").execute({ extra: true }),
      (error) => error instanceof ReadOnlyToolError
        && error.code === "INVALID_ARGUMENTS"
    );
  } finally {
    fixture.cleanup();
  }
});

test("system_info returns bounded non-identifying machine facts", async () => {
  const fixture = createFixture();

  try {
    const result = await fixture.registry
      .require("system_info")
      .execute({});

    assert.equal(result.platform, process.platform);
    assert.equal(result.architecture, process.arch);
    assert.equal(result.node_version, process.version);
    assert.ok(Number.isInteger(result.cpu_count));
    assert.ok(result.cpu_count > 0);
    assert.ok(result.total_memory_bytes > 0);
    assert.equal("username" in result, false);
    assert.equal("hostname" in result, false);
  } finally {
    fixture.cleanup();
  }
});

test("list_directory uses canonical path policy and filters sensitive entries", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = createFixture();

  try {
    mkdirSync(path.join(fixture.root, "docs"));
    writeFileSync(path.join(fixture.root, "visible.txt"), "hello");
    writeFileSync(path.join(fixture.root, ".env"), "SECRET=x");
    mkdirSync(path.join(fixture.root, ".ssh"));

    const result = await fixture.registry
      .require("list_directory")
      .execute({ path: fixture.root });

    assert.deepEqual(
      result.entries.map((entry) => entry.name).sort(),
      ["docs", "visible.txt"]
    );
    assert.equal(result.filtered_sensitive_entries, 2);
    assert.equal(
      result.entries.find((entry) => entry.name === "docs").type,
      "directory"
    );
  } finally {
    fixture.cleanup();
  }
});

test("list_directory rejects a junction that escapes the allowed root", {
  skip: process.platform !== "win32"
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-list-junction-"));
  const root = path.join(directory, "Allowed");
  const outside = path.join(directory, "Outside");
  const junction = path.join(root, "escape");
  const registry = new ToolRegistry();

  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    symlinkSync(outside, junction, "junction");

    registerReadOnlyTools(registry, { allowedRoots: [root] });

    await assert.rejects(
      registry.require("list_directory").execute({ path: junction }),
      (error) => error?.code === "PATH_OUTSIDE_ALLOWED_ROOTS"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read_text_file reads UTF-8 text inside an allowed root", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = createFixture();
  const file = path.join(fixture.root, "notes.txt");

  try {
    writeFileSync(file, "hello\nworld", "utf8");

    const result = await fixture.registry
      .require("read_text_file")
      .execute({ path: file });

    assert.equal(result.text, "hello\nworld");
    assert.equal(result.bytes, Buffer.byteLength("hello\nworld"));
    assert.match(result.path, /notes\.txt$/i);
  } finally {
    fixture.cleanup();
  }
});

test("read_text_file supports bounded offset byte ranges", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = createFixture();
  const file = path.join(fixture.root, "range.txt");

  try {
    writeFileSync(file, "hello world", "utf8");

    const first = await fixture.registry
      .require("read_text_file")
      .execute({
        path: file,
        offset: 0,
        maxBytes: 5
      });

    assert.equal(first.text, "hello");
    assert.equal(first.offset, 0);
    assert.equal(first.bytes, 5);
    assert.equal(first.next_offset, 5);
    assert.equal(first.eof, false);

    const second = await fixture.registry
      .require("read_text_file")
      .execute({
        path: file,
        offset: first.next_offset,
        maxBytes: 6
      });

    assert.equal(second.text, " world");
    assert.equal(second.offset, 5);
    assert.equal(second.bytes, 6);
    assert.equal(second.next_offset, 11);
    assert.equal(second.eof, true);
  } finally {
    fixture.cleanup();
  }
});

test("read_text_file rejects invalid range arguments", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = createFixture();
  const file = path.join(fixture.root, "range.txt");

  try {
    writeFileSync(file, "hello", "utf8");

    await assert.rejects(
      fixture.registry.require("read_text_file").execute({
        path: file,
        offset: -1
      }),
      (error) => error instanceof ReadOnlyToolError
        && error.code === "INVALID_ARGUMENTS"
    );

    await assert.rejects(
      fixture.registry.require("read_text_file").execute({
        path: file,
        maxBytes: 65537
      }),
      (error) => error instanceof ReadOnlyToolError
        && error.code === "INVALID_ARGUMENTS"
    );
  } finally {
    fixture.cleanup();
  }
});

test("read_text_file denies sensitive files even when they are in an allowed root", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = createFixture();
  const file = path.join(fixture.root, ".env");

  try {
    writeFileSync(file, "SECRET=x", "utf8");

    await assert.rejects(
      fixture.registry.require("read_text_file").execute({ path: file }),
      (error) => error instanceof ReadOnlyToolError
        && error.code === "SENSITIVE_PATH"
    );
  } finally {
    fixture.cleanup();
  }
});

test("read_text_file rejects binary content and oversized files", {
  skip: process.platform !== "win32"
}, async () => {
  const binaryFixture = createFixture();
  const binaryFile = path.join(binaryFixture.root, "binary.bin");

  try {
    writeFileSync(binaryFile, Buffer.from([0x41, 0x00, 0x42]));

    await assert.rejects(
      binaryFixture.registry
        .require("read_text_file")
        .execute({ path: binaryFile }),
      (error) => error instanceof ReadOnlyToolError
        && error.code === "BINARY_FILE"
    );
  } finally {
    binaryFixture.cleanup();
  }

  const smallLimitFixture = createFixture({ maxTextFileBytes: 8 });
  const largeFile = path.join(smallLimitFixture.root, "large.txt");

  try {
    writeFileSync(largeFile, "123456789", "utf8");

    await assert.rejects(
      smallLimitFixture.registry
        .require("read_text_file")
        .execute({ path: largeFile }),
      (error) => error instanceof ReadOnlyToolError
        && error.code === "FILE_TOO_LARGE"
    );
  } finally {
    smallLimitFixture.cleanup();
  }
});

test("tasklist CSV parser handles commas and escaped quotes", () => {
  const rows = parseTasklistCsv(
    '"node.exe","1234","Console","1","42,000 K"\r\n' +
    '"weird""name.exe","5678","Console","1","1 K"\r\n'
  );

  assert.deepEqual(rows, [
    { image_name: "node.exe", pid: 1234 },
    { image_name: 'weird"name.exe', pid: 5678 }
  ]);
});

test("list_processes executes only the fixed Windows process inspection path", {
  skip: process.platform !== "win32"
}, async () => {
  const fixture = createFixture();

  try {
    const result = await fixture.registry
      .require("list_processes")
      .execute({});

    assert.ok(result.processes.length > 0);
    assert.equal(result.count, result.processes.length);
    assert.ok(
      result.processes.every(
        (entry) => typeof entry.image_name === "string"
          && Number.isInteger(entry.pid)
          && entry.pid > 0
      )
    );
  } finally {
    fixture.cleanup();
  }
});
