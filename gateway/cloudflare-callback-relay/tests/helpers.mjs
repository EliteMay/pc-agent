import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, randomBytes } from 'node:crypto';

// Public, deliberately non-production test keys; never used in hosted settings.
export const KEY = Buffer.alloc(32, 7).toString('base64url');
export const STORAGE_KEY = Buffer.alloc(32, 9).toString('base64url');
export const ORIGIN = 'https://relay.example.invalid';
export const SITE = 'https://kaito-pc-agent-web-bridge.kaito2526.chatgpt.site';
export const ISSUER = 'https://vtnwbgejlaqpnwmlzbjy.supabase.co/auth/v1';
export const epoch = 1800000000000;
export const value = () => randomBytes(32).toString('base64url');
export const digest = x => createHash('sha256').update(x).digest('base64url');

export function signed(path, body, { key = KEY, now = epoch, nonce = value(), origin = ORIGIN } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const time = String(Math.floor(now / 1000));
  const message = ['kaito-relay-v1', origin, 'POST', path, time, nonce, digest(text)].join('\n');
  const signature = createHmac('sha256', Buffer.from(key, 'base64url')).update(message).digest('base64url');
  return new Request(origin + path, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-relay-time': time, 'x-relay-nonce': nonce, 'x-relay-signature': signature,
  }, body: text });
}

export function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_relay.sql', import.meta.url), 'utf8'));
  let tail = Promise.resolve();
  // D1 batch runs synchronously inside one SQLite transaction. Queue transactions
  // so this adapter does not conceal or invent overlap behavior.
  const atomic = task => {
    const result = tail.then(task); tail = result.catch(() => {}); return result;
  };
  return {
    sql,
    prepare(query) {
      let args = [];
      const execute = () => {
        const stmt = sql.prepare(query);
        const rows = stmt.columns().length ? stmt.all(...args) : [];
        const result = rows.length || stmt.columns().length ? null : stmt.run(...args);
        const changes = result?.changes ?? sql.prepare('SELECT changes() AS n').get().n;
        return { results: rows, success: true, meta: { changes: Number(changes) } };
      };
      return { bind(...values) { args = values; return this; },
        async first() { return atomic(() => execute().results[0] ?? null); },
        async run() { return atomic(execute); }, async all() { return atomic(execute); }, _execute: execute };
    },
    async batch(statements) { return atomic(() => {
      sql.exec('BEGIN');
      try { const result = statements.map(s => s._execute()); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    }); },
    rows(table) { return sql.prepare(`SELECT * FROM ${table}`).all(); },
    dump() { return JSON.stringify(['relay_pending', 'relay_nonces', 'relay_limits'].map(t => this.rows(t))); },
  };
}

export async function fixture(options = {}) {
  const { createWorker } = await import('../src/worker.mjs');
  let now = epoch;
  const DB = database();
  const env = { DB, RELAY_MODE: 'dummy', RELAY_ORIGIN: ORIGIN, RELAY_SIGNING_KEY: KEY, RELAY_STORAGE_KEY: STORAGE_KEY, ...options.env };
  const worker = createWorker({ clock: () => now });
  const state = value(), binding = digest('owner-browser-session');
  const request = (path, body, opts) => signed(path, body, { now, ...opts });
  const prepare = async (s = state, b = binding) => worker.fetch(request('/prepare', { state: s, binding: b }), env);
  const callback = (query = `code=dummy-code-canary&state=${state}`) => worker.fetch(new Request(`${ORIGIN}/oauth/callback?${query}`), env);
  const claim = (opts = {}) => worker.fetch(request('/claim', { state, binding, ...opts.body }, opts), env);
  return { DB, env, worker, state, binding, prepare, callback, claim, request, advance: ms => { now += ms; }, clock: () => now };
}
