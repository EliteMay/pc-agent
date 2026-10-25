import { RelayError, RETURN_URL, ISSUER, OAUTH_ERRORS, opaque, dummyCode, oauthCode, plainObject, keyBytes,
  relayOrigin, RELAY_PRODUCTION_ORIGIN, authenticatedBody, modeStateHash, seal, open, safeHeaders, safeJson, safeError } from './protocol.mjs';
import { createStore } from './store.mjs';

function configuration(env) {
  // Production remains dummy-only unless BOTH server-managed settings opt into live.
  // Source-only opt-in is NOT approval for deployment or real-code handling.
  const mode = env.RELAY_MODE;
  if(!['dummy','live'].includes(mode)||
    (mode==='live'&&env.RELAY_LIVE_ENABLED!=='true')||
    !env.DB?.prepare||!env.DB?.batch) throw new RelayError('setup_required');
  keyBytes(env.RELAY_SIGNING_KEY); keyBytes(env.RELAY_STORAGE_KEY);
  if(env.RELAY_SIGNING_KEY===env.RELAY_STORAGE_KEY) throw new RelayError('setup_required');
  const origin=relayOrigin(env.RELAY_ORIGIN);
  // Real OAuth codes must never be handled by the offline-test relay host.
  if(mode==='live'&&origin!==RELAY_PRODUCTION_ORIGIN) throw new RelayError('setup_required');
  return {origin,store:createStore(env.DB),mode};
}
function callbackPayload(url,mode) {
  if(url.href.length>4096) throw new RelayError('invalid_input');
  const q=url.searchParams;
  for(const key of q.keys()) if(!['code','state','error','error_description','iss'].includes(key)||q.getAll(key).length!==1) throw new RelayError('invalid_input');
  const state=q.get('state'); if(!opaque(state)||q.has('code')===q.has('error')||q.has('iss')&&q.get('iss')!==ISSUER) throw new RelayError('invalid_input');
  if(q.has('error')) { if(!OAUTH_ERRORS.has(q.get('error'))) throw new RelayError('invalid_input'); return {outcome:'denied',state}; }
  const code=q.get('code');
  const allowed=mode==='dummy' ? dummyCode(code) : oauthCode(code)&&!dummyCode(code);
  if(!allowed||q.has('error_description')) throw new RelayError('invalid_input');
  return {outcome:'code',code,state};
}
function validateClaim(payload,state,mode) {
  const expected=payload?.outcome==='code'?'code,outcome,state':'outcome,state';
  if(!plainObject(payload)||Object.keys(payload).sort().join(',')!==expected||payload.state!==state||
    !['code','denied'].includes(payload.outcome)||payload.outcome==='code'&&!(mode==='dummy'?dummyCode(payload.code):oauthCode(payload.code)&&!dummyCode(payload.code))) throw new RelayError('unavailable');
  return payload;
}
export function createWorker({clock=Date.now}={}) {
  async function route(request,env) {
    const {origin,store,mode}=configuration(env); const url=new URL(request.url),now=clock();
    if(url.origin!==origin) throw new RelayError('origin_rejected');
    if(!['/prepare','/claim','/oauth/callback'].includes(url.pathname)) throw new RelayError('not_found');
    if(request.method!==(url.pathname==='/oauth/callback'?'GET':'POST')) throw new RelayError('method_not_allowed');
    if(url.pathname==='/oauth/callback') {
      const payload=callbackPayload(url,mode),stateHash=await modeStateHash(mode,payload.state),row=await store.row(stateHash);
      if(!row||row.expires_at<=now||row.phase!=='prepared') throw new RelayError('state_unavailable');
      await store.receive(row,await seal(payload,env.RELAY_STORAGE_KEY,row,mode),now);
      return new Response(null,{status:303,headers:{...safeHeaders,location:RETURN_URL}});
    }
    if(url.search||url.hash) throw new RelayError('invalid_input');
    const {body,nonceHash}=await authenticatedBody(request,origin,env.RELAY_SIGNING_KEY,now);
    await store.rate(url.pathname.slice(1),now);
    const stateHash=await modeStateHash(mode,body.state);
    if(url.pathname==='/prepare') { await store.prepare(stateHash,body.binding,nonceHash,now); return safeJson({prepared:true,mode},201); }
    const row=await store.claim(stateHash,body.binding,nonceHash,now);
    const payload=validateClaim(await open(row.envelope,env.RELAY_STORAGE_KEY,row,mode),body.state,mode);
    // This response is exclusively a signed, server-to-server HTTPS handoff.
    // It must never be proxied to a browser or an MCP tool response.
    return safeJson(payload);
  }
  return {
    async fetch(request,env) { try { return await route(request,env); } catch(error) { return safeError(error); } },
    async scheduled(_event,env) {
      try { await createStore(env.DB).cleanup(clock()); }
      catch {
        // Do not report a successful Cron invocation when D1 cleanup failed.
        // Never include raw D1 errors, query data or secrets in the exception.
        throw new Error('relay_cleanup_failed');
      }
    },
  };
}
export default createWorker();
