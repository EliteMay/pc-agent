import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreOAuthBrowserBindings} from '../src/pre-oauth-browser-session.mjs';
import {createSitesV10LiveCandidate,LIVE_CALLBACK_URL} from '../src/site-v10-live-candidate.mjs';
import {fixture,LIVE_ORIGIN,SITE,KEY,epoch,value} from './helpers.mjs';
import {ISSUER,sha} from '../src/protocol.mjs';

const OWNER_UUID='11111111-1111-4111-8111-111111111111';
const OTHER_UUID='22222222-2222-4222-8222-222222222222';
const CLIENT='offline-confidential-client';
const browser=value();
const scopeId=value(),sessionNonce=value(),browserId=value();
const validSession=()=>({scopeId,sessionNonce,browserId,expiresAt:epoch+300000});
const req=(cookie,headers={})=>new Request(SITE+'/oauth/start',{method:'POST',headers:{
  origin:SITE,cookie,...headers,
}});

test('missing trusted Site session verifier is configuration error',()=>{
  for(const options of [undefined,{}, {readVerifiedBrowserSession:true},
    {readVerifiedBrowserSession:async()=>validSession(),clock:'not-clock'}]){
    assert.throws(()=>createPreOAuthBrowserBindings(options),e=>e.code==='setup_required');
  }
});

test('pre-OAuth binding uses only server-verified session, not claimed ChatGPT identity',async()=>{
  const bindings=createPreOAuthBrowserBindings({
    readVerifiedBrowserSession:async request=>request.headers.get('cookie')===browser?validSession():null,
    clock:()=>epoch,
  });
  const start=req(browser,{'oai-authenticated-user-email':'attacker@example.invalid',
    'oai-authenticated-user-id':'forged-owner'});
  assert.equal(await bindings.authorize(start),scopeId);
  assert.deepEqual(await bindings.verifyIdentityBinding(start),{
    owner:scopeId,principalId:sessionNonce,browserId,
  });
  for(const forged of [
    req('wrong',{'oai-authenticated-user-email':'owner@example.invalid'}),
    req('',{'oai-authenticated-user-id':scopeId}),
    req('wrong',{'x-test-owner':scopeId}),
  ]){
    await assert.rejects(bindings.authorize(forged),e=>e.code==='authentication_required');
    await assert.rejects(bindings.verifyIdentityBinding(forged),e=>e.code==='authentication_required');
  }
});

test('pre-OAuth sessions reject expiry, overlong TTL, invalid opaque fields and unsafe clocks',async()=>{
  const cases=[
    {...validSession(),expiresAt:epoch},
    {...validSession(),expiresAt:epoch+300001},
    {...validSession(),scopeId:'email@example.invalid'},
    {...validSession(),sessionNonce:'not-session-bound'},
    {...validSession(),browserId:'browser'},
    {...validSession(),expiresAt:'soon'},
    Object.create(null),
    null,
  ];
  for(const value of cases) {
    const b=createPreOAuthBrowserBindings({
      readVerifiedBrowserSession:async()=>value,clock:()=>epoch,
    });
    await assert.rejects(b.authorize(req(browser)),e=>e.code==='authentication_required');
  }
  const b=createPreOAuthBrowserBindings({
    readVerifiedBrowserSession:async()=>validSession(),clock:()=>Number.NaN,
  });
  await assert.rejects(b.verifyIdentityBinding(req(browser)),e=>e.code==='authentication_required');
});

test('Site session reader exceptions are sanitized, never exposed through bearer headers',async()=>{
  const b=createPreOAuthBrowserBindings({
    readVerifiedBrowserSession:async()=>{throw Error('private-cookie-secret canary');},
    clock:()=>epoch,
  });
  await assert.rejects(b.authorize(req(browser)),e=>e.code==='authentication_required'&&
    !e.message.includes('private-cookie-secret'));
});

test('independent session lookup notices cookie rotation or revocation between calls',async()=>{
  let current=validSession();
  const b=createPreOAuthBrowserBindings({
    readVerifiedBrowserSession:async()=>current,clock:()=>epoch,
  });
  const start=req(browser);
  assert.equal(await b.authorize(start),scopeId);
  current={...current,sessionNonce:value()};
  assert.notEqual((await b.verifyIdentityBinding(start)).principalId,sessionNonce);
  current=null;
  await assert.rejects(b.verifyIdentityBinding(start),e=>e.code==='authentication_required');
});

