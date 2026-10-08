import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureNotepadTool, parseNotepadCapture } from "../src/tools/capture-notepad.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
function reply(overrides = {}) {
  return JSON.stringify({
    target: "notepad",
    mime_type: "image/jpeg",
    width: 640,
    height: 480,
    image_base64: jpeg,
    ...overrides
  });
}

test("capture_notepad is approval-required and cannot capture another target", () => {
  const tool = createCaptureNotepadTool({ platform: "win32" });
  assert.equal(tool.name, "capture_notepad");
  assert.equal(tool.capability, "screen.capture");
  assert.equal(tool.risk, "medium");
  assert.equal(tool.confirmation, "required");
  assert.match(JSON.stringify(tool.approvalSummary({})), /transmitted/);
  assert.throws(
    () => tool.approvalSummary({ target: "desktop" }),
    (error) => error?.code === "INVALID_ARGUMENTS"
  );
});

test("capture is forbidden outside Windows before subprocess execution", async () => {
  let invoked = false;
  const tool = createCaptureNotepadTool({
    platform: "linux",
    runCapture: async () => { invoked = true; }
  });
  await assert.rejects(
    tool.execute({}),
    (error) => error?.code === "UNSUPPORTED_PLATFORM"
  );
  assert.equal(invoked, false);
});

test("capture uses only the fixed Windows PowerShell executable without a shell", async () => {
  const calls = [];
  const tool = createCaptureNotepadTool({
    platform: "win32",
    env: {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      PC_AGENT_DEVICE_TOKEN: "never-send-to-capture"
    },
    runCapture: async (...args) => {
      calls.push(args);
      return { stdout: reply(), stderr: "" };
    }
  });

  const result = await tool.execute({});
  assert.deepEqual(result, {
    target: "notepad",
    mime_type: "image/jpeg",
    image_base64: jpeg,
    width: 640,
    height: 480
  });
  assert.equal(calls.length, 1);
  const [exe, args, options] = calls[0];
  assert.equal(exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 20000);
  assert.equal(options.env.PC_AGENT_DEVICE_TOKEN, undefined);
  assert.ok(!args.includes("-Command"));
  assert.ok(!args.includes("-File"));
  const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  assert.match(script, /PrintWindow/);
  assert.match(script, /GetProcessesByName\('notepad'\)/);
  assert.match(script, /Assert-GameNotRunning/);
  await assert.rejects(
    tool.execute({ shell: true }),
    (error) => error?.code === "INVALID_ARGUMENTS"
  );
  assert.equal(calls.length, 1);
});

test("capture rejects absent or relative Windows system root", async () => {
  const tool = createCaptureNotepadTool({ platform: "win32", env: { SystemRoot: "Windows" } });
  await assert.rejects(
    tool.execute({}),
    (error) => error?.code === "SYSTEM_ROOT_UNAVAILABLE"
  );
});

test("capture normalizes subprocess failures without leaking stderr or secrets", async () => {
  const tool = createCaptureNotepadTool({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    runCapture: async () => { throw new Error("Sensitive application contents"); }
  });
  await assert.rejects(
    tool.execute({}),
    (error) => error?.code === "CAPTURE_FAILED"
      && !error.message.includes("Sensitive")
  );
});

test("capture rejects corrupt metadata, oversized images and invalid base64", () => {
  const oversized = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(350_000, 0x01),
    Buffer.from([0xff, 0xd9])
  ]).toString("base64");
  const invalid = [
    "not json",
    reply({ target: "desktop" }),
    reply({ mime_type: "image/png" }),
    reply({ width: 961 }),
    reply({ height: 721 }),
    reply({ image_base64: Buffer.from("text").toString("base64") }),
    reply({ image_base64: "!" }),
    reply({ image_base64: jpeg + " " }),
    reply({ image_base64: oversized }),
    "x".repeat(650_001)
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseNotepadCapture(value),
      (error) => error?.code === "INVALID_CAPTURE_RESULT",
      value.slice(0, 50)
    );
  }
});
