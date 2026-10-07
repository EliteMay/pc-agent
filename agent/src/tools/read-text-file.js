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
  requireObjectArgs,
  requirePositiveInteger,
  requireWindows
} from "./read-only-common.js";

const READ_CHUNK_BYTES = 64 * 1024;

function readBoundedFile(fileDescriptor, maximumBytes, offset = 0) {
  const chunks = [];
  let total = 0;

  while (total < maximumBytes) {
    const remaining = maximumBytes - total;
    const buffer = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, remaining)
    );
    const bytesRead = readSync(
      fileDescriptor,
      buffer,
      0,
      buffer.length,
      offset + total
    );

    if (bytesRead === 0) {
      break;
    }

    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }

  return Buffer.concat(chunks, total);
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

function parseReadRequest(args, configuredMaximumBytes) {
  requireObjectArgs(args, ["path", "offset", "maxBytes"]);

  if (typeof args.path !== "string" || args.path.trim().length === 0) {
    throw new ReadOnlyToolError(
      "path must be a non-empty string.",
      "INVALID_ARGUMENTS"
    );
  }

  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ReadOnlyToolError(
      "offset must be a non-negative integer.",
      "INVALID_ARGUMENTS"
    );
  }

  const defaultRangeBytes = Math.min(
    READ_CHUNK_BYTES,
    configuredMaximumBytes
  );
  const rangeBytes = args.maxBytes ?? defaultRangeBytes;

  if (
    !Number.isSafeInteger(rangeBytes)
    || rangeBytes < 1
    || rangeBytes > READ_CHUNK_BYTES
    || rangeBytes > configuredMaximumBytes
  ) {
    throw new ReadOnlyToolError(
      "maxBytes must be an integer between 1 and " +
        Math.min(READ_CHUNK_BYTES, configuredMaximumBytes) + ".",
      "INVALID_ARGUMENTS"
    );
  }

  return Object.freeze({
    path: args.path,
    offset,
    maxBytes: rangeBytes
  });
}

function decodeUtf8Range(buffer) {
  if (buffer.length === 0) {
    return Object.freeze({
      buffer,
      text: ""
    });
  }

  for (
    let trim = 0;
    trim <= Math.min(3, buffer.length - 1);
    trim += 1
  ) {
    const candidate = trim === 0
      ? buffer
      : buffer.subarray(0, buffer.length - trim);

    try {
      return Object.freeze({
        buffer: candidate,
        text: decodeUtf8Text(candidate)
      });
    } catch (error) {
      if (
        !(error instanceof ReadOnlyToolError)
        || error.code !== "INVALID_UTF8"
      ) {
        throw error;
      }
    }
  }

  throw new ReadOnlyToolError(
    "Requested byte range does not end on a UTF-8 boundary.",
    "INVALID_UTF8_RANGE"
  );
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
      const request = parseReadRequest(args, maxBytes);
      const requestedPath = request.path;
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

        if (request.offset > stats.size) {
          throw new ReadOnlyToolError(
            "offset is beyond the end of the file.",
            "OFFSET_OUT_OF_RANGE"
          );
        }

        const rawBuffer = readBoundedFile(
          descriptor,
          request.maxBytes,
          request.offset
        );
        const decoded = decodeUtf8Range(rawBuffer);
        const bytes = decoded.buffer.length;
        const nextOffset = request.offset + bytes;

        if (rawBuffer.length > 0 && bytes === 0) {
          throw new ReadOnlyToolError(
            "maxBytes is too small to decode the next UTF-8 character.",
            "READ_RANGE_TOO_SMALL"
          );
        }

        return Object.freeze({
          path: canonicalPath,
          offset: request.offset,
          bytes,
          next_offset: nextOffset,
          eof: nextOffset >= stats.size,
          text: decoded.text
        });
      } finally {
        closeSync(descriptor);
      }
    }
  };
}

export const readTextFileInternals = Object.freeze({
  readBoundedFile,
  decodeUtf8Text,
  decodeUtf8Range,
  parseReadRequest
});
