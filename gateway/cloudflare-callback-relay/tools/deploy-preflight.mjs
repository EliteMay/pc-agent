// Offline deployment candidate review only. This module cannot deploy, change secrets,
// call Cloudflare, or turn a self-reported baseline into verified remote evidence.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectLogSettings } from '../src/log-policy.mjs';

const keys = x => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort() : [];
const same = (a,b) => JSON.stringify(keys(a)) === JSON.stringify([...b].sort());
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
const known = ['$schema','name','main','compatibility_date','workers_dev','preview_urls',
  'send_metrics','logpush','tail_consumers','observability','vars','d1_databases',
  'triggers','keep_vars'];
const expectedSecrets = ['RELAY_SIGNING_KEY','RELAY_STORAGE_KEY'];
const expectedName = 'kaito-oauth-callback-relay-dummy';

export function inspectCandidate(config, baseline, now=Date.now()) {
  const b = baseline ?? {}, c = config ?? {};
  const db = Array.isArray(c.d1_databases) && c.d1_databases.length === 1 ? c.d1_databases[0] : null;
  const baselineTime = Date.parse(b.observed_at);
  const origin = c.vars?.RELAY_ORIGIN;
  let url;
  try { url = new URL(origin); } catch {}
  const checks = {
    known_config_keys: same(c,known),
    expected_worker: c.name === expectedName && b.worker_name === expectedName,
    exact_runtime: c.main === 'src/worker.mjs' && c.compatibility_date === '2026-10-10' &&
      c.workers_dev === true && c.preview_urls === false && c.send_metrics === false,
    vars_only_dummy: same(c.vars,['RELAY_MODE','RELAY_ORIGIN']) && c.vars?.RELAY_MODE === 'dummy',
    exact_worker_origin: !!url && url.protocol === 'https:' && !url.username && !url.password &&
      !url.port && url.pathname === '/' && !url.search && !url.hash &&
      /^kaito-oauth-callback-relay-dummy\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) &&
      origin === b.worker_origin,
    d1_binding: !!db && same(db,['binding','database_name','database_id','migrations_dir']) &&
      db.binding === 'DB' && db.database_name === expectedName && db.migrations_dir === 'migrations' &&
      uuid(db.database_id) && db.database_id !== '00000000-0000-0000-0000-000000000000' &&
      db.database_id === b.database_id && b.database_name === expectedName,
    cron: same(c.triggers,['crons']) &&
      Array.isArray(c.triggers?.crons) && c.triggers.crons.length === 1 &&
      c.triggers.crons[0] === '* * * * *' &&
      Array.isArray(b.crons) && b.crons.length === 1 && b.crons[0] === '* * * * *',
    logs_intent: inspectLogSettings({success:true,result:c}).worker_settings === 'matched',
    preserve_dashboard_vars: c.keep_vars === true,
    rollback_version_noted: uuid(b.active_version_id) && b.traffic_percent === 100,
    secret_names_only: Array.isArray(b.secret_names) &&
      b.secret_names.length === 2 && expectedSecrets.every(x=>b.secret_names.includes(x)),
    free_plan_observed: b.plan === 'free',
    recent_baseline: Number.isFinite(baselineTime) && Number.isFinite(now) &&
      baselineTime <= now && now - baselineTime <= 60 * 60 * 1000,
  };
  const all = Object.values(checks).every(Boolean);
  return {
    candidate_config_check: all ? 'passed_offline_only' : 'blocked',
    checks,
    remote_state_authenticated: false,
    active_version_artifact_identity: 'unverified',
    rollback_success: 'unverified',
    deploy_authorized: false,
    live_oauth_allowed: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('usage');
    const config = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
    const baseline = JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8'));
    const report = inspectCandidate(config, baseline);
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.candidate_config_check !== 'passed_offline_only') process.exitCode = 1;
  } catch {
    process.stdout.write(JSON.stringify({candidate_config_check:'blocked',
      remote_state_authenticated:false,deploy_authorized:false,live_oauth_allowed:false})+'\n');
    process.exitCode = 1;
  }
}
