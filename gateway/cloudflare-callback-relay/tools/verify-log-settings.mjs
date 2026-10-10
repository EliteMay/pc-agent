import { inspectLogSettings } from '../src/log-policy.mjs';

// Pipe the official script-settings GET JSON locally. This tool never makes
// network requests, needs no API token, and prints no account/raw settings.
let text = '', oversized = false;
for await (const chunk of process.stdin) {
  if (Buffer.byteLength(text) + chunk.length > 65536) oversized = true;
  if (!oversized) text += chunk.toString('utf8');
}
let data;
try { if (!oversized) data = JSON.parse(text); } catch {}
const report = inspectLogSettings(data);
process.stdout.write(JSON.stringify(report) + '\n');
process.exitCode = report.worker_settings === 'matched' ? 0 : 1;
