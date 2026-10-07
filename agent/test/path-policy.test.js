import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPathWithinAllowedRoots,
  isSensitivePath
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
