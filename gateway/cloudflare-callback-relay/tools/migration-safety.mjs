// Runner-independent migration safety check. Local in-memory SQLite only: it never
// touches Cloudflare, Sites or any hosted DB. It does NOT prove how a hosted runner
// behaves; it proves the SQL tolerates ANY partial application followed by a full
// re-run, which is the worst case for a runner with unknown transaction/retry rules.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = '[`"\\[]?\\w+[`"\\]]?';
const TABLE = new RegExp(`^CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})`, 'i');
const INDEX = new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})`, 'i');

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}
export function splitStatements(sql) {
  const parts = /-->\s*statement-breakpoint/.test(sql) ? sql.split(/-->\s*statement-breakpoint/) : [sql];
  const out = [];
  for (const part of parts) {
    let cur = '', quote = '';
    for (const ch of stripComments(part)) {
      if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
      if (ch === ';') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
  }
  return out.map(s => s.trim()).filter(Boolean);
}
export function classify(statement) {
  if (TABLE.test(statement)) return { kind: 'create_table', replaySafe: !!statement.match(TABLE)[1] };
  if (INDEX.test(statement)) return { kind: 'create_index', replaySafe: !!statement.match(INDEX)[2] };
  return { kind: 'non_additive', replaySafe: false };
}
// Proposed fix: add IF NOT EXISTS to additive CREATEs only. Never touches other SQL.
export function makeReplaySafe(sql) {
  return sql.replace(/\bCREATE(\s+UNIQUE)?\s+(TABLE|INDEX)\s+(?!IF\s+NOT\s+EXISTS)/gi,
    (_, unique = '', kind) => `CREATE${unique} ${kind} IF NOT EXISTS `);
}
// Structure only (columns, types, notnull, pk, indexes), independent of SQL text.
export function fingerprint(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const shape = {};
  for (const { name } of tables) {
    const q = JSON.stringify(name);
    shape[name] = {
      columns: db.prepare(`PRAGMA table_info(${q})`).all().map(c => [c.name, c.type, c.notnull, c.pk]),
      indexes: db.prepare(`PRAGMA index_list(${q})`).all().filter(i => i.origin === 'c')
        .map(i => [i.name, i.unique, db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map(c => c.name)]).sort(),
    };
  }
  return JSON.stringify(shape);
}
function run(db, statements) {
  for (const s of statements) db.exec(s);
}
function tryRun(db, statements) {
  try { run(db, statements); return null; } catch (e) { return String(e.message).slice(0, 120); }
}

export function analyze(sql) {
  const statements = splitStatements(sql);
  const kinds = statements.map(classify);
  const report = { statements: statements.length, nonAdditive: [], replayUnsafe: [], retryFailsAfter: [],
    convergeMismatch: [], mismatchedExistingSchemaDetected: null, dataPreserved: null };
  kinds.forEach((k, i) => {
    if (k.kind === 'non_additive') report.nonAdditive.push(i + 1);
    else if (!k.replaySafe) report.replayUnsafe.push(i + 1);
  });
  if (report.nonAdditive.length) return { ...report, verdict: 'not_additive' };

  const clean = new DatabaseSync(':memory:'); run(clean, statements);
  const expected = fingerprint(clean); clean.close();

  // Crash after k committed statements, then runner retries the whole file.
  for (let k = 0; k <= statements.length; k++) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE unrelated(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO unrelated VALUES(1,\'keep\')');
    run(db, statements.slice(0, k));
    if (tryRun(db, statements)) report.retryFailsAfter.push(k);
    else {
      db.exec('DROP TABLE unrelated');
      if (fingerprint(db) !== expected) report.convergeMismatch.push(k);
    }
    db.close();
  }
  // Same-named table with a different shape already exists (e.g. an older partial build).
  const first = statements.find((_, i) => kinds[i].kind === 'create_table');
  if (first) {
    const db = new DatabaseSync(':memory:');
    const name = first.match(TABLE)[2].replace(/[`"[\]]/g, '');
    db.exec(`CREATE TABLE ${JSON.stringify(name)}(unexpected_column TEXT)`);
    tryRun(db, statements);
    db.exec('DROP TABLE IF EXISTS unrelated');
    report.mismatchedExistingSchemaDetected = fingerprint(db) !== expected;
    db.close();
  }
  // Existing rows in unrelated tables survive a full apply.
  const keep = new DatabaseSync(':memory:');
  keep.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO unrelated VALUES(1,'keep')");
  tryRun(keep, statements);
  report.dataPreserved = keep.prepare('SELECT v FROM unrelated WHERE id=1').get()?.v === 'keep';
  keep.close();

  const replaySafe = !report.retryFailsAfter.length && !report.convergeMismatch.length;
  return { ...report, expectedFingerprint: expected, verdict: replaySafe && report.dataPreserved ? 'replay_safe' : 'replay_unsafe' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), suggest = args.includes('--suggest');
  const files = args.filter(a => !a.startsWith('--'));
  if (!files.length) { process.stderr.write('usage: migration-safety.mjs [--suggest] <file.sql>...\n'); process.exit(2); }
  let bad = false;
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    const { expectedFingerprint, ...result } = analyze(sql);
    process.stdout.write(JSON.stringify({ file, ...result }) + '\n');
    if (result.verdict !== 'replay_safe') bad = true;
    if (suggest && result.verdict === 'replay_unsafe') {
      const fixed = analyze(makeReplaySafe(sql));
      process.stdout.write(JSON.stringify({ file, suggestedVerdict: fixed.verdict,
        mismatchedExistingSchemaDetected: fixed.mismatchedExistingSchemaDetected }) + '\n');
    }
  }
  process.exitCode = bad ? 1 : 0;
}
