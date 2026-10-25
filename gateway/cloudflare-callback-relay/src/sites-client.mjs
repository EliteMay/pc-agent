// SERVER ONLY. Call from the existing Sites handler after trusted dispatch
// identity resolution. Do not expose this module, its keys or claim body to UI/MCP.
import { RelayError, SITE_ORIGIN, TTL, opaque, dummyCode, oauthCode, plainObject, relayOrigin,
  keyBytes, RELAY_PRODUCTION_ORIGIN, sha, signedRequest, readText, safeJson, safeError } from './protocol.mjs';

function checkRoute(request,action) {
  const u=new URL(request.url),path=action==='prepare'?'/oauth/start':'/connect/complete';
  if(u.origin!==SITE_ORIGIN) throw new RelayError('origin_rejected');
  if(u.pathname!==path) throw new RelayError('not_found');
  // OAuth state consumption is never allowed on GET. Both actions require POST.
  if(request.method!=='POST') throw new RelayError('method_not_allowed');
  if(u.search||u.hash) throw new RelayError('invalid_input');
  const origin=request.headers.get('origin');
  // Reject missing Origin as well as cross-origin requests for both POST routes.
  if(origin!==SITE_ORIGIN) throw new RelayError('origin_rejected');
}
function checkPending(pending,owner,origin,now,mode) {
  if(!plainObject(pending)||pending.owner!==owner||!opaque(pending.browserId)||!opaque(pending.state)||!opaque(pending.verifier)||
    !Number.isSafeInteger(pending.expiresAt)||pending.expiresAt<=now||pending.expiresAt>now+TTL||pending.redirectUri!==origin+'/oauth/callback'||
    (mode==='live'&&pending.mode!=='live')||
    (mode==='dummy'&&pending.mode!==undefined&&pending.mode!=='dummy')) throw new RelayError('state_unavailable');
  return pending;
}
function checkClaim(value,state,mode) {
  if(!plainObject(value)||value.state!==state||!['code','denied'].includes(value.outcome)||
    Object.keys(value).sort().join(',')!==(value.outcome==='code'?'code,outcome,state':'outcome,state')||
    value.outcome==='code'&&!(mode==='dummy'?dummyCode(value.code):oauthCode(value.code)&&!dummyCode(value.code))) throw new RelayError('unavailable');
  return value;
}
export function createSitesRelayClient({origin,key,authorize,loadPending,consumePending,invalidatePending,
  exchangeDummy,exchangeOAuthCode,mode='dummy',liveEnabled=false,fetcher=fetch,clock=Date.now,timeoutMs=10000}) {
  origin=relayOrigin(origin);keyBytes(key);
  // The Site's trusted server must opt in explicitly. Neither browser args
  // nor MCP tool input can select this mode.
  if(!['dummy','live'].includes(mode)||
    (mode==='live'&&(liveEnabled!==true||origin!==RELAY_PRODUCTION_ORIGIN))) throw new RelayError('setup_required');
  const exchange=mode==='dummy'?exchangeDummy:exchangeOAuthCode;
  if([authorize,loadPending,consumePending,invalidatePending,exchange,fetcher].some(fn=>typeof fn!=='function')||
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
    const pending=checkPending(await loadPending(request,owner),owner,origin,clock(),mode);
    return {pending,binding:await sha(`kaito-sites-binding|${owner}|${pending.browserId}|${pending.state}`)};
  }
  return {
    async prepare(request) {
      try {
        const {pending,binding}=await pendingFor(request,'prepare');
        if(!opaque(pending.csrf)||request.headers.get('x-oauth-csrf')!==pending.csrf) throw new RelayError('authentication_required');
        const result=await rpc('/prepare',{state:pending.state,binding},201);
        if(!plainObject(result)||Object.keys(result).sort().join(',')!=='mode,prepared'||result.prepared!==true||result.mode!==mode) throw new RelayError('unavailable');
        return safeJson({prepared:true,mode},201);
      } catch(error) { return safeError(error); }
    },
    async complete(request) {
      let pending,consumed=false;
      try {
        const loaded=await pendingFor(request,'complete');pending=loaded.pending;
        // A matching CSRF token is mandatory before any atomic state consumption.
        if(!opaque(pending.csrf)||request.headers.get('x-oauth-csrf')!==pending.csrf) throw new RelayError('authentication_required');
        // Atomic Site consumption precedes claim/exchange after POST + CSRF verification.
        if(await consumePending(pending)!==true) throw new RelayError('state_unavailable');consumed=true;
        const result=checkClaim(await rpc('/claim',{state:pending.state,binding:loaded.binding},200),pending.state,mode);
        if(result.outcome==='denied') {
          await invalidatePending(pending);consumed=false;
          return safeJson({state:'denied',mode,gateway_authenticated:false});
        }
        // Actual token exchange is supplied by the Site's existing confidential
        // OAuth client handler. Never forward the exchange result to the browser.
        await exchange({code:result.code,state:pending.state,code_verifier:pending.verifier,redirect_uri:pending.redirectUri});
        return safeJson({state:'checking',mode,gateway_authenticated:false});
      } catch(error) {
        if(consumed) { try { await invalidatePending(pending); } catch {} }
        return safeError(error);
      }
    },
  };
}
