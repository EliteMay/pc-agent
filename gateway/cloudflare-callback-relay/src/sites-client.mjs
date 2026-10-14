// SERVER ONLY. Call from the existing Sites handler after trusted dispatch
// identity resolution. Do not expose this module, its keys or claim body to UI/MCP.
import { RelayError, SITE_ORIGIN, TTL, opaque, dummyCode, plainObject, relayOrigin,
  keyBytes, sha, signedRequest, readText, safeJson, safeError } from './protocol.mjs';

function checkRoute(request,action) {
  const u=new URL(request.url),path=action==='prepare'?'/oauth/start':'/connect/complete';
  if(u.origin!==SITE_ORIGIN) throw new RelayError('origin_rejected');
  if(u.pathname!==path) throw new RelayError('not_found');
  if(request.method!==(action==='prepare'?'POST':'GET')) throw new RelayError('method_not_allowed');
  if(u.search||u.hash) throw new RelayError('invalid_input');
  const origin=request.headers.get('origin');
  if((action==='prepare'||origin!==null)&&origin!==SITE_ORIGIN) throw new RelayError('origin_rejected');
}
function checkPending(pending,owner,origin,now) {
  if(!plainObject(pending)||pending.owner!==owner||!opaque(pending.browserId)||!opaque(pending.state)||!opaque(pending.verifier)||
    !Number.isSafeInteger(pending.expiresAt)||pending.expiresAt<=now||pending.expiresAt>now+TTL||pending.redirectUri!==origin+'/oauth/callback') throw new RelayError('state_unavailable');
  return pending;
}
function checkClaim(value,state) {
  if(!plainObject(value)||value.state!==state||!['code','denied'].includes(value.outcome)||
    Object.keys(value).sort().join(',')!==(value.outcome==='code'?'code,outcome,state':'outcome,state')||
    value.outcome==='code'&&!dummyCode(value.code)) throw new RelayError('unavailable');
  return value;
}
export function createSitesRelayClient({origin,key,authorize,loadPending,consumePending,invalidatePending,
  exchangeDummy,fetcher=fetch,clock=Date.now,timeoutMs=10000}) {
  origin=relayOrigin(origin);keyBytes(key);
  if([authorize,loadPending,consumePending,invalidatePending,exchangeDummy,fetcher].some(fn=>typeof fn!=='function')||
    !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000) throw new RelayError('setup_required');
  async function rpc(path,body,status) {
    const request=await signedRequest({origin,key,path,body,now:clock()});
    const controller=new AbortController();let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RelayError('unavailable'));},timeoutMs);});
    const operation=(async()=>{
      const response=await fetcher(new Request(request,{signal:controller.signal}));
      if(response.status!==status||response.redirected||!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type')??'')) throw new RelayError('unavailable');
      try { return JSON.parse(await readText(response,2048)); } catch { throw new RelayError('unavailable'); }
    })();
    try { return await Promise.race([operation,timeout]); }
    catch { throw new RelayError('unavailable'); }
    finally { clearTimeout(timer);controller.abort(); }
  }
  async function pendingFor(request,action) {
    checkRoute(request,action);
    const owner=await authorize(request);
    if(typeof owner!=='string'||!owner||owner.length>200) throw new RelayError('authentication_required');
    // loadPending MUST use the validated HttpOnly browser session and owner. A
    // pending object from the browser or a caller-supplied ID is never accepted.
    const pending=checkPending(await loadPending(request,owner),owner,origin,clock());
    return {pending,binding:await sha(`kaito-sites-binding|${owner}|${pending.browserId}|${pending.state}`)};
  }
  return {
    async prepare(request) {
      try {
        const {pending,binding}=await pendingFor(request,'prepare');
        if(!opaque(pending.csrf)||request.headers.get('x-oauth-csrf')!==pending.csrf) throw new RelayError('authentication_required');
        const result=await rpc('/prepare',{state:pending.state,binding},201);
        if(!plainObject(result)||Object.keys(result).sort().join(',')!=='mode,prepared'||result.prepared!==true||result.mode!=='dummy') throw new RelayError('unavailable');
        return safeJson({prepared:true,mode:'dummy'},201);
      } catch(error) { return safeError(error); }
    },
    async complete(request) {
      let pending,consumed=false;
      try {
        const loaded=await pendingFor(request,'complete');pending=loaded.pending;
        // Atomic Site consumption precedes claim/exchange, just as in saved2.
        if(await consumePending(pending)!==true) throw new RelayError('state_unavailable');consumed=true;
        const result=checkClaim(await rpc('/claim',{state:pending.state,binding:loaded.binding},200),pending.state);
        if(result.outcome==='denied') {
          await invalidatePending(pending);consumed=false;
          return safeJson({state:'denied',mode:'dummy',gateway_authenticated:false});
        }
        await exchangeDummy({code:result.code,state:pending.state,code_verifier:pending.verifier,redirect_uri:pending.redirectUri});
        return safeJson({state:'checking',mode:'dummy',gateway_authenticated:false});
      } catch(error) {
        if(consumed) { try { await invalidatePending(pending); } catch {} }
        return safeError(error);
      }
    },
  };
}
