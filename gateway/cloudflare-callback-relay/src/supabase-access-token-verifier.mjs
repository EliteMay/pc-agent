// UNPUBLISHED SITE SERVER ONLY. This delegates signature verification to the
// official Supabase Auth SDK instead of parsing or verifying JWTs ourselves.
// Configure the Supabase client for the existing, pinned project's Auth URL.
// Do not expose this module or access tokens to browser bundles or MCP results.
import { RelayError, plainObject } from './protocol.mjs';

// IMPORTANT: auth is the trusted Supabase Auth client from the existing Site.
// Supabase auth.getClaims(jwt) validates the specific JWT against the Auth
// server/JWKS. Never invoke getClaims() without the token argument: doing so
// checks the SDK's *current session*, not the OAuth response to be stored.
// This alone does not prove the client is configured for the right project;
// the verified-oauth-exchange policy separately requires the pinned issuer.
export function createSupabaseAccessTokenVerifier(auth) {
  if(!auth||typeof auth!=='object'||typeof auth.getClaims!=='function')
    throw new RelayError('setup_required');
  return async function verifySupabaseOAuthToken(accessToken) {
    if(typeof accessToken!=='string'||accessToken.length<1||
      accessToken.length>16384||/\s/u.test(accessToken))
      throw new RelayError('authentication_required');
    try {
      const result=await auth.getClaims(accessToken);
      if(!plainObject(result)||result.error!=null||
         !plainObject(result.data)||!plainObject(result.data.claims))
        throw new RelayError('authentication_required');
      // Do not return SDK token/header/signature or any raw response.
      return result.data.claims;
    } catch {
      // SDK errors can contain identity, transport or token material.
      throw new RelayError('authentication_required');
    }
  };
}
