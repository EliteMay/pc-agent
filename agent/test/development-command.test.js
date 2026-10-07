import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  createDevelopmentCommandTool,
  DevelopmentCommandError,
  developmentCommandInternals
} from "../src/tools/development-command.js";

const {
  validateDevelopmentRequest,
  sanitizeEnvironment
} = developmentCommandInternals;

test("development command policy allows only narrow git inspection commands", () => {
  assert.deepEqual(
    validateDevelopmentRequest({
      program: "git",
      args: ["status", "--short", "--branch"],
      cwd: "D:\\AI\\project",
      timeout_ms: 15000
    }).args,
    ["status", "--short", "--branch"]
  );

  assert.deepEqual(
    validateDevelopmentRequest({
      program: "git",
      args: ["diff", "--cached", "--stat"],
      cwd: "D:\\AI\\project"
    }).args,
    ["diff", "--cached", "--stat"]
  );

  assert.deepEqual(
    validateDevelopmentRequest({
      program: "git",
      args: ["log", "--oneline", "-n", "25"],
      cwd: "D:\\AI\\project"
    }).args,
    ["log", "--oneline", "-n", "25"]
  );

  for (const args of [
    ["add", "."],
    ["commit", "-m", "x"],
    ["push"],
    ["reset", "--hard"],
    ["clean", "-fd"],
    ["checkout", "--", "file.txt"],
    ["diff", "--ext-diff"],
    ["log", "--all"]
  ]) {
    assert.throws(
      () => validateDevelopmentRequest({
        program: "git",
        args,
        cwd: "D:\\AI\\project"
      }),
      (error) =>
        error instanceof DevelopmentCommandError
        && error.code === "DEVELOPMENT_COMMAND_DENIED"
    );
  }
});

test("development command policy allows only exact npm test and node --test", () => {
  assert.deepEqual(
    validateDevelopmentRequest({
      program: "npm",
      args: ["test"],
      cwd: "D:\\AI\\project"
    }).args,
    ["test"]
  );

  assert.deepEqual(
    validateDevelopmentRequest({
      program: "node",
      args: ["--test"],
      cwd: "D:\\AI\\project"
    }).args,
    ["--test"]
  );

  for (const request of [
    { program: "npm", args: ["install"] },
    { program: "npm", args: ["run", "build"] },
    { program: "node", args: ["script.js"] },
    { program: "powershell", args: ["-Command", "dir"] },
    { program: "cmd", args: ["/c", "dir"] }
  ]) {
    assert.throws(
      () => validateDevelopmentRequest({
        ...request,
        cwd: "D:\\AI\\project"
      }),
      (error) =>
        error instanceof DevelopmentCommandError
        && error.code === "DEVELOPMENT_COMMAND_DENIED"
    );
  }
});

test("development command timeout is bounded", () => {
  assert.equal(
    validateDevelopmentRequest({
      program: "git",
      args: ["status"],
      cwd: "D:\\AI\\project"
    }).timeoutMs,
    30000
  );

  assert.throws(
    () => validateDevelopmentRequest({
      program: "git",
      args: ["status"],
      cwd: "D:\\AI\\project",
      timeout_ms: 60001
    }),
    (error) =>
      error instanceof DevelopmentCommandError
      && error.code === "INVALID_TIMEOUT"
  );
});

test("development command environment drops arbitrary inherited secrets", () => {
  const env = sanitizeEnvironment({
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    USERPROFILE: "C:\\Users\\Test",
    PATH: "C:\\evil",
    SECRET_TOKEN: "do-not-copy",
    OPENAI_API_KEY: "do-not-copy"
  }, {
    safePathEntries: [
      "C:\\Windows\\System32",
      "C:\\Program Files\\Git\\cmd"
    ]
  });

  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.PAGER, "cat");
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH.includes("C:\\evil"), false);
});

test("development command tool is confirmation-gated", {
  skip: process.platform !== "win32"
}, () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "pc-agent-dev-runner-")
  );
  const registry = new ToolRegistry();

  try {
    registry.register(createDevelopmentCommandTool({
      allowedRoots: [root],
      executableResolver() {
        throw new Error("not used");
      }
    }));

    const tool = registry.require(
      "run_development_command"
    );

    assert.equal(tool.capability, "command.development");
    assert.equal(tool.risk, "medium");
    assert.equal(tool.confirmation, "required");

    const summary = tool.approvalSummary({
      program: "git",
      args: ["status", "--short"],
      cwd: root
    });

    assert.equal(summary.program, "git");
    assert.deepEqual(summary.args, [
      "status",
      "--short"
    ]);
    assert.equal(summary.cwd.length > 0, true);
  } finally {
    rmSync(root, {
      recursive: true,
      force: true
    });
  }
});

test("development runner executes a bounded node --test command without a shell", {
  skip: process.platform !== "win32"
}, async () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "pc-agent-dev-runner-")
  );
  const testFile = path.join(
    root,
    "sample.test.js"
  );

  writeFileSync(
    testFile,
    `import test from "node:test";
import assert from "node:assert/strict";
test("sample", () => assert.equal(2 + 2, 4));
`,
    "utf8"
  );

  try {
    const tool = createDevelopmentCommandTool({
      allowedRoots: [root],
      executableResolver(program) {
        if (program === "node") {
          return {
            executable: process.execPath,
            prefixArgs: []
          };
        }
        throw new Error("unexpected program");
      }
    });

    const result = await tool.execute({
      program: "node",
      args: ["--test"],
      cwd: root,
      timeout_ms: 30000
    });

    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.equal(result.output_truncated, false);
    assert.match(result.stdout, /pass/i);
    assert.equal(result.program, "node");
  } finally {
    rmSync(root, {
      recursive: true,
      force: true
    });
  }
});

test("git status execution stays in the approved cwd", {
  skip: process.platform !== "win32"
}, async (t) => {
  let gitPath;

  try {
    gitPath = execFileSync(
      "where.exe",
      ["git"],
      { encoding: "utf8" }
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    t.skip("git is not installed");
    return;
  }

  const root = mkdtempSync(
    path.join(tmpdir(), "pc-agent-dev-git-")
  );

  try {
    execFileSync(
      gitPath,
      ["init"],
      {
        cwd: root,
        windowsHide: true,
        stdio: "ignore"
      }
    );

    writeFileSync(
      path.join(root, "new.txt"),
      "hello",
      "utf8"
    );

    const tool = createDevelopmentCommandTool({
      allowedRoots: [root],
      executableResolver(program) {
        assert.equal(program, "git");
        return {
          executable: gitPath,
          prefixArgs: []
        };
      }
    });

    const result = await tool.execute({
      program: "git",
      args: ["status", "--short"],
      cwd: root
    });

    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /new\.txt/);
  } finally {
    rmSync(root, {
      recursive: true,
      force: true
    });
  }
});
