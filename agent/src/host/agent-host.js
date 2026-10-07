import { setTimeout as delay } from "node:timers/promises";
import { ToolRegistry } from "../tools/tool-registry.js";
import { registerReadOnlyTools } from "../tools/read-only-tools.js";
import { registerSafeWriteTools } from "../tools/safe-write-tools.js";
import { createDevelopmentCommandTool } from "../tools/development-command.js";
import { OperationJournal } from "../journal/operation-journal.js";
import { SupabaseQueueClient } from "../cloud/supabase-queue-client.js";
import { runQueueOnce } from "../queue/run-queue-once.js";
import { LocalApprovalBroker } from "../approval/local-approval-broker.js";
import {
  createInitialHealth,
  markPollFailure,
  markPollSuccess,
  markStopping,
  setActiveCommand
} from "./health-state.js";
import { createNamedPipeServer } from "./named-pipe-server.js";

function log(event, details = {}) {
  process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details
  }) + "\n");
}

export async function runAgentHost(config) {
  const registry = new ToolRegistry();
  registerReadOnlyTools(registry, {
    allowedRoots: config.allowedRoots
  });
  registerSafeWriteTools(registry, {
    allowedRoots: config.allowedRoots
  });
  registry.register(createDevelopmentCommandTool({
    allowedRoots: config.allowedRoots
  }));

  const journal = new OperationJournal(config.journalPath);
  const approvalBroker = new LocalApprovalBroker();
  const client = new SupabaseQueueClient({
    endpointUrl: config.endpointUrl,
    deviceToken: config.deviceToken,
    deviceId: config.deviceId,
    agentVersion: config.version
  });

  let health = createInitialHealth(config.version);
  let stopping = false;
  let consecutiveFailures = 0;

  const requestStop = () => {
    stopping = true;
    health = markStopping(health);
  };

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  const pipe = createNamedPipeServer({
    pipeName: config.pipeName,
    getHealth: () => health,
    getPendingApproval: () => approvalBroker.getPendingApproval(),
    onApprovalResponse: (operationId, decision) =>
      approvalBroker.respond(operationId, decision),
    onPrepareShutdown: requestStop
  });

  await pipe.listen();
  log("agent_started", {
    version: config.version,
    allowedRootCount: config.allowedRoots.length
  });

  try {
    while (!stopping) {
      try {
        const outcome = await runQueueOnce({
          client,
          registry,
          journal,
          approvalProvider: approvalBroker,
          waitMs: 5000,
          onCommand(command) {
            health = setActiveCommand(health, command.command_id);
          }
        });

        health = setActiveCommand(health, null);
        health = markPollSuccess(health);
        consecutiveFailures = 0;

        if (outcome.status !== "IDLE") {
          log("queue_outcome", {
            status: outcome.status,
            command_id: outcome.command_id ?? null
          });
        }
      } catch (error) {
        health = setActiveCommand(health, null);
        health = markPollFailure(health, error);
        consecutiveFailures += 1;

        log("queue_error", {
          code: error?.code ?? null,
          message: error?.message ?? String(error)
        });

        const backoffMs = Math.min(
          30_000,
          1000 * 2 ** Math.min(consecutiveFailures - 1, 5)
        );

        await delay(backoffMs);
      }
    }
  } finally {
    health = markStopping(health);
    approvalBroker.cancelPending();
    await pipe.close().catch(() => undefined);
    journal.close();
    log("agent_stopped");
  }
}
