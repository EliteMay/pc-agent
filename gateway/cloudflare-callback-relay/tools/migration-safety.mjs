// Local replay/shape check for additive SQLite migrations. In-memory node:sqlite only:
// it never touches Cloudflare, Sites or any hosted DB.
//
// What a result means (and does not mean):
//  * `rerun_safe` = on LOCAL SQLite, committing the first k statements one by one and then
//    running the whole file again succeeds for every k and converges to the same shape.
//  * It does NOT model a hosted runner: transaction scope, migration history/checksums,
//    concurrent deploys, D1-specific behaviour or SQL-vs-history atomicity are unknown.
//  * Re-run safety is NOT schema compatibility. `IF NOT EXISTS` silently keeps a same-named
//    table of a different shape; see `existingSchema`. Compatibility must be checked at
//    runtime with fingerprint(), and that check is not provided by this file's verdict.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
// Lowercase outside quotes, drop identifier quoting and layout. Deliberately conservative:
// a cosmetic difference is reported as a difference (fail closed), never the reverse.
function normalizeSql(sql) {
  let out = '', quote = '';
  for (const ch of String(sql ?? '')) {
    if (quote) { out += ch; if (ch === quote) quote = ''; continue; }
    if (ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '`' || ch === '"' || ch === '[' || ch === ']') continue;
    out += ch.toLowerCase();
  }
  return out.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').replace(/ if not exists/g, '').trim();
}
// Structure including CHECK/DEFAULT/FK/collation/partial-index/WITHOUT ROWID/triggers/views.
// PRAGMAs give structured facts; normalized sqlite_master.sql covers what PRAGMAs cannot (CHECK, WHERE).
export function fingerprint(db) {
  const q = n => JSON.stringify(n);
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const shape = objects.map(o => {
    const entry = { type: o.type, name: o.name, sql: normalizeSql(o.sql) };
    if (o.type === 'table') {
      entry.columns = db.prepare(`PRAGMA table_xinfo(${q(o.name)})`).all().map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk, c.hidden]);
      entry.foreignKeys = db.prepare(`PRAGMA foreign_key_list(${q(o.name)})`).all()
        .map(f => [f.table, f.from, f.to, f.on_update, f.on_delete, f.match]).sort();
      entry.indexes = db.prepare(`PRAGMA index_list(${q(o.name)})`).all().map(i => [i.name, i.unique, i.origin, i.partial,
        db.prepare(`PRAGMA index_xinfo(${q(i.name)})`).all().map(c => [c.seqno, c.cid, c.name, c.desc, c.coll, c.key])]).sort();
    }
    return entry;
  });
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
  const report = { statements: statements.length, nonAdditive: [], notIfNotExists: [], retryFailsAfter: [],
    convergeMismatch: [], dataPreserved: null,
    // Re-run safety says nothing about whether an EXISTING same-named table is the right shape.
    existingSchema: { compatibilityGuaranteedBySql: false, requiresRuntimeFingerprintCheck: true, sameNameDifferentShape: [] } };
  kinds.forEach((k, i) => {
    if (k.kind === 'non_additive') report.nonAdditive.push(i + 1);
    else if (!k.replaySafe) report.notIfNotExists.push(i + 1);
  });
  if (report.nonAdditive.length) return { ...report, verdict: 'not_additive' };

  const clean = new DatabaseSync(':memory:'); run(clean, statements);
  const expected = fingerprint(clean); clean.close();

  // Crash after k committed statements, then the whole file is run again.
  for (let k = 0; k <= statements.length; k++) {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO unrelated VALUES(1,'keep')");
    run(db, statements.slice(0, k));
    if (tryRun(db, statements)) report.retryFailsAfter.push(k);
    else {
      db.exec('DROP TABLE unrelated');
      if (fingerprint(db) !== expected) report.convergeMismatch.push(k);
    }
    db.close();
  }
  // For every created table: a same-named table of a different shape already exists.
  statements.forEach((stmt, i) => {
    if (kinds[i].kind !== 'create_table') return;
    const name = stmt.match(TABLE)[2].replace(/[`"[\]]/g, '');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE ${JSON.stringify(name)}(unexpected_column TEXT)`);
    const error = tryRun(db, statements);
    report.existingSchema.sameNameDifferentShape.push({ table: name,
      sqlOutcome: error ? 'error' : 'silently_accepted', shapeDiffersFromExpected: fingerprint(db) !== expected });
    db.close();
  });
  const keep = new DatabaseSync(':memory:');
  keep.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO unrelated VALUES(1,'keep')");
  tryRun(keep, statements);
  report.dataPreserved = keep.prepare('SELECT v FROM unrelated WHERE id=1').get()?.v === 'keep';
  keep.close();

  const rerunSafe = !report.retryFailsAfter.length && !report.convergeMismatch.length && report.dataPreserved;
  return { ...report, expectedFingerprint: expected, verdict: rerunSafe ? 'rerun_safe' : 'rerun_unsafe' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), suggest = args.includes('--suggest');
  const files = args.filter(a => !a.startsWith('--'));
  if (!files.length) { process.stderr.write('usage: migration-safety.mjs [--suggest] <file.sql>...\n'); process.exit(2); }
  let bad = false;
  const digest = text => createHash('sha256').update(text).digest('hex');
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    const { expectedFingerprint, ...result } = analyze(sql);
    process.stdout.write(JSON.stringify({ file, scope: 'local-sqlite-only', ...result,
      expectedShapeSha256: expectedFingerprint ? digest(expectedFingerprint) : null }) + '\n');
    if (result.verdict !== 'rerun_safe') bad = true;
    if (suggest && result.verdict === 'rerun_unsafe') {
      const { expectedFingerprint: fp, ...fixed } = analyze(makeReplaySafe(sql));
      process.stdout.write(JSON.stringify({ file, suggestion: 'add IF NOT EXISTS', suggestedVerdict: fixed.verdict,
        existingSchema: fixed.existingSchema }) + '\n');
    }
  }
  process.exitCode = bad ? 1 : 0;
}
