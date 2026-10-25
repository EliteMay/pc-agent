const utf8 = new TextEncoder();
const statuses = { setup_required:503, unavailable:503, origin_rejected:403,
  not_found:404, method_not_allowed:405, invalid_input:400, authentication_required:401,
  replay_rejected:409, state_unavailable:409, rate_limited:429 };
export class RelayError extends Error {
  constructor(code) { super(Object.hasOwn(statuses,code)?code:'unavailable'); this.code=this.message; this.status=statuses[this.code]; }
}
export const SITE_ORIGIN='https://kaito-pc-agent-web-bridge.kaito2526.chatgpt.site';
export const RETURN_URL=SITE_ORIGIN+'/connect/complete';
export const ISSUER='https://vtnwbgejlaqpnwmlzbjy.supabase.co/auth/v1';
export const TTL=300000;
export const opaque = x => typeof x==='string' && /^[A-Za-z0-9_-]{43}$/.test(x);
export const dummyCode = x => typeof x==='string' && /^dummy-code-[A-Za-z0-9._-]{1,160}$/.test(x);
// Supabase documents the code as single-use and valid for 10 minutes but does not specify its format.
// For the future live mode accept only an RFC 6749 URL-safe subset, bounded; never used in dummy mode.
export const oauthCode = x => typeof x==='string' && /^[A-Za-z0-9._~-]{1,512}$/.test(x);
// RFC 6749 4.1.2.1 authorization-response error codes. Only the finite code is acted on; descriptions are discarded.
export const OAUTH_ERRORS = new Set(['invalid_request','unauthorized_client','access_denied','unsupported_response_type','invalid_scope','server_error','temporarily_unavailable']);
export const plainObject = x => x!==null && typeof x==='object' && !Array.isArray(x);
export function base64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
export function bytes(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)) throw new RelayError('setup_required');
  const binary=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));
  const result=Uint8Array.from(binary,c=>c.charCodeAt(0));
  if(base64(result)!==value) throw new RelayError('setup_required'); return result;
}
export function keyBytes(key) { try { const raw=bytes(key); if(raw.length!==32) throw 0; return raw; } catch { throw new RelayError('setup_required'); } }
export async function sha(value) { return base64(await crypto.subtle.digest('SHA-256',utf8.encode(value))); }
export const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
// This relay is tied to one existing Cloudflare Worker. Never accept another
// *.workers.dev tenant from a configuration typo or attacker-provided value.
// The exact .invalid origin is reserved for offline tests only.
export const RELAY_PRODUCTION_ORIGIN='https://kaito-oauth-callback-relay-dummy.k12m45k.workers.dev';
export const RELAY_TEST_ORIGIN='https://relay.example.invalid';
export function relayOrigin(value) {
  try {
    const u=new URL(value);
    if(typeof value!=='string'||u.href!==value+'/'&&u.href!==value||
      ![RELAY_PRODUCTION_ORIGIN,RELAY_TEST_ORIGIN].includes(u.origin)||
      u.pathname!=='/'||u.search||u.hash||u.username||u.password||u.port) throw 0;
    return u.origin;
  } catch { throw new RelayError('setup_required'); }
}
export const safeHeaders = { 'cache-control':'no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' };
export const safeJson = (value,status=200) => Response.json(value,{status,headers:safeHeaders});
export function safeError(error) { const e=error instanceof RelayError?error:new RelayError('unavailable'); return safeJson({error:e.code},e.status); }
export async function readText(request,limit=1024) {
  if(request.headers.get('content-encoding')) throw new RelayError('invalid_input');
  const declared=request.headers.get('content-length');
  if(declared && (!/^\d+$/.test(declared)||Number(declared)>limit)) throw new RelayError('invalid_input');
  if(!request.body) throw new RelayError('invalid_input');
  const reader=request.body.getReader(); let total=0; const chunks=[];
  try { while(true) { const part=await reader.read(); if(part.done) break;
    total+=part.value.length; if(total>limit) { await reader.cancel(); throw new RelayError('invalid_input'); } chunks.push(part.value);
  } const joined=new Uint8Array(total); let offset=0; for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder('utf-8',{fatal:true}).decode(joined);
  } catch(error) { if(error instanceof RelayError) throw error; throw new RelayError('invalid_input'); }
}
export async function parseBody(request) {
  if(!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type')??'')) throw new RelayError('invalid_input');
  const text=await readText(request); let body;
  try { body=JSON.parse(text); } catch { throw new RelayError('invalid_input'); }
  if(!plainObject(body)||Object.keys(body).sort().join(',')!=='binding,state'||!opaque(body.state)||!opaque(body.binding)) throw new RelayError('invalid_input');
  return {text,body};
}
async function signatureMessage(origin,path,time,nonce,text) { return ['kaito-relay-v1',origin,'POST',path,time,nonce,await sha(text)].join('\n'); }
export async function signedRequest({origin,key,path,body,now=Date.now(),nonce=random()}) {
  const audience=relayOrigin(origin); keyBytes(key);
  if(!['/prepare','/claim'].includes(path)||!opaque(nonce)) throw new RelayError('invalid_input');
  const text=JSON.stringify(body), time=String(Math.floor(now/1000));
  const cryptoKey=await crypto.subtle.importKey('raw',keyBytes(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=base64(await crypto.subtle.sign('HMAC',cryptoKey,utf8.encode(await signatureMessage(audience,path,time,nonce,text))));
  return new Request(audience+path,{method:'POST',credentials:'omit',redirect:'error',headers:{
    'content-type':'application/json','x-relay-time':time,'x-relay-nonce':nonce,'x-relay-signature':signature,
  },body:text});
}
export async function authenticatedBody(request,origin,key,now) {
  const time=request.headers.get('x-relay-time'),nonce=request.headers.get('x-relay-nonce'),signature=request.headers.get('x-relay-signature');
  if(!time||!/^\d{10,12}$/.test(time)||Math.abs(now-Number(time)*1000)>30000||!opaque(nonce)||!opaque(signature)) throw new RelayError('authentication_required');
  const {text,body}=await parseBody(request); const path=new URL(request.url).pathname;
  const cryptoKey=await crypto.subtle.importKey('raw',keyBytes(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  let valid=false; try { valid=await crypto.subtle.verify('HMAC',cryptoKey,bytes(signature),utf8.encode(await signatureMessage(origin,path,time,nonce,text))); } catch {}
  if(!valid) throw new RelayError('authentication_required');
  return {body,nonceHash:await sha(nonce)};
}
// Separate live and dummy ciphertext domains without changing the existing D1 schema.
export const modeStateHash = (mode, state) => sha(mode === 'live' ? 'kaito-relay|live|' + state : state);
export const aad = (row, mode='dummy') => `kaito-relay|v1|${mode}|${row.state_hash}|${row.binding}|${row.expires_at}`;
export async function seal(payload,key,row,mode='dummy') {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey=await crypto.subtle.importKey('raw',keyBytes(key),'AES-GCM',false,['encrypt']);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(aad(row,mode))},cryptoKey,utf8.encode(JSON.stringify(payload)));
  return JSON.stringify({v:1,iv:base64(iv),ciphertext:base64(encrypted)});
}
export async function open(envelope,key,row,mode='dummy') {
  try { if(typeof envelope!=='string'||envelope.length>4096) throw 0;
    const data=JSON.parse(envelope); if(!plainObject(data)||Object.keys(data).sort().join(',')!=='ciphertext,iv,v'||data.v!==1) throw 0;
    const iv=bytes(data.iv); if(iv.length!==12) throw 0;
    const cryptoKey=await crypto.subtle.importKey('raw',keyBytes(key),'AES-GCM',false,['decrypt']);
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:utf8.encode(aad(row,mode))},cryptoKey,bytes(data.ciphertext));
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(clear));
  } catch { throw new RelayError('unavailable'); }
}
