import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, value, digest, ORIGIN, SITE, ISSUER, epoch, signed } from './helpers.mjs';

test('registered dummy callback redirects without any query, cookie, code or state', async () => {
  const f = await fixture(); assert.equal((await f.prepare()).status, 201);
  const r = await f.callback(); assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), SITE + '/connect/complete');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('set-cookie'), null); assert.equal(await r.text(), '');
  assert.ok(!f.DB.dump().includes('dummy-code-canary')); assert.ok(!f.DB.dump().includes(f.state));
  const claimed = await f.claim(); assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), { outcome: 'code', code: 'dummy-code-canary', state: f.state });
  const rows = f.DB.rows('relay_pending'); assert.equal(rows[0].phase, 'consumed'); assert.equal(rows[0].envelope, null);
});

test('unregistered callbacks cannot create persistent records', async () => {
  const f = await fixture(); assert.equal((await f.callback()).status, 409);
  assert.equal(f.DB.rows('relay_pending').length, 0); assert.equal(f.DB.rows('relay_nonces').length, 0);
});

test('real-looking authorization codes and live mode fail closed', async () => {
  const f = await fixture(); await f.prepare();
  const r = await f.callback(`code=NOT_A_DUMMY_REAL_LOOKING_VALUE&state=${f.state}`);
  assert.equal(r.status, 400); assert.ok(!(await r.text()).includes('NOT_A_DUMMY'));
  assert.equal(f.DB.rows('relay_pending')[0].phase, 'prepared');
  const live = await fixture({ env: { RELAY_MODE: 'live' } }); assert.equal((await live.prepare()).status, 503);
});

test('wrong or missing signatures do not touch any D1 table', async () => {
  const f = await fixture();
  const r = f.request('/prepare', { state: f.state, binding: f.binding }); r.headers.set('x-relay-signature', value());
  assert.equal((await f.worker.fetch(r, f.env)).status, 401);
  assert.equal((await f.worker.fetch(new Request(ORIGIN + '/claim', { method: 'POST', body: '{}' }), f.env)).status, 401);
  assert.equal(f.DB.dump(), '[[],[],[]]');
});

test('signed request body, origin and path cannot be substituted', async () => {
  const f = await fixture();
  const good = f.request('/prepare', { state: f.state, binding: f.binding });
  for (const changed of [
    new Request(ORIGIN + '/prepare', { method: 'POST', headers: good.headers, body: JSON.stringify({ state: value(), binding: f.binding }) }),
    new Request(ORIGIN + '/claim', { method: 'POST', headers: good.headers, body: JSON.stringify({ state: f.state, binding: f.binding }) }),
    signed('/prepare', { state: f.state, binding: f.binding }, { origin: 'https://other.example.invalid' }),
  ]) assert.ok((await f.worker.fetch(changed, f.env)).status >= 400);
  assert.equal(f.DB.dump(), '[[],[],[]]');
});

test('old and future signed requests are rejected before storage', async () => {
  const f = await fixture();
  for (const now of [epoch - 31000, epoch + 31000]) assert.equal((await f.worker.fetch(signed('/prepare', { state: f.state, binding: f.binding }, { now }), f.env)).status, 401);
  assert.equal(f.DB.dump(), '[[],[],[]]');
});

test('persistent nonce rejects prepare replay without rearming state', async () => {
  const f = await fixture(); const r = f.request('/prepare', { state: f.state, binding: f.binding });
  assert.equal((await f.worker.fetch(r.clone(), f.env)).status, 201);
  assert.equal((await f.worker.fetch(r.clone(), f.env)).status, 409);
  assert.equal(f.DB.rows('relay_pending').length, 1);
});

test('two concurrent callbacks cannot overwrite the first result', async () => {
  const f = await fixture(); await f.prepare();
  const results = await Promise.all(['first','second'].map(x => f.callback(`code=dummy-code-${x}&state=${f.state}`)));
  assert.deepEqual(results.map(r => r.status).sort(), [303,409]);
  const winner = results.findIndex(r => r.status === 303);
  assert.equal((await (await f.claim()).json()).code, `dummy-code-${['first','second'][winner]}`);
});

test('concurrent claims yield exactly one code and erase the stored ciphertext', async () => {
  const f = await fixture(); await f.prepare(); await f.callback();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.claim()));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 11);
  assert.equal(f.DB.rows('relay_pending')[0].envelope, null);
  assert.equal((await f.prepare()).status, 409);
});

test('wrong owner/browser binding cannot consume another session result', async () => {
  const f = await fixture(); await f.prepare(); await f.callback();
  assert.equal((await f.claim({ body: { binding: digest('other-owner-browser') } })).status, 409);
  assert.equal((await f.claim()).status, 200);
});

test('claim before callback leaves the registration usable', async () => {
  const f = await fixture(); await f.prepare(); assert.equal((await f.claim()).status, 409);
  assert.equal((await f.callback()).status, 303); assert.equal((await f.claim()).status, 200);
});

