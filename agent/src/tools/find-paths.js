import path from "node:path";
import { Capabilities } from "../security/capabilities.js";
import {
  resolveExistingPathWithinAllowedRoots
} from "../security/path-policy.js";
import {
  assertNonSensitivePath,
  requireWindows
} from "./read-only-common.js";
import {
  parseWorkspaceSearchArgs,
  walkWorkspace
} from "./workspace-search-common.js";

export function createFindPathsTool({ allowedRoots }) {
  return {
    name: "find_paths",
    version: "1",
    capability: Capabilities.FILE_READ,
    risk: "low",
    confirmation: "none",
    description:
      "Search file and directory names recursively inside an allowed root without following links.",
    async execute(args) {
      requireWindows();

      const request = parseWorkspaceSearchArgs(args, {
        defaultMaxDepth: 4,
        defaultMaxResults: 100
      });

      const canonicalRoot = resolveExistingPathWithinAllowedRoots(
        request.path,
        allowedRoots
      );
      assertNonSensitivePath(request.path, canonicalRoot);

      const needle = request.query.toLocaleLowerCase("en-US");
      const matches = [];

      const scan = walkWorkspace({
        rootPath: canonicalRoot,
        maxDepth: request.maxDepth,
        onEntry(entry) {
          if (
            entry.name
              .toLocaleLowerCase("en-US")
              .includes(needle)
          ) {
            matches.push(Object.freeze({
              path: entry.path,
              relative_path: path.win32.relative(
                canonicalRoot,
                entry.path
              ),
              name: entry.name,
              type: entry.type
            }));

            if (matches.length >= request.maxResults) {
              return false;
            }
          }

          return true;
        }
      });

      return Object.freeze({
        path: canonicalRoot,
        query: request.query,
        matches: Object.freeze(matches),
        max_depth: request.maxDepth,
        max_results: request.maxResults,
        ...scan,
        truncated:
          matches.length >= request.maxResults
          || scan.scan_budget_exhausted
      });
    }
  };
}
