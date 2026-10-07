import {
  closeSync,
  fstatSync,
  openSync,
  readSync
} from "node:fs";
import { Capabilities } from "../security/capabilities.js";
import { resolveExistingPathWithinAllowedRoots } from "../security/path-policy.js";
import {
  ReadOnlyToolError,
  assertNonSensitivePath,
  requirePathArg,
  requirePositiveInteger,
  requireWindows
} from "./read-only-common.js";

const READ_CHUNK_BYTES = 64 * 1024;

function readBoundedFile(fileDescriptor, maximumBytes) {
  const chunks = [];
  let total = 0;

  while (total <= maximumBytes) {
    const remaining = maximumBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, remaining)
    );
    const bytesRead = readSync(
      fileDescriptor,
      buffer,
      0,
      buffer.length,
      null
    );

    if (bytesRead === 0) {
      break;
    }

    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }

  const content = Buffer.concat(chunks, total);

  if (content.length > maximumBytes) {
    throw new ReadOnlyToolError(
      "File is larger than the configured read limit.",
      "FILE_TOO_LARGE"
    );
  }

  return content;
}

function decodeUtf8Text(buffer) {
  if (buffer.includes(0x00)) {
    throw new ReadOnlyToolError(
      "Binary files are not supported by read_text_file.",
      "BINARY_FILE"
    );
  }

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false
    }).decode(buffer);
  } catch (error) {
    throw new ReadOnlyToolError(
      "File is not valid UTF-8 text.",
      "INVALID_UTF8",
      { cause: error }
    );
  }
}

export function createReadTextFileTool({
  allowedRoots,
  maxTextFileBytes = 1024 * 1024
}) {
  const maxBytes = requirePositiveInteger(maxTextFileBytes, {
    name: "maxTextFileBytes",
    defaultValue: 1024 * 1024,
    maximum: 4 * 1024 * 1024
  });

  return {
    name: "read_text_file",
    version: "1",
    capability: Capabilities.FILE_READ,
    risk: "low",
    confirmation: "none",
    description: "Read a bounded UTF-8 text file inside an allowed root.",
    async execute(args) {
      requireWindows();
      const requestedPath = requirePathArg(args);
      const canonicalPath = resolveExistingPathWithinAllowedRoots(
        requestedPath,
        allowedRoots
      );

      assertNonSensitivePath(requestedPath, canonicalPath);

      let descriptor;
      try {
        descriptor = openSync(canonicalPath, "r");
      } catch (error) {
        throw new ReadOnlyToolError(
          "Unable to open file.",
          "FILE_OPEN_FAILED",
          { cause: error }
        );
      }

      try {
        const stats = fstatSync(descriptor);

        if (!stats.isFile()) {
          throw new ReadOnlyToolError(
            "Path is not a regular file.",
            "NOT_A_FILE"
          );
        }

        if (stats.size > maxBytes) {
          throw new ReadOnlyToolError(
            "File is larger than the configured read limit.",
            "FILE_TOO_LARGE"
          );
        }

        const buffer = readBoundedFile(descriptor, maxBytes);
        const text = decodeUtf8Text(buffer);

        return Object.freeze({
          path: canonicalPath,
          bytes: buffer.length,
          text
        });
      } finally {
        closeSync(descriptor);
      }
    }
  };
}

export const readTextFileInternals = Object.freeze({
  readBoundedFile,
  decodeUtf8Text
});
