import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The Windows bundle ships its own Node runtime (Runtime\node.exe). The release workflow installs
// the runtime from .node-version, and Test-PcAgentRelease.ps1 refuses a bundle older than it, so
// a floating "22" can no longer ship a runtime that lags a Node security release.
const repo = new URL("../../", import.meta.url);
const pinned = readFileSync(new URL(".node-version", repo), "utf8").trim();
const manifest = JSON.parse(readFileSync(new URL("agent/package.json", repo), "utf8"));

test(".node-version is an exact x.y.z release", () => {
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
});

test("pinned runtime satisfies the Agent's declared engine range", () => {
  const minimumMajor = Number(/>=\s*(\d+)/.exec(manifest.engines.node)?.[1]);
  assert.ok(Number(pinned.split(".")[0]) >= minimumMajor, `${pinned} vs ${manifest.engines.node}`);
});

test("CI and release workflows read the runtime from .node-version, never a floating major", () => {
  for (const name of ["agent-ci", "manager-ci", "release"]) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}.yml`, repo), "utf8");
    assert.match(workflow, /node-version-file:\s*'\.node-version'/, name);
    assert.doesNotMatch(workflow, /node-version:\s*'?\d+'?\s*$/m, `${name} must not pin a floating major`);
  }
});

test("bundle verification enforces the pinned runtime as a floor", () => {
  for (const name of ["manager-ci", "release"]) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}.yml`, repo), "utf8");
    assert.match(workflow, /Test-PcAgentRelease\.ps1[^\n]*-MinimumNodeVersion[^\n]*\.node-version/, name);
  }
});
