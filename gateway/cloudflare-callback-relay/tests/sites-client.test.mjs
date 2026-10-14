import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, KEY, ORIGIN, SITE, value, epoch } from './helpers.mjs';
import { RelayError } from '../src/protocol.mjs';

async function setup(options={}) {
  const { createSitesRelayClient }=await import('../src/sites-client.mjs');
  const f=await fixture(); const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE local_pending(state TEXT PRIMARY KEY,owner TEXT,browser TEXT,verifier TEXT,expires_at INTEGER,csrf TEXT)');
  const owner='dummy-site-owner',browser=value(),verifier=value(),csrf=value();
  db.prepare('INSERT INTO local_pending VALUES(?,?,?,?,?,?)').run(f.state,owner,browser,verifier,epoch+300000,csrf);
  const calls=[],exchanges=[]; let invalidated=0;
  const load=async(request,who)=> {
    const row=db.prepare('SELECT * FROM local_pending WHERE owner=? AND browser=?').get(who,request.headers.get('cookie'));
    if(!row) return null;
    return {state:row.state,owner:row.owner,browserId:row.browser,verifier:row.verifier,expiresAt:row.expires_at,csrf:row.csrf,redirectUri:ORIGIN+'/oauth/callback',...options.pending};
  };
  const client=createSitesRelayClient({origin:ORIGIN,key:KEY,clock:f.clock,timeoutMs:options.timeoutMs??1000,
    // Only the fixture accepts test identity headers. This is not runtime auth.
    authorize:async request=>{if(request.headers.get('x-test-owner')!==owner) throw new RelayError('authentication_required');return owner;},
    loadPending:load,
    consumePending:async pending=>db.prepare('DELETE FROM local_pending WHERE state=? AND owner=? AND browser=? AND expires_at>? RETURNING state').get(pending.state,owner,browser,f.clock())!==undefined,
    invalidatePending:async()=>{invalidated++;db.exec('DELETE FROM local_pending');},
    exchangeDummy:async input=>{exchanges.push(input);if(options.exchangeError) throw new Error('dummy-private-token');return {dummy:true};},
    fetcher:async request=>{calls.push({url:request.url,method:request.method,redirect:request.redirect,credentials:request.credentials,headers:Object.fromEntries(request.headers),body:await request.clone().text()});
      if(options.fetcher) return options.fetcher(request,f);
      return f.worker.fetch(request,f.env);
    },
  });
  const req=(complete=false,headers={},query='')=>new Request(SITE+(complete?'/connect/complete':'/oauth/start')+query,{method:complete?'GET':'POST',headers:{'x-test-owner':owner,cookie:browser,origin:SITE,'x-oauth-csrf':csrf,...headers}});
  const prepare=()=>client.prepare(req());
  const callback=()=>f.callback();
  return {f,db,client,calls,exchanges,owner,browser,verifier,csrf,req,prepare,callback,invalidated:()=>invalidated};
}

test('Sites pulls only a signed POST body and exchanges dummy code with original verifier and relay redirect URI',async()=>{
  const s=await setup();assert.equal((await s.prepare()).status,201);assert.equal((await s.callback()).status,303);
  const r=await s.client.complete(s.req(true));assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{state:'checking',mode:'dummy',gateway_authenticated:false});
  const call=s.calls[1];assert.equal(call.url,ORIGIN+'/claim');assert.equal(new URL(call.url).search,'');
  assert.equal(call.method,'POST');assert.equal(call.redirect,'error');assert.equal(call.credentials,'omit');
  assert.ok(call.headers['x-relay-signature']);assert.ok(!call.headers.cookie);assert.ok(!call.headers.authorization);
  assert.equal(s.exchanges.length,1);assert.deepEqual(s.exchanges[0],{code:'dummy-code-canary',state:s.f.state,code_verifier:s.verifier,redirect_uri:ORIGIN+'/oauth/callback'});
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM local_pending').get().n,0);
});

test('owner mismatch, missing login and wrong browser never contact the relay',async()=>{
  for(const headers of [{'x-test-owner':'another-owner'},{'x-test-owner':''},{cookie:value()}]){
    const s=await setup();const r=await s.client.complete(s.req(true,headers));assert.ok(r.status>=400);assert.equal(s.calls.length,0);assert.equal(s.exchanges.length,0);
  }
  const s=await setup({pending:{owner:'other'}});assert.ok((await s.client.complete(s.req(true))).status>=400);assert.equal(s.calls.length,0);
});

