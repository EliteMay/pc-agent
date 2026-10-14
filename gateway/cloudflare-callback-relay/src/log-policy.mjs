import { plainObject } from './protocol.mjs';

// Input is the official script-settings GET response, not deployment intent.
// Missing defaults are deliberately unknown. Never print its raw payload.
export function inspectLogSettings(payload) {
  const value = plainObject(payload) && payload.success === true && plainObject(payload.result) ? payload.result : {};
  const obs = plainObject(value.observability) ? value.observability : {};
  const logs = plainObject(obs.logs) ? obs.logs : {};
  const traces = plainObject(obs.traces) ? obs.traces : {};
  const empty = x => Array.isArray(x) && x.length === 0;
  const checks = {
    redaction: obs.redact_query_string === true,
    observabilityDisabled: obs.enabled === false,
    logsDisabled: logs.enabled === false,
    invocationDisabled: logs.invocation_logs === false,
    logPersistenceDisabled: logs.persist === false,
    logExportsDisabled: empty(logs.destinations),
    tracesDisabled: traces.enabled === false,
    tracePersistenceDisabled: traces.persist === false,
    traceExportsDisabled: empty(traces.destinations),
    logpushDisabled: value.logpush === false,
    tailConsumersDisabled: empty(value.tail_consumers),
  };
  return { worker_settings: Object.values(checks).every(Boolean) ? 'matched' : 'unverified',
    checks, platform_log_scope: 'unverified', live_oauth_allowed: false };
}
