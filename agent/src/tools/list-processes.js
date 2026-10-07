import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Capabilities } from "../security/capabilities.js";
import {
  ReadOnlyToolError,
  requireObjectArgs,
  requireWindows
} from "./read-only-common.js";

const execFileAsync = promisify(execFile);

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
      continue;
    }

    if (character === ",") {
      values.push(value);
      value = "";
      continue;
    }

    value += character;
  }

  if (quoted) {
    return null;
  }

  values.push(value);
  return values;
}

export function parseTasklistCsv(output) {
  if (typeof output !== "string") {
    throw new TypeError("tasklist output must be a string.");
  }

  const processes = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fields = parseCsvLine(line);
    if (!fields || fields.length < 2) continue;

    const pid = Number.parseInt(fields[1], 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;

    processes.push(Object.freeze({
      image_name: fields[0],
      pid
    }));
  }

  processes.sort((a, b) => a.pid - b.pid);
  return processes;
}

function tasklistExecutablePath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;

  if (
    typeof systemRoot !== "string"
    || !path.win32.isAbsolute(systemRoot)
  ) {
    throw new ReadOnlyToolError(
      "Windows SystemRoot is unavailable.",
      "SYSTEM_ROOT_UNAVAILABLE"
    );
  }

  return path.win32.join(systemRoot, "System32", "tasklist.exe");
}

export function createListProcessesTool() {
  return {
    name: "list_processes",
    version: "1",
    capability: Capabilities.PROCESS_INSPECT,
    risk: "low",
    confirmation: "none",
    description: "Return executable image names and process IDs using the fixed Windows tasklist binary.",
    async execute(args) {
      requireWindows();
      requireObjectArgs(args, []);

      let stdout;
      try {
        const result = await execFileAsync(
          tasklistExecutablePath(),
          ["/FO", "CSV", "/NH"],
          {
            shell: false,
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf8"
          }
        );
        stdout = result.stdout;
      } catch (error) {
        throw new ReadOnlyToolError(
          "Unable to list Windows processes.",
          "PROCESS_LIST_FAILED",
          { cause: error }
        );
      }

      const processes = parseTasklistCsv(stdout);

      return Object.freeze({
        count: processes.length,
        processes: Object.freeze(processes)
      });
    }
  };
}
