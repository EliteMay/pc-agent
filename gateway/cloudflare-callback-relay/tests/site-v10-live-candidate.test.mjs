import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSitesV10LiveCandidate, checkedAuthorizationUrl, LIVE_CALLBACK_URL,
} from '../src/site-v10-live-candidate.mjs';
import { fixture, LIVE_ORIGIN, ORIGIN, SITE, KEY, value, epoch } from './helpers.mjs';
import { ISSUER, sha } from '../src/protocol.mjs';

const CLIENT='offline-confidential-client';
const LIVE={RELAY_MODE:'live',RELAY_LIVE_ENABLED:'true',RELAY_ORIGIN:LIVE_ORIGIN};
const CANARY='offline-live-code-canary';
const OWNER_UUID='11111111-1111-4111-8111-111111111111';
const OTHER_UUID='22222222-2222-4222-8222-222222222222';
function authUrl(pending,overrides={}) {
  const url=new URL(ISSUER+'/oauth/authorize');
  for(const [k,v] of Object.entries({
    response_type:'code',client_id:CLIENT,state:pending.state,
    redirect_uri:LIVE_CALLBACK_URL,code_challenge:pending.challenge,
    code_challenge_method:'S256',scope:'openid',...overrides,
  })) url.searchParams.set(k,v);
  return url.href;
}

async function setup({enabled=true,pendingMode='live',alterUrl,failExchange=false,
  verifiedOverrides={},verifyFailure=false,invalidTokenResponse=false,storeFailure=false}={}) {
  const f=await fixture({env:LIVE});
  const owner='offline-owner',browser=value(),csrf=value(),verifier=value();
  const principalId=value();
  let authenticatedPrincipal=principalId;
  let pending={mode:pendingMode,owner,principalId,browserId:browser,csrf,verifier,
    challenge:await sha(verifier),state:f.state,
    expiresAt:epoch+300000,redirectUri:LIVE_CALLBACK_URL};
  const exchanges=[],calls=[],verifications=[],stored=[];
  const authorize=async req=>req.headers.get('x-test-owner')===owner?owner:null;
  const loadPending=async(req,who)=>req.headers.get('cookie')===browser&&who===owner?pending:null;
  const candidate=createSitesV10LiveCandidate({
    enabled,origin:LIVE_ORIGIN,key:KEY,authorize,loadPending,
    // The mock session verifier is independent of the request's user headers.
    // A production verifier MUST validate the signed/encrypted Site session.
    verifyIdentityBinding:async req=>req.headers.get('cookie')===browser?
      {owner,principalId:authenticatedPrincipal,browserId:browser}:null,
    consumePending:async p=>{if(!pending||pending.state!==p.state)return false;pending=null;return true;},
    invalidatePending:async()=>{pending=null;},
    exchangeAuthorizationCode:async p=>{
      exchanges.push(p);
      if(failExchange)throw Error('private-token-exchange-failure');
      if(invalidTokenResponse) return {token_type:'none',access_token:'bad token'};
      return {access_token:'invisible-token',refresh_token:'invisible-refresh',token_type:'Bearer'};
    },
    supabaseAuth:{getClaims:async token=>{
      verifications.push(token);
      if(verifyFailure)throw Error('private-verifier-failure');
      return {data:{claims:{sub:OWNER_UUID,user_id:OWNER_UUID,
        client_id:CLIENT,role:'authenticated',aud:'authenticated',iss:ISSUER,
        iat:Math.floor(epoch/1000)-100,exp:Math.floor(epoch/1000)+3600,
        ...verifiedOverrides}},error:null};
    }},
    storeVerifiedTokens:async v=>{
      stored.push(v);
      if(storeFailure)throw Error('private-store-failure');
    },
    ownerUserId:OWNER_UUID,
    buildExistingAuthorizationUrl:async(_request,p)=>alterUrl?alterUrl(authUrl(p),p):authUrl(p),
    oauthClientId:CLIENT,clock:()=>epoch,timeoutMs:1000,
    fetcher:async req=>{calls.push(req.url);return f.worker.fetch(req,f.env);},
  });
  const req=(path,method='POST',headers={})=>new Request(SITE+path,{method,
    headers:{origin:SITE,cookie:browser,'x-test-owner':owner,'x-oauth-csrf':csrf,...headers}});
  return {f,candidate,req,calls,exchanges,verifications,stored,
    pending:()=>pending,csrf,owner,browser,
    changeAuthenticatedPrincipal:()=>{authenticatedPrincipal=value();}};
}

