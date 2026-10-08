import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Capabilities } from "../security/capabilities.js";
import { ReadOnlyToolError, requireObjectArgs } from "./read-only-common.js";

const execFileAsync = promisify(execFile);
const ACTIONS = new Set(["click", "type", "scroll", "save"]);
const OUTPUT_LIMIT = 4096;
const ACTION_TIMEOUT_MS = 20_000;

export function validateNotepadGuiArgs(args) {
  requireObjectArgs(args, ["action", "x", "y", "text", "direction", "steps"]);
  if (!ACTIONS.has(args.action)) {
    throw new ReadOnlyToolError("Notepad action is not supported.", "INVALID_ARGUMENTS");
  }

  let expectedKeys;
  switch (args.action) {
    case "click":
      expectedKeys = ["action", "x", "y"];
      if (![args.x, args.y].every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 3840)) {
        throw new ReadOnlyToolError("Click requires bounded client coordinates.", "INVALID_ARGUMENTS");
      }
      break;
    case "type":
      expectedKeys = ["action", "text"];
      if (
        typeof args.text !== "string" || args.text.length < 1 || args.text.length > 500
        || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(args.text)
      ) {
        throw new ReadOnlyToolError("Typing requires 1 to 500 text characters without control codes.", "INVALID_ARGUMENTS");
      }
      break;
    case "scroll":
      expectedKeys = ["action", "direction", "steps"];
      if (!["up", "down"].includes(args.direction)
        || !Number.isSafeInteger(args.steps) || args.steps < 1 || args.steps > 3) {
        throw new ReadOnlyToolError("Scroll direction or step count is invalid.", "INVALID_ARGUMENTS");
      }
      break;
    case "save":
      expectedKeys = ["action"];
      break;
    default:
      throw new ReadOnlyToolError("Unknown action.", "INVALID_ARGUMENTS");
  }
  if (Object.keys(args).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(args, key))) {
    throw new ReadOnlyToolError("Unexpected or missing Notepad action arguments.", "INVALID_ARGUMENTS");
  }

  return Object.freeze({ ...args });
}

export function parseNotepadGuiResult(stdout, action) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT) {
    throw new ReadOnlyToolError("Notepad action reply is too large.", "INVALID_GUI_RESULT");
  }
  let result;
  try { result = JSON.parse(stdout.trim()); }
  catch {
    throw new ReadOnlyToolError("Notepad action reply is not JSON.", "INVALID_GUI_RESULT");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)
    || result.target !== "notepad" || result.action !== action
    || result.dispatched !== true || result.verified !== false
    || Object.keys(result).length !== 4) {
    throw new ReadOnlyToolError("Invalid Notepad action reply.", "INVALID_GUI_RESULT");
  }
  return Object.freeze({
    target: "notepad",
    action,
    dispatched: true,
    verified: false,
    notice: "Input was sent to the focused Notepad window; verify its effect with a fresh capture."
  });
}

export function createNotepadGuiTool({
  platform = process.platform,
  env = process.env,
  runCommand = execFileAsync
} = {}) {
  function assertPlatform() {
    if (platform !== "win32") {
      throw new ReadOnlyToolError("GUI input requires an interactive Windows session.", "UNSUPPORTED_PLATFORM");
    }
  }

  return {
    name: "notepad_gui",
    version: "1",
    capability: Capabilities.GUI_INPUT,
    risk: "high",
    confirmation: "required",
    description: "Send one limited click, text, scroll, or Ctrl+S to the sole visible Notepad window, with fresh local approval.",
    approvalSummary(args) {
      assertPlatform();
      const value = validateNotepadGuiArgs(args);
      return Object.freeze({
        action: "notepad_gui",
        target: "The only visible, foreground-validated Notepad window",
        operation: value.action,
        ...(value.action === "click" ? { x: value.x, y: value.y } : {}),
        ...(value.action === "type" ? { preview: value.text.slice(0, 80), characters: value.text.length } : {}),
        ...(value.action === "scroll" ? { direction: value.direction, steps: value.steps } : {}),
        notice: "Input affects Notepad and requires local approval for every command."
      });
    },
    async execute(args) {
      assertPlatform();
      const action = validateNotepadGuiArgs(args);
      const systemRoot = env.SystemRoot ?? env.WINDIR;
      if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
        throw new ReadOnlyToolError("Windows SystemRoot is unavailable.", "SYSTEM_ROOT_UNAVAILABLE");
      }
      const userTemp = [env.TEMP, env.TMP,
        env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Temp")
      ].find((v) => typeof v === "string" && path.win32.isAbsolute(v));
      if (!userTemp) {
        throw new ReadOnlyToolError("A user temporary directory is unavailable.", "TEMP_DIRECTORY_UNAVAILABLE");
      }

      const executable = path.win32.join(
        systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
      );
      const script = readFileSync(new URL("./notepad-gui.ps1", import.meta.url), "utf8");
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const actionBase64 = Buffer.from(JSON.stringify(action), "utf8").toString("base64");
      let stdout;
      try {
        ({ stdout } = await runCommand(
          executable,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
          {
            shell: false,
            windowsHide: true,
            timeout: ACTION_TIMEOUT_MS,
            maxBuffer: OUTPUT_LIMIT,
            encoding: "utf8",
            env: {
              SystemRoot: systemRoot,
              WINDIR: systemRoot,
              TEMP: userTemp,
              TMP: userTemp,
              PATH: path.win32.join(systemRoot, "System32"),
              PC_AGENT_NOTEPAD_ACTION_B64: actionBase64
            }
          }
        ));
      } catch {
        // Never send the raw PowerShell stderr to ChatGPT.
        throw new ReadOnlyToolError(
          "Notepad action failed or Windows/Game Safety blocked it.",
          "GUI_ACTION_FAILED"
        );
      }
      return parseNotepadGuiResult(stdout, action.action);
    }
  };
}
