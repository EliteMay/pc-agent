import {
  existsSync,
  lstatSync,
  mkdirSync
} from "node:fs";
import { Capabilities } from "../security/capabilities.js";
import {
  resolveExistingPathWithinAllowedRoots,
  resolveNewPathWithinAllowedRoots,
  revalidateNewPathBeforeWrite
} from "../security/path-policy.js";
import {
  SafeWriteToolError,
  assertWritableNonSensitivePath,
  requireWindowsForWrite,
  requireWritePath
} from "./safe-write-common.js";

export function createCreateDirectoryTool({ allowedRoots }) {
  return {
    name: "create_directory",
    version: "1",
    capability: Capabilities.FILE_WRITE,
    risk: "medium",
    confirmation: "required",
    description: "Create a directory inside an allowed root after explicit local approval.",
    approvalSummary(args) {
      requireWindowsForWrite();
      const requestedPath = requireWritePath(args);
      const canonicalPath = resolveNewPathWithinAllowedRoots(
        requestedPath,
        allowedRoots
      );

      assertWritableNonSensitivePath(
        requestedPath,
        canonicalPath
      );

      return Object.freeze({
        action: "create_directory",
        path: canonicalPath
      });
    },
    async execute(args) {
      requireWindowsForWrite();
      const requestedPath = requireWritePath(args);
      const canonicalPath = resolveNewPathWithinAllowedRoots(
        requestedPath,
        allowedRoots
      );

      assertWritableNonSensitivePath(
        requestedPath,
        canonicalPath
      );

      if (existsSync(canonicalPath)) {
        const stats = lstatSync(canonicalPath);

        if (!stats.isDirectory()) {
          throw new SafeWriteToolError(
            "Target exists and is not a directory.",
            "TARGET_EXISTS"
          );
        }

        return Object.freeze({
          path: canonicalPath,
          created: false,
          verified: true
        });
      }

      revalidateNewPathBeforeWrite(
        requestedPath,
        allowedRoots,
        canonicalPath
      );

      mkdirSync(canonicalPath, { recursive: true });

      const verifiedPath = resolveExistingPathWithinAllowedRoots(
        canonicalPath,
        allowedRoots
      );

      return Object.freeze({
        path: verifiedPath,
        created: true,
        verified: true
      });
    }
  };
}
