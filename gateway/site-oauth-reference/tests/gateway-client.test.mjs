import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayClient, ALLOWED_TOOLS, GATEWAY_URL } from '../gateway-client.mjs';

const TOKEN = 'aaaa.bbbb.cccc';
// The gateway wraps every tool result as mcpResult(): structuredContent carries the payload.
function rpc(id, payload, isError = false) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError } };
}
function harness(respond) {
  const calls = [];
  const fetcher = async (request) => {
    const body = JSON.parse(await request.clone().text());
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body, redirect: request.redirect, credentials: request.credentials });
    return respond(body, request);
  };
  return { calls, client: createGatewayClient({ fetcher, timeoutMs: 500 }) };
}
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers });
const ok = (payloadFor) => (body) => json(rpc(body.id, payloadFor(body.params.name)));

test('the allowlist is exactly the three first-goal read-only tools', () => {
  assert.deepEqual([...ALLOWED_TOOLS].sort(), ['gateway_probe', 'ping', 'relay_ping']);
});

test('gateway_probe, relay_ping and ping succeed against the real response shapes and send one fixed request each', async () => {
  const payloads = {
    gateway_probe: { success: true, authenticated: true, readOnly: false, safeWrite: true, orchestration: true, gateway: 'supabase-oauth', service: 'pc-agent-oauth', version: '10' },
    relay_ping: { success: true, message: 'relay_pong', relay: 'supabase-oauth', service: 'kaito-pc-agent-oauth-readonly', version: '10', deviceRegistered: true, lastSeenAt: '2026-10-22T07:34:59Z', agentVersion: '0.11.6' },
    ping: { success: true, message: 'pong', transport: 'pc-agent-v1' },
  };
  const { client, calls } = harness(ok((name) => payloads[name]));
  assert.deepEqual(await client.callTool(TOKEN, 'gateway_probe'), { state: 'ok', tool: 'gateway_probe', result: { authenticated: true, gateway_version: '10' } });
  assert.deepEqual(await client.callTool(TOKEN, 'relay_ping'), { state: 'ok', tool: 'relay_ping', result: { device_registered: true, last_seen_at: '2026-10-22T07:34:59Z', agent_version: '0.11.6' } });
  assert.deepEqual(await client.callTool(TOKEN, 'ping'), { state: 'ok', tool: 'ping', result: { pc_connected: true, pong: true } });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, GATEWAY_URL);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer ' + TOKEN);
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.body.method, 'tools/call');
    assert.deepEqual(call.body.params.arguments, {});
  }
});

test('tools outside the allowlist never reach the network', async () => {
  const { client, calls } = harness(() => { throw new Error('must not be called'); });
  for (const name of ['capture_notepad', 'notepad_gui', 'write_text_file', 'run_development_command', 'system_info', 'tools/list', '', 'ping ']) {
    assert.deepEqual(await client.callTool(TOKEN, name), { state: 'tool_not_allowed' });
  }
  assert.equal(calls.length, 0);
});

test('a missing or malformed token never reaches the network', async () => {
  const { client, calls } = harness(() => { throw new Error('must not be called'); });
  for (const token of [undefined, null, '', 'not-a-jwt', 'a.b', 'a b.c.d', 5]) {
    assert.deepEqual(await client.callTool(token, 'ping'), { state: 'auth_required' });
  }
  assert.equal(calls.length, 0);
});

test('HTTP 401 means auth_required (no token or expired), 403 means a user that is not the allowed owner', async () => {
  assert.deepEqual(await harness(() => json({ code: 'MISSING_CREDENTIALS' }, 401)).client.callTool(TOKEN, 'gateway_probe'), { state: 'auth_required' });
  assert.deepEqual(await harness(() => json({ error: 'forbidden' }, 403)).client.callTool(TOKEN, 'gateway_probe'), { state: 'forbidden_user' });
});

test('PC command expiry is distinguished from other tool errors', async () => {
  const expired = harness((body) => json(rpc(body.id, { success: false, errorCode: 'expired', message: 'PC command expired.' }, true)));
  assert.deepEqual(await expired.client.callTool(TOKEN, 'ping'), { state: 'pc_timeout' });
  const other = harness((body) => json(rpc(body.id, { success: false, errorCode: 'gateway_error', message: 'No paired PC Agent device is registered.' }, true)));
  assert.deepEqual(await other.client.callTool(TOKEN, 'ping'), { state: 'tool_error' });
});

test('anything unexpected collapses to unavailable: bad status, content type, JSON, id, shape, redirects, oversize, timeout, wrong tool answer', async () => {
  const cases = {
    status500: () => json({ error: 'x' }, 500),
    status204: () => new Response(null, { status: 204 }),
    wrongType: () => new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } }),
    notJson: () => new Response('nope', { status: 200, headers: { 'content-type': 'application/json' } }),
    wrongId: () => json(rpc('someone-elses-id', { success: true, message: 'pong', transport: 'pc-agent-v1' })),
    rpcError: (body) => json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }),
    noStructured: (body) => json({ jsonrpc: '2.0', id: body.id, result: { content: [], isError: false } }),
    wrongAnswer: (body) => json(rpc(body.id, { success: true, message: 'relay_pong', transport: 'pc-agent-v1' })),
    pongWithoutTransport: (body) => json(rpc(body.id, { success: true, message: 'pong' })),
    oversize: (body) => json(rpc(body.id, { success: true, message: 'pong', transport: 'pc-agent-v1', pad: 'x'.repeat(70000) })),
    redirect: () => Response.redirect('https://evil.example/', 302),
  };
  for (const [name, respond] of Object.entries(cases)) {
    assert.deepEqual(await harness(respond).client.callTool(TOKEN, 'ping'), { state: 'unavailable' }, name);
  }
  const hanging = createGatewayClient({ fetcher: (request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))), timeoutMs: 30 });
  assert.deepEqual(await hanging.callTool(TOKEN, 'ping'), { state: 'unavailable' });
  const failing = createGatewayClient({ fetcher: async () => { throw new TypeError('network ' + TOKEN); } });
  const result = await failing.callTool(TOKEN, 'ping');
  assert.deepEqual(result, { state: 'unavailable' });
});

test('no result or error ever contains the access token', async () => {
  const outputs = [];
  outputs.push(await harness(ok(() => ({ success: true, message: 'pong', transport: 'pc-agent-v1', echo: TOKEN }))).client.callTool(TOKEN, 'ping'));
  outputs.push(await harness(() => json({ error: TOKEN }, 401)).client.callTool(TOKEN, 'ping'));
  outputs.push(await harness(() => { throw new Error(TOKEN); }).client.callTool(TOKEN, 'ping'));
  for (const output of outputs) assert.ok(!JSON.stringify(output).includes(TOKEN));
});
