import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeBearerToken } from "./oauth-site-smoke-validation.mjs";

const sampleJwt = [
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiJ0ZXN0LXVzZXIiLCJjbGllbnRfaWQiOiJzaXRlIn0",
  "sample-signature-with-s-and-r",
].join(".");

test("ordinary JWT-looking tokens with s and r are not mistakenly rejected", () => {
  assert.ok(sampleJwt.includes("s"));
  assert.ok(sampleJwt.includes("r"));
  assert.equal(isSafeBearerToken(sampleJwt), true);
  assert.equal(isSafeBearerToken("a".repeat(45) + "s" + "r"), true);
});

test("reject whitespace, newline, tabs and Authorization header prefixes", () => {
  for (const token of [
    "Bearer " + sampleJwt,
    " " + sampleJwt,
    sampleJwt + " ",
    sampleJwt + "\r\n",
    sampleJwt + "\n",
    sampleJwt + "\t",
    sampleJwt + "\u00a0",
  ]) assert.equal(isSafeBearerToken(token), false);
});

test("reject missing, nonsensical or undersized token input", () => {
  for (const token of [null, undefined, "", 42, {}, ["token"], "x".repeat(39)]) {
    assert.equal(isSafeBearerToken(token), false);
  }
});