test('default OFF blocks every live handler before touching owner, pending, Worker or OAuth',async()=>{
  let calls=0;
  const bridge=createSitesV10LiveCandidate({
    authorize:async()=>{calls++;throw Error('must not happen');},
    buildExistingAuthorizationUrl:async()=>{calls++;throw Error('must not happen');},
  });
  for(const method of ['start','getComplete','postComplete']){
    const r=await bridge[method](new Request(SITE+'/oauth/start',{method:'POST'}));
    assert.equal(r.status,503);
    assert.deepEqual(await r.json(),{error:'setup_required'});
  }
  assert.equal(calls,0);
});

test('live start validates existing PKCE, redirects only after a signed prepare, then browser GET cannot consume',async()=>{
  const s=await setup();
  const start=await s.candidate.start(s.req('/oauth/start'));
  assert.equal(start.status,303);
  const location=start.headers.get('location');
  const auth=new URL(location);
  assert.equal(auth.origin,new URL(ISSUER).origin);
  assert.equal(auth.pathname,'/auth/v1/oauth/authorize');
  assert.equal(auth.searchParams.get('redirect_uri'),LIVE_CALLBACK_URL);
  assert.equal(auth.searchParams.get('code_challenge'),s.pending().challenge);
  assert.equal(s.calls.length,1);
  assert.equal(s.f.DB.rows('relay_pending').length,1);

  const c=await s.f.callback('code='+CANARY+'&state='+s.f.state);
  assert.equal(c.status,303);
  assert.equal(c.headers.get('location'),SITE+'/connect/complete');
  const before=s.f.DB.rows('relay_pending')[0];
  const get=await s.candidate.getComplete(s.req('/connect/complete','GET'));
  assert.equal(get.status,303);
  assert.equal(get.headers.get('location'),SITE+'/');
  assert.equal(s.calls.length,1);
  assert.equal(s.exchanges.length,0);
  assert.equal(s.pending().state,s.f.state);
  assert.deepEqual(s.f.DB.rows('relay_pending')[0],before);

  const badPost=await s.candidate.postComplete(s.req('/connect/complete','POST',{'x-oauth-csrf':'bad'}));
  assert.equal(badPost.status,401);
  assert.equal(s.calls.length,1);
  assert.ok(s.pending());
  const finish=await s.candidate.postComplete(s.req('/connect/complete'));
  assert.equal(finish.status,200);
  const body=await finish.text();
  assert.deepEqual(JSON.parse(body),{state:'checking',mode:'live',gateway_authenticated:false});
  assert.equal(s.exchanges.length,1);
  assert.equal(s.verifications.length,1);
  assert.equal(s.stored.length,1);
  assert.equal(s.stored[0].ownerUserId,OWNER_UUID);
  assert.equal(s.stored[0].oauthClientId,CLIENT);
  assert.deepEqual(s.exchanges[0],{
    code:CANARY,state:s.f.state,code_verifier:s.exchanges[0].code_verifier,
    redirect_uri:LIVE_CALLBACK_URL,
  });
  assert.ok(!body.includes(CANARY));
  assert.ok(!body.includes('invisible-token'));
  assert.ok(!body.includes('invisible-refresh'));
  assert.ok(!body.includes(OWNER_UUID));
  assert.equal(s.pending(),null);
  assert.equal(s.f.DB.rows('relay_pending')[0].envelope,null);
  assert.equal((await s.candidate.postComplete(s.req('/connect/complete'))).status,409);
});

test('wrong redirect, OAuth client ID, state and PKCE challenge fail BEFORE any Relay network request',async()=>{
  for(const alterUrl of [
    (url)=>{const u=new URL(url);u.searchParams.set('redirect_uri',SITE+'/oauth/callback');return u.href;},
    (url)=>{const u=new URL(url);u.searchParams.set('client_id','unapproved-client');return u.href;},
    (url)=>{const u=new URL(url);u.searchParams.set('state',value());return u.href;},
    (url)=>{const u=new URL(url);u.searchParams.set('code_challenge',value());return u.href;},
    (url)=>{const u=new URL(url);u.searchParams.set('code_challenge_method','plain');return u.href;},
    (url)=>{const u=new URL(url);u.searchParams.append('state',value());return u.href;},
    (url)=>url.replace('/oauth/authorize','/oauth/token'),
    ()=> 'https://attacker.example.invalid/auth/v1/oauth/authorize',
  ]) {
    const s=await setup({alterUrl});
    const r=await s.candidate.start(s.req('/oauth/start'));
    assert.equal(r.status,503);
    assert.equal(s.calls.length,0);
    assert.equal(s.f.DB.rows('relay_pending').length,0);
    assert.ok(s.pending());
  }
});

