import os from "node:os";
import { Capabilities } from "../security/capabilities.js";
import {
  requireObjectArgs,
  requireWindows
} from "./read-only-common.js";

export function createSystemInfoTool() {
  return {
    name: "system_info",
    version: "1",
    capability: Capabilities.SYSTEM_INSPECT,
    risk: "low",
    confirmation: "none",
    description: "Return bounded, non-identifying operating system and runtime facts.",
    async execute(args) {
      requireWindows();
      requireObjectArgs(args, []);

      const cpus = os.cpus();

      return Object.freeze({
        platform: process.platform,
        os_release: os.release(),
        os_version: os.version(),
        architecture: process.arch,
        node_version: process.version,
        cpu_count: cpus.length,
        cpu_model: cpus[0]?.model ?? null,
        total_memory_bytes: os.totalmem(),
        free_memory_bytes: os.freemem(),
        uptime_seconds: Math.floor(os.uptime())
      });
    }
  };
}
