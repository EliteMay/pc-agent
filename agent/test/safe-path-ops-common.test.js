import assert from "node:assert/strict";
import test from "node:test";
import {
  isPathInside,
  requireSourceDestinationArgs,
  sameWindowsVolume
} from "../src/tools/safe-path-ops-common.js";

test("source and destination are required", () => {
  assert.throws(() => requireSourceDestinationArgs(null), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => requireSourceDestinationArgs({ source_path: "C:\\AI\\a" }), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => requireSourceDestinationArgs({ source_path: "", destination_path: "C:\\AI\\b" }), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => requireSourceDestinationArgs({ source_path: "C:\\AI\\a", destination_path: "C:\\AI\\b", extra: true }), { code: "INVALID_ARGUMENTS" });
  assert.deepEqual(requireSourceDestinationArgs({
    source_path: "C:\\AI\\a", destination_path: "C:\\AI\\b"
  }), { sourcePath: "C:\\AI\\a", destinationPath: "C:\\AI\\b" });
});

test("directory descendant detection respects path boundaries", () => {
  assert.equal(isPathInside("C:\\AI\\folder\\child", "C:\\AI\\folder"), true);
  assert.equal(isPathInside("C:\\AI\\folder", "C:\\AI\\folder"), false);
  assert.equal(isPathInside("C:\\AI\\folder2", "C:\\AI\\folder"), false);
  assert.equal(isPathInside("C:\\AI\\other", "C:\\AI\\folder"), false);
  assert.equal(isPathInside("c:\\ai\\FOLDER\\child", "C:\\AI\\folder"), true);
});

test("volume checks are case-insensitive and reject cross-volume", () => {
  assert.equal(sameWindowsVolume("C:\\AI\\a", "c:\\AI\\b"), true);
  assert.equal(sameWindowsVolume("C:\\AI\\a", "D:\\AI\\b"), false);
  assert.equal(sameWindowsVolume("\\\\server\\share\\a", "\\\\server\\share\\b"), true);
  assert.equal(sameWindowsVolume("\\\\server\\share\\a", "\\\\server\\other\\b"), false);
});
