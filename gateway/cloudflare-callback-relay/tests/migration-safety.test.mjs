import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { analyze, makeReplaySafe, splitStatements, classify, fingerprint } from '../tools/migration-safety.mjs';

const plain = 'CREATE TABLE a(id TEXT PRIMARY KEY, x INTEGER NOT NULL);\nCREATE INDEX a_x ON a(x);\nCREATE TABLE b(id TEXT PRIMARY KEY);';
const shape = ddl => { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=OFF;' + ddl); const f = fingerprint(db); db.close(); return f; };

test('splits plain and drizzle breakpoint SQL, ignoring comments and quoted semicolons', () => {
  assert.equal(splitStatements(plain).length, 3);
  const drizzle = 'CREATE TABLE `a` (`id` text);--> statement-breakpoint\n-- note;\nCREATE INDEX `i` ON `a` (`id`);';
  assert.equal(splitStatements(drizzle).length, 2);
  assert.equal(splitStatements("CREATE TABLE a(v TEXT DEFAULT 'x;y')").length, 1);
});

test('plain CREATE migration fails a re-run after any partial apply', () => {
  const r = analyze(plain);
  assert.equal(r.verdict, 'rerun_unsafe');
  assert.deepEqual(r.retryFailsAfter, [1, 2, 3]);
  assert.equal(r.dataPreserved, true);
});

test('IF NOT EXISTS version is rerun_safe from every partial state, with unrelated data kept', () => {
  const r = analyze(makeReplaySafe(plain));
  assert.equal(r.verdict, 'rerun_safe');
  assert.deepEqual(r.retryFailsAfter, []);
  assert.deepEqual(r.convergeMismatch, []);
});

test('rerun_safe never claims schema compatibility: a same-named different-shape table is silently kept', () => {
  const r = analyze(makeReplaySafe(plain));
  assert.equal(r.verdict, 'rerun_safe');
  assert.equal(r.existingSchema.compatibilityGuaranteedBySql, false);
  assert.equal(r.existingSchema.requiresRuntimeFingerprintCheck, true);
  assert.deepEqual(r.existingSchema.sameNameDifferentShape.map(x => [x.table, x.sqlOutcome, x.shapeDiffersFromExpected]),
    // 'a' stops loudly only because a LATER statement (index on a.x) needs the missing column; 'b' has no such dependent.
    [['a', 'error', true], ['b', 'silently_accepted', true]]);
  // Without IF NOT EXISTS every such table is a loud SQL error instead (but leaves earlier statements applied).
  assert.ok(analyze(plain).existingSchema.sameNameDifferentShape.every(x => x.sqlOutcome === 'error'));
});

test('fingerprint distinguishes CHECK, DEFAULT, FOREIGN KEY, UNIQUE, COLLATE, partial index, WITHOUT ROWID, view, trigger', () => {
  const base = 'CREATE TABLE p(id TEXT PRIMARY KEY);CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER NOT NULL, s TEXT);';
  const same = shape(base);
  const variants = {
    check: base.replace('n INTEGER NOT NULL', 'n INTEGER NOT NULL CHECK(n>0)'),
    default: base.replace('n INTEGER NOT NULL', 'n INTEGER NOT NULL DEFAULT 0'),
    fk: base.replace('s TEXT', 's TEXT REFERENCES p(id) ON DELETE CASCADE'),
    unique: base.replace('s TEXT', 's TEXT UNIQUE'),
    collate: base.replace('s TEXT', 's TEXT COLLATE NOCASE'),
    withoutRowid: base.replace('s TEXT)', 's TEXT) WITHOUT ROWID'),
    index: base + 'CREATE INDEX i ON t(n);',
    partialIndex: base + 'CREATE INDEX i ON t(n) WHERE n>0;',
    descIndex: base + 'CREATE INDEX i ON t(n DESC);',
    view: base + 'CREATE VIEW v AS SELECT id FROM t;',
    trigger: base + 'CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END;',
  };
  const seen = new Set([same]);
  for (const [name, ddl] of Object.entries(variants)) {
    const f = shape(ddl);
    assert.ok(!seen.has(f), `${name} must change the fingerprint`);
    seen.add(f);
  }
  assert.equal(shape(variants.index), shape(variants.index), 'deterministic');
});

test('fingerprint ignores layout, identifier quoting and IF NOT EXISTS only', () => {
  const a = shape('CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER);');
  assert.equal(a, shape('CREATE TABLE IF NOT EXISTS `t` (\n  "id" TEXT PRIMARY KEY,\n  "n"  INTEGER\n);'));
  assert.notEqual(a, shape("CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER DEFAULT 'A');"));
  assert.notEqual(shape("CREATE TABLE t(v TEXT DEFAULT 'A');"), shape("CREATE TABLE t(v TEXT DEFAULT 'a');"), 'string literals are case-sensitive');
});

test('non-additive SQL is rejected before any simulation', () => {
  for (const sql of ['DROP TABLE a;', 'CREATE TABLE a(id TEXT); DELETE FROM a;', 'ALTER TABLE a ADD COLUMN y TEXT;']) {
    assert.equal(analyze(sql).verdict, 'not_additive');
  }
  assert.equal(classify('INSERT INTO a VALUES(1)').kind, 'non_additive');
});

test('makeReplaySafe never rewrites non-CREATE statements', () => {
  assert.equal(makeReplaySafe('DROP TABLE a;'), 'DROP TABLE a;');
  assert.match(makeReplaySafe('CREATE UNIQUE INDEX i ON a(x);'), /CREATE UNIQUE INDEX IF NOT EXISTS i/);
});

test('Cloudflare relay migration 0001 (NOT the Sites saved-v5 SQL) is additive but not rerun_safe locally', () => {
  const sql = readFileSync(new URL('../migrations/0001_relay.sql', import.meta.url), 'utf8');
  const r = analyze(sql);
  assert.equal(r.nonAdditive.length, 0);
  assert.equal(r.verdict, 'rerun_unsafe');
  assert.equal(analyze(makeReplaySafe(sql)).verdict, 'rerun_safe');
});
