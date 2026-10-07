import { createCreateDirectoryTool } from "./create-directory.js";
import { createWriteTextFileTool } from "./write-text-file.js";
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

  return registry;
}
