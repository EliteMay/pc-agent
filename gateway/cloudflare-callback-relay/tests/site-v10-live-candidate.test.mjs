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
function authUrl(pending,overrides={}) {
  const url=new URL(ISSUER+'/oauth/authorize');
  for(const [k,v] of Object.entries({
    response_type:'code',client_id:CLIENT,state:pending.state,
    redirect_uri:LIVE_CALLBACK_URL,code_challenge:pending.challenge,
    code_challenge_method:'S256',scope:'openid',...overrides,
  })) url.searchParams.set(k,v);
  return url.href;
}

async function setup({enabled=true,pendingMode='live',alterUrl,failExchange=false}={}) {
  const f=await fixture({env:LIVE});
  const owner='offline-owner',browser=value(),csrf=value(),verifier=value();
  let pending={mode:pendingMode,owner,browserId:browser,csrf,verifier,
    challenge:await sha(verifier),state:f.state,
    expiresAt:epoch+300000,redirectUri:LIVE_CALLBACK_URL};
  const exchanges=[],calls=[];
  const authorize=async req=>req.headers.get('x-test-owner')===owner?owner:null;
  const loadPending=async(req,who)=>req.headers.get('cookie')===browser&&who===owner?pending:null;
  const candidate=createSitesV10LiveCandidate({
    enabled,origin:LIVE_ORIGIN,key:KEY,authorize,loadPending,
    consumePending:async p=>{if(!pending||pending.state!==p.state)return false;pending=null;return true;},
    invalidatePending:async()=>{pending=null;},
    exchangeAndStoreExistingOAuth:async p=>{
      exchanges.push(p);
      if(failExchange)throw Error('private-token-exchange-failure');
      return {access_token:'invisible-token',refresh_token:'invisible-refresh'};
    },
    buildExistingAuthorizationUrl:async(_request,p)=>alterUrl?alterUrl(authUrl(p),p):authUrl(p),
    oauthClientId:CLIENT,clock:()=>epoch,timeoutMs:1000,
    fetcher:async req=>{calls.push(req.url);return f.worker.fetch(req,f.env);},
  });
  const req=(path,method='POST',headers={})=>new Request(SITE+path,{method,
    headers:{origin:SITE,cookie:browser,'x-test-owner':owner,'x-oauth-csrf':csrf,...headers}});
  return {f,candidate,req,calls,exchanges,pending:()=>pending,csrf,owner,browser};
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
  assert.deepEqual(s.exchanges[0],{
    code:CANARY,state:s.f.state,code_verifier:s.exchanges[0].code_verifier,
    redirect_uri:LIVE_CALLBACK_URL,
  });
  assert.ok(!body.includes(CANARY));
  assert.ok(!body.includes('invisible-token'));
  assert.ok(!body.includes('invisible-refresh'));
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

test('authorization URL checker rejects non-server pending values and invalid client configuration',async()=>{
  const p={mode:'live',state:value(),verifier:value(),redirectUri:LIVE_CALLBACK_URL};
  p.challenge=await sha(p.verifier);
  assert.equal(await checkedAuthorizationUrl(authUrl(p),p,CLIENT),authUrl(p));
  await assert.rejects(checkedAuthorizationUrl(authUrl(p),{...p,mode:'dummy'},CLIENT),e=>e.code==='setup_required');
  await assert.rejects(checkedAuthorizationUrl(authUrl(p),p,''),e=>e.code==='setup_required');
});
