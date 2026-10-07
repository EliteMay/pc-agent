import { opendirSync } from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../security/path-policy.js";
import { ReadOnlyToolError } from "./read-only-common.js";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  "node_modules",
  "coverage"
]);

export const WORKSPACE_SCAN_LIMITS = Object.freeze({
  maxDepth: 8,
  maxResults: 200,
  maxEntries: 10000,
  maxDirectories: 2000
});

export function parseWorkspaceSearchArgs(
  args,
  {
    defaultMaxDepth = 4,
    defaultMaxResults = 100,
    allowCaseSensitive = false
  } = {}
) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ReadOnlyToolError(
      "Tool args must be an object.",
      "INVALID_ARGUMENTS"
    );
  }

  const allowedKeys = new Set([
    "path",
    "query",
    "max_depth",
    "max_results",
    ...(allowCaseSensitive ? ["case_sensitive"] : [])
  ]);
  const unexpected = Object.keys(args)
    .filter((key) => !allowedKeys.has(key));

  if (unexpected.length > 0) {
    throw new ReadOnlyToolError(
      "Unexpected tool args: " + unexpected.join(", "),
      "INVALID_ARGUMENTS"
    );
  }

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    throw new ReadOnlyToolError(
      "path must be a non-empty string.",
      "INVALID_ARGUMENTS"
    );
  }

  if (
    typeof args.query !== "string"
    || args.query.length < 1
    || args.query.length > 256
    || /[\r\n]/.test(args.query)
  ) {
    throw new ReadOnlyToolError(
      "query must be a single-line string from 1 to 256 characters.",
      "INVALID_ARGUMENTS"
    );
  }

  const maxDepth = args.max_depth ?? defaultMaxDepth;
  if (
    !Number.isSafeInteger(maxDepth)
    || maxDepth < 1
    || maxDepth > WORKSPACE_SCAN_LIMITS.maxDepth
  ) {
    throw new ReadOnlyToolError(
      "max_depth must be an integer from 1 to "
        + WORKSPACE_SCAN_LIMITS.maxDepth + ".",
      "INVALID_ARGUMENTS"
    );
  }

  const maxResults = args.max_results ?? defaultMaxResults;
  if (
    !Number.isSafeInteger(maxResults)
    || maxResults < 1
    || maxResults > WORKSPACE_SCAN_LIMITS.maxResults
  ) {
    throw new ReadOnlyToolError(
      "max_results must be an integer from 1 to "
        + WORKSPACE_SCAN_LIMITS.maxResults + ".",
      "INVALID_ARGUMENTS"
    );
  }

  if (
    allowCaseSensitive
    && args.case_sensitive !== undefined
    && typeof args.case_sensitive !== "boolean"
  ) {
    throw new ReadOnlyToolError(
      "case_sensitive must be a boolean.",
      "INVALID_ARGUMENTS"
    );
  }

  return Object.freeze({
    path: args.path,
    query: args.query,
    maxDepth,
    maxResults,
    caseSensitive: allowCaseSensitive
      ? (args.case_sensitive ?? false)
      : false
  });
}

export function walkWorkspace({
  rootPath,
  maxDepth,
  onEntry
}) {
  const stack = [{
    directoryPath: rootPath,
    depth: 0
  }];

  const stats = {
    scanned_entries: 0,
    scanned_directories: 0,
    skipped_links: 0,
    skipped_heavy_directories: 0,
    filtered_sensitive_entries: 0,
    unreadable_directories: 0,
    scan_budget_exhausted: false
  };

  let stoppedByCaller = false;

  while (stack.length > 0 && !stoppedByCaller) {
    if (
      stats.scanned_directories
      >= WORKSPACE_SCAN_LIMITS.maxDirectories
    ) {
      stats.scan_budget_exhausted = true;
      break;
    }

    const current = stack.pop();
    stats.scanned_directories += 1;

    let directory;
    try {
      directory = opendirSync(current.directoryPath);
    } catch {
      stats.unreadable_directories += 1;
      continue;
    }

    const childDirectories = [];

    try {
      while (true) {
        const entry = directory.readSync();
        if (entry === null) break;

        if (
          stats.scanned_entries
          >= WORKSPACE_SCAN_LIMITS.maxEntries
        ) {
          stats.scan_budget_exhausted = true;
          stoppedByCaller = true;
          break;
        }

        stats.scanned_entries += 1;

        const childPath = path.win32.join(
          current.directoryPath,
          entry.name
        );

        if (isSensitivePath(childPath)) {
          stats.filtered_sensitive_entries += 1;
          continue;
        }

        if (entry.isSymbolicLink()) {
          stats.skipped_links += 1;
          continue;
        }

        const type = entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other";

        const depth = current.depth + 1;
        const keepGoing = onEntry(Object.freeze({
          path: childPath,
          name: entry.name,
          type,
          depth
        }));

        if (keepGoing === false) {
          stoppedByCaller = true;
          break;
        }

        if (
          type === "directory"
          && depth < maxDepth
        ) {
          if (
            SKIPPED_DIRECTORY_NAMES.has(
              entry.name.toLocaleLowerCase("en-US")
            )
          ) {
            stats.skipped_heavy_directories += 1;
          } else {
            childDirectories.push({
              directoryPath: childPath,
              depth
            });
          }
        }
      }
    } finally {
      directory.closeSync();
    }

    for (let i = childDirectories.length - 1; i >= 0; i -= 1) {
      stack.push(childDirectories[i]);
    }
  }

  return Object.freeze({
    ...stats,
    stopped_by_caller: stoppedByCaller
      && !stats.scan_budget_exhausted
  });
}

export const workspaceSearchInternals = Object.freeze({
  SKIPPED_DIRECTORY_NAMES
});
