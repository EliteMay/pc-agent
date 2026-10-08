import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNotepadGuiTool,
  parseNotepadGuiResult,
  validateNotepadGuiArgs
} from "../src/tools/notepad-gui.js";

const actions = [
  { action: "click", x: 90, y: 150 },
  { action: "type", text: "Test あいう\nSecond line" },
  { action: "scroll", direction: "down", steps: 2 },
  { action: "save" }
];

test("Notepad GUI actions require high-risk local approval", () => {
  const tool = createNotepadGuiTool({ platform: "win32" });
  assert.equal(tool.capability, "gui.input");
  assert.equal(tool.confirmation, "required");
  assert.equal(tool.risk, "high");
  for (const args of actions) {
    assert.equal(tool.approvalSummary(args).operation, args.action);
  }
  assert.equal(tool.approvalSummary(actions[1]).characters, actions[1].text.length);
});

test("validateNotepadGuiArgs rejects unknown actions, fields, coordinates and text", () => {
  const bad = [
    {}, { action: "launch" }, null, [],
    { action: "click" }, { action: "click", x: 2.5, y: 3 },
    { action: "click", x: -1, y: 1 }, { action: "click", x: 3841, y: 1 },
    { action: "click", x: 1, y: 2, shell: true },
    { action: "type", text: "" }, { action: "type", text: "a".repeat(501) },
    { action: "type", text: "hello\u0000world" },
    { action: "scroll", direction: "left", steps: 1 },
    { action: "scroll", direction: "up", steps: 0 },
    { action: "scroll", direction: "down", steps: 4 },
    { action: "save", path: "C:\\secret.txt" },
    { action: "open", path: "notepad.txt" },
    { action: "open", path: "C:\\Windows\\calc.exe" },
    { action: "open", path: "C:\\secret.txt", extra: true }
  ];
  for (const args of bad) {
    assert.throws(() => validateNotepadGuiArgs(args),
      (error) => error.code === "INVALID_ARGUMENTS");
  }
  for (const args of actions) {
    assert.deepEqual(validateNotepadGuiArgs(args), args);
  }
});

test("Notepad GUI does not execute on non-Windows machines", async () => {
  let called = false;
  const tool = createNotepadGuiTool({
    platform: "linux",
    runCommand: async () => { called = true; }
  });
  await assert.rejects(tool.execute(actions[0]),
    (error) => error.code === "UNSUPPORTED_PLATFORM");
  assert.equal(called, false);
});

test("GUI tool invokes a fixed PowerShell script, with bounded sanitized environment and encoded arguments", async () => {
  const calls = [];
  const tool = createNotepadGuiTool({
    platform: "win32",
    env: {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\Tester\\AppData\\Local\\Temp",
      PC_AGENT_DEVICE_TOKEN: "secret-must-never-inherit",
      PC_AGENT_LOCAL_APPROVAL_SECRET: "private-key"
    },
    runCommand: async (...args) => {
      calls.push(args);
      const payload = JSON.parse(
        Buffer.from(args[2].env.PC_AGENT_NOTEPAD_ACTION_B64, "base64").toString("utf8")
      );
      return {
        stdout: JSON.stringify({
          target: "notepad",
          action: payload.action,
          dispatched: true,
          verified: false
        }), stderr: ""
      };
    }
  });
  for (const args of actions) {
    const result = await tool.execute(args);
    assert.equal(result.action, args.action);
    assert.equal(result.verified, false);
  }
  assert.equal(calls.length, actions.length);
  for (let i = 0; i < calls.length; i++) {
    const [exe, argv, options] = calls[i];
    assert.equal(exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(argv.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
    assert.equal(argv[3], "-EncodedCommand");
    const ps = Buffer.from(argv[4], "base64").toString("utf16le");
    assert.match(ps, /PcAgentNotepadInput/);
    assert.match(ps, /RequireFocused/);
    // A hidden PowerShell child has STARTF_USESHOWWINDOW=SW_HIDE.
    // ShowWindow's first invocation may hide Notepad instead of showing it.
    assert.doesNotMatch(ps, /\bShowWindow\s*\(/);
    assert.match(ps, /-WindowStyle Normal/);
    assert.match(ps, /IsWindowVisible\(hwnd\)/);
    assert.match(ps, /RequireFocused\(\$target\)/);
    assert.match(ps, /Assert-NoProtectedGame/);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 20_000);
    assert.equal(options.maxBuffer, 4096);
    assert.equal(options.env.TEMP, options.env.TMP);
    assert.equal(options.env.PC_AGENT_DEVICE_TOKEN, undefined);
    assert.equal(options.env.PC_AGENT_LOCAL_APPROVAL_SECRET, undefined);
    assert.deepEqual(
      JSON.parse(Buffer.from(options.env.PC_AGENT_NOTEPAD_ACTION_B64, "base64").toString("utf8")),
      actions[i]
    );
  }
});

test("GUI subprocess errors do not leak tool input or stderr", async () => {
  const tool = createNotepadGuiTool({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
    runCommand: async () => {
      throw new Error("secret screenshot content");
    }
  });
  await assert.rejects(tool.execute({ action: "type", text: "sensitive text" }),
    (error) => error.code === "GUI_ACTION_FAILED"
      && !error.message.includes("secret")
      && !error.message.includes("sensitive"));
});

test("notepad GUI result must match the requested action, never claim verification", () => {
  const valid = JSON.stringify({
    target: "notepad", action: "click", dispatched: true, verified: false
  });
  assert.equal(parseNotepadGuiResult(valid, "click").verified, false);
  for (const invalid of [
    "hello",
    JSON.stringify({ target: "desktop", action: "click", dispatched: true, verified: false }),
    JSON.stringify({ target: "notepad", action: "save", dispatched: true, verified: false }),
    JSON.stringify({ target: "notepad", action: "click", dispatched: true, verified: true }),
    JSON.stringify({ target: "notepad", action: "click", dispatched: true, verified: false, secret: "oops" }),
    "x".repeat(4097)
  ]) {
    assert.throws(() => parseNotepadGuiResult(invalid, "click"),
      (error) => error.code === "INVALID_GUI_RESULT");
  }
});

test("open is only allowed for an existing small .txt file inside allowed roots", {
  skip: process.platform !== "win32"
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pc-agent-notepad-open-"));
  const filename = path.join(root, "test.txt");
  const outside = path.join(tmpdir(), "other.txt");
  writeFileSync(filename, "harmless test data");
  try {
    const invocations = [];
    const tool = createNotepadGuiTool({
      platform: "win32",
      allowedRoots: [root],
      env: { SystemRoot: "C:\\Windows", TEMP: root },
      runCommand: async (_exe, _argv, options) => {
        invocations.push(options.env.PC_AGENT_NOTEPAD_ACTION_B64);
        return { stdout: JSON.stringify({
          target: "notepad", action: "open", dispatched: true, verified: false
        }), stderr: "" };
      }
    });
    const summary = tool.approvalSummary({ action: "open", path: filename });
    assert.equal(summary.operation, "open");
    assert.equal(summary.path.toLowerCase(), realpathSync.native(filename).toLowerCase());
    await tool.execute({ action: "open", path: filename });
    assert.equal(invocations.length, 1);
    const passed = JSON.parse(Buffer.from(invocations[0], "base64").toString("utf8"));
    assert.equal(passed.path.toLowerCase(), realpathSync.native(filename).toLowerCase());
    await assert.rejects(
      tool.execute({ action: "open", path: outside }),
      (error) => error.code === "PATH_NOT_FOUND" || error.code === "PATH_OUTSIDE_ALLOWED_ROOTS"
    );
    assert.equal(invocations.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
