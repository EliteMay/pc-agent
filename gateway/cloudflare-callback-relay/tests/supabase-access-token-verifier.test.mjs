import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseAccessTokenVerifier} from '../src/supabase-access-token-verifier.mjs';

const JWT='offline-test-jwt-not-a-real-token';
const CLAIMS=Object.freeze({sub:'11111111-1111-4111-8111-111111111111',client_id:'offline-client'});

test('getClaims receives exactly the supplied OAuth access token, not an implicit session',async()=>{
  const args=[];
  const verify=createSupabaseAccessTokenVerifier({
    async getClaims(...values){
      args.push(values);
      return {data:{claims:{...CLAIMS},header:{alg:'RS256'},signature:new Uint8Array([1])},error:null};
    },
  });
  const result=await verify(JWT);
  assert.deepEqual(result,CLAIMS);
  assert.deepEqual(args,[[JWT]]);
  assert.equal(Object.hasOwn(result,'signature'),false);
});

test('refuses absent or malformed official SDK getClaims and never falls back to session',async()=>{
  for(const candidate of [null,undefined,{},[],{getClaims:false},{getUser:async()=>({})}]){
    assert.throws(()=>createSupabaseAccessTokenVerifier(candidate),e=>e.code==='setup_required');
  }
});

test('invalid token input is refused without contacting Supabase Auth',async()=>{
  let calls=0;
  const verify=createSupabaseAccessTokenVerifier({getClaims:async()=>{calls++;return {data:{claims:CLAIMS},error:null};}});
  for(const jwt of ['',null,undefined,'Bearer '+JWT,'some\ntoken','some\ttoken','a'.repeat(16385)]){
    await assert.rejects(verify(jwt),e=>e.code==='authentication_required');
  }
  assert.equal(calls,0);
});

test('unverified, malformed, and SDK-rejected results are refused',async()=>{
  for(const sdkResult of [
    null,undefined,{}, {data:null,error:null},
    {data:{},error:null}, {data:{claims:null},error:null},
    {data:{claims:CLAIMS},error:{message:'invalid signature'}},
    {data:{claims:CLAIMS},error:'invalid'},
    {data:{claims:[]},error:null}, {data:'bad',error:null},
  ]){
    const verify=createSupabaseAccessTokenVerifier({getClaims:async()=>sdkResult});
    await assert.rejects(verify(JWT),e=>e.code==='authentication_required');
  }
});

test('SDK verification exceptions are sanitized without leaking transport or token',async()=>{
  const verify=createSupabaseAccessTokenVerifier({
    getClaims:async token=>{throw Error('private-signature-details '+token);},
  });
  await assert.rejects(verify(JWT),e=>
    e.code==='authentication_required'&&!e.message.includes(JWT)&&
    !e.message.includes('private-signature-details'));
});
