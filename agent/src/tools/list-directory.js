import { opendirSync } from "node:fs";
import path from "node:path";
import { Capabilities } from "../security/capabilities.js";
import {
  resolveExistingPathWithinAllowedRoots,
  isSensitivePath
} from "../security/path-policy.js";
import {
  ReadOnlyToolError,
  assertNonSensitivePath,
  requirePathArg,
  requirePositiveInteger,
  requireWindows
} from "./read-only-common.js";

function entryType(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "link";
  return "other";
}

export function createListDirectoryTool({
  allowedRoots,
  maxDirectoryEntries = 500
}) {
  const maxEntries = requirePositiveInteger(maxDirectoryEntries, {
    name: "maxDirectoryEntries",
    defaultValue: 500,
    maximum: 5000
  });

  return {
    name: "list_directory",
    version: "1",
    capability: Capabilities.FILE_READ,
    risk: "low",
    description: "List names and entry types inside an allowed directory without following child links.",
    async execute(args) {
      requireWindows();
      const requestedPath = requirePathArg(args);
      const canonicalPath = resolveExistingPathWithinAllowedRoots(
        requestedPath,
        allowedRoots
      );

      assertNonSensitivePath(requestedPath, canonicalPath);

      let directory;
      try {
        directory = opendirSync(canonicalPath);
      } catch (error) {
        if (error?.code === "ENOTDIR") {
          throw new ReadOnlyToolError(
            "Path is not a directory.",
            "NOT_A_DIRECTORY",
            { cause: error }
          );
        }

        throw new ReadOnlyToolError(
          "Unable to open directory.",
          "DIRECTORY_OPEN_FAILED",
          { cause: error }
        );
      }

      const entries = [];
      let filteredSensitiveEntries = 0;
      let truncated = false;

      try {
        while (true) {
          const entry = directory.readSync();
          if (entry === null) break;

          const childPath = path.win32.join(canonicalPath, entry.name);

          if (isSensitivePath(childPath)) {
            filteredSensitiveEntries += 1;
            continue;
          }

          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }

          entries.push(Object.freeze({
            name: entry.name,
            type: entryType(entry)
          }));
        }
      } finally {
        directory.closeSync();
      }

      entries.sort((a, b) =>
        a.name.localeCompare(b.name, "en", {
          numeric: true,
          sensitivity: "base"
        })
      );

      return Object.freeze({
        path: canonicalPath,
        entries: Object.freeze(entries),
        filtered_sensitive_entries: filteredSensitiveEntries,
        truncated
      });
    }
  };
}
