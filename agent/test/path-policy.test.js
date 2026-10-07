import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertPathWithinAllowedRoots,
  isSensitivePath,
  resolveExistingPathWithinAllowedRoots,
  resolveNewPathWithinAllowedRoots,
  revalidateNewPathBeforeWrite,
  PathPolicyError
} from "../src/security/path-policy.js";

test("accepts a Windows path inside an allowed root", () => {
  assert.equal(
    assertPathWithinAllowedRoots("D:\\AI\\project\\README.md", ["D:\\AI"]),
    "D:\\AI\\project\\README.md"
  );
});

test("rejects sibling-prefix escapes such as D:\\AI-evil", () => {
  assert.throws(
    () => assertPathWithinAllowedRoots("D:\\AI-evil\\secret.txt", ["D:\\AI"]),
    /outside allowed roots/i
  );
});

test("rejects parent traversal outside an allowed root", () => {
  assert.throws(
    () => assertPathWithinAllowedRoots("D:\\AI\\project\\..\\..\\secret.txt", ["D:\\AI"]),
    /outside allowed roots/i
  );
});

test("detects sensitive file names case-insensitively", () => {
  assert.equal(isSensitivePath("D:\\AI\\project\\.ENV"), true);
  assert.equal(isSensitivePath("D:\\AI\\project\\keys\\id_ed25519"), true);
  assert.equal(isSensitivePath("D:\\AI\\project\\README.md"), false);
});

test("existing path is canonicalized with the filesystem before root enforcement", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-path-"));
  const root = path.join(directory, "Allowed");
  const file = path.join(root, "Folder", "file.txt");

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "ok");

    const resolved = resolveExistingPathWithinAllowedRoots(file, [root]);

    assert.equal(
      resolved.toLocaleLowerCase("en-US"),
      realpathSync.native(file).toLocaleLowerCase("en-US")
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("junction inside an allowed root cannot escape to an outside existing file", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-junction-"));
  const root = path.join(directory, "Allowed");
  const outside = path.join(directory, "Outside");
  const junction = path.join(root, "escape");
  const secret = path.join(outside, "secret.txt");

  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(secret, "secret");
    symlinkSync(outside, junction, "junction");

    assert.throws(
      () => resolveExistingPathWithinAllowedRoots(
        path.join(junction, "secret.txt"),
        [root]
      ),
      (error) => error instanceof PathPolicyError
        && error.code === "PATH_OUTSIDE_ALLOWED_ROOTS"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new path resolves the nearest existing parent and rejects junction escape", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-new-junction-"));
  const root = path.join(directory, "Allowed");
  const outside = path.join(directory, "Outside");
  const junction = path.join(root, "escape");

  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, junction, "junction");

    assert.throws(
      () => resolveNewPathWithinAllowedRoots(
        path.join(junction, "new-folder", "new-file.txt"),
        [root]
      ),
      (error) => error instanceof PathPolicyError
        && error.code === "PATH_OUTSIDE_ALLOWED_ROOTS"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new nested path under a real allowed root returns a canonical target", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-new-path-"));
  const root = path.join(directory, "Allowed");

  try {
    mkdirSync(root, { recursive: true });

    const candidate = path.join(root, "does-not-exist", "nested", "file.txt");
    const resolved = resolveNewPathWithinAllowedRoots(candidate, [root]);
    const expected = path.join(
      realpathSync.native(root),
      "does-not-exist",
      "nested",
      "file.txt"
    );

    assert.equal(
      resolved.toLocaleLowerCase("en-US"),
      expected.toLocaleLowerCase("en-US")
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("allowed root may itself be a junction without weakening containment", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-root-junction-"));
  const physicalRoot = path.join(directory, "Physical");
  const rootAlias = path.join(directory, "Alias");
  const file = path.join(physicalRoot, "file.txt");

  try {
    mkdirSync(physicalRoot, { recursive: true });
    writeFileSync(file, "ok");
    symlinkSync(physicalRoot, rootAlias, "junction");

    const resolved = resolveExistingPathWithinAllowedRoots(
      path.join(rootAlias, "file.txt"),
      [rootAlias]
    );

    assert.equal(
      resolved.toLocaleLowerCase("en-US"),
      realpathSync.native(file).toLocaleLowerCase("en-US")
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("new path rejects Windows alternate data stream syntax and reserved names", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-invalid-name-"));
  const root = path.join(directory, "Allowed");

  try {
    mkdirSync(root, { recursive: true });

    assert.throws(
      () => resolveNewPathWithinAllowedRoots(
        path.join(root, "file.txt:secret"),
        [root]
      ),
      (error) => error instanceof PathPolicyError
        && error.code === "INVALID_NEW_PATH_SEGMENT"
    );

    assert.throws(
      () => resolveNewPathWithinAllowedRoots(
        path.join(root, "CON.txt"),
        [root]
      ),
      (error) => error instanceof PathPolicyError
        && error.code === "RESERVED_WINDOWS_NAME"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("write-time revalidation detects a parent replaced by a junction", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-toctou-"));
  const root = path.join(directory, "Allowed");
  const parent = path.join(root, "parent");
  const outside = path.join(directory, "Outside");
  const candidate = path.join(parent, "new-file.txt");

  try {
    mkdirSync(parent, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const expected = resolveNewPathWithinAllowedRoots(candidate, [root]);

    rmSync(parent, { recursive: true, force: true });
    symlinkSync(outside, parent, "junction");

    assert.throws(
      () => revalidateNewPathBeforeWrite(candidate, [root], expected),
      (error) => error instanceof PathPolicyError
        && (
          error.code === "PATH_OUTSIDE_ALLOWED_ROOTS"
          || error.code === "PATH_CHANGED_DURING_OPERATION"
        )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing allowed root fails closed", {
  skip: process.platform !== "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pc-agent-missing-root-"));
  const missingRoot = path.join(directory, "missing");

  try {
    assert.throws(
      () => resolveNewPathWithinAllowedRoots(
        path.join(missingRoot, "file.txt"),
        [missingRoot]
      ),
      (error) => error instanceof PathPolicyError
        && error.code === "ALLOWED_ROOT_NOT_FOUND"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
