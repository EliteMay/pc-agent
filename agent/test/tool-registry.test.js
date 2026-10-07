import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/tool-registry.js";

test("registers and resolves a known tool", async () => {
  const registry = new ToolRegistry();
  const tool = {
    name: "system_info",
    version: "1",
    capability: "system.inspect",
    risk: "low",
    execute: async () => ({ ok: true })
  };

  registry.register(tool);
  const resolved = registry.require("system_info");

  assert.equal(resolved.name, "system_info");
  assert.equal(resolved.version, "1");
  assert.equal(resolved.capability, "system.inspect");
  assert.deepEqual(await resolved.execute(), { ok: true });
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
