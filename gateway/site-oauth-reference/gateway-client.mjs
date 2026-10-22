// Calls the existing OAuth-protected PC Agent gateway (Supabase Edge Function, unchanged) from the
// Site server with the owner's REAL access token. First-goal scope: three read-only tools, in
// increasing reach - gateway_probe (token + allowed user, no PC), relay_ping (device registration
// and heartbeat, no PC command) and ping (a command to the PC Agent, answered with "pong").
// Nothing here can reach capture_notepad / notepad_gui / write tools: they are not in the allowlist.
export const GATEWAY_URL = 'https://vtnwbgejlaqpnwmlzbjy.supabase.co/functions/v1/kaito-pc-agent-oauth-readonly';
const MAX_BYTES = 65536;

const validators = {
  gateway_probe: (r) => r.success === true && r.authenticated === true && r.service === 'pc-agent-oauth'
    ? { authenticated: true, gateway_version: String(r.version ?? '').slice(0, 16) } : null,
  relay_ping: (r) => r.success === true && r.message === 'relay_pong' && typeof r.deviceRegistered === 'boolean' &&
    (r.lastSeenAt === null || typeof r.lastSeenAt === 'string') && (r.agentVersion === null || typeof r.agentVersion === 'string')
    ? { device_registered: r.deviceRegistered, last_seen_at: r.lastSeenAt, agent_version: r.agentVersion === null ? null : r.agentVersion.slice(0, 32) } : null,
  ping: (r) => r.success === true && r.message === 'pong' && r.transport === 'pc-agent-v1'
    ? { pc_connected: true, pong: true } : null,
};
export const ALLOWED_TOOLS = Object.freeze(Object.keys(validators));

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty');
  const chunks = []; let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.length;
    if (total > MAX_BYTES) { await reader.cancel(); throw new Error('too_large'); }
    chunks.push(part.value);
  }
  const joined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

export function createGatewayClient({ fetcher = fetch, timeoutMs = 20000 } = {}) {
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('invalid_client_options');
  return {
    // The result is always a finite, token-free state; errors never carry the access token.
    async callTool(accessToken, tool) {
      if (!ALLOWED_TOOLS.includes(tool)) return { state: 'tool_not_allowed' };
      if (typeof accessToken !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(accessToken)) return { state: 'auth_required' };
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(new Request(GATEWAY_URL, {
          method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
          headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: {} } }),
        }));
        if (response.status === 401) { await response.body?.cancel(); return { state: 'auth_required' }; }
        if (response.status === 403) { await response.body?.cancel(); return { state: 'forbidden_user' }; }
        if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '')) {
          await response.body?.cancel(); return { state: 'unavailable' };
        }
        const message = JSON.parse(await readBounded(response));
        if (message?.jsonrpc !== '2.0' || message.id !== id || message.error || typeof message.result !== 'object' || message.result === null) return { state: 'unavailable' };
        const payload = message.result.structuredContent;
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { state: 'unavailable' };
        if (message.result.isError === true) return { state: payload.errorCode === 'expired' ? 'pc_timeout' : 'tool_error' };
        const reduced = validators[tool](payload);
        return reduced ? { state: 'ok', tool, result: reduced } : { state: 'unavailable' };
      } catch { return { state: 'unavailable' }; }
      finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
