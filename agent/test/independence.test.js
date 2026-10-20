import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Goal #29: the production path (Agent and Gateway) must not depend on Remote Desktop Commander.
// The optional Manager "Game Safety" supervisor for it is covered by the Manager tests and by
// scripts/Test-PcAgentIndependence.ps1 on the real machine.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORBIDDEN = /desktop[-_ ]?commander|wonderwhy/i;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "node_modules") yield* files(full); }
    else if (/\.(js|mjs|ts|ps1|json)$/.test(name)) yield full;
  }
}

for (const rel of ["agent/src", "agent/bin", "gateway/oauth-pc-agent", "gateway/pc-agent-device"]) {
  test(`${rel} has no Desktop Commander dependency`, () => {
    const dir = path.join(root, rel);
    const scanned = [...files(dir)];
    assert.ok(scanned.length > 0, `${rel} should contain source files`);
    for (const file of scanned) {
      assert.doesNotMatch(readFileSync(file, "utf8"), FORBIDDEN, path.relative(root, file));
    }
  });
}

test("Agent package declares no runtime dependency on a remote-control provider", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "agent", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.doesNotMatch(JSON.stringify(manifest), FORBIDDEN);
});
