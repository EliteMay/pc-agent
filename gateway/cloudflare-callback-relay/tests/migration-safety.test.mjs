import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, makeReplaySafe, splitStatements, classify } from '../tools/migration-safety.mjs';

const plain = 'CREATE TABLE a(id TEXT PRIMARY KEY, x INTEGER NOT NULL);\nCREATE INDEX a_x ON a(x);\nCREATE TABLE b(id TEXT PRIMARY KEY);';

test('splits plain and drizzle breakpoint SQL, ignoring comments and quoted semicolons', () => {
  assert.equal(splitStatements(plain).length, 3);
  const drizzle = 'CREATE TABLE `a` (`id` text);--> statement-breakpoint\n-- note;\nCREATE INDEX `i` ON `a` (`id`);';
  assert.equal(splitStatements(drizzle).length, 2);
  assert.equal(splitStatements("CREATE TABLE a(v TEXT DEFAULT 'x;y')").length, 1);
});

test('plain CREATE migration fails a re-run after any partial apply', () => {
  const r = analyze(plain);
  assert.equal(r.verdict, 'replay_unsafe');
  assert.deepEqual(r.retryFailsAfter, [1, 2, 3]);
  assert.equal(r.dataPreserved, true);
});

test('makeReplaySafe converges from every partial state and keeps unrelated data', () => {
  const r = analyze(makeReplaySafe(plain));
  assert.equal(r.verdict, 'replay_safe');
  assert.deepEqual(r.retryFailsAfter, []);
  assert.deepEqual(r.convergeMismatch, []);
});

test('IF NOT EXISTS alone silently accepts a same-named table with a different shape (runtime fingerprint check is needed)', () => {
  const r = analyze(makeReplaySafe(plain));
  assert.equal(r.mismatchedExistingSchemaDetected, true, 'final fingerprint must differ so a runtime check can fail closed');
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

test('existing relay migration 0001 is additive but not re-run safe (already applied live; informational)', () => {
  const sql = readFileSync(new URL('../migrations/0001_relay.sql', import.meta.url), 'utf8');
  const r = analyze(sql);
  assert.equal(r.nonAdditive.length, 0);
  assert.equal(r.verdict, 'replay_unsafe');
  assert.equal(analyze(makeReplaySafe(sql)).verdict, 'replay_safe');
});
