import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLogSettings } from '../src/log-policy.mjs';

const safe = () => ({
  logpush: false, tail_consumers: [],
  observability: { enabled: false, redact_query_string: true,
    logs: { enabled: false, invocation_logs: false, persist: false, destinations: [] },
    traces: { enabled: false, persist: false, destinations: [] } },
});

test('explicit effective Worker settings match the policy without authorizing live OAuth', () => {
  const report = inspectLogSettings({ success: true, result: safe() });
  assert.equal(report.worker_settings, 'matched');
  assert.equal(report.platform_log_scope, 'unverified');
  assert.equal(report.live_oauth_allowed, false);
  assert.ok(Object.values(report.checks).every(x => x === true));
});

test('each enabled logger, trace, export or missing flag prevents a match', () => {
  const changes = [
    x => x.logpush = true,
    x => x.tail_consumers = [{ service: 'private-canary' }],
    x => x.observability.enabled = true,
    x => x.observability.redact_query_string = false,
    x => x.observability.logs.enabled = true,
    x => x.observability.logs.invocation_logs = true,
    x => x.observability.logs.persist = true,
    x => x.observability.logs.destinations.push('private-canary'),
    x => x.observability.traces.enabled = true,
    x => x.observability.traces.persist = true,
    x => x.observability.traces.destinations.push('private-canary'),
    x => delete x.observability.redact_query_string,
    x => delete x.tail_consumers,
    x => delete x.observability.logs.persist,
    x => delete x.observability.traces,
  ];
  for (const change of changes) {
    const data = safe(); change(data);
    const report = inspectLogSettings({ success: true, result: data });
    assert.equal(report.worker_settings, 'unverified');
    assert.equal(report.live_oauth_allowed, false);
  }
});

test('absent, malformed or unsuccessful API responses never become verified', () => {
  for (const input of [undefined, null, {}, [], safe(), { success: false, result: safe() },
    { success: true, result: null }, { success: true, result: [] }]) {
    assert.equal(inspectLogSettings(input).worker_settings, 'unverified');
  }
});

test('the report contains only fixed labels and booleans, never raw metadata or errors', () => {
  const data = safe(); data.observability.logs.destinations.push('dummy-code-private-canary');
  const report = inspectLogSettings({ success: true, result: data, errors: [{ message: 'private-canary' }] });
  assert.doesNotMatch(JSON.stringify(report), /private-canary|dummy-code|destinations/);
  assert.deepEqual(Object.keys(report).sort(), ['checks', 'live_oauth_allowed', 'platform_log_scope', 'worker_settings']);
  assert.ok(Object.values(report.checks).every(x => typeof x === 'boolean'));
});
