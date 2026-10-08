import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Capabilities } from "../security/capabilities.js";
import { ReadOnlyToolError, requireObjectArgs } from "./read-only-common.js";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 350_000;
const MAX_STDOUT_BYTES = 650_000;
const IMAGE_TIMEOUT_MS = 20_000;

export function parseNotepadCapture(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
    throw new ReadOnlyToolError("Image response is too large.", "INVALID_CAPTURE_RESULT");
  }

  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new ReadOnlyToolError("Image response is invalid JSON.", "INVALID_CAPTURE_RESULT");
  }

  if (
    !result || typeof result !== "object" || Array.isArray(result)
    || result.target !== "notepad" || result.mime_type !== "image/jpeg"
    || !Number.isSafeInteger(result.width) || result.width < 1 || result.width > 960
    || !Number.isSafeInteger(result.height) || result.height < 1 || result.height > 720
    || typeof result.image_base64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.image_base64)
  ) {
    throw new ReadOnlyToolError("Invalid Notepad capture metadata.", "INVALID_CAPTURE_RESULT");
  }

  const image = Buffer.from(result.image_base64, "base64");
  if (
    image.length < 4 || image.length > MAX_IMAGE_BYTES
    || image[0] !== 0xff || image[1] !== 0xd8
    || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9
    || image.toString("base64") !== result.image_base64
  ) {
    throw new ReadOnlyToolError("Invalid or oversized JPEG image.", "INVALID_CAPTURE_RESULT");
  }

  return Object.freeze({
    target: "notepad",
    mime_type: "image/jpeg",
    image_base64: result.image_base64,
    width: result.width,
    height: result.height
  });
}

export function createCaptureNotepadTool({
  platform = process.platform,
  env = process.env,
  runCapture = execFileAsync
} = {}) {
  function assertArguments(args) {
    requireObjectArgs(args, []);
    if (platform !== "win32") {
      throw new ReadOnlyToolError("Window capture requires Windows.", "UNSUPPORTED_PLATFORM");
    }
  }

  return {
    name: "capture_notepad",
    version: "1",
    capability: Capabilities.SCREEN_CAPTURE,
    risk: "medium",
    confirmation: "required",
    description: "Capture one visible Notepad window, never the full desktop. Sends image data to the cloud after local approval.",
    approvalSummary(args) {
      assertArguments(args);
      return Object.freeze({
        action: "capture_notepad",
        target: "Exactly one visible Notepad window",
        notice: "Its content will be transmitted to the authenticated ChatGPT gateway."
      });
    },
    async execute(args) {
      assertArguments(args);
      const systemRoot = env.SystemRoot ?? env.WINDIR;
      if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
        throw new ReadOnlyToolError("Windows SystemRoot is unavailable.", "SYSTEM_ROOT_UNAVAILABLE");
      }

      const executable = path.win32.join(
        systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
      );
      const script = readFileSync(new URL("./capture-notepad.ps1", import.meta.url), "utf8");
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      let stdout;

      try {
        ({ stdout } = await runCapture(
          executable,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
          {
            shell: false,
            windowsHide: true,
            timeout: IMAGE_TIMEOUT_MS,
            maxBuffer: MAX_STDOUT_BYTES,
            encoding: "utf8",
            env: {
              SystemRoot: systemRoot,
              WINDIR: systemRoot,
              TEMP: env.TEMP ?? path.win32.join(systemRoot, "Temp"),
              TMP: env.TMP ?? path.win32.join(systemRoot, "Temp"),
              PATH: path.win32.join(systemRoot, "System32")
            }
          }
        ));
      } catch {
        throw new ReadOnlyToolError(
          "Notepad capture failed or was blocked by Game Safety.",
          "CAPTURE_FAILED"
        );
      }

      return parseNotepadCapture(stdout);
    }
  };
}
