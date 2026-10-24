import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectReadback, readCloudflare } from '../tools/cloudflare-readback.mjs';

const id='123e4567-e89b-42d3-a456-426614174001';
const dep='123e4567-e89b-42d3-a456-426614174002';
const api=x=>({success:true,result:x});
const good=()=>({
 deployments:api({deployments:[{id:dep,versions:[{percentage:100,version_id:id}]}]}),
 version:api({id,resources:{
   script_runtime:{compatibility_date:'2026-10-10T00:00:00Z'},
   script:{handlers:['fetch','scheduled']},
   bindings:Object.fromEntries(['DB','RELAY_MODE','RELAY_ORIGIN','RELAY_SIGNING_KEY','RELAY_STORAGE_KEY']
      .map(name=>[name,{type:'secret_text',text:'SUPER_SECRET_DO_NOT_PRINT'}])),
 }}),
 schedules:api({schedules:[{cron:'* * * * *'}]}),
 scriptSettings:api({observability:null,logpush:false,tail_consumers:[]})
});
const token='READONLY_FAKE_TOKEN_CANARY';
const accountId='0123456789abcdef0123456789abcdef';

test('valid metadata projection is narrow, never prints binding values or permits OAuth/deploy',()=>{
 const x=inspectReadback(good());
 assert.equal(x.readback,'metadata_consistent');
 assert.equal(x.log_settings,'disabled_observed');
 assert.equal(x.live_oauth_allowed,false);
 assert.equal(x.deploy_authorized,false);
 assert.equal(x.active_version_binary_identity,'unverified');
 assert.ok(Object.values(x.checks).every(Boolean));
 assert.doesNotMatch(JSON.stringify(x),/SUPER_SECRET_DO_NOT_PRINT|123e4567/);
});

test('alternate named binding array and plain date are supported without assuming safety',()=>{
 const x=good();
 x.version.result.resources.script_runtime.compatibility_date='2026-10-10';
 x.version.result.resources.bindings=Object.keys(x.version.result.resources.bindings)
   .map(name=>({name,type:'secret_text',text:'SUPER_SECRET_DO_NOT_PRINT'}));
 const p=inspectReadback(x);
 assert.equal(p.readback,'metadata_consistent');
 assert.equal(p.deploy_authorized,false);
});

test('date/time mismatch and unknown binding shape remain unverified',()=>{
 for(const date of ['2026-10-11','2026-10-10T08:00:00Z','2026-10-10T00:00:00+09:00']) {
   const x=good();x.version.result.resources.script_runtime.compatibility_date=date;
   assert.equal(inspectReadback(x).readback,'unverified');
 }
 for(const v of [null,[],12]) {const x=good();x.version.result.resources.bindings=v;
   assert.equal(inspectReadback(x).readback,'unverified');}
});

test('missing binding names, version mismatch, tail, Cron, logpush, split all fail closed',()=>{
 const edits=[
  x=>x.version.result.id=dep,
  x=>x.version.result.resources.bindings=[],
  x=>x.version.result.resources.bindings={DB:{}},
  x=>x.version.result.resources.script.handlers=['fetch'],
  x=>x.schedules.result.schedules=[],
  x=>x.scriptSettings.result.tail_consumers=[{service:'tail'}],
  x=>x.scriptSettings.result.logpush=true,
  x=>x.scriptSettings.result.observability=undefined,
  x=>x.deployments.result.deployments[0].versions.push({percentage:10,version_id:dep}),
 ];
 for(const edit of edits){const x=good();edit(x); const result=inspectReadback(x);
  assert.equal(result.readback,'unverified'); assert.equal(result.live_oauth_allowed,false);}
});

test('all network operations use five GET requests with version-pinned detail and stable deployment',async()=>{
 const records=[];const payload=good();
 const mock=async (url,options)=>{
   records.push({url,method:options.method,redirect:options.redirect,cache:options.cache});
   let obj;
   if(url.endsWith('/deployments'))obj=payload.deployments;
   else if(url.endsWith('/versions/'+id))obj=payload.version;
   else if(url.endsWith('/schedules'))obj=payload.schedules;
   else if(url.endsWith('/script-settings'))obj=payload.scriptSettings;
   else throw Error('unexpected endpoint');
   return new Response(JSON.stringify(obj),{headers:{'content-type':'application/json'}});
 };
 const result=await readCloudflare({accountId,token,fetcher:mock});
 assert.equal(result.readback,'metadata_consistent');
 assert.equal(result.remote_state_authenticated,true);
 assert.equal(records.length,5);
 assert.ok(records.every(x=>x.method==='GET' && x.redirect==='error' && x.cache==='no-store'));
 assert.ok(records[1].url.endsWith('/versions/'+id));
 assert.equal(records[0].url,records[4].url);
 assert.doesNotMatch(JSON.stringify(result),/READONLY_FAKE_TOKEN_CANARY|SUPER_SECRET/);
});

test('deployment changing during readback fails without revealing version ids',async()=>{
 const first=good(),changed=good();changed.deployments.result.deployments[0].id='123e4567-e89b-42d3-a456-426614174099';
 let seen=0;
 const out=await readCloudflare({accountId,token,fetcher:async(url)=>{
   let obj;
   if(url.endsWith('/deployments'))obj=(++seen===1 ? first : changed).deployments;
   else if(url.endsWith('/versions/'+id))obj=first.version;
   else if(url.endsWith('/schedules'))obj=first.schedules;
   else if(url.endsWith('/script-settings'))obj=first.scriptSettings;
   else throw Error('unexpected endpoint');
   return new Response(JSON.stringify(obj),{headers:{'content-type':'application/json'}});
 }});
 assert.equal(seen,2);
 assert.equal(out.readback,'unverified_deployment_changed');
 assert.equal(out.deploy_authorized,false);
 assert.doesNotMatch(JSON.stringify(out),/123e4567|READONLY_FAKE/);
});

test('HTTP failures, malformed account/token and oversized content return fixed labels',async()=>{
 const failed=async()=>new Response('LEAK_PRIVATE_CANARY',{status:403,headers:{'content-type':'text/plain'}});
 const out=await readCloudflare({accountId,token,fetcher:failed});
 assert.equal(out.readback,'unverified');
 assert.equal(out.remote_state_authenticated,false);
 assert.doesNotMatch(JSON.stringify(out),/LEAK_PRIVATE_CANARY|READONLY_FAKE_TOKEN_CANARY/);
 const invalid=await readCloudflare({accountId:'invalid',token,fetcher:()=>{throw Error('must not fetch');}});
 assert.equal(invalid.readback,'unverified');
 const huge=async()=>new Response('A'.repeat(300000),{headers:{'content-type':'application/json'}});
 assert.equal((await readCloudflare({accountId,token,fetcher:huge})).readback,'unverified');
});

test('ambiguous deployment stops before any further API requests',async()=>{
 const records=[];
 const response=api({deployments:[{id:dep,versions:[
   {percentage:50,version_id:id},{percentage:50,version_id:dep}
 ]}]});
 const out=await readCloudflare({accountId,token,fetcher:async(url,opts)=>{
   records.push(url);return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
 }});
 assert.equal(out.readback,'unverified_deployment');
 assert.equal(out.remote_state_authenticated,false);
 assert.equal(records.length,1);
});
