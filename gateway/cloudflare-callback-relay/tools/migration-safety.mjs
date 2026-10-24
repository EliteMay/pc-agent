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

// Minimal SQLite lexer. It only separates strings / quoted identifiers / comments from code so
// they are never edited or mistaken for syntax. Anything it cannot lex with certainty throws
// UnsupportedSql, and the caller refuses the file instead of guessing.
export class UnsupportedSql extends Error {}
function lex(sql, { compound = false } = {}) {
  const tokens = [];
  let i = 0, code = '';
  const flush = () => { if (code) { tokens.push({ type: 'code', text: code }); code = ''; } };
  const quoted = (close) => { // doubled close char is an escape ('' "" ``); ] has no escape
    let j = i + 1;
    for (;;) {
      if (j >= sql.length) throw new UnsupportedSql('unterminated quote');
      if (sql[j] === close) { if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } break; }
      j++;
    }
    return j + 1;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      flush(); const end = quoted(c === '[' ? ']' : c);
      tokens.push({ type: c === "'" ? 'string' : 'ident', text: sql.slice(i, end) }); i = end;
    } else if (c === '-' && sql[i + 1] === '-') {
      flush(); let end = sql.indexOf('\n', i); if (end < 0) end = sql.length;
      tokens.push({ type: 'comment', text: sql.slice(i, end) }); i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      flush(); const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new UnsupportedSql('unterminated comment');
      tokens.push({ type: 'comment', text: sql.slice(i, end + 2) }); i = end + 2;
    } else { code += c; i++; }
  }
  flush();
  for (const t of tokens) if (t.type === 'code' && /\b(begin|trigger|case)\b/i.test(t.text)) throw new UnsupportedSql('compound statement');
  return tokens;
}
const BREAKPOINT = /^-->\s*statement-breakpoint\s*$/;
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  const end = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const t of lex(sql)) {
    if (t.type === 'comment') { if (BREAKPOINT.test(t.text)) end(); else cur += ' '; }
    else if (t.type === 'code') { const parts = t.text.split(';'); parts.forEach((x, k) => { if (k) end(); cur += x; }); }
    else cur += t.text;
  }
  end();
  return out;
}
export function classify(statement) {
  if (TABLE.test(statement)) return { kind: 'create_table', replaySafe: !!statement.match(TABLE)[1] };
  if (INDEX.test(statement)) return { kind: 'create_index', replaySafe: !!statement.match(INDEX)[2] };
  return { kind: 'non_additive', replaySafe: false };
}
// Proposed fix: add IF NOT EXISTS to additive CREATE TABLE/INDEX only, and only where the
// statement starts (code text). Strings, quoted identifiers and comments are copied verbatim.
// Unlexable SQL is returned unchanged by throwing UnsupportedSql to the caller.
export function makeReplaySafe(sql) {
  let atStart = true, out = '';
  for (const t of lex(sql)) {
    if (t.type === 'code') {
      let text = t.text, pos = 0, built = '';
      for (;;) {
        const semi = text.indexOf(';', pos), seg = semi < 0 ? text.slice(pos) : text.slice(pos, semi);
        built += atStart
          ? seg.replace(/^(\s*CREATE(?:\s+UNIQUE)?\s+(?:TABLE|INDEX)\s+)(?!IF\s+NOT\s+EXISTS)/i, '$1IF NOT EXISTS ')
          : seg;
        if (seg.trim()) atStart = false;
        if (semi < 0) break;
        built += ';'; atStart = true; pos = semi + 1;
      }
      out += built;
    } else {
      if (t.type === 'comment' && BREAKPOINT.test(t.text)) atStart = true;
      else if (t.type !== 'comment') atStart = false;
      out += t.text;
    }
  }
  return out;
}
// Normalize layout only, never string contents: string literals are copied verbatim; simple quoted
// identifiers lose their quotes; other quoted identifiers stay verbatim; code is lowercased with
// whitespace collapsed; the DDL-leading IF NOT EXISTS is the only keyword removed. Deliberately
// conservative: a cosmetic difference is reported as a difference (fail closed), never the reverse.
// SQL that cannot be lexed is compared as raw text.
function normalizeSql(sql) {
  const text = String(sql ?? '');
  let tokens;
  try { tokens = lex(text, { compound: true }); } catch { return 'raw:' + text; }
  const out = tokens.map(t => {
    if (t.type === 'string') return t.text;
    if (t.type === 'ident') return /^[`"[]\w+[`"\]]$/.test(t.text) ? t.text.slice(1, -1) : t.text;
    if (t.type === 'comment') return ' ';
    return t.text.toLowerCase().replace(/\s+/g, ' ').replace(/ ?([(),]) ?/g, '$1');
  }).join('');
  return out.trim().replace(/^(create (?:unique )?(?:table|index)) if not exists /, '$1 ');
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
  let statements;
  try { statements = splitStatements(sql); }
  catch (e) { if (e instanceof UnsupportedSql) return { verdict: 'unsupported_sql', reason: e.message }; throw e; }
  if (!statements.length) return { verdict: 'unsupported_sql', reason: 'no statements' };
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

  const clean = new DatabaseSync(':memory:');
  try { run(clean, statements); }
  catch (e) { clean.close(); return { ...report, verdict: 'unsupported_sql', reason: 'does not run on an empty database' }; }
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
