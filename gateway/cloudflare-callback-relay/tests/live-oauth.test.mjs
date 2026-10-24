import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, value, SITE, ORIGIN, KEY } from './helpers.mjs';
import { createSitesRelayClient } from '../src/sites-client.mjs';

const liveEnv = { RELAY_MODE:'live', RELAY_LIVE_ENABLED:'true' };
const liveCanary = 'offline-oauth-code-canary';

test('live mode requires two explicit Worker settings and valid keys before D1 writes', async()=>{
  for(const env of [
    {RELAY_MODE:'live'},
    {RELAY_MODE:'live',RELAY_LIVE_ENABLED:'false'},
    {RELAY_MODE:'live',RELAY_LIVE_ENABLED:true},
    {RELAY_MODE:'invalid',RELAY_LIVE_ENABLED:'true'},
  ]){
    const f=await fixture({env});
    assert.equal((await f.prepare()).status,503);
    assert.equal(f.DB.dump(),'[[],[],[]]');
  }
});

test('offline live callback is encrypted and claimed only once, without redirect leakage',async()=>{
  const f=await fixture({env:liveEnv});
  assert.equal((await f.prepare()).status,201);
  const reply=await f.callback(`code=${liveCanary}&state=${f.state}`);
  assert.equal(reply.status,303);
  assert.equal(reply.headers.get('location'),SITE+'/connect/complete');
  assert.equal(new URL(reply.headers.get('location')).search,'');
  assert.equal(reply.headers.get('set-cookie'),null);
  assert.equal(await reply.text(),'');
  assert.ok(!f.DB.dump().includes(liveCanary));
  assert.ok(!f.DB.dump().includes(f.state));
  const consumed=await f.claim();
  assert.equal(consumed.status,200);
  assert.deepEqual(await consumed.json(),{outcome:'code',code:liveCanary,state:f.state});
  assert.equal(f.DB.rows('relay_pending')[0].envelope,null);
  assert.equal((await f.claim()).status,409);
});

test('live cannot consume or mutate dummy pending registrations and vice versa',async()=>{
  const f=await fixture();
  assert.equal((await f.prepare()).status,201);
  f.env.RELAY_MODE='live';f.env.RELAY_LIVE_ENABLED='true';
  assert.equal((await f.callback(`code=${liveCanary}&state=${f.state}`)).status,409);
  assert.equal((await f.claim()).status,409);
  assert.equal(f.DB.rows('relay_pending')[0].phase,'prepared');
  assert.equal((await f.prepare()).status,201);
  assert.equal(f.DB.rows('relay_pending').length,2);
  assert.equal((await f.callback(`code=${liveCanary}&state=${f.state}`)).status,303);
  f.env.RELAY_MODE='dummy';
  assert.equal((await f.claim()).status,409);
  assert.equal((await f.callback()).status,303);
  assert.equal((await f.claim()).status,200);
  f.env.RELAY_MODE='live';
  assert.deepEqual(await (await f.claim()).json(),{outcome:'code',code:liveCanary,state:f.state});
});

test('live rejects dummy callback code and replays without modifying pending state',async()=>{
  const f=await fixture({env:liveEnv});await f.prepare();
  assert.equal((await f.callback()).status,400);
  assert.equal(f.DB.rows('relay_pending')[0].phase,'prepared');
  assert.equal((await f.callback(`code=${liveCanary}&state=${f.state}&code=duplicate`)).status,400);
  assert.equal((await f.callback(`code=${liveCanary}&state=${f.state}`)).status,303);
  assert.equal((await f.callback(`code=${liveCanary}&state=${f.state}`)).status,409);
  assert.equal((await f.claim()).status,200);
  assert.equal((await f.claim()).status,409);
});

test('live Site adapter requires explicit mode switch and an exchange callback',()=>{
  const common={origin:ORIGIN,key:KEY,authorize:async()=>true,
    loadPending:async()=>null,consumePending:async()=>false,
    invalidatePending:async()=>{},fetcher:async()=>Response.json({})};
  assert.throws(()=>createSitesRelayClient({...common,mode:'live',exchangeOAuthCode:async()=>{}}),e=>e.code==='setup_required');
  assert.throws(()=>createSitesRelayClient({...common,mode:'live',liveEnabled:true}),e=>e.code==='setup_required');
  assert.throws(()=>createSitesRelayClient({...common,mode:'unsupported',exchangeDummy:async()=>{}}),e=>e.code==='setup_required');
});

test('live Site adapter performs PKCE-bound exchange only through authenticated POST',async()=>{
  // Fully offline mock Site controller: no OAuth token endpoint or Worker network.
  const { DatabaseSync }=await import('node:sqlite');
  const { digest, epoch, signed }=await import('./helpers.mjs');
  const { createWorker }=await import('../src/worker.mjs');
  const { database }=await import('./helpers.mjs');
  const DB=database(),worker=createWorker({clock:()=>epoch});
  const env={DB,...liveEnv,RELAY_ORIGIN:ORIGIN,
    RELAY_SIGNING_KEY:KEY,RELAY_STORAGE_KEY:(await import('./helpers.mjs')).STORAGE_KEY};
  const state=value(),browser=value(),csrf=value(),verifier=value();
  let pending={owner:'offline-owner',browserId:browser,state,csrf,verifier,
    expiresAt:epoch+300000,redirectUri:ORIGIN+'/oauth/callback'};
  const exchanges=[];
  const client=createSitesRelayClient({
    origin:ORIGIN,key:KEY,mode:'live',liveEnabled:true,clock:()=>epoch,
    authorize:async()=>pending?.owner??null,loadPending:async()=>pending,
    consumePending:async()=>{if(!pending)return false;pending=null;return true;},
    invalidatePending:async()=>{pending=null;},
    exchangeOAuthCode:async input=>{exchanges.push(input);return {access_token:'offline-private-access-token'};},
    fetcher:request=>worker.fetch(request,env),
  });
  const request=(method='POST',headers={})=>new Request(SITE+'/connect/complete',
    {method,headers:{origin:SITE,'x-oauth-csrf':csrf,...headers}});
  const prepareReq=new Request(SITE+'/oauth/start',{method:'POST',headers:{origin:SITE,'x-oauth-csrf':csrf}});
  assert.equal((await client.prepare(prepareReq)).status,201);
  const callback=await worker.fetch(new Request(ORIGIN+'/oauth/callback?'+new URLSearchParams({code:liveCanary,state})),env);
  assert.equal(callback.status,303);
  assert.equal((await client.complete(request('GET'))).status,405);
  assert.equal((await client.complete(request('POST',{'x-oauth-csrf':'wrong'}))).status,401);
  assert.equal(exchanges.length,0);
  const finished=await client.complete(request());
  assert.equal(finished.status,200);
  assert.deepEqual(await finished.json(),{state:'checking',mode:'live',gateway_authenticated:false});
  assert.deepEqual(exchanges,[{code:liveCanary,state,code_verifier:verifier,redirect_uri:ORIGIN+'/oauth/callback'}]);
  assert.ok(!(await finished.clone().text()).includes('offline-private-access-token'));
  assert.equal((await client.complete(request())).status,401);
});
