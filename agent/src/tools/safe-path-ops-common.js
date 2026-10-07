import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveExistingPathWithinAllowedRoots,
  resolveNewPathWithinAllowedRoots
} from "../security/path-policy.js";
import {
  SafeWriteToolError,
  assertWritableNonSensitivePath,
  requireWriteArgs
} from "./safe-write-common.js";

function pathKey(value) {
  return path.win32
    .normalize(String(value).trim())
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase("en-US");
}

export function requireSourceDestinationArgs(args) {
  requireWriteArgs(args, ["source_path", "destination_path"]);

  if (
    typeof args.source_path !== "string"
    || args.source_path.trim().length === 0
    || typeof args.destination_path !== "string"
    || args.destination_path.trim().length === 0
  ) {
    throw new SafeWriteToolError(
      "source_path and destination_path are required.",
      "INVALID_ARGUMENTS"
    );
  }

  return Object.freeze({
    sourcePath: args.source_path,
    destinationPath: args.destination_path
  });
}

export function planPathTransfer({
  sourcePath,
  destinationPath,
  allowedRoots,
  rejectRootSource = true
}) {
  if (existsSync(destinationPath)) {
    throw new SafeWriteToolError(
      "Destination already exists; overwrite is not allowed.",
      "TARGET_EXISTS"
    );
  }

  const canonicalSource = resolveExistingPathWithinAllowedRoots(
    sourcePath,
    allowedRoots
  );
  const canonicalDestination = resolveNewPathWithinAllowedRoots(
    destinationPath,
    allowedRoots
  );

  assertWritableNonSensitivePath(
    sourcePath,
    canonicalSource
  );
  assertWritableNonSensitivePath(
    destinationPath,
    canonicalDestination
  );

  if (pathKey(sourcePath) !== pathKey(canonicalSource)) {
    throw new SafeWriteToolError(
      "Source path resolves through a link or junction; path transfer is refused.",
      "LINKED_SOURCE_NOT_ALLOWED"
    );
  }

  if (
    pathKey(destinationPath)
    !== pathKey(canonicalDestination)
  ) {
    throw new SafeWriteToolError(
      "Destination path resolves through a link or junction; path transfer is refused.",
      "LINKED_DESTINATION_NOT_ALLOWED"
    );
  }

  if (rejectRootSource) {
    for (const root of allowedRoots) {
      const canonicalRoot =
        resolveExistingPathWithinAllowedRoots(
          root,
          allowedRoots
        );

      if (pathKey(canonicalRoot) === pathKey(canonicalSource)) {
        throw new SafeWriteToolError(
          "Configured allowed roots cannot be moved.",
          "ROOT_MOVE_NOT_ALLOWED"
        );
      }
    }
  }

  return Object.freeze({
    sourcePath: canonicalSource,
    destinationPath: canonicalDestination
  });
}

export function isPathInside(childPath, parentPath) {
  const relative = path.win32.relative(
    parentPath,
    childPath
  );

  return (
    relative.length > 0
    && relative !== ".."
    && !relative.startsWith("..\\")
    && !path.win32.isAbsolute(relative)
  );
}

export function sameWindowsVolume(leftPath, rightPath) {
  return path.win32
    .parse(leftPath)
    .root
    .toLocaleLowerCase("en-US")
    === path.win32
      .parse(rightPath)
      .root
      .toLocaleLowerCase("en-US");
}

export const safePathOpsInternals = Object.freeze({
  pathKey
});
