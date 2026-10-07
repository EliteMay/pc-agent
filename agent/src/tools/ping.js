import { Capabilities } from "../security/capabilities.js";
import { requireObjectArgs } from "./read-only-common.js";

export function createPingTool() {
  return {
    name: "ping",
    version: "1",
    capability: Capabilities.SYSTEM_INSPECT,
    risk: "low",
    confirmation: "none",
    description:
      "Return a bounded pong from the production PC Agent through the v1 queue.",
    async execute(args) {
      requireObjectArgs(args, []);

      return Object.freeze({
        success: true,
        message: "pong",
        transport: "pc-agent-v1"
      });
    }
  };
}
