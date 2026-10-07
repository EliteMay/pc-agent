import {
  closeSync,
  fstatSync,
  openSync,
  readSync
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { Capabilities } from "../security/capabilities.js";
import {
  resolveExistingPathWithinAllowedRoots
} from "../security/path-policy.js";
import {
  assertNonSensitivePath,
  requirePositiveInteger,
  requireWindows
} from "./read-only-common.js";
import {
  parseWorkspaceSearchArgs,
  walkWorkspace
} from "./workspace-search-common.js";

const MAX_MATCHES_PER_FILE = 10;
const MAX_SNIPPET_CHARS = 320;

function readBoundedSearchFile(filePath, maximumFileBytes) {
  let descriptor;

  try {
    descriptor = openSync(filePath, "r");
    const stats = fstatSync(descriptor);

    if (!stats.isFile()) {
      return Object.freeze({
        kind: "not_file",
        buffer: null
      });
    }

    if (stats.size > maximumFileBytes) {
      return Object.freeze({
        kind: "too_large",
        buffer: null
      });
    }

    const buffer = Buffer.alloc(stats.size);
    let offset = 0;

    while (offset < buffer.length) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset
      );

      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    return Object.freeze({
      kind: "ok",
      buffer: offset === buffer.length
        ? buffer
        : buffer.subarray(0, offset)
    });
  } catch {
    return Object.freeze({
      kind: "unreadable",
      buffer: null
    });
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function decodeSearchableUtf8(buffer) {
  if (buffer.includes(0x00)) return null;

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false
    }).decode(buffer);
  } catch {
    return null;
  }
}

function boundedSnippet(line, index, queryLength) {
  if (line.length <= MAX_SNIPPET_CHARS) {
    return line;
  }

  const context = Math.floor(
    (MAX_SNIPPET_CHARS - queryLength) / 2
  );
  const start = Math.max(0, index - context);
  const end = Math.min(
    line.length,
    start + MAX_SNIPPET_CHARS
  );

  return (
    (start > 0 ? "…" : "")
    + line.slice(start, end)
    + (end < line.length ? "…" : "")
  );
}

export function createSearchTextTool({
  allowedRoots,
  maxTextFileBytes = 64 * 1024
}) {
  const maximumFileBytes = requirePositiveInteger(
    maxTextFileBytes,
    {
      name: "maxTextFileBytes",
      defaultValue: 64 * 1024,
      maximum: 1024 * 1024
    }
  );

  return {
    name: "search_text",
    version: "1",
    capability: Capabilities.FILE_READ,
    risk: "low",
    confirmation: "none",
    description:
      "Search literal text in bounded UTF-8 files recursively inside an allowed root without following links.",
    async execute(args) {
      requireWindows();

      const request = parseWorkspaceSearchArgs(args, {
        defaultMaxDepth: 4,
        defaultMaxResults: 50,
        allowCaseSensitive: true
      });

      const canonicalRoot = resolveExistingPathWithinAllowedRoots(
        request.path,
        allowedRoots
      );
      assertNonSensitivePath(request.path, canonicalRoot);

      const needle = request.caseSensitive
        ? request.query
        : request.query.toLocaleLowerCase("en-US");

      const matches = [];
      let scannedFiles = 0;
      let skippedLargeFiles = 0;
      let skippedBinaryOrInvalidUtf8 = 0;
      let unreadableFiles = 0;
      let rejectedChangedPaths = 0;

      const scan = walkWorkspace({
        rootPath: canonicalRoot,
        maxDepth: request.maxDepth,
        onEntry(entry) {
          if (entry.type !== "file") return true;

          let canonicalFile;
          try {
            canonicalFile = resolveExistingPathWithinAllowedRoots(
              entry.path,
              allowedRoots
            );
            assertNonSensitivePath(entry.path, canonicalFile);
          } catch {
            rejectedChangedPaths += 1;
            return true;
          }

          const bounded = readBoundedSearchFile(
            canonicalFile,
            maximumFileBytes
          );

          if (bounded.kind === "too_large") {
            skippedLargeFiles += 1;
            return true;
          }

          if (bounded.kind === "not_file") {
            return true;
          }

          if (bounded.kind !== "ok") {
            unreadableFiles += 1;
            return true;
          }

          const text = decodeSearchableUtf8(bounded.buffer);
          if (text === null) {
            skippedBinaryOrInvalidUtf8 += 1;
            return true;
          }

          scannedFiles += 1;
          const lines = text.split(/\r?\n/);
          let matchesInFile = 0;

          for (
            let lineIndex = 0;
            lineIndex < lines.length;
            lineIndex += 1
          ) {
            const line = lines[lineIndex];
            const haystack = request.caseSensitive
              ? line
              : line.toLocaleLowerCase("en-US");
            const matchIndex = haystack.indexOf(needle);

            if (matchIndex < 0) continue;

            matches.push(Object.freeze({
              path: canonicalFile,
              relative_path: path.win32.relative(
                canonicalRoot,
                canonicalFile
              ),
              line: lineIndex + 1,
              snippet: boundedSnippet(
                line,
                matchIndex,
                request.query.length
              )
            }));
            matchesInFile += 1;

            if (matches.length >= request.maxResults) {
              return false;
            }

            if (matchesInFile >= MAX_MATCHES_PER_FILE) {
              break;
            }
          }

          return true;
        }
      });

      return Object.freeze({
        path: canonicalRoot,
        query: request.query,
        case_sensitive: request.caseSensitive,
        matches: Object.freeze(matches),
        max_depth: request.maxDepth,
        max_results: request.maxResults,
        scanned_files: scannedFiles,
        skipped_large_files: skippedLargeFiles,
        skipped_binary_or_invalid_utf8:
          skippedBinaryOrInvalidUtf8,
        unreadable_files: unreadableFiles,
        rejected_changed_paths: rejectedChangedPaths,
        ...scan,
        truncated:
          matches.length >= request.maxResults
          || scan.scan_budget_exhausted
      });
    }
  };
}

export const searchTextInternals = Object.freeze({
  readBoundedSearchFile,
  decodeSearchableUtf8,
  boundedSnippet
});
