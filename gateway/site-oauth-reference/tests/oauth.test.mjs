import test from 'node:test';
import assert from 'node:assert/strict';
import { createPkce, buildAuthorizeUrl, parseCallback, buildTokenRequest, buildRefreshRequest, parseTokenResponse,
  randomToken, isOpaque, OAuthError, ISSUER, AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT, REDIRECT_URI, SITE_ORIGIN } from '../oauth.mjs';

const state = randomToken();
const jwt = 'aaa.bbb.ccc';
const callback = (query) => `${SITE_ORIGIN}/oauth/callback?${new URLSearchParams(query)}`;
const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof OAuthError && e.code === code);

test('PKCE S256 matches the RFC 7636 appendix B vector, and random verifiers are 43-char opaque tokens', async () => {
  // The RFC vector's verifier is 43 URL-safe characters, as ours are.
  const { challenge } = await createPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = await createPkce(); const b = await createPkce();
  assert.ok(isOpaque(a.verifier) && isOpaque(a.challenge));
  assert.notEqual(a.verifier, b.verifier);
  await assert.rejects(createPkce('short'), (e) => e.code === 'invalid_input');
});

test('authorize URL: fixed issuer endpoint, code flow, S256, exact redirect, no secret or verifier', async () => {
  const { verifier, challenge } = await createPkce();
  const url = new URL(buildAuthorizeUrl({ clientId: 'client-123', state, challenge, scope: 'openid email' }));
  assert.equal(url.origin + url.pathname, AUTHORIZE_ENDPOINT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('state'), state);
  assert.ok(!url.toString().includes(verifier), 'the verifier never appears in the browser URL');
  rejects(() => buildAuthorizeUrl({ clientId: 'c', state, challenge, redirectUri: 'https://evil.example/cb' }), 'invalid_input');
  rejects(() => buildAuthorizeUrl({ clientId: 'c', state: 'short', challenge }), 'invalid_input');
  rejects(() => buildAuthorizeUrl({ clientId: 'bad id!', state, challenge }), 'invalid_input');
});

test('callback accepts only the exact route, one state, and returns the code', () => {
  assert.deepEqual(parseCallback(callback({ code: 'abc.DEF-123_~', state }), { state }), { outcome: 'code', code: 'abc.DEF-123_~' });
  assert.deepEqual(parseCallback(callback({ code: 'abc', state, iss: ISSUER }), { state }), { outcome: 'code', code: 'abc' });
});

test('callback rejects wrong state, missing state, issuer mismatch, wrong origin or path, duplicates, extras and fragments', () => {
  const other = randomToken();
  rejects(() => parseCallback(callback({ code: 'abc', state: other }), { state }), 'state_mismatch');
  rejects(() => parseCallback(callback({ code: 'abc' }), { state }), 'state_mismatch');
  rejects(() => parseCallback(callback({ code: 'abc', state, iss: 'https://evil.example/auth/v1' }), { state }), 'issuer_mismatch');
  rejects(() => parseCallback(`https://evil.example/oauth/callback?code=abc&state=${state}`, { state }), 'invalid_callback');
  rejects(() => parseCallback(`${SITE_ORIGIN}/oauth/other?code=abc&state=${state}`, { state }), 'invalid_callback');
  rejects(() => parseCallback(`${SITE_ORIGIN}/oauth/callback?code=a&code=b&state=${state}`, { state }), 'invalid_callback');
  rejects(() => parseCallback(callback({ code: 'abc', state, extra: '1' }), { state }), 'invalid_callback');
  rejects(() => parseCallback(callback({ code: 'abc', state }) + '#frag', { state }), 'invalid_callback');
  rejects(() => parseCallback(callback({ code: 'a'.repeat(513), state }), { state }), 'invalid_callback');
  rejects(() => parseCallback(callback({ code: 'a b', state }), { state }), 'invalid_callback');
  rejects(() => parseCallback(callback({ state }), { state }), 'invalid_callback');
  rejects(() => parseCallback(callback({ code: 'abc', error: 'access_denied', state }), { state }), 'invalid_callback');
  rejects(() => parseCallback('not a url', { state }), 'invalid_callback');
  rejects(() => parseCallback(callback({ code: 'abc', state }), { state: 'short' }), 'invalid_callback');
});

