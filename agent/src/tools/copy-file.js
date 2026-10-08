import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { Capabilities } from "../security/capabilities.js";
import {
  resolveExistingPathWithinAllowedRoots,
  revalidateNewPathBeforeWrite
} from "../security/path-policy.js";
import {
  SafeWriteToolError,
  requireWindowsForWrite,
  sha256Buffer
} from "./safe-write-common.js";
import {
  planPathTransfer,
  requireSourceDestinationArgs
} from "./safe-path-ops-common.js";

export function createCopyFileTool({
  allowedRoots,
  maxCopyFileBytes = 64 * 1024 * 1024
}) {
  if (
    !Number.isSafeInteger(maxCopyFileBytes)
    || maxCopyFileBytes < 1
    || maxCopyFileBytes > 256 * 1024 * 1024
  ) {
    throw new RangeError(
      "maxCopyFileBytes must be between 1 and 268435456."
    );
  }

  function plan(args) {
    requireWindowsForWrite();
    const parsed = requireSourceDestinationArgs(args);
    const transfer = planPathTransfer({
      sourcePath: parsed.sourcePath,
      destinationPath: parsed.destinationPath,
      allowedRoots,
      rejectRootSource: false
    });

    const stats = lstatSync(transfer.sourcePath);

    if (!stats.isFile()) {
      throw new SafeWriteToolError(
        "copy_file supports regular files only.",
        "NOT_A_FILE"
      );
    }

    if (stats.size > maxCopyFileBytes) {
      throw new SafeWriteToolError(
        "Source file exceeds the configured copy limit.",
        "FILE_TOO_LARGE"
      );
    }

    const sourceBytes = readFileSync(
      transfer.sourcePath
    );

    return Object.freeze({
      ...transfer,
      bytes: sourceBytes.length,
      sourceSha256: sha256Buffer(sourceBytes)
    });
  }

  return {
    name: "copy_file",
    version: "1",
    capability: Capabilities.FILE_WRITE,
    risk: "medium",
    confirmation: "required",
    description:
      "Copy one bounded regular file inside allowed roots without overwrite after explicit local approval.",
    approvalSummary(args) {
      const planned = plan(args);

      return Object.freeze({
        action: "copy_file",
        source_path: planned.sourcePath,
        destination_path: planned.destinationPath,
        bytes: planned.bytes,
        source_sha256: planned.sourceSha256
      });
    },
    async execute(args) {
      const planned = plan(args);

      revalidateNewPathBeforeWrite(
        args.destination_path,
        allowedRoots,
        planned.destinationPath
      );

      if (existsSync(planned.destinationPath)) {
        throw new SafeWriteToolError(
          "Destination appeared before copy; overwrite is refused.",
          "TARGET_EXISTS"
        );
      }

      const currentSource = resolveExistingPathWithinAllowedRoots(
        args.source_path,
        allowedRoots
      );

      if (currentSource !== planned.sourcePath) {
        throw new SafeWriteToolError(
          "Source path changed before copy.",
          "PATH_CHANGED_DURING_OPERATION"
        );
      }

      const currentBytes = readFileSync(
        planned.sourcePath
      );

      if (
        currentBytes.length !== planned.bytes
        || sha256Buffer(currentBytes)
          !== planned.sourceSha256
      ) {
        throw new SafeWriteToolError(
          "Source file changed before copy.",
          "SOURCE_CHANGED_DURING_OPERATION"
        );
      }

      try {
        // Create a new file from the exact bytes that were verified.
        // "wx" refuses to replace a destination that appears concurrently.
        writeFileSync(planned.destinationPath, currentBytes, { flag: "wx" });
      } catch (error) {
        throw new SafeWriteToolError(
          "File copy failed.",
          "COPY_FAILED",
          { cause: error }
        );
      }

      try {
        const verifiedPath =
          resolveExistingPathWithinAllowedRoots(
            planned.destinationPath,
            allowedRoots
          );
        const verifiedBytes = readFileSync(verifiedPath);
        const verifiedSha256 =
          sha256Buffer(verifiedBytes);

        if (
          verifiedBytes.length !== planned.bytes
          || verifiedSha256 !== planned.sourceSha256
        ) {
          throw new SafeWriteToolError(
            "Copied file verification failed.",
            "VERIFY_FAILED"
          );
        }

        return Object.freeze({
          source_path: planned.sourcePath,
          destination_path: verifiedPath,
          bytes: verifiedBytes.length,
          sha256: verifiedSha256,
          verified: true
        });
      } catch (error) {
        // Preserve a potentially replaced destination for investigation.
        // Blind rollback could delete another process's file.
        throw error;
      }
    }
  };
}
