import { RelayError, RETURN_URL, ISSUER, opaque, dummyCode, plainObject, keyBytes,
  relayOrigin, authenticatedBody, sha, seal, open, safeHeaders, safeJson, safeError } from './protocol.mjs';
import { createStore } from './store.mjs';

function configuration(env) {
  if(env.RELAY_MODE!=='dummy'||!env.DB?.prepare||!env.DB?.batch) throw new RelayError('setup_required');
  keyBytes(env.RELAY_SIGNING_KEY); keyBytes(env.RELAY_STORAGE_KEY);
  if(env.RELAY_SIGNING_KEY===env.RELAY_STORAGE_KEY) throw new RelayError('setup_required');
  return {origin:relayOrigin(env.RELAY_ORIGIN),store:createStore(env.DB)};
}
function callbackPayload(url) {
  if(url.href.length>4096) throw new RelayError('invalid_input');
  const q=url.searchParams;
  for(const key of q.keys()) if(!['code','state','error','error_description','iss'].includes(key)||q.getAll(key).length!==1) throw new RelayError('invalid_input');
  const state=q.get('state'); if(!opaque(state)||q.has('code')===q.has('error')||q.has('iss')&&q.get('iss')!==ISSUER) throw new RelayError('invalid_input');
  if(q.has('error')) { if(q.get('error')!=='access_denied') throw new RelayError('invalid_input'); return {outcome:'denied',state}; }
  const code=q.get('code'); if(!dummyCode(code)||q.has('error_description')) throw new RelayError('invalid_input');
  return {outcome:'code',code,state};
}
function validateClaim(payload,state) {
  const expected=payload?.outcome==='code'?'code,outcome,state':'outcome,state';
  if(!plainObject(payload)||Object.keys(payload).sort().join(',')!==expected||payload.state!==state||
    !['code','denied'].includes(payload.outcome)||payload.outcome==='code'&&!dummyCode(payload.code)) throw new RelayError('unavailable');
  return payload;
}
export function createWorker({clock=Date.now}={}) {
  async function route(request,env) {
    const {origin,store}=configuration(env); const url=new URL(request.url),now=clock();
    if(url.origin!==origin) throw new RelayError('origin_rejected');
    if(!['/prepare','/claim','/oauth/callback'].includes(url.pathname)) throw new RelayError('not_found');
    if(request.method!==(url.pathname==='/oauth/callback'?'GET':'POST')) throw new RelayError('method_not_allowed');
    if(url.pathname==='/oauth/callback') {
      const payload=callbackPayload(url),stateHash=await sha(payload.state),row=await store.row(stateHash);
      if(!row||row.expires_at<=now||row.phase!=='prepared') throw new RelayError('state_unavailable');
      await store.receive(row,await seal(payload,env.RELAY_STORAGE_KEY,row),now);
      return new Response(null,{status:303,headers:{...safeHeaders,location:RETURN_URL}});
    }
    if(url.search||url.hash) throw new RelayError('invalid_input');
    const {body,nonceHash}=await authenticatedBody(request,origin,env.RELAY_SIGNING_KEY,now);
    await store.rate(url.pathname.slice(1),now);
    const stateHash=await sha(body.state);
    if(url.pathname==='/prepare') { await store.prepare(stateHash,body.binding,nonceHash,now); return safeJson({prepared:true,mode:'dummy'},201); }
    const row=await store.claim(stateHash,body.binding,nonceHash,now);
    const payload=validateClaim(await open(row.envelope,env.RELAY_STORAGE_KEY,row),body.state);
    // This response is exclusively a signed, server-to-server HTTPS handoff.
    // It must never be proxied to a browser or an MCP tool response.
    return safeJson(payload);
  }
  return {
    async fetch(request,env) { try { return await route(request,env); } catch(error) { return safeError(error); } },
    async scheduled(_event,env) { try { await createStore(env.DB).cleanup(clock()); return {cleanup_completed:true}; } catch { return {cleanup_completed:false}; } },
  };
}
export default createWorker();
