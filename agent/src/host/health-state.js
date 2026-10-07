export const AgentHealthState = Object.freeze({
  STARTING: "STARTING",
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  RECONNECTING: "RECONNECTING",
  STOPPING: "STOPPING"
});

function freeze(value) {
  return Object.freeze({ ...value });
}

export function createInitialHealth(version) {
  return freeze({
    agent_state: AgentHealthState.STARTING,
    last_poll_time: null,
    queue_connectivity: "unknown",
    active_command_id: null,
    version,
    protocol_version: 1,
    started_at: new Date().toISOString(),
    last_error: null
  });
}

export function markPollSuccess(state, at = new Date()) {
  return freeze({
    ...state,
    agent_state: AgentHealthState.HEALTHY,
    queue_connectivity: "connected",
    last_poll_time: at.toISOString(),
    last_error: null
  });
}

export function markPollFailure(state, error) {
  return freeze({
    ...state,
    agent_state: AgentHealthState.RECONNECTING,
    queue_connectivity: "unreachable",
    last_error:
      typeof error?.message === "string"
        ? error.message.slice(0, 1000)
        : String(error).slice(0, 1000)
  });
}

export function setActiveCommand(state, commandId) {
  return freeze({
    ...state,
    active_command_id: commandId ?? null
  });
}

export function markStopping(state) {
  return freeze({
    ...state,
    agent_state: AgentHealthState.STOPPING
  });
}