test('an intervening pending rewrite cannot prepare a different state or PKCE session',async()=>{
  // The trusted URL-builder can yield to overlapping browser/session writes.
  // The URL for the old state must never prepare a newly loaded pending state.
  for(const mutate of [
    p=>{p.state=value();},
    p=>{p.verifier=value();},
    p=>{p.browserId=value();},
    p=>{p.principalId=value();},
    p=>{p.csrf=value();},
    p=>{p.mode='dummy';},
    p=>{p.redirectUri=SITE+'/oauth/callback';},
  ]){
    const s=await setup({alterUrl:(url,p)=>{mutate(p);return url;}});
    const result=await s.candidate.start(s.req('/oauth/start'));
    assert.ok([401,409].includes(result.status));
    assert.equal(s.calls.length,0);
    assert.equal(s.f.DB.rows('relay_pending').length,0);
    assert.equal(s.exchanges.length,0);
  }
});

test('live candidate refuses to initialize without independent server-side identity verification',async()=>{
  assert.throws(()=>createSitesV10LiveCandidate({
    enabled:true,origin:LIVE_ORIGIN,key:KEY,
    authorize:async()=> 'offline-owner',loadPending:async()=>null,
    consumePending:async()=>true,invalidatePending:async()=>{},
    buildExistingAuthorizationUrl:async()=>'',
    exchangeAuthorizationCode:async()=>({}),
    supabaseAuth:{getClaims:async()=>({data:null,error:null})},storeVerifiedTokens:async()=>{},
    ownerUserId:OWNER_UUID,oauthClientId:CLIENT,
  }),e=>e.code==='setup_required');
});

test('same owner email but changed authenticated principal is denied before any Relay network call',async()=>{
  const s=await setup();
  s.changeAuthenticatedPrincipal();
  const r=await s.candidate.start(s.req('/oauth/start','POST',{
    'oai-authenticated-user-email':s.owner,
    'oai-authenticated-user-id':s.pending().principalId,
  }));
  assert.equal(r.status,401);
  assert.equal(s.calls.length,0);
  assert.equal(s.exchanges.length,0);
  assert.equal(s.f.DB.rows('relay_pending').length,0);
});

test('principal switch between initial start and POST complete blocks OAuth claim and token exchange',async()=>{
  const s=await setup();
  assert.equal((await s.candidate.start(s.req('/oauth/start'))).status,303);
  assert.equal((await s.f.callback('code='+CANARY+'&state='+s.f.state)).status,303);
  const before=s.calls.length;
  s.changeAuthenticatedPrincipal();
  const completed=await s.candidate.postComplete(s.req('/connect/complete'));
  assert.equal(completed.status,401);
  assert.equal(s.calls.length,before);
  assert.equal(s.exchanges.length,0);
});

test('dummy pending cannot be reused to start or finish a live OAuth exchange',async()=>{
  const s=await setup({pendingMode:'dummy'});
  const r=await s.candidate.start(s.req('/oauth/start'));
  assert.equal(r.status,401);
  assert.equal(s.calls.length,0);
  assert.equal(s.exchanges.length,0);
  const post=await s.candidate.postComplete(s.req('/connect/complete'));
  assert.equal(post.status,409);
  assert.equal(s.calls.length,0);
});

test('invalid browser identity, Origin, GET method and callback query do not reach Relay',async()=>{
  const s=await setup();
  const variants=[
    s.req('/oauth/start','GET'),
    s.req('/oauth/start','POST',{origin:'https://attacker.example.invalid'}),
    s.req('/oauth/start','POST',{'x-test-owner':'impersonator'}),
    s.req('/oauth/start','POST',{cookie:value()}),
    s.req('/oauth/start','POST',{'x-oauth-csrf':'invalid'}),
    s.req('/oauth/start?code=private','POST'),
  ];
  for(const req of variants){
    const r=await s.candidate.start(req);
    assert.ok(r.status>=400);
  }
  assert.equal(s.calls.length,0);
  const query=await s.candidate.getComplete(s.req('/connect/complete?code=private','GET'));
  assert.equal(query.status,400);
  const postAsGet=await s.candidate.getComplete(s.req('/connect/complete','POST'));
  assert.equal(postAsGet.status,405);
  assert.equal(s.calls.length,0);
});

