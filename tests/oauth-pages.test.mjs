import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const login = load('../web/oauth/login/index.html');
const consent = load('../web/oauth/consent/index.html');
const home = load('../web/index.html');

test('GitHub Pages has real static entrypoints', () => {
  for (const relative of ['../web/index.html', '../web/oauth/login/index.html', '../web/oauth/consent/index.html']) {
    assert.ok(existsSync(new URL(relative, import.meta.url)), relative);
  }
  for (const html of [home, login, consent]) assert.match(html, /<html lang="ja">/);
});

test('OAuth authentication flow is preserved', () => {
  assert.match(login, /supabase\.auth\.signInWithPassword/);
  assert.match(login, /sessionStorage\.getItem\("oauth_return"\)/);
  assert.match(consent, /authorization_id/);
  assert.match(consent, /sessionStorage\.setItem\("oauth_return",location\.href\)/);
  assert.match(consent, /\.\.\/login\//);
  for (const op of ['getAuthorizationDetails', 'approveAuthorization', 'denyAuthorization']) {
    assert.ok(consent.includes(op), op);
  }
  assert.match(consent, /location\.assign\(data\.redirect_url\)/);
});

test('Both pages use the same Supabase project and only a publishable browser key', () => {
  const project = 'https://vtnwbgejlaqpnwmlzbjy.supabase.co';
  assert.ok(login.includes(project) && consent.includes(project));
  const key = /sb_publishable_[A-Za-z0-9_-]+/g;
  const loginKeys = login.match(key);
  const consentKeys = consent.match(key);
  assert.equal(loginKeys?.length, 1);
  assert.deepEqual(loginKeys, consentKeys);
  for (const html of [home, login, consent]) {
    assert.doesNotMatch(html, /service_role|sb_secret_|BEGIN PRIVATE KEY|password\s*[:=]\s*["'][^"']+["']/i);
    assert.doesNotMatch(html, /site-min\/oauth\//);
  }
});

test('Approval stays explicitly disabled until authorization details load', () => {
  assert.match(consent, /id="allow" disabled/);
  assert.match(consent, /id="deny" disabled/);
  assert.match(consent, /allow\.disabled=false/);
  assert.match(consent, /deny\.disabled=false/);
  assert.match(consent, /details\.textContent/);
});
