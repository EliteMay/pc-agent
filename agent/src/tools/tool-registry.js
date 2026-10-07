const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,2}$/;
const VALID_RISKS = new Set(["low", "medium", "high"]);
const VALID_CONFIRMATIONS = new Set(["none", "required"]);

export class ToolRegistryError extends Error {
  constructor(message, code = "TOOL_REGISTRY_ERROR") {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
  }
}

function assertToolDefinition(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new ToolRegistryError("Tool definition must be an object.", "INVALID_TOOL_DEFINITION");
  }

  if (typeof tool.name !== "string" || !NAME_PATTERN.test(tool.name)) {
    throw new ToolRegistryError("Tool name is invalid.", "INVALID_TOOL_NAME");
  }

  if (typeof tool.version !== "string" || !VERSION_PATTERN.test(tool.version)) {
    throw new ToolRegistryError("Tool version is invalid.", "INVALID_TOOL_VERSION");
  }

  if (typeof tool.capability !== "string" || tool.capability.trim().length === 0) {
    throw new ToolRegistryError("Tool capability is required.", "INVALID_TOOL_CAPABILITY");
  }

  if (!VALID_RISKS.has(tool.risk)) {
    throw new ToolRegistryError("Tool risk must be low, medium, or high.", "INVALID_TOOL_RISK");
  }

  if (!VALID_CONFIRMATIONS.has(tool.confirmation)) {
    throw new ToolRegistryError(
      "Tool confirmation must be none or required.",
      "INVALID_TOOL_CONFIRMATION"
    );
  }

  if (
    tool.confirmation === "required"
    && typeof tool.approvalSummary !== "function"
  ) {
    throw new ToolRegistryError(
      "Confirmation-required tools must provide approvalSummary(args).",
      "INVALID_APPROVAL_SUMMARY"
    );
  }

  if (typeof tool.execute !== "function") {
    throw new ToolRegistryError("Tool execute handler is required.", "INVALID_TOOL_HANDLER");
  }
}

export class ToolRegistry {
  #tools = new Map();

  register(tool) {
    assertToolDefinition(tool);

    if (this.#tools.has(tool.name)) {
      throw new ToolRegistryError(
        `Tool "${tool.name}" is already registered.`,
        "DUPLICATE_TOOL"
      );
    }

    this.#tools.set(tool.name, Object.freeze({ ...tool }));
    return this;
  }

  get(name) {
    return this.#tools.get(name);
  }

  require(name) {
    const tool = this.get(name);

    if (!tool) {
      throw new ToolRegistryError(
        `Unknown tool "${String(name)}".`,
        "UNKNOWN_TOOL"
      );
    }

    return tool;
  }

  list() {
    return [...this.#tools.values()].map(({ execute: _execute, ...metadata }) => metadata);
  }
}
