// Reference for the Site's REAL Supabase OAuth (Authorization Code + PKCE S256). Web-standard APIs
// only (crypto.subtle, URL, Request, fetch) so it can be ported into the Sites server as is.
// The module never stores or logs anything: persistence (pending state, encrypted tokens) belongs
// to the Site, which must keep the verifier and tokens server-side only.
export class OAuthError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const ISSUER = 'https://vtnwbgejlaqpnwmlzbjy.supabase.co/auth/v1';
export const AUTHORIZE_ENDPOINT = ISSUER + '/oauth/authorize';
export const TOKEN_ENDPOINT = ISSUER + '/oauth/token';
export const SITE_ORIGIN = 'https://kaito-pc-agent-web-bridge.kaito2526.chatgpt.site';
export const CALLBACK_PATH = '/oauth/callback';
export const REDIRECT_URI = SITE_ORIGIN + CALLBACK_PATH;

// RFC 6749 4.1.2.1 authorization errors; only the finite code is ever acted on.
const AUTH_ERRORS = new Set(['invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_response_type',
  'invalid_scope', 'server_error', 'temporarily_unavailable']);
const CODE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[\w.:-]{1,200}$/;
const REFRESH_TOKEN = /^[\w.~+/=-]{1,1024}$/;
export const isOpaque = (value) => typeof value === 'string' && OPAQUE.test(value);

export function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function createPkce(verifier = randomToken()) {
  if (!isOpaque(verifier)) throw new OAuthError('invalid_input');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

export function buildAuthorizeUrl({ clientId, redirectUri = REDIRECT_URI, state, challenge, scope }) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId) || redirectUri !== REDIRECT_URI ||
    !isOpaque(state) || !isOpaque(challenge) || (scope !== undefined && !/^[a-z_ ]{1,100}$/.test(scope))) throw new OAuthError('invalid_input');
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}

function sameSecret(a, b) { // constant-time comparison of two opaque tokens
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Validate the browser redirect. The URL carries the code, so the Site must consume it on this very
// request and never log, render, or store it. Returns {outcome:'code', code} or {outcome:'denied'}.
export function parseCallback(href, { state }) {
  let url;
  try { url = new URL(href); } catch { throw new OAuthError('invalid_callback'); }
  if (url.origin !== SITE_ORIGIN || url.pathname !== CALLBACK_PATH || url.hash || !isOpaque(state)) throw new OAuthError('invalid_callback');
  const query = url.searchParams;
  for (const key of query.keys()) {
    if (!['code', 'state', 'iss', 'error', 'error_description', 'error_uri'].includes(key) || query.getAll(key).length !== 1) throw new OAuthError('invalid_callback');
  }
  // The state is bound to the browser session and owner by the caller; here it must match exactly.
  if (!sameSecret(query.get('state'), state)) throw new OAuthError('state_mismatch');
  if (query.has('iss') && query.get('iss') !== ISSUER) throw new OAuthError('issuer_mismatch');
  if (query.has('code') === query.has('error')) throw new OAuthError('invalid_callback');
  if (query.has('error')) {
    if (!AUTH_ERRORS.has(query.get('error'))) throw new OAuthError('invalid_callback');
    return { outcome: 'denied' }; // description / uri are discarded on purpose
  }
  const code = query.get('code');
  if (!CODE_PATTERN.test(code)) throw new OAuthError('invalid_callback');
  return { outcome: 'code', code };
}

function tokenRequest(fields, clientId, clientSecret) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = { ...fields };
  if (clientSecret !== undefined) {
    if (typeof clientSecret !== 'string' || !clientSecret) throw new OAuthError('invalid_input');
    headers.authorization = 'Basic ' + btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`); // client_secret_basic
  } else body.client_id = clientId;
  return new Request(TOKEN_ENDPOINT, { method: 'POST', headers, body: new URLSearchParams(body).toString(), credentials: 'omit', redirect: 'error' });
}
export function buildTokenRequest({ code, verifier, clientId, clientSecret, redirectUri = REDIRECT_URI }) {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code) || !isOpaque(verifier) || redirectUri !== REDIRECT_URI ||
    typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new OAuthError('invalid_input');
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, clientId, clientSecret);
}
export function buildRefreshRequest({ refreshToken, clientId, clientSecret }) {
  if (typeof refreshToken !== 'string' || !REFRESH_TOKEN.test(refreshToken) ||
    typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new OAuthError('invalid_input');
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, clientId, clientSecret);
}

// Keep only what the Site needs. Unknown fields (e.g. a user object) are dropped, never retained.
export function parseTokenResponse(value, now = Date.now()) {
  const jwtLike = /^[\w-]+\.[\w-]+\.[\w-]+$/;
  const bad = value === null || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.access_token !== 'string' || value.access_token.length > 8192 || !jwtLike.test(value.access_token) ||
    typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' ||
    !Number.isInteger(value.expires_in) || value.expires_in < 60 || value.expires_in > 86400 ||
    (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !REFRESH_TOKEN.test(value.refresh_token))) ||
    (value.scope !== undefined && (typeof value.scope !== 'string' || value.scope.length > 200));
  if (bad) throw new OAuthError('invalid_token_response');
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: now + value.expires_in * 1000,
    scope: value.scope,
  };
}
