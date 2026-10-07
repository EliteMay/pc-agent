#!/usr/bin/env node

import { loadHostConfiguration } from "../src/host/host-config.js";
import { runAgentHost } from "../src/host/agent-host.js";

try {
  const config = loadHostConfiguration();
  await runAgentHost(config);
} catch (error) {
  process.stderr.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "fatal",
    code: error?.code ?? null,
    message: error?.message ?? String(error)
  }) + "\n");
  process.exitCode = 1;
}
