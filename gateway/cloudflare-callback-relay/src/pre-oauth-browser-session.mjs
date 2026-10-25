// UNPUBLISHED, SITE-SERVER-ONLY PRE-OAUTH SESSION ADAPTER.
// This authenticates possession of a short-lived bootstrap BROWSER SESSION,
// NOT possession of the user's account and NOT a ChatGPT MCP identity.
// Use only with a server-verified, HttpOnly-cookie-backed session reader.
// OAuth *owner authorization* happens later, only when a verified Supabase
// token's sub AND client_id match server-configured owner/client identities.
import { RelayError, TTL, opaque, plainObject } from './protocol.mjs';

function validBootstrap(record,now) {
  return plainObject(record) &&
    opaque(record.scopeId) && opaque(record.sessionNonce) &&
    opaque(record.browserId) &&
    Number.isSafeInteger(record.expiresAt) &&
    record.expiresAt>now && record.expiresAt<=now+TTL;
}

/**
 * Provide readVerifiedBrowserSession from the existing Site's server-side
 * signed/encrypted-cookie verification and server-side session storage.
 * It must NOT simply read request headers, a browser-sent user ID, an email,
 * JSON-RPC tool arguments, a bare client-supplied cookie value or a public
 * session object. It MUST reject invalid/revoked/unrecognized sessions.
 *
 * scopeId: random, session-unique **pre-auth storage scope**, not owner UUID.
 * sessionNonce: server-issued random 43-char **session binding**, not user ID.
 * browserId: server-issued browser binding, not user ID.
 * expiresAt: short-lived session timestamp.
 *
 * During OAuth pending creation, pending.owner MUST equal scopeId and
 * pending.principalId MUST equal sessionNonce; both encrypted and bound to
 * the verified browser session. This is compatible with the existing
 * createSitesV10LiveCandidate callback contract but DOES NOT prove that
 * the current Site exposes such a verified session. Until the actual Sites
 * saved-v12 implementation is inspected, leave the live feature flag OFF.
 */
export function createPreOAuthBrowserBindings({readVerifiedBrowserSession,clock=Date.now}={}) {
  if(typeof readVerifiedBrowserSession!=='function'||typeof clock!=='function')
    throw new RelayError('setup_required');

  async function read(request) {
    try {
      const record=await readVerifiedBrowserSession(request);
      const now=clock();
      if(!Number.isSafeInteger(now)||!validBootstrap(record,now))
        throw new RelayError('authentication_required');
      return record;
    } catch {
      // Never expose cookie/session information or verification details.
      throw new RelayError('authentication_required');
    }
  }

  return Object.freeze({
    // Existing relay client uses the returned string to scope pending.
    // It MUST NOT be treated as evidence of owner account identity.
    authorize:async request=>(await read(request)).scopeId,
    // Re-read independently: invalidation / cookie rotation between reads
    // must fail closed in the existing sessionBoundPending comparison.
    verifyIdentityBinding:async request=>{
      const s=await read(request);
      return {
        owner:s.scopeId,
        principalId:s.sessionNonce,
        browserId:s.browserId,
      };
    },
  });
}
