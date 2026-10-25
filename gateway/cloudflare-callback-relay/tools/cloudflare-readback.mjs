// Authenticated Cloudflare metadata readback. GET only, fixed labels only.
// Never copy this tool's token or raw API response into a chat, GitHub or CI.
import { inspectLogSettings } from '../src/log-policy.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT = 'kaito-oauth-callback-relay-dummy';
const API = 'https://api.cloudflare.com/client/v4';
const MAX_BODY = 256 * 1024;
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const envelope = x => obj(x) && x.success === true && obj(x.result) ? x.result : null;
const readFail = () => ({ readback: 'unverified', all_requests_get_only: true,
  remote_state_authenticated: false, active_version_binary_identity: 'unverified',
  deploy_authorized: false, live_oauth_allowed: false });

export function inspectReadback({ deployments, version, schedules, scriptSettings }) {
  const d = envelope(deployments)?.deployments;
  const active = Array.isArray(d) ? d[0] : null;
  const versions = active?.versions;
  const single = Array.isArray(versions) && versions.length === 1 && versions[0]?.percentage === 100;
  const activeId = single ? versions[0].version_id : null;
  const versionResult = envelope(version);
  const clock = envelope(schedules)?.schedules;
  const script = envelope(scriptSettings);
  const logResult = script ? inspectLogSettings(scriptSettings).worker_settings : 'unverified';
  const bindings = versionResult?.resources?.bindings;
  // Cloudflare's Version API documents resources.bindings as an object;
  // older/alternate responses may expose an array of named entries.
  // Unknown formats remain unverified rather than presumed absent.
  const names = Array.isArray(bindings)
    ? bindings.every(x => obj(x) && typeof x.name === 'string') ? bindings.map(x => x.name) : null
    : obj(bindings) ? Object.keys(bindings) : null;
  const date = versionResult?.resources?.script_runtime?.compatibility_date;
  const expectedDate = date === '2026-10-10' ||
    /^2026-10-10T00:00:00(?:[.]0+)?Z$/.test(date ?? '');
  const checks = {
    active_single_version: single && uuid(activeId) && uuid(active?.id),
    version_detail_matches_active: uuid(activeId) && versionResult?.id === activeId,
    runtime_date_matches_expected: expectedDate,
    expected_handlers: Array.isArray(versionResult?.resources?.script?.handlers) &&
      versionResult.resources.script.handlers.includes('fetch') &&
      versionResult.resources.script.handlers.includes('scheduled'),
    expected_binding_names_present: names !== null &&
      ['DB','RELAY_MODE','RELAY_ORIGIN','RELAY_SIGNING_KEY','RELAY_STORAGE_KEY'].every(x => names.includes(x)),
    cron_readback: Array.isArray(clock) && clock.length === 1 && clock[0]?.cron === '* * * * *',
    logpush_off: script?.logpush === false,
    no_tail_consumers: script?.tail_consumers === null ||
      (Array.isArray(script?.tail_consumers) && script.tail_consumers.length === 0),
    logs_disabled_observed: logResult === 'disabled_observed' || logResult === 'matched',
  };
  // A successful read does NOT validate billing plan, source/byte identity,
  // the provenance of the Worker version, the platform's private logs,
  // or that its bindings match the intended local deployment configuration.
  return {
    readback: Object.values(checks).every(Boolean) ? 'metadata_consistent' : 'unverified',
    checks,
    log_settings: logResult,
    active_version_binary_identity: 'unverified',
    platform_log_scope: 'unverified',
    free_plan_verified: false,
    rollback_tested: false,
    deploy_authorized: false,
    live_oauth_allowed: false,
  };
}

async function getJSON(fetcher, path, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(API + path, {method:'GET', redirect:'error',
      cache:'no-store', signal: controller.signal,
      headers: {Authorization: 'Bearer ' + token, Accept:'application/json'}});
    if (response.status !== 200 || !/^application\/json\b/i.test(response.headers.get('content-type')??''))
      throw new Error('request_failed');
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > MAX_BODY) throw new Error('response_too_large');
    if (!response.body) throw new Error('empty_body');
    const reader = response.body.getReader();
    const chunks=[];let length=0;
    while(true) {
      const {done,value} = await reader.read();
      if(done) break;
      length += value.length;
      if(length > MAX_BODY) {await reader.cancel();throw new Error('response_too_large');}
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);let offset=0;
    for(const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.length; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } finally {clearTimeout(timeout);controller.abort();}
}

export async function readCloudflare({accountId, token, fetcher=fetch}) {
  if (!/^[a-f0-9]{32}$/i.test(accountId??'') || typeof token !== 'string' ||
    token.length < 16 || token.length > 512 || /\s/.test(token)) return readFail();
  const prefix = '/accounts/' + accountId + '/workers/scripts/' + SCRIPT;
  try {
    const deployments = await getJSON(fetcher, prefix + '/deployments', token);
    const d = envelope(deployments)?.deployments;
    const current = Array.isArray(d) ? d[0] : null;
    const v = current?.versions;
    if (!Array.isArray(v) || v.length !== 1 || v[0]?.percentage !== 100 ||
      !uuid(v[0].version_id)) return {...readFail(), readback:'unverified_deployment'};
    const versionId = v[0].version_id;
    // The version metadata endpoint is pinned to the Version ID from the deployment.
    const [version, schedules, scriptSettings] = await Promise.all([
      getJSON(fetcher,prefix+'/versions/'+versionId,token),
      getJSON(fetcher,prefix+'/schedules',token),
      getJSON(fetcher,prefix+'/script-settings',token),
    ]);
    // Re-read deployments to avoid accepting an outdated rollout observed
    // before the other requests. Never mistake local timing for a guarantee.
    const after = await getJSON(fetcher, prefix + '/deployments', token);
    const afterActive = envelope(after)?.deployments?.[0];
    const stable = afterActive?.id === current?.id &&
      Array.isArray(afterActive?.versions) && afterActive.versions.length === 1 &&
      afterActive.versions[0]?.percentage === 100 &&
      afterActive.versions[0]?.version_id === versionId;
    if (!stable) return {...readFail(), readback:'unverified_deployment_changed'};
    const report = inspectReadback({deployments,version,schedules,scriptSettings});
    return {...report, remote_state_authenticated:true, all_requests_get_only:true};
  } catch {
    // Error responses and exceptions can contain tokens or arbitrary URLs.
    return readFail();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await readCloudflare({accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN});
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.readback !== 'metadata_consistent') process.exitCode = 1;
  } catch {
    process.stdout.write(JSON.stringify(readFail()) + '\n');
    process.exitCode = 1;
  }
}
