import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentHealthState,
  createInitialHealth,
  markPollSuccess,
  markPollFailure,
  setActiveCommand
} from "../src/host/health-state.js";

test("initial health is STARTING and does not claim queue connectivity", () => {
  const state = createInitialHealth("0.3.0");

  assert.equal(state.agent_state, AgentHealthState.STARTING);
  assert.equal(state.queue_connectivity, "unknown");
  assert.equal(state.active_command_id, null);
  assert.equal(state.version, "0.3.0");
  assert.equal(state.protocol_version, 1);
});

test("poll success marks health and updates timestamp", () => {
  const initial = createInitialHealth("0.3.0");
  const at = new Date("2026-10-07T06:00:00.000Z");
  const state = markPollSuccess(initial, at);

  assert.equal(state.agent_state, AgentHealthState.HEALTHY);
  assert.equal(state.queue_connectivity, "connected");
  assert.equal(state.last_poll_time, at.toISOString());
  assert.equal(state.last_error, null);
});

test("poll failure becomes RECONNECTING without losing active command identity", () => {
  let state = createInitialHealth("0.3.0");
  state = setActiveCommand(state, "cmd-1");
  state = markPollFailure(state, new Error("network down"));

  assert.equal(state.agent_state, AgentHealthState.RECONNECTING);
  assert.equal(state.queue_connectivity, "unreachable");
  assert.equal(state.active_command_id, "cmd-1");
  assert.equal(state.last_error, "network down");
});
