#!/usr/bin/env node
import { isSafeBearerToken } from "./oauth-site-smoke-validation.mjs";
/**
 * Issue #29, approval-gated, read-only OAuth Gateway smoke.
 *
 * NEVER reads or prints an OAuth token, client_id, or raw HTTP responses.
 * Never calls the PC-command tool "ping", or any GUI/file/task tool.
 * Opt-in with --live, after OAuth/Gateway deployment is approved separately.
 *
 * This validates the real HTTPS OAuth middleware and SITE gateway_probe only
 * after a separately approved production rollout. It is NOT a PC command test.
 */

const allowedMethods = new Set(["GET", "POST"]);
const projectRef = "vtnwbgejlaqpnwmlzbjy";
const endpoint =
  `https://${projectRef}.supabase.co/functions/v1/kaito-pc-agent-oauth-readonly`;
const toolNames = Object.freeze(["gateway_probe"]);

function fail(stage, reason) {
  throw new Error(`${stage}: ${reason}`);
}

function assertObject(value, stage) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(stage, "invalid_response_shape");
  }
  return value;
}

async function send({ method, token, body, stage }) {
  if (!allowedMethods.has(method)) fail(stage, "invalid_http_method");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: "error", // never forward a bearer token to another host
  });
  if (!response.ok) fail(stage, `unexpected_http_status_${response.status}`);
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    fail(stage, "unexpected_content_type");
  }
  // Do not print or store raw responses, which can include personal device data.
  return assertObject(await response.json(), stage);
}

function expectScopedCapabilities(result, stage) {
  if (result.authenticated !== true || result.readOnly !== true ||
      result.safeWrite !== false || result.orchestration !== false) {
    fail(stage, "site_scope_not_confirmed");
  }
}

function unwrapToolResponse(json, expectedId, stage) {
  if (json.jsonrpc !== "2.0" || json.id !== expectedId) {
    fail(stage, "jsonrpc_response_mismatch");
  }
  const result = assertObject(json.result, stage);
  if (result.isError === true) fail(stage, "tool_reported_error");
  return assertObject(result.structuredContent, stage);
}

async function callTool(name, id, token) {
  const stage = `tool_${name}`;
  return unwrapToolResponse(await send({
    method: "POST",
    token,
    stage,
    body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } },
  }), id, stage);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--live") {
    process.stdout.write("NOT RUN: live mode requires --live and a separately approved OAuth rollout.\n");
    return;
  }
  const token = process.env.PC_AGENT_OAUTH_ACCESS_TOKEN;
  if (!isSafeBearerToken(token)) {
    fail("preflight", "missing_or_invalid_token_environment");
  }

  // GET and tools/list cannot enqueue a device operation.
  expectScopedCapabilities(await send({ method: "GET", token, stage: "get_status" }), "get_status");
  process.stdout.write("PASS get_status: verified Site-scoped capabilities\n");

  const rpc = await send({
    method: "POST",
    token,
    stage: "tools_list",
    body: { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} },
  });
  if (rpc.jsonrpc !== "2.0" || rpc.id !== 101) fail("tools_list", "invalid_jsonrpc_envelope");
  const tools = assertObject(rpc.result, "tools_list").tools;
  const actual = Array.isArray(tools) ? tools.map(t => t?.name).sort() : null;
  if (!actual || JSON.stringify(actual) !== JSON.stringify([...toolNames].sort())) {
    fail("tools_list", "tool_scope_mismatch");
  }
  process.stdout.write("PASS tools_list: only gateway_probe is advertised\n");

  expectScopedCapabilities(await callTool("gateway_probe", 102, token), "gateway_probe");
  process.stdout.write("PASS gateway_probe: authenticated Site client\n");

  process.stdout.write("STOP: No PC ping, screenshot, GUI, task, or file action was sent.\n");
}

main().catch(error => {
  // Report stage/code only. Never surface response bodies, tokens or headers.
  const safe = error instanceof Error ? error.message : "unknown_failure";
  process.stderr.write(`FAIL ${/^[a-z_]+: [a-z0-9_]+$/.test(safe) ? safe : "connection_or_unexpected_error"}\n`);
  process.exitCode = 1;
});
