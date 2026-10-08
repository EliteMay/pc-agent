import test from "node:test";
import assert from "node:assert/strict";
import { minimalWindowsChildEnvironment } from "../src/security/child-process-env.js";

test("helper subprocess environment cannot inherit device and local IPC credentials", () => {
  const child = minimalWindowsChildEnvironment({
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Tmp",
    PC_AGENT_DEVICE_TOKEN: "sensitive-device-token",
    PC_AGENT_LOCAL_APPROVAL_SECRET: "a".repeat(64),
    PC_AGENT_ENDPOINT: "https://internal.example.test",
    UNRELATED_SECRET: "must-not-appear"
  });

  assert.deepEqual(child, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Tmp"
  });
  assert.equal(Object.isFrozen(child), true);
  assert.equal(child.PC_AGENT_LOCAL_APPROVAL_SECRET, undefined);
});

test("helper subprocess environment requires an absolute system root", () => {
  assert.throws(
    () => minimalWindowsChildEnvironment({ SystemRoot: "relative-folder" }),
    TypeError
  );
});
