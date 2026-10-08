import { createCaptureNotepadTool } from "./capture-notepad.js";
import { createFindPathsTool } from "./find-paths.js";
import { createListDirectoryTool } from "./list-directory.js";
import { createPingTool } from "./ping.js";
import { createListProcessesTool } from "./list-processes.js";
import { createReadTextFileTool } from "./read-text-file.js";
import { createSearchTextTool } from "./search-text.js";
import { createSystemInfoTool } from "./system-info.js";
export { ReadOnlyToolError } from "./read-only-common.js";

export function registerReadOnlyTools(registry, options = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registry must provide register(tool).");
  }

  const allowedRoots = options.allowedRoots;

  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new TypeError("allowedRoots must contain at least one Windows directory.");
  }

  registry.register(createPingTool());
  registry.register(createCaptureNotepadTool());
  registry.register(createSystemInfoTool());
  registry.register(createListDirectoryTool({
    allowedRoots: [...allowedRoots],
    maxDirectoryEntries: options.maxDirectoryEntries
  }));
  registry.register(createReadTextFileTool({
    allowedRoots: [...allowedRoots],
    maxTextFileBytes: options.maxTextFileBytes
  }));
  registry.register(createFindPathsTool({
    allowedRoots: [...allowedRoots]
  }));
  registry.register(createSearchTextTool({
    allowedRoots: [...allowedRoots],
    maxTextFileBytes: options.maxTextFileBytes
  }));
  registry.register(createListProcessesTool());

  return registry;
}
