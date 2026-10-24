import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relayOrigin, RELAY_PRODUCTION_ORIGIN, RELAY_TEST_ORIGIN, signedRequest,
} from '../src/protocol.mjs';
import { createSitesRelayClient } from '../src/sites-client.mjs';
import { fixture, KEY, value } from './helpers.mjs';

test('accepts only the exact owned Worker and exact offline-test relay hosts',()=>{
  assert.equal(relayOrigin(RELAY_PRODUCTION_ORIGIN), RELAY_PRODUCTION_ORIGIN);
  assert.equal(relayOrigin(RELAY_PRODUCTION_ORIGIN+'/'), RELAY_PRODUCTION_ORIGIN);
  assert.equal(relayOrigin(RELAY_TEST_ORIGIN), RELAY_TEST_ORIGIN);
  assert.equal(relayOrigin(RELAY_TEST_ORIGIN+'/'), RELAY_TEST_ORIGIN);
});

test('does not allow a different workers.dev tenant, deceptive host or arbitrary test domain',()=>{
  for (const origin of [
    'https://attacker.workers.dev',
    'https://kaito-oauth-callback-relay-dummy.other-account.workers.dev',
    'https://relay.example.invalid.attacker.workers.dev',
    'https://other.example.invalid',
    RELAY_PRODUCTION_ORIGIN+'.attacker.example.invalid',
    'http://kaito-oauth-callback-relay-dummy.k12m45k.workers.dev',
    RELAY_PRODUCTION_ORIGIN+':443',
    RELAY_PRODUCTION_ORIGIN+'/prepare',
    RELAY_PRODUCTION_ORIGIN+'?state=dummy',
    RELAY_PRODUCTION_ORIGIN+'/#fragment',
    'https://user:password@kaito-oauth-callback-relay-dummy.k12m45k.workers.dev',
    ' '+RELAY_PRODUCTION_ORIGIN,
    null, 5, {},
  ]) {
    assert.throws(()=>relayOrigin(origin),e=>e.code==='setup_required');
  }
});

test('Site cannot sign requests or initialize adapter with a different Worker host',async()=>{
  const bad='https://attacker.workers.dev';
  await assert.rejects(
    signedRequest({origin:bad,key:KEY,path:'/claim',body:{state:value(),binding:value()}}),
    e=>e.code==='setup_required');
  assert.throws(()=>createSitesRelayClient({
    origin:bad,key:KEY,exchangeDummy:async()=>{},
    authorize:async()=>'',loadPending:async()=>null,consumePending:async()=>false,
    invalidatePending:async()=>{},
  }),e=>e.code==='setup_required');
});

test('live OAuth rejects the offline-only test origin even with both opt-ins enabled',async()=>{
  const f=await fixture({env:{
    RELAY_MODE:'live',
    RELAY_LIVE_ENABLED:'true',
    RELAY_ORIGIN:RELAY_TEST_ORIGIN,
  }});
  const result=await f.prepare();
  assert.equal(result.status,503);
  assert.deepEqual(await result.json(),{error:'setup_required'});
  assert.equal(f.DB.dump(),'[[],[],[]]');

  assert.throws(()=>createSitesRelayClient({
    origin:RELAY_TEST_ORIGIN,key:KEY,
    mode:'live',liveEnabled:true,exchangeOAuthCode:async()=>{},
    authorize:async()=>'',loadPending:async()=>null,consumePending:async()=>false,
    invalidatePending:async()=>{},
  }),e=>e.code==='setup_required');
});

test('Worker rejects callback and signed requests if RELAY_ORIGIN is not pinned',async()=>{
  const f=await fixture({env:{RELAY_ORIGIN:'https://attacker.workers.dev'}});
  const result=await f.prepare();
  assert.equal(result.status,503);
  assert.deepEqual(await result.json(),{error:'setup_required'});
  assert.equal(f.DB.dump(),'[[],[],[]]');
});
