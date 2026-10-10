import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inspectLogSettings } from '../src/log-policy.mjs';

const root = new URL('../', import.meta.url);
let count = 0;
try {
  for (const folder of ['src', 'tests', 'tools']) {
    for (const name of readdirSync(new URL(folder + '/', root)).filter(x => x.endsWith('.mjs'))) {
      const file = new URL(folder + '/' + name, root);
      if (spawnSync(process.execPath, ['--check', file.pathname], { stdio: 'ignore' }).status !== 0) throw 0;
      const source = readFileSync(file, 'utf8');
      if (folder === 'src' && /\bconsole\s*\.|\beval\s*\(|\bnew\s+Function\b/.test(source)) throw 0;
      if (folder === 'src' && name !== 'sites-client.mjs' && /(?<!async )\bfetch\s*\(/.test(source)) throw 0;
      count++;
    }
  }
  const config = JSON.parse(readFileSync(new URL('wrangler.json', root), 'utf8'));
  if (inspectLogSettings({ success: true, result: config }).worker_settings !== 'matched' ||
    config.vars.RELAY_MODE !== 'dummy' || config.vars.RELAY_ORIGIN !== 'https://relay.example.invalid' ||
    Object.keys(config.vars).sort().join(',') !== 'RELAY_MODE,RELAY_ORIGIN' ||
    config.d1_databases[0].database_id !== '00000000-0000-0000-0000-000000000000' ||
    config.preview_urls !== false || config.send_metrics !== false || config.triggers.crons.join(',') !== '* * * * *') throw 0;
  process.stdout.write(`Syntax and source/config safety checks passed (${count} modules). No platform deployment or log guarantee.\n`);
} catch {
  process.stderr.write('Source/config validation failed; no raw input printed.\n');
  process.exitCode = 1;
}
