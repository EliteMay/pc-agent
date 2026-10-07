import {
  lstatSync,
  readFileSync
} from "node:fs";
import { Capabilities } from "../security/capabilities.js";
import {
  resolveExistingPathWithinAllowedRoots
} from "../security/path-policy.js";
import {
  SafeWriteToolError,
  assertWritableNonSensitivePath,
  requireWindowsForWrite,
  requireWriteArgs,
  sha256Buffer,
  validateExpectedSha256
} from "./safe-write-common.js";
import { createWriteTextFileTool } from "./write-text-file.js";

function requireEditArgs(args) {
  requireWriteArgs(args, [
    "path",
    "old_text",
    "new_text",
    "expected_sha256"
  ]);

  if (
    typeof args.path !== "string"
    || args.path.trim().length === 0
    || typeof args.old_text !== "string"
    || args.old_text.length === 0
    || typeof args.new_text !== "string"
  ) {
    throw new SafeWriteToolError(
      "path, old_text, new_text, and expected_sha256 are required.",
      "INVALID_ARGUMENTS"
    );
  }

  return {
    path: args.path,
    oldText: args.old_text,
    newText: args.new_text,
    expectedSha256: validateExpectedSha256(
      args.expected_sha256,
      { allowNull: false }
    )
  };
}

function readCurrentText({
  requestedPath,
  allowedRoots,
  expectedSha256,
  maximumBytes
}) {
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
      "Target is not a regular file.",
      "NOT_A_FILE"
    );
  }

  if (stats.size > maximumBytes) {
    throw new SafeWriteToolError(
      "File exceeds the configured size limit.",
      "FILE_TOO_LARGE"
    );
  }

  const buffer = readFileSync(canonicalPath);
  const currentSha256 = sha256Buffer(buffer);

  if (currentSha256 !== expectedSha256) {
    throw new SafeWriteToolError(
      "Existing file hash does not match expected_sha256.",
      "EXPECTED_HASH_MISMATCH"
    );
  }

  let text;

  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false
    }).decode(buffer);
  } catch (error) {
    throw new SafeWriteToolError(
      "File is not valid UTF-8 text.",
      "INVALID_UTF8",
      { cause: error }
    );
  }

  return {
    canonicalPath,
    currentSha256,
    text
  };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;

  while (true) {
    const index = haystack.indexOf(needle, offset);

    if (index < 0) {
      return count;
    }

    count += 1;
    offset = index + needle.length;
  }
}

function planEdit({
  args,
  allowedRoots,
  maximumBytes
}) {
  const parsed = requireEditArgs(args);
  const current = readCurrentText({
    requestedPath: parsed.path,
    allowedRoots,
    expectedSha256: parsed.expectedSha256,
    maximumBytes
  });

  const replacements = countOccurrences(
    current.text,
    parsed.oldText
  );

  if (replacements === 0) {
    throw new SafeWriteToolError(
      "old_text was not found in the target file.",
      "EDIT_TEXT_NOT_FOUND"
    );
  }

  if (replacements !== 1) {
    throw new SafeWriteToolError(
      "old_text is ambiguous; exactly one occurrence is required.",
      "EDIT_TEXT_AMBIGUOUS"
    );
  }

  const updatedText = current.text.replace(
    parsed.oldText,
    parsed.newText
  );
  const updatedBuffer = Buffer.from(
    updatedText,
    "utf8"
  );

  if (updatedBuffer.length > maximumBytes) {
    throw new SafeWriteToolError(
      "Edited text exceeds the configured size limit.",
      "FILE_TOO_LARGE"
    );
  }

  return {
    path: current.canonicalPath,
    expectedSha256: current.currentSha256,
    updatedText,
    updatedSha256: sha256Buffer(updatedBuffer),
    replacements
  };
}

export function createEditTextFileTool({
  allowedRoots,
  maxTextFileBytes = 1024 * 1024
}) {
  const writer = createWriteTextFileTool({
    allowedRoots,
    maxTextFileBytes
  });

  return {
    name: "edit_text_file",
    version: "1",
    capability: Capabilities.FILE_WRITE,
    risk: "medium",
    confirmation: "required",
    description: "Replace exactly one expected text occurrence in an allowed UTF-8 file after explicit local approval.",
    approvalSummary(args) {
      requireWindowsForWrite();

      const plan = planEdit({
        args,
        allowedRoots,
        maximumBytes: maxTextFileBytes
      });

      return Object.freeze({
        action: "edit_text_file",
        path: plan.path,
        replacements: plan.replacements,
        previous_sha256: plan.expectedSha256,
        new_sha256: plan.updatedSha256,
        new_bytes: Buffer.byteLength(
          plan.updatedText,
          "utf8"
        )
      });
    },
    async execute(args) {
      requireWindowsForWrite();

      const plan = planEdit({
        args,
        allowedRoots,
        maximumBytes: maxTextFileBytes
      });

      const result = await writer.execute({
        path: plan.path,
        text: plan.updatedText,
        expected_sha256: plan.expectedSha256
      });

      return Object.freeze({
        ...result,
        replacements: plan.replacements
      });
    }
  };
}

export const editTextFileInternals = Object.freeze({
  countOccurrences,
  planEdit
});
