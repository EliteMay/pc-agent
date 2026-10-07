import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
  requireWriteArgs,
  sha256Buffer,
  validateExpectedSha256
} from "./safe-write-common.js";

function requireTextWriteArgs(args) {
  requireWriteArgs(args, [
    "path",
    "text",
    "expected_sha256"
  ]);

  if (
    typeof args.path !== "string"
    || args.path.trim().length === 0
    || typeof args.text !== "string"
  ) {
    throw new SafeWriteToolError(
      "path and text are required.",
      "INVALID_ARGUMENTS"
    );
  }

  return {
    path: args.path,
    text: args.text,
    expectedSha256: validateExpectedSha256(
      args.expected_sha256,
      { allowNull: true }
    )
  };
}

function inspectCurrentTarget({
  requestedPath,
  allowedRoots,
  expectedSha256,
  maximumBytes
}) {
  if (!existsSync(requestedPath)) {
    if (expectedSha256 !== null) {
      throw new SafeWriteToolError(
        "expected_sha256 must be null when creating a new file.",
        "EXPECTED_HASH_MISMATCH"
      );
    }

    const canonicalPath = resolveNewPathWithinAllowedRoots(
      requestedPath,
      allowedRoots
    );

    assertWritableNonSensitivePath(
      requestedPath,
      canonicalPath
    );

    return {
      exists: false,
      canonicalPath,
      previousSha256: null
    };
  }

  const canonicalPath = resolveExistingPathWithinAllowedRoots(
    requestedPath,
    allowedRoots
  );

  assertWritableNonSensitivePath(
    requestedPath,
    canonicalPath
  );

  const stats = lstatSync(canonicalPath);
  if (!stats.isFile()) {
    throw new SafeWriteToolError(
      "Existing target is not a regular file.",
      "NOT_A_FILE"
    );
  }

  if (stats.size > maximumBytes) {
    throw new SafeWriteToolError(
      "Existing file exceeds the configured size limit.",
      "FILE_TOO_LARGE"
    );
  }

  if (expectedSha256 === null) {
    throw new SafeWriteToolError(
      "expected_sha256 is required when replacing an existing file.",
      "EXPECTED_HASH_REQUIRED"
    );
  }

  const current = readFileSync(canonicalPath);
  const currentSha256 = sha256Buffer(current);

  if (currentSha256 !== expectedSha256) {
    throw new SafeWriteToolError(
      "Existing file hash does not match expected_sha256.",
      "EXPECTED_HASH_MISMATCH"
    );
  }

  return {
    exists: true,
    canonicalPath,
    previousSha256: currentSha256
  };
}

function prepareBackupDirectory(canonicalPath, allowedRoots) {
  const parent = path.win32.dirname(canonicalPath);
  const requested = path.win32.join(
    parent,
    ".pc-agent-backups"
  );

  const canonical = resolveNewPathWithinAllowedRoots(
    requested,
    allowedRoots
  );

  assertWritableNonSensitivePath(requested, canonical);

  if (!existsSync(canonical)) {
    revalidateNewPathBeforeWrite(
      requested,
      allowedRoots,
      canonical
    );
    mkdirSync(canonical);
  }

  return resolveExistingPathWithinAllowedRoots(
    canonical,
    allowedRoots
  );
}

export function createWriteTextFileTool({
  allowedRoots,
  maxTextFileBytes = 1024 * 1024
}) {
  if (
    !Number.isSafeInteger(maxTextFileBytes)
    || maxTextFileBytes < 1
    || maxTextFileBytes > 4 * 1024 * 1024
  ) {
    throw new RangeError(
      "maxTextFileBytes must be between 1 and 4194304."
    );
  }

  return {
    name: "write_text_file",
    version: "1",
    capability: Capabilities.FILE_WRITE,
    risk: "medium",
    confirmation: "required",
    description: "Create or replace a bounded UTF-8 text file after explicit local approval.",
    approvalSummary(args) {
      requireWindowsForWrite();
      const parsed = requireTextWriteArgs(args);
      const content = Buffer.from(parsed.text, "utf8");

      if (content.length > maxTextFileBytes) {
        throw new SafeWriteToolError(
          "Text exceeds the configured size limit.",
          "FILE_TOO_LARGE"
        );
      }

      const target = inspectCurrentTarget({
        requestedPath: parsed.path,
        allowedRoots,
        expectedSha256: parsed.expectedSha256,
        maximumBytes: maxTextFileBytes
      });

      return Object.freeze({
        action: "write_text_file",
        path: target.canonicalPath,
        bytes: content.length,
        previous_sha256: target.previousSha256,
        new_sha256: sha256Buffer(content)
      });
    },
    async execute(args) {
      requireWindowsForWrite();
      const parsed = requireTextWriteArgs(args);
      const content = Buffer.from(parsed.text, "utf8");

      if (content.length > maxTextFileBytes) {
        throw new SafeWriteToolError(
          "Text exceeds the configured size limit.",
          "FILE_TOO_LARGE"
        );
      }

      const target = inspectCurrentTarget({
        requestedPath: parsed.path,
        allowedRoots,
        expectedSha256: parsed.expectedSha256,
        maximumBytes: maxTextFileBytes
      });

      revalidateNewPathBeforeWrite(
        parsed.path,
        allowedRoots,
        target.canonicalPath
      );

      const parent = path.win32.dirname(
        target.canonicalPath
      );
      const baseName = path.win32.basename(
        target.canonicalPath
      );

      let backupPath = null;

      if (target.exists) {
        const backupDirectory = prepareBackupDirectory(
          target.canonicalPath,
          allowedRoots
        );

        backupPath = path.win32.join(
          backupDirectory,
          baseName + "." + Date.now() + "." +
            randomUUID() + ".bak"
        );

        copyFileSync(
          target.canonicalPath,
          backupPath
        );
      }

      const temporaryPath = path.win32.join(
        parent,
        "." + baseName + "." +
          randomUUID() + ".tmp"
      );

      let descriptor;

      try {
        descriptor = openSync(temporaryPath, "wx");
        writeFileSync(descriptor, content);
        fsyncSync(descriptor);
      } finally {
        if (descriptor !== undefined) {
          closeSync(descriptor);
        }
      }

      try {
        revalidateNewPathBeforeWrite(
          parsed.path,
          allowedRoots,
          target.canonicalPath
        );

        renameSync(
          temporaryPath,
          target.canonicalPath
        );
      } catch (error) {
        try {
          rmSync(temporaryPath, { force: true });
        } catch {
          // Best-effort cleanup only.
        }
        throw error;
      }

      const verifiedPath = resolveExistingPathWithinAllowedRoots(
        target.canonicalPath,
        allowedRoots
      );
      const verifiedContent = readFileSync(verifiedPath);

      if (verifiedContent.length > maxTextFileBytes) {
        throw new SafeWriteToolError(
          "Written file exceeds the configured size limit.",
          "VERIFY_FAILED"
        );
      }

      const verifiedSha256 = sha256Buffer(
        verifiedContent
      );
      const intendedSha256 = sha256Buffer(content);

      if (verifiedSha256 !== intendedSha256) {
        throw new SafeWriteToolError(
          "Written file hash verification failed.",
          "VERIFY_FAILED"
        );
      }

      return Object.freeze({
        path: verifiedPath,
        bytes: verifiedContent.length,
        sha256: verifiedSha256,
        previous_sha256: target.previousSha256,
        backup_path: backupPath,
        verified: true
      });
    }
  };
}
