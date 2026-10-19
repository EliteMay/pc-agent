import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectCandidate } from '../tools/deploy-preflight.mjs';

const original = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-10-19T14:00:00Z');
const id = '123e4567-e89b-42d3-a456-426614174000';
const ver = '123e4567-e89b-42d3-a456-426614174001';
function sample() {
  const config = structuredClone(original);
  config.keep_vars = true;
  config.vars.RELAY_ORIGIN = 'https://kaito-oauth-callback-relay-dummy.testowner.workers.dev';
  config.d1_databases[0].database_id = id;
  const baseline = {worker_name:config.name,worker_origin:config.vars.RELAY_ORIGIN,
    database_name:config.d1_databases[0].database_name,database_id:id,
    crons:['* * * * *'],active_version_id:ver,traffic_percent:100,
    secret_names:['RELAY_STORAGE_KEY','RELAY_SIGNING_KEY'],plan:'free',
    observed_at:new Date(now-1000).toISOString()};
  return {config,baseline};
}
const result=(c,b)=>inspectCandidate(c,b,now);

test('public placeholder configuration is rejected even with a healthy baseline',()=>{
  const {baseline}=sample(), v=result(original,baseline);
  assert.equal(v.candidate_config_check,'blocked');
  assert.equal(v.deploy_authorized,false);
});
test('matching private dummy config only passes offline review and never grants deploy or OAuth',()=>{
  const {config,baseline}=sample(), v=result(config,baseline);
  assert.equal(v.candidate_config_check,'passed_offline_only');
  assert.ok(Object.values(v.checks).every(Boolean));
  assert.equal(v.remote_state_authenticated,false);
  assert.equal(v.deploy_authorized,false);
  assert.equal(v.live_oauth_allowed,false);
});
test('rejects wrong IDs, changed routes/cron/secret inventory, stale remote baselines and live mode',()=>{
  const mutations=[
    x=>x.config.vars.RELAY_MODE='live',
    x=>x.config.vars.OTHER_SECRET='secret-value',
    x=>x.config.d1_databases[0].database_id='123e4567-e89b-42d3-a456-426614174099',
    x=>x.config.routes=['*/*'],
    x=>x.config.keep_vars=false,
    x=>x.config.observability.logs.enabled=true,
    x=>x.config.triggers.crons=[],
    x=>x.baseline.secret_names=['RELAY_SIGNING_KEY'],
    x=>x.baseline.active_version_id=null,
    x=>x.baseline.plan='paid',
    x=>x.baseline.observed_at=new Date(now-7200000).toISOString(),
    x=>x.baseline.traffic_percent=50,
  ];
  for(const change of mutations){const x=sample();change(x);
    assert.equal(result(x.config,x.baseline).candidate_config_check,'blocked');}
});
test('invalid or missing local files fail with fixed output and do not echo raw file contents',t=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-preflight-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'private.json');writeFileSync(path,'{"secret":"TOKEN-PRIVATE-CANARY"}');
  const cli=fileURLToPath(new URL('../tools/deploy-preflight.mjs',import.meta.url));
  const p=spawnSync(process.execPath,[cli,path,path],{encoding:'utf8'});
  assert.equal(p.status,1);
  assert.doesNotMatch(p.stdout+p.stderr,/TOKEN-PRIVATE-CANARY|private.json/);
  assert.equal(JSON.parse(p.stdout).deploy_authorized,false);
});