async function flow({ownerSub=OWNER_UUID,validBrowser=true}={}){
  const f=await fixture({env:{RELAY_MODE:'live',RELAY_LIVE_ENABLED:'true',RELAY_ORIGIN:LIVE_ORIGIN}});
  const cookie=value(),csrf=value(),verifier=value();
  const sessions=new Map(validBrowser?[[cookie,validSession()]]:[]);
  const bindings=createPreOAuthBrowserBindings({
    readVerifiedBrowserSession:async request=>sessions.get(request.headers.get('cookie')),
    clock:()=>epoch,
  });
  const pending={mode:'live',owner:scopeId,principalId:sessionNonce,browserId,
    csrf,verifier,state:f.state,expiresAt:epoch+300000,redirectUri:LIVE_CALLBACK_URL};
  const stored=[],exchanged=[];
  const authUrl=async(_req,p)=>{
    const url=new URL(ISSUER+'/oauth/authorize');
    for(const [k,v] of Object.entries({
      response_type:'code',client_id:CLIENT,state:p.state,
      redirect_uri:p.redirectUri,code_challenge:await sha(p.verifier),
      code_challenge_method:'S256',scope:'openid',
    }))url.searchParams.set(k,v);
    return url.href;
  };
  const client=createSitesV10LiveCandidate({
    enabled:true,origin:LIVE_ORIGIN,key:KEY,...bindings,
    loadPending:async(request,owner)=>owner===scopeId&&sessions.has(request.headers.get('cookie'))?pending:null,
    consumePending:async p=>{if(!pending||p.state!==pending.state)return false;return true;},
    invalidatePending:async()=>{},
    exchangeAuthorizationCode:async p=>{exchanged.push(p);
      return {access_token:'offline.jwt.canary',refresh_token:'offline-refresh-canary',token_type:'Bearer'};},
    supabaseAuth:{getClaims:async token=>{
      assert.equal(token,'offline.jwt.canary');
      return {data:{claims:{sub:ownerSub,client_id:CLIENT,iss:ISSUER,aud:'authenticated',
        role:'authenticated',iat:Math.floor(epoch/1000)-100,exp:Math.floor(epoch/1000)+3600}},error:null};
    }},
    storeVerifiedTokens:async p=>{stored.push(p);},
    ownerUserId:OWNER_UUID,oauthClientId:CLIENT,
    buildExistingAuthorizationUrl:authUrl,
    fetcher:async r=>f.worker.fetch(r,f.env),
    clock:()=>epoch,timeoutMs:1000,
  });
  const request=(path,headers={})=>new Request(SITE+path,{method:'POST',headers:{
    origin:SITE,cookie,'x-oauth-csrf':csrf,...headers,
  }});
  return {f,client,request,stored,exchanged};
}

test('browser bootstrap can start OAuth with no authenticated user email; owner JWT gates storage',async()=>{
  const {f,client,request,stored,exchanged}=await flow();
  const begin=await client.start(request('/oauth/start'));
  assert.equal(begin.status,303);
  assert.equal(f.DB.rows('relay_pending').length,1);
  const callback=await f.callback('code=offline-live-code-canary&state='+f.state);
  assert.equal(callback.status,303);
  const finish=await client.postComplete(request('/connect/complete'));
  assert.equal(finish.status,200);
  assert.deepEqual(await finish.json(),{state:'checking',mode:'live',gateway_authenticated:false});
  assert.equal(exchanged.length,1);
  assert.equal(stored.length,1);
  assert.equal(stored[0].ownerUserId,OWNER_UUID);
});

test('bootstrap with a verified different Supabase user fails before token storage',async()=>{
  const {f,client,request,stored,exchanged}=await flow({ownerSub:OTHER_UUID});
  assert.equal((await client.start(request('/oauth/start'))).status,303);
  assert.equal((await f.callback('code=offline-live-code-canary&state='+f.state)).status,303);
  const denied=await client.postComplete(request('/connect/complete',{
    'oai-authenticated-user-email':'owner@example.invalid',
    'oai-authenticated-user-id':OWNER_UUID,
  }));
  assert.equal(denied.status,401);
  assert.equal(exchanged.length,1);
  assert.equal(stored.length,0);
});

test('missing genuine browser session denies OAuth bootstrap regardless of spoofed owner headers',async()=>{
  const {client,request,stored,exchanged}=await flow({validBrowser:false});
  const denied=await client.start(request('/oauth/start',{
    'oai-authenticated-user-email':'owner@example.invalid',
    'oai-authenticated-user-id':OWNER_UUID,
  }));
  assert.equal(denied.status,401);
  assert.equal(exchanged.length,0);
  assert.equal(stored.length,0);
});