test('provider errors become a finite denial and the description is discarded', () => {
  const result = parseCallback(callback({ error: 'access_denied', error_description: 'secret-ish text', state }), { state });
  assert.deepEqual(result, { outcome: 'denied' });
  rejects(() => parseCallback(callback({ error: 'made_up', state }), { state }), 'invalid_callback');
});

test('token request: fixed endpoint, form body, verifier only in the body, secret only in the Basic header', async () => {
  const { verifier } = await createPkce();
  const request = buildTokenRequest({ code: 'abc', verifier, clientId: 'client-123', clientSecret: 's3cr3t/+=' });
  assert.equal(request.url, TOKEN_ENDPOINT);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  const body = new URLSearchParams(await request.text());
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'abc');
  assert.equal(body.get('code_verifier'), verifier);
  assert.equal(body.get('redirect_uri'), REDIRECT_URI);
  assert.ok(!body.has('client_secret') && !body.has('client_id'));
  assert.equal(request.headers.get('authorization'), 'Basic ' + btoa(`client-123:${encodeURIComponent('s3cr3t/+=')}`));
  // Public client: no secret, client_id in the body.
  const publicRequest = buildTokenRequest({ code: 'abc', verifier, clientId: 'client-123' });
  assert.equal(new URLSearchParams(await publicRequest.text()).get('client_id'), 'client-123');
  assert.equal(publicRequest.headers.get('authorization'), null);
  rejects(() => buildTokenRequest({ code: 'abc', verifier: 'short', clientId: 'client-123' }), 'invalid_input');
  rejects(() => buildTokenRequest({ code: 'a b', verifier, clientId: 'client-123' }), 'invalid_input');
  rejects(() => buildTokenRequest({ code: 'abc', verifier, clientId: 'client-123', redirectUri: 'https://evil.example/cb' }), 'invalid_input');
  rejects(() => buildTokenRequest({ code: 'abc', verifier, clientId: 'client-123', clientSecret: '' }), 'invalid_input');
});

test('refresh request carries only the refresh grant', async () => {
  const request = buildRefreshRequest({ refreshToken: 'r-123.abc', clientId: 'client-123', clientSecret: 'x' });
  assert.equal(request.url, TOKEN_ENDPOINT);
  const body = new URLSearchParams(await request.text());
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'r-123.abc');
  rejects(() => buildRefreshRequest({ refreshToken: 'bad token', clientId: 'client-123' }), 'invalid_input');
});

test('token response: validated, bounded, extras dropped', () => {
  const ok = parseTokenResponse({ access_token: jwt, token_type: 'bearer', expires_in: 3600, refresh_token: 'r.1', scope: 'openid', user: { email: 'x@example.com' } }, 1000);
  assert.deepEqual(ok, { accessToken: jwt, refreshToken: 'r.1', expiresAt: 1000 + 3600000, scope: 'openid' });
  assert.ok(!('user' in ok));
  assert.equal(parseTokenResponse({ access_token: jwt, token_type: 'Bearer', expires_in: 60 }).refreshToken, undefined);
  for (const bad of [null, [], {}, { access_token: 'not-a-jwt', token_type: 'bearer', expires_in: 3600 },
    { access_token: jwt, token_type: 'mac', expires_in: 3600 }, { access_token: jwt, token_type: 'bearer', expires_in: 59 },
    { access_token: jwt, token_type: 'bearer', expires_in: 86401 }, { access_token: jwt, token_type: 'bearer', expires_in: '3600' },
    { access_token: `${'a'.repeat(8190)}.b.c`, token_type: 'bearer', expires_in: 3600 },
    { access_token: jwt, token_type: 'bearer', expires_in: 3600, refresh_token: 'bad token' }]) {
    rejects(() => parseTokenResponse(bad), 'invalid_token_response');
  }
});

test('errors never echo input values', () => {
  try { parseCallback(callback({ code: 'TOP-SECRET-CODE ', state }), { state }); assert.fail('should throw'); }
  catch (e) { assert.ok(!String(e.message).includes('TOP-SECRET-CODE')); assert.ok(!String(e.stack).includes('TOP-SECRET-CODE')); }
});
