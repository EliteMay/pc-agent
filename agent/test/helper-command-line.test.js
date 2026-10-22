import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The helpers run as `powershell.exe -EncodedCommand <base64 UTF-16LE>`. Windows CreateProcess
// rejects command lines over 32,767 characters, which would silently break every GUI/capture
// command once a helper grows. Keep a margin so growth fails here, not on the home PC.
const COMMAND_LINE_LIMIT = 32_767;
const MARGIN = 700;
const exe = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

for (const name of readdirSync(new URL("../src/tools/", import.meta.url)).filter((f) => f.endsWith(".ps1"))) {
  test(`${name} fits the Windows command-line limit with margin`, () => {
    const script = readFileSync(new URL(`../src/tools/${name}`, import.meta.url), "utf8");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const commandLine = `"${exe}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
    assert.ok(
      commandLine.length <= COMMAND_LINE_LIMIT - MARGIN,
      `${name}: ${commandLine.length} chars of ${COMMAND_LINE_LIMIT} (margin ${MARGIN})`
    );
  });
}
