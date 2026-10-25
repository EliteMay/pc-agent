// UNPUBLISHED SERVER-ONLY ADAPTER. No JWT verification is implemented here.
// verifyAccessToken MUST verify the signature, issuer, audience and expiry
// against the actual Supabase Auth issuer before it returns claims. Never
// decode unverified JWTs or accept caller-supplied JSON as verified claims.
import { ISSUER, RelayError, plainObject } from './protocol.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const bearer=x=>typeof x==='string'&&x.length>0&&x.length<=16384&&!/\s/u.test(x);
function validConfiguration({exchangeAuthorizationCode,verifyAccessToken,storeVerifiedTokens,ownerUserId,oauthClientId,clock}) {
  return typeof exchangeAuthorizationCode==='function' &&
    typeof verifyAccessToken==='function' &&
    typeof storeVerifiedTokens==='function' &&
    typeof ownerUserId==='string'&&UUID.test(ownerUserId) &&
    typeof oauthClientId==='string'&&CLIENT.test(oauthClientId) &&
    typeof clock==='function';
}

// Verifier output alone is NOT proof: the injected verification function must
// be backed by Supabase Auth / JWKS. This policy layer checks that *already
// verified* JWT claims belong to the preconfigured owner and OAuth client.
export function isExpectedVerifiedOAuthClaims(claims,{ownerUserId,oauthClientId,nowSec}={}) {
  if(!plainObject(claims)||!UUID.test(ownerUserId??'')||!CLIENT.test(oauthClientId??'')||
     !Number.isSafeInteger(nowSec)) return false;
  if(claims.sub!==ownerUserId||claims.client_id!==oauthClientId||
     claims.iss!==ISSUER||claims.aud!=='authenticated'||claims.role!=='authenticated'||
     claims.is_anonymous===true) return false;
  if(claims.user_id!==undefined&&claims.user_id!==claims.sub) return false;
  if(!Number.isSafeInteger(claims.iat)||claims.iat>nowSec+60||
     !Number.isSafeInteger(claims.exp)||claims.exp<=nowSec||
     claims.exp<=claims.iat) return false;
  if(claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>nowSec+60)) return false;
  return true;
}

export function createVerifiedOAuthExchange({
  exchangeAuthorizationCode,verifyAccessToken,storeVerifiedTokens,
  ownerUserId,oauthClientId,clock=Date.now,
}={}) {
  if(!validConfiguration({exchangeAuthorizationCode,verifyAccessToken,
    storeVerifiedTokens,ownerUserId,oauthClientId,clock}))
    throw new RelayError('setup_required');
  return async function exchangeVerifyThenStore(params) {
    // Relay already atomically consumed its pending and verified the callback
    // before reaching here. Never persist a token merely because exchange
    // returned 2xx. Only the post-verification callback can store it.
    const tokens=await exchangeAuthorizationCode(params);
    if(!plainObject(tokens)||!bearer(tokens.access_token)||
       !bearer(tokens.refresh_token)||tokens.token_type?.toLowerCase()!=='bearer')
      throw new RelayError('unavailable');
    const claims=await verifyAccessToken(tokens.access_token);
    if(!isExpectedVerifiedOAuthClaims(claims,{
      ownerUserId,oauthClientId,nowSec:Math.floor(clock()/1000),
    })) throw new RelayError('authentication_required');
    // The storage implementation MUST write only to an encrypted server-only
    // owner record, never to browser-visible state or MCP tool output.
    await storeVerifiedTokens({tokens,ownerUserId,oauthClientId});
    // Do not return the access token, refresh token, claims or user ID.
  };
}
