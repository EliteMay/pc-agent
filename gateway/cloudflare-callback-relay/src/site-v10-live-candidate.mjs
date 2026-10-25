// UNPUBLISHED SOURCE CANDIDATE ONLY. Not the hosted Sites saved-v10 source.
// Bind these server-side callbacks to the existing trusted Sites session,
// encrypted pending store and confidential PKCE token-exchange implementation.
// Do not expose this module, signing key, verifier or tokens to client bundles.
import { createSitesRelayClient } from './sites-client.mjs';
import {
  RelayError, SITE_ORIGIN, RELAY_PRODUCTION_ORIGIN, ISSUER, TTL,
  opaque, sha, safeHeaders, safeError,
} from './protocol.mjs';

export const LIVE_CALLBACK_URL=RELAY_PRODUCTION_ORIGIN+'/oauth/callback';
const AUTH_URL=ISSUER+'/oauth/authorize';

// The URL is built by the existing trusted Sites OAuth function, never from
// request JSON. Require the exact state, actual S256 verifier, registered
// server-side client ID and Worker callback before contacting the Relay.
export async function checkedAuthorizationUrl(value,pending,clientId) {
  try {
    if(typeof value!=='string'||value.length>4096||
      typeof clientId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(clientId)||
      !pending||pending.mode!=='live'||!opaque(pending.state)||!opaque(pending.verifier)||
      pending.redirectUri!==LIVE_CALLBACK_URL) throw 0;
    const url=new URL(value);
    if(url.origin!==ISSUER.replace('/auth/v1','')||
      url.pathname!=='/auth/v1/oauth/authorize'||url.hash||
      url.username||url.password||url.port) throw 0;
    const params=url.searchParams;
    for(const key of ['response_type','client_id','state','redirect_uri','code_challenge','code_challenge_method']) {
      if(params.getAll(key).length!==1) throw 0;
    }
    if(params.get('response_type')!=='code'||params.get('client_id')!==clientId||
      params.get('state')!==pending.state||params.get('redirect_uri')!==LIVE_CALLBACK_URL||
      params.get('code_challenge_method')!=='S256'||
      params.get('code_challenge')!==await sha(pending.verifier)) throw 0;
    return url.href;
  } catch { throw new RelayError('setup_required'); }
}

function checkGetComplete(request) {
  const url=new URL(request.url);
  if(url.origin!==SITE_ORIGIN) throw new RelayError('origin_rejected');
  if(url.pathname!=='/connect/complete') throw new RelayError('not_found');
  if(request.method!=='GET') throw new RelayError('method_not_allowed');
  if(url.search||url.hash) throw new RelayError('invalid_input');
}

// In saved v10, existing Site code must first persist an encrypted pending
// record with mode:'live', then invoke start. No synthetic dummy callbacks.
export function createSitesV10LiveCandidate({
  enabled=false,origin=RELAY_PRODUCTION_ORIGIN,key,
  authorize,loadPending,consumePending,invalidatePending,
  exchangeAndStoreExistingOAuth,buildExistingAuthorizationUrl,
  oauthClientId,fetcher,clock,timeoutMs,
}={}) {
  // Disabled by default. Do not even instantiate an OAuth transport.
  if(enabled!==true) {
    const unavailable=async()=>safeError(new RelayError('setup_required'));
    return { start:unavailable, getComplete:unavailable, postComplete:unavailable };
  }
  if(typeof buildExistingAuthorizationUrl!=='function'||
    typeof exchangeAndStoreExistingOAuth!=='function') throw new RelayError('setup_required');
  const relay=createSitesRelayClient({
    origin,key,mode:'live',liveEnabled:true,authorize,loadPending,
    consumePending,invalidatePending,exchangeOAuthCode:exchangeAndStoreExistingOAuth,
    ...(fetcher?{fetcher}:{}),...(clock?{clock}:{}),
    ...(timeoutMs?{timeoutMs}:{}),
  });
  return {
    async start(request) {
      try {
        // Relay.prepare also checks trusted owner, HttpOnly session, Origin,
        // CSRF, TTL and mode. Read only after validating the route.
        const url=new URL(request.url);
        if(url.origin!==SITE_ORIGIN) throw new RelayError('origin_rejected');
        if(url.pathname!=='/oauth/start') throw new RelayError('not_found');
        if(request.method!=='POST') throw new RelayError('method_not_allowed');
        if(url.search||url.hash) throw new RelayError('invalid_input');
        if(request.headers.get('origin')!==SITE_ORIGIN) throw new RelayError('origin_rejected');

        const owner=await authorize(request);
        if(typeof owner!=='string'||!owner||owner.length>200) throw new RelayError('authentication_required');
        const pending=await loadPending(request,owner);
        const now=(typeof clock==='function'?clock:Date.now)();
        // Before invoking even the Site's trusted authorize URL builder, confirm
        // the persisted session-bound record is for THIS owner and live flow.
        // The relay separately revalidates this immediately before prepare.
        if(!pending||pending.owner!==owner||pending.mode!=='live'||
          !opaque(pending.browserId)||!opaque(pending.csrf)||
          request.headers.get('x-oauth-csrf')!==pending.csrf||
          !opaque(pending.state)||!opaque(pending.verifier)||
          !Number.isSafeInteger(pending.expiresAt)||pending.expiresAt<=now||pending.expiresAt>now+TTL||
          pending.redirectUri!==LIVE_CALLBACK_URL) throw new RelayError('authentication_required');
        const authLocation=await checkedAuthorizationUrl(
          await buildExistingAuthorizationUrl(request,pending),pending,oauthClientId);
        // Do not start browser OAuth if Worker registration/signing fails.
        const prepared=await relay.prepare(request);
        if(prepared.status!==201) return prepared;
        return new Response(null,{status:303,headers:{...safeHeaders,location:authLocation}});
      } catch(error) { return safeError(error); }
    },
    async getComplete(request) {
      try {
        // GET is display/navigation only. Do not consume pending, claim,
        // issue new OAuth codes or call the token endpoint.
        checkGetComplete(request);
        return new Response(null,{status:303,headers:{...safeHeaders,location:SITE_ORIGIN+'/'}});
      } catch(error) { return safeError(error); }
    },
    // The existing v10 UI must handle mode='live' + state='checking' without
    // presenting it as authenticated before a separate Gateway verification.
    postComplete:request=>relay.complete(request),
  };
}
