import {
  existsSync,
  lstatSync,
  renameSync
} from "node:fs";
import { Capabilities } from "../security/capabilities.js";
import {
  resolveExistingPathWithinAllowedRoots,
  revalidateNewPathBeforeWrite
} from "../security/path-policy.js";
import {
  SafeWriteToolError,
  requireWindowsForWrite
} from "./safe-write-common.js";
import {
  isPathInside,
  planPathTransfer,
  requireSourceDestinationArgs,
  sameWindowsVolume
} from "./safe-path-ops-common.js";

export function createMovePathTool({ allowedRoots }) {
  function plan(args) {
    requireWindowsForWrite();

    const parsed = requireSourceDestinationArgs(args);
    const transfer = planPathTransfer({
      sourcePath: parsed.sourcePath,
      destinationPath: parsed.destinationPath,
      allowedRoots,
      rejectRootSource: true
    });

    const stats = lstatSync(transfer.sourcePath);

    if (!stats.isFile() && !stats.isDirectory()) {
      throw new SafeWriteToolError(
        "Only regular files and directories can be moved.",
        "UNSUPPORTED_SOURCE_TYPE"
      );
    }

    if (
      stats.isDirectory()
      && isPathInside(
        transfer.destinationPath,
        transfer.sourcePath
      )
    ) {
      throw new SafeWriteToolError(
        "A directory cannot be moved inside itself.",
        "DESTINATION_INSIDE_SOURCE"
      );
    }

    if (
      !sameWindowsVolume(
        transfer.sourcePath,
        transfer.destinationPath
      )
    ) {
      throw new SafeWriteToolError(
        "Cross-volume move is not supported.",
        "CROSS_VOLUME_MOVE_NOT_SUPPORTED"
      );
    }

    return Object.freeze({
      ...transfer,
      sourceType: stats.isDirectory()
        ? "directory"
        : "file"
    });
  }

  return {
    name: "move_path",
    version: "1",
    capability: Capabilities.FILE_WRITE,
    risk: "medium",
    confirmation: "required",
    description:
      "Move or rename one file/directory inside allowed roots without overwrite after explicit local approval.",
    approvalSummary(args) {
      const planned = plan(args);

      return Object.freeze({
        action: "move_path",
        source_path: planned.sourcePath,
        destination_path: planned.destinationPath,
        source_type: planned.sourceType
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
          "Destination appeared before move; overwrite is refused.",
          "TARGET_EXISTS"
        );
      }

      const currentSource =
        resolveExistingPathWithinAllowedRoots(
          args.source_path,
          allowedRoots
        );

      if (currentSource !== planned.sourcePath) {
        throw new SafeWriteToolError(
          "Source path changed before move.",
          "PATH_CHANGED_DURING_OPERATION"
        );
      }

      try {
        renameSync(
          planned.sourcePath,
          planned.destinationPath
        );
      } catch (error) {
        throw new SafeWriteToolError(
          "Path move failed.",
          "MOVE_FAILED",
          { cause: error }
        );
      }

      if (existsSync(planned.sourcePath)) {
        throw new SafeWriteToolError(
          "Source still exists after move.",
          "VERIFY_FAILED"
        );
      }

      const verifiedPath =
        resolveExistingPathWithinAllowedRoots(
          planned.destinationPath,
          allowedRoots
        );
      const verifiedStats = lstatSync(verifiedPath);

      if (
        (planned.sourceType === "file"
          && !verifiedStats.isFile())
        || (planned.sourceType === "directory"
          && !verifiedStats.isDirectory())
      ) {
        throw new SafeWriteToolError(
          "Moved path type verification failed.",
          "VERIFY_FAILED"
        );
      }

      return Object.freeze({
        source_path: planned.sourcePath,
        destination_path: verifiedPath,
        source_type: planned.sourceType,
        verified: true
      });
    }
  };
}
