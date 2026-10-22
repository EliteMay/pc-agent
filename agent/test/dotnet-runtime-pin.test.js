import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Branch feat/dotnet10-manager: the self-contained Manager embeds its .NET runtime. The runtime
// version it embeds is whatever the build SDK knows, so the pinned minimum below is enforced on
// the finished bundle by Test-PcAgentRelease.ps1 (-MinimumDotNetRuntime).
const repo = new URL("../../", import.meta.url);
const pinned = readFileSync(new URL(".dotnet-runtime-version", repo), "utf8").trim();

test(".dotnet-runtime-version is an exact 10.0.x release", () => {
  assert.match(pinned, /^10\.0\.\d+$/);
});

test("Manager and its tests target the same .NET 10 framework", () => {
  for (const file of ["manager/PcAgentManager/PcAgentManager.csproj", "manager/PcAgentManager.Tests/PcAgentManager.Tests.csproj"]) {
    assert.match(readFileSync(new URL(file, repo), "utf8"), /<TargetFramework>net10\.0-windows<\/TargetFramework>/, file);
  }
});

test("CI and release build with the .NET 10 SDK and enforce the runtime floor", () => {
  for (const name of ["manager-ci", "release"]) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}.yml`, repo), "utf8");
    assert.match(workflow, /dotnet-version:\s*'10\.0\.x'/, name);
    assert.match(workflow, /Test-PcAgentRelease\.ps1[^\n]*-MinimumDotNetRuntime[^\n]*\.dotnet-runtime-version/, name);
  }
});
