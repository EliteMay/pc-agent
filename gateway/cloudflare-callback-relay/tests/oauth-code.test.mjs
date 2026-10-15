import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthCode, dummyCode } from '../src/protocol.mjs';

test('oauthCode accepts bounded URL-safe codes of the shapes an OAuth server may issue', () => {
  for (const x of ['a', '0f8fad5b-d9cb-469f-a165-70867728950e', 'A-b_c.d~E', 'eyJhbGciOi.J9eyJzdWIi.abc-_', 'x'.repeat(512)]) assert.equal(oauthCode(x), true);
});

test('oauthCode refuses empty, oversized, whitespace, delimiter, encoding and non-string input', () => {
  for (const x of ['', 'x'.repeat(513), 'a b', 'a\nb', 'a/b', 'a+b', 'a=b', 'a%20b', 'a&b', 'a"b', "a'b", 'a<b', 'a\\b', 'é', undefined, null, 1, ['a'], {}]) assert.equal(oauthCode(x), false);
});

test('dummy mode stays strict: live-shaped codes are not dummy codes', () => {
  assert.equal(dummyCode('0f8fad5b-d9cb-469f-a165-70867728950e'), false);
  assert.equal(dummyCode('dummy-code-a'), true);
});