test('expiry rejects claim immediately and scheduled cleanup deletes all expired rows', async () => {
  const f = await fixture(); await f.prepare(); await f.callback(); f.advance(300000);
  assert.equal((await f.claim()).status, 409);
  assert.equal((await f.callback()).status, 409);
  await f.worker.scheduled({}, f.env);
  assert.equal(f.DB.rows('relay_pending').length, 0);
  f.advance(100000); await f.worker.scheduled({}, f.env); assert.equal(f.DB.rows('relay_nonces').length, 0);
});

test('consent denial discards error_description and hands off only a finite denial', async () => {
  const f = await fixture(); await f.prepare();
  assert.equal((await f.callback(`error=access_denied&error_description=dummy-private-description&state=${f.state}&iss=${encodeURIComponent(ISSUER)}`)).status, 303);
  assert.deepEqual(await (await f.claim()).json(), { outcome: 'denied', state: f.state });
  assert.ok(!f.DB.dump().includes('dummy-private-description'));
});

test('duplicate, mixed and unexpected query fields or issuer are refused', async () => {
  const f = await fixture(); await f.prepare();
  for (const q of [
    `code=dummy-code-a&state=${f.state}&state=${f.state}`,
    `code=dummy-code-a&state=${f.state}&error=access_denied`,
    `code=dummy-code-a&state=${f.state}&redirect=https://attacker.example.invalid`,
    `code=dummy-code-a&state=${f.state}&iss=https://other.example.invalid`,
    'code=dummy-code-a&state=short',
  ]) assert.equal((await f.callback(q)).status, 400);
  assert.equal(f.DB.rows('relay_pending')[0].phase, 'prepared');
});

test('signed body is strictly bounded and schema-checked', async () => {
  const f = await fixture();
  for (const body of [{ state:f.state,binding:f.binding,extra:'x' }, 'x'.repeat(2048), '{not-json', {state:[],binding:f.binding}]) {
    assert.equal((await f.worker.fetch(f.request('/prepare', body), f.env)).status, 400);
  }
  assert.equal(f.DB.rows('relay_pending').length, 0);
});

test('method, endpoint and control-query restrictions never enable open redirects', async () => {
  const f = await fixture();
  for (const [url, method, status] of [
    [ORIGIN+'/claim','GET',405], [ORIGIN+'/oauth/callback','POST',405],
    [ORIGIN+'/prepare?state=dummy','POST',400], [ORIGIN+'/unknown','GET',404],
  ]) assert.equal((await f.worker.fetch(new Request(url,{method}),f.env)).status,status);
});

test('bounded prepare and claim rates survive new Worker instances', async () => {
  const f = await fixture();
  for(let i=0;i<5;i++) assert.equal((await f.prepare(value())).status,201);
  const { createWorker } = await import('../src/worker.mjs');
  const restarted = createWorker({ clock: f.clock });
  assert.equal((await restarted.fetch(f.request('/prepare',{state:value(),binding:f.binding}),f.env)).status,429);
  for(let i=0;i<20;i++) assert.equal((await f.claim()).status,409);
  assert.equal((await f.claim()).status,429);
});

test('ciphertext tampering fails without returning code and cannot be claimed twice', async () => {
  const f=await fixture(); assert.equal((await f.prepare()).status,201); assert.equal((await f.callback()).status,303);
  f.DB.sql.exec("UPDATE relay_pending SET envelope='{}'");
  const r=await f.claim(); assert.equal(r.status,503); assert.ok(!(await r.text()).includes('dummy-code-canary'));
  assert.equal(f.DB.rows('relay_pending')[0].envelope,null);
  assert.equal((await f.claim()).status,409);
});

test('D1 failures are sanitized and do not expose bound input or exceptions', async () => {
  const f=await fixture(); f.env.DB={prepare(){throw new Error('dummy-secret-code-and-state');},batch(){throw new Error('dummy-secret-code-and-state');}};
  const r=await f.prepare(); assert.equal(r.status,503);
  assert.ok(!(await r.text()).includes('dummy-secret-code-and-state'));
});

test('failure while clearing ciphertext rolls back the whole claim and nonce transaction', async () => {
  const f=await fixture(); assert.equal((await f.prepare()).status,201); assert.equal((await f.callback()).status,303);
  const before=f.DB.rows('relay_nonces').length;
  f.DB.sql.exec(`CREATE TRIGGER reject_clear BEFORE UPDATE OF envelope ON relay_pending
    WHEN NEW.envelope IS NULL BEGIN SELECT RAISE(ABORT,'dummy-code-private-canary'); END`);
  const request=f.request('/claim',{state:f.state,binding:f.binding});
  const rejected=await f.worker.fetch(request.clone(),f.env);
  assert.equal(rejected.status,503); assert.doesNotMatch(await rejected.text(),/dummy-code-private-canary/);
  assert.equal(f.DB.rows('relay_pending')[0].phase,'ready');
  assert.notEqual(f.DB.rows('relay_pending')[0].envelope,null);
  assert.equal(f.DB.rows('relay_nonces').length,before);
  f.DB.sql.exec('DROP TRIGGER reject_clear');
  const recovered=await f.worker.fetch(request.clone(),f.env);
  assert.equal(recovered.status,200); assert.equal((await recovered.json()).code,'dummy-code-canary');
  assert.equal(f.DB.rows('relay_pending')[0].envelope,null);
});
