import { createCreateDirectoryTool } from "./create-directory.js";
import { createWriteTextFileTool } from "./write-text-file.js";
import { createEditTextFileTool } from "./edit-text-file.js";
import { createCopyFileTool } from "./copy-file.js";
import { createMovePathTool } from "./move-path.js";
export { SafeWriteToolError } from "./safe-write-common.js";

export function registerSafeWriteTools(registry, options = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registry must provide register(tool).");
  }

  const allowedRoots = options.allowedRoots;

  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new TypeError(
      "allowedRoots must contain at least one Windows directory."
    );
  }

  registry.register(createCreateDirectoryTool({
    allowedRoots: [...allowedRoots]
  }));

  registry.register(createWriteTextFileTool({
    allowedRoots: [...allowedRoots],
    maxTextFileBytes: options.maxTextFileBytes
  }));

  registry.register(createEditTextFileTool({
    allowedRoots: [...allowedRoots],
    maxTextFileBytes: options.maxTextFileBytes
  }));

  registry.register(createCopyFileTool({
    allowedRoots: [...allowedRoots],
    maxCopyFileBytes: options.maxCopyFileBytes
  }));

  registry.register(createMovePathTool({
    allowedRoots: [...allowedRoots]
  }));

  return registry;
}