test('prepare retains explicit same-origin CSRF validation',async()=>{
  for(const headers of [{origin:'https://other.example.invalid'},{'x-oauth-csrf':'wrong'}]){
    const s=await setup();assert.ok((await s.client.prepare(s.req(false,headers))).status>=400);assert.equal(s.calls.length,0);
  }
});

test('complete rejects query parameters and wrong HTTP methods before any transport',async()=>{
  const s=await setup();assert.equal((await s.client.complete(s.req(true,{},'?code=dummy-code-a&state=dummy'))).status,400);
  assert.equal((await s.client.complete(new Request(SITE+'/connect/complete',{method:'POST'}))).status,405);assert.equal(s.calls.length,0);
});

test('expired or wrong redirect pending data is rejected without claim or exchange',async()=>{
  for(const pending of [{expiresAt:epoch},{redirectUri:SITE+'/oauth/callback'}]) {
    const s=await setup({pending});assert.ok((await s.client.complete(s.req(true))).status>=400);assert.equal(s.calls.length,0);
  }
});

test('concurrent Site completion atomically consumes local pending state once',async()=>{
  const s=await setup();await s.prepare();await s.callback();
  const results=await Promise.all(Array.from({length:8},()=>s.client.complete(s.req(true))));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(s.calls.filter(c=>c.url.endsWith('/claim')).length,1);assert.equal(s.exchanges.length,1);
});

test('wrong returned state or unexpected response fields never reach dummy token exchange',async()=>{
  for(const extra of [{state:value()},{token:'dummy-token'}]) {
    const s=await setup({fetcher:async(_request,f)=>Response.json({outcome:'code',state:f.state,code:'dummy-code-a',...extra})});
    const r=await s.client.complete(s.req(true));assert.equal(r.status,503);assert.equal(s.exchanges.length,0);assert.equal(s.invalidated(),1);
    assert.ok(!(await r.text()).includes('dummy-token'));
  }
});

test('denied consent never exchanges tokens and browser output contains no code or state',async()=>{
  const s=await setup();await s.prepare();await s.f.callback(`error=access_denied&state=${s.f.state}`);
  const r=await s.client.complete(s.req(true));assert.equal(r.status,200);assert.deepEqual(await r.json(),{state:'denied',mode:'dummy',gateway_authenticated:false});
  assert.equal(s.exchanges.length,0);assert.equal(s.invalidated(),1);
});

test('token exchange rejection cannot retry consumed local or relay state or expose exception text',async()=>{
  const s=await setup({exchangeError:true});await s.prepare();await s.callback();
  const r=await s.client.complete(s.req(true));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('dummy-private-token'));
  assert.ok((await s.client.complete(s.req(true))).status>=400);assert.equal(s.exchanges.length,1);assert.equal(s.invalidated(),1);
  assert.equal(s.f.DB.rows('relay_pending')[0].envelope,null);
});

test('redirects, excessive responses and network exceptions are rejected safely',async()=>{
  for(const fetcher of [async()=>new Response(null,{status:302,headers:{location:'https://other.example.invalid'}}),async()=>Response.json({padding:'x'.repeat(10000)}),async()=>{throw new Error('dummy-upstream-private-data');}]) {
    const s=await setup({fetcher});const r=await s.client.complete(s.req(true));assert.equal(r.status,503);assert.equal(s.exchanges.length,0);assert.ok(!(await r.text()).includes('dummy-upstream-private-data'));
  }
});

test('timeout bounds transport and permanently invalidates the local attempt',async()=>{
  const s=await setup({timeoutMs:10,fetcher:()=>new Promise(()=>{})});
  const r=await s.client.complete(s.req(true));assert.equal(r.status,503);assert.equal(s.invalidated(),1);assert.equal(s.exchanges.length,0);
});

test('a response containing a non-dummy code is refused before exchange',async()=>{
  const s=await setup({fetcher:async(_request,f)=>Response.json({outcome:'code',state:f.state,code:'NOT_A_DUMMY_CODE'})});
  assert.equal((await s.client.complete(s.req(true))).status,503);assert.equal(s.exchanges.length,0);
});