test('existing encrypted-token exchange failure is sanitized and cannot be retried',async()=>{
  const s=await setup({failExchange:true});
  assert.equal((await s.candidate.start(s.req('/oauth/start'))).status,303);
  assert.equal((await s.f.callback('code='+CANARY+'&state='+s.f.state)).status,303);
  const r=await s.candidate.postComplete(s.req('/connect/complete'));
  assert.equal(r.status,503);
  assert.ok(!(await r.text()).includes('private-token-exchange-failure'));
  assert.equal(s.exchanges.length,1);
  assert.equal(s.pending(),null);
  assert.equal(s.f.DB.rows('relay_pending')[0].envelope,null);
  assert.notEqual((await s.candidate.postComplete(s.req('/connect/complete'))).status,200);
});

test('verified OAuth user/client claim mismatch denies storage even with same email header',async()=>{
  for(const verifiedOverrides of [
    {sub:OTHER_UUID,user_id:OTHER_UUID,email:'offline-owner'},
    {client_id:'attacker-oauth-client'},
    {sub:undefined},
    {user_id:OTHER_UUID},
    {iss:'https://attacker.invalid/auth/v1'},
    {aud:'other'},
    {role:'anon'},
    {is_anonymous:true},
    {exp:Math.floor(epoch/1000)-1},
    {iat:Math.floor(epoch/1000)+180},
    {nbf:Math.floor(epoch/1000)+180},
  ]) {
    const s=await setup({verifiedOverrides});
    assert.equal((await s.candidate.start(s.req('/oauth/start'))).status,303);
    assert.equal((await s.f.callback('code='+CANARY+'&state='+s.f.state)).status,303);
    const response=await s.candidate.postComplete(s.req('/connect/complete','POST',{
      'oai-authenticated-user-email':'offline-owner',
      'oai-authenticated-user-id':OWNER_UUID,
    }));
    assert.equal(response.status,401);
    assert.equal(s.verifications.length,1);
    assert.equal(s.stored.length,0);
    assert.equal(s.pending(),null);
    assert.notEqual((await s.candidate.postComplete(s.req('/connect/complete'))).status,200);
  }
});

test('verification and token-shape failures cannot store credentials or disclose private data',async()=>{
  for(const scenario of [{verifyFailure:true},{invalidTokenResponse:true}]){
    const s=await setup(scenario);
    assert.equal((await s.candidate.start(s.req('/oauth/start'))).status,303);
    assert.equal((await s.f.callback('code='+CANARY+'&state='+s.f.state)).status,303);
    const response=await s.candidate.postComplete(s.req('/connect/complete'));
    assert.equal(response.status,scenario.verifyFailure?401:503);
    const body=await response.text();
    assert.ok(!body.includes('private-verifier-failure'));
    assert.ok(!body.includes('invisible-token'));
    assert.equal(s.stored.length,0);
    assert.equal(s.pending(),null);
  }
});

test('verified token-store failure remains sanitized and cannot repeat OAuth exchange',async()=>{
  const s=await setup({storeFailure:true});
  assert.equal((await s.candidate.start(s.req('/oauth/start'))).status,303);
  assert.equal((await s.f.callback('code='+CANARY+'&state='+s.f.state)).status,303);
  const r=await s.candidate.postComplete(s.req('/connect/complete'));
  assert.equal(r.status,503);
  assert.ok(!(await r.text()).includes('private-store-failure'));
  assert.equal(s.exchanges.length,1);
  assert.equal(s.stored.length,1);
  assert.equal(s.pending(),null);
  assert.notEqual((await s.candidate.postComplete(s.req('/connect/complete'))).status,200);
});

test('authorization URL checker rejects non-server pending values and invalid client configuration',async()=>{
  const p={mode:'live',state:value(),verifier:value(),redirectUri:LIVE_CALLBACK_URL};
  p.challenge=await sha(p.verifier);
  assert.equal(await checkedAuthorizationUrl(authUrl(p),p,CLIENT),authUrl(p));
  await assert.rejects(checkedAuthorizationUrl(authUrl(p),{...p,mode:'dummy'},CLIENT),e=>e.code==='setup_required');
  await assert.rejects(checkedAuthorizationUrl(authUrl(p),p,''),e=>e.code==='setup_required');
});
