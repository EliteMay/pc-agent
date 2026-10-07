import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/tool-registry.js";

test("registers and resolves a known tool", () => {
  const registry = new ToolRegistry();
  const tool = {
    name: "system_info",
    version: "1",
    capability: "system.inspect",
    risk: "low",
    execute: async () => ({ ok: true })
  };

  registry.register(tool);

  assert.equal(registry.get("system_info"), tool);
});

test("rejects duplicate tool names", () => {
  const registry = new ToolRegistry();
  const tool = {
    name: "system_info",
    version: "1",
    capability: "system.inspect",
    risk: "low",
    execute: async () => ({ ok: true })
  };

  registry.register(tool);

  assert.throws(() => registry.register(tool), /already registered/i);
});

test("unknown tools fail closed", () => {
  const registry = new ToolRegistry();

  assert.throws(() => registry.require("does_not_exist"), /unknown tool/i);
});
