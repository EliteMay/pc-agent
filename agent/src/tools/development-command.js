import {
  existsSync,
  statSync
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Capabilities } from "../security/capabilities.js";
import {
  isSensitivePath,
  resolveExistingPathWithinAllowedRoots
} from "../security/path-policy.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ARGS = 12;
const MAX_ARG_LENGTH = 256;

const GIT_STATUS_FLAGS = new Set([
  "--short",
  "--branch",
  "--porcelain",
  "--porcelain=v1",
  "--porcelain=v2",
  "--untracked-files=no",
  "--untracked-files=normal",
  "--untracked-files=all"
]);

const GIT_DIFF_FLAGS = new Set([
  "--stat",
  "--name-only",
  "--name-status",
  "--cached",
  "--check"
]);

export class DevelopmentCommandError extends Error {
  constructor(message, code = "DEVELOPMENT_COMMAND_ERROR", options = undefined) {
    super(message, options);
    this.name = "DevelopmentCommandError";
    this.code = code;
  }
}

function deny(message) {
  throw new DevelopmentCommandError(
    message,
    "DEVELOPMENT_COMMAND_DENIED"
  );
}

function requireRequestObject(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new DevelopmentCommandError(
      "Development command must be an object.",
      "INVALID_DEVELOPMENT_COMMAND"
    );
  }

  const allowedKeys = new Set([
    "program",
    "args",
    "cwd",
    "timeout_ms"
  ]);

  const unexpected = Object.keys(request)
    .filter((key) => !allowedKeys.has(key));

  if (unexpected.length > 0) {
    throw new DevelopmentCommandError(
      "Unexpected development command fields: " +
        unexpected.join(", "),
      "INVALID_DEVELOPMENT_COMMAND"
    );
  }
}

function validateArgsArray(args) {
  if (
    !Array.isArray(args)
    || args.length < 1
    || args.length > MAX_ARGS
  ) {
    throw new DevelopmentCommandError(
      "args must contain between 1 and " + MAX_ARGS + " entries.",
      "INVALID_DEVELOPMENT_ARGS"
    );
  }

  for (const arg of args) {
    if (
      typeof arg !== "string"
      || arg.length === 0
      || arg.length > MAX_ARG_LENGTH
      || /[\0\r\n]/.test(arg)
    ) {
      throw new DevelopmentCommandError(
        "Each development command argument must be a bounded single-line string.",
        "INVALID_DEVELOPMENT_ARGS"
      );
    }
  }

  return [...args];
}

function validateGitArgs(args) {
  const [subcommand, ...rest] = args;

  if (subcommand === "status") {
    if (!rest.every((arg) => GIT_STATUS_FLAGS.has(arg))) {
      deny("git status only allows bounded inspection flags.");
    }

    return;
  }

  if (subcommand === "diff") {
    if (!rest.every((arg) => GIT_DIFF_FLAGS.has(arg))) {
      deny("git diff only allows bounded inspection flags.");
    }

    return;
  }

  if (subcommand === "log") {
    if (rest.length === 0) {
      return;
    }

    if (rest.length === 1 && rest[0] === "--oneline") {
      return;
    }

    if (
      rest.length === 2
      && rest[0] === "-n"
      && /^[1-9][0-9]?$|^100$/.test(rest[1])
    ) {
      return;
    }

    if (
      rest.length === 3
      && rest[0] === "--oneline"
      && rest[1] === "-n"
      && /^[1-9][0-9]?$|^100$/.test(rest[2])
    ) {
      return;
    }

    deny("git log only allows --oneline and -n 1..100.");
  }

  if (
    subcommand === "rev-parse"
    && rest.length === 1
    && rest[0] === "--show-toplevel"
  ) {
    return;
  }

  deny("This git subcommand is not allowed by the development runner.");
}

function validateProgramPolicy(program, args) {
  if (program === "git") {
    validateGitArgs(args);
    return;
  }

  if (program === "npm") {
    if (args.length === 1 && args[0] === "test") {
      return;
    }

    deny("Only npm test is allowed.");
  }

  if (program === "node") {
    if (args.length === 1 && args[0] === "--test") {
      return;
    }

    deny("Only node --test is allowed.");
  }

  deny("Program is not allowed by the development runner.");
}

export function validateDevelopmentRequest(request) {
  requireRequestObject(request);

  if (
    typeof request.program !== "string"
    || request.program.length === 0
  ) {
    throw new DevelopmentCommandError(
      "program is required.",
      "INVALID_DEVELOPMENT_COMMAND"
    );
  }

  if (
    typeof request.cwd !== "string"
    || request.cwd.trim().length === 0
  ) {
    throw new DevelopmentCommandError(
      "cwd is required.",
      "INVALID_DEVELOPMENT_COMMAND"
    );
  }

  const program = request.program.trim().toLowerCase();
  const args = validateArgsArray(request.args);

  validateProgramPolicy(program, args);

  const timeoutMs = request.timeout_ms === undefined
    ? DEFAULT_TIMEOUT_MS
    : request.timeout_ms;

  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1000
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new DevelopmentCommandError(
      "timeout_ms must be an integer between 1000 and " +
        MAX_TIMEOUT_MS + ".",
      "INVALID_TIMEOUT"
    );
  }

  return Object.freeze({
    program,
    args: Object.freeze(args),
    cwd: request.cwd.trim(),
    timeoutMs
  });
}

export function sanitizeEnvironment(
  inherited = process.env,
  { safePathEntries = [] } = {}
) {
  const systemRoot =
    inherited.SystemRoot
    || inherited.SYSTEMROOT
    || inherited.WINDIR
    || "C:\\Windows";

  const env = {
    SystemRoot: systemRoot,
    WINDIR: inherited.WINDIR || systemRoot,
    TEMP: inherited.TEMP || path.win32.join(systemRoot, "Temp"),
    TMP: inherited.TMP || inherited.TEMP || path.win32.join(systemRoot, "Temp"),
    USERPROFILE: inherited.USERPROFILE || "",
    PATH: safePathEntries
      .filter((entry) => typeof entry === "string" && entry.length > 0)
      .join(";"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false"
  };

  return Object.freeze(env);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveTrustedDevelopmentExecutable(program) {
  const programFiles =
    process.env.ProgramFiles
    || "C:\\Program Files";
  const systemRoot =
    process.env.SystemRoot
    || process.env.WINDIR
    || "C:\\Windows";

  if (program === "git") {
    const executable = firstExisting([
      path.win32.join(
        programFiles,
        "Git",
        "cmd",
        "git.exe"
      ),
      path.win32.join(
        programFiles,
        "Git",
        "bin",
        "git.exe"
      )
    ]);

    if (!executable) {
      throw new DevelopmentCommandError(
        "Trusted Git executable was not found.",
        "DEVELOPMENT_PROGRAM_NOT_FOUND"
      );
    }

    return Object.freeze({
      executable,
      prefixArgs: Object.freeze([]),
      safePathEntries: Object.freeze([
        path.win32.dirname(executable),
        path.win32.join(systemRoot, "System32"),
        systemRoot
      ])
    });
  }

  if (program === "node") {
    const executable = process.execPath;

    return Object.freeze({
      executable,
      prefixArgs: Object.freeze([]),
      safePathEntries: Object.freeze([
        path.win32.dirname(executable),
        path.win32.join(systemRoot, "System32"),
        systemRoot
      ])
    });
  }

  if (program === "npm") {
    const nodeExecutable = firstExisting([
      path.win32.join(
        programFiles,
        "nodejs",
        "node.exe"
      )
    ]);

    const npmCli = firstExisting([
      path.win32.join(
        programFiles,
        "nodejs",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js"
      )
    ]);

    if (!nodeExecutable || !npmCli) {
      throw new DevelopmentCommandError(
        "Trusted system Node.js/npm installation was not found.",
        "DEVELOPMENT_PROGRAM_NOT_FOUND"
      );
    }

    return Object.freeze({
      executable: nodeExecutable,
      prefixArgs: Object.freeze([npmCli]),
      safePathEntries: Object.freeze([
        path.win32.dirname(nodeExecutable),
        path.win32.join(
          programFiles,
          "Git",
          "cmd"
        ),
        path.win32.join(systemRoot, "System32"),
        systemRoot
      ])
    });
  }

  deny("Program is not allowed by the development runner.");
}

function resolveDevelopmentCwd(cwd, allowedRoots) {
  const canonical = resolveExistingPathWithinAllowedRoots(
    cwd,
    allowedRoots
  );

  if (isSensitivePath(canonical)) {
    throw new DevelopmentCommandError(
      "Sensitive directories cannot be used as development command cwd.",
      "SENSITIVE_PATH"
    );
  }

  const stats = statSync(canonical);

  if (!stats.isDirectory()) {
    throw new DevelopmentCommandError(
      "Development command cwd must be a directory.",
      "CWD_NOT_DIRECTORY"
    );
  }

  return canonical;
}

function effectiveArgs(program, args, resolved) {
  if (program === "git" && args[0] === "diff") {
    return [
      ...resolved.prefixArgs,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--color=never",
      ...args.slice(1)
    ];
  }

  if (program === "git" && args[0] === "log") {
    return [
      ...resolved.prefixArgs,
      "log",
      "--no-color",
      "--decorate=no",
      ...args.slice(1)
    ];
  }

  return [
    ...resolved.prefixArgs,
    ...args
  ];
}

function terminateProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }

    const systemRoot =
      process.env.SystemRoot
      || process.env.WINDIR
      || "C:\\Windows";
    const taskkill = path.win32.join(
      systemRoot,
      "System32",
      "taskkill.exe"
    );

    if (!existsSync(taskkill)) {
      resolve();
      return;
    }

    let killer;

    try {
      killer = spawn(
        taskkill,
        [
          "/PID",
          String(pid),
          "/T",
          "/F"
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore"
        }
      );
    } catch {
      resolve();
      return;
    }

    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

async function executeBoundedProcess({
  executable,
  args,
  cwd,
  timeoutMs,
  env,
  maximumOutputBytes = MAX_OUTPUT_BYTES
}) {
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    let child;

    try {
      child = spawn(
        executable,
        args,
        {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: [
            "ignore",
            "pipe",
            "pipe"
          ]
        }
      );
    } catch (error) {
      reject(new DevelopmentCommandError(
        "Unable to start development command.",
        "DEVELOPMENT_COMMAND_START_FAILED",
        { cause: error }
      ));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let terminationStarted = false;

    const terminate = async () => {
      if (terminationStarted) {
        return;
      }

      terminationStarted = true;

      try {
        await terminateProcessTree(child.pid);
      } catch {
        try {
          child.kill();
        } catch {
          // Best effort only.
        }
      }
    };

    const capture = (destination, chunk) => {
      if (outputExceeded) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

      const remaining =
        maximumOutputBytes - totalBytes;

      if (remaining <= 0) {
        outputExceeded = true;
        void terminate();
        return;
      }

      if (buffer.length <= remaining) {
        destination.push(buffer);
        totalBytes += buffer.length;
        return;
      }

      destination.push(buffer.subarray(0, remaining));
      totalBytes += remaining;
      outputExceeded = true;
      void terminate();
    };

    child.stdout.on(
      "data",
      (chunk) => capture(stdoutChunks, chunk)
    );
    child.stderr.on(
      "data",
      (chunk) => capture(stderrChunks, chunk)
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new DevelopmentCommandError(
        "Development command process failed.",
        "DEVELOPMENT_COMMAND_PROCESS_ERROR",
        { cause: error }
      ));
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);

      const stdout = Buffer.concat(
        stdoutChunks
      ).toString("utf8");
      const stderr = Buffer.concat(
        stderrChunks
      ).toString("utf8");

      if (timedOut) {
        reject(new DevelopmentCommandError(
          "Development command exceeded its timeout.",
          "DEVELOPMENT_COMMAND_TIMEOUT"
        ));
        return;
      }

      if (outputExceeded) {
        reject(new DevelopmentCommandError(
          "Development command exceeded the output limit.",
          "DEVELOPMENT_OUTPUT_LIMIT"
        ));
        return;
      }

      resolve(Object.freeze({
        exit_code:
          Number.isInteger(code)
            ? code
            : null,
        signal: signal ?? null,
        stdout,
        stderr,
        duration_ms:
          Date.now() - startedAt,
        timed_out: false,
        output_truncated: false
      }));
    });
  });
}

export function createDevelopmentCommandTool({
  allowedRoots,
  executableResolver =
    resolveTrustedDevelopmentExecutable,
  maximumOutputBytes = MAX_OUTPUT_BYTES
}) {
  if (
    !Array.isArray(allowedRoots)
    || allowedRoots.length === 0
  ) {
    throw new TypeError(
      "allowedRoots must contain at least one Windows directory."
    );
  }

  if (
    !Number.isSafeInteger(maximumOutputBytes)
    || maximumOutputBytes < 4096
    || maximumOutputBytes > 1024 * 1024
  ) {
    throw new RangeError(
      "maximumOutputBytes must be between 4096 and 1048576."
    );
  }

  return {
    name: "run_development_command",
    version: "1",
    capability: Capabilities.COMMAND_DEVELOPMENT,
    risk: "medium",
    confirmation: "required",
    description:
      "Run one tightly allowlisted development command with no Agent shell and bounded resources.",
    approvalSummary(args) {
      const request =
        validateDevelopmentRequest(args);
      const cwd =
        resolveDevelopmentCwd(
          request.cwd,
          allowedRoots
        );

      return Object.freeze({
        action: "run_development_command",
        program: request.program,
        args: request.args,
        cwd,
        timeout_ms: request.timeoutMs,
        policy: "CONFIRM"
      });
    },
    async execute(args) {
      const request =
        validateDevelopmentRequest(args);

      const cwd =
        resolveDevelopmentCwd(
          request.cwd,
          allowedRoots
        );

      const resolved =
        executableResolver(request.program);

      if (
        !resolved
        || typeof resolved.executable !== "string"
        || !path.win32.isAbsolute(
          resolved.executable
        )
        || !Array.isArray(resolved.prefixArgs)
      ) {
        throw new DevelopmentCommandError(
          "Executable resolver returned an invalid trusted executable.",
          "INVALID_EXECUTABLE_RESOLUTION"
        );
      }

      const finalArgs = effectiveArgs(
        request.program,
        request.args,
        resolved
      );

      const env = sanitizeEnvironment(
        process.env,
        {
          safePathEntries:
            resolved.safePathEntries
            ?? [
              path.win32.dirname(
                resolved.executable
              )
            ]
        }
      );

      const result =
        await executeBoundedProcess({
          executable: resolved.executable,
          args: finalArgs,
          cwd,
          timeoutMs: request.timeoutMs,
          env,
          maximumOutputBytes
        });

      return Object.freeze({
        program: request.program,
        args: request.args,
        cwd,
        ...result
      });
    }
  };
}

export const developmentCommandInternals =
  Object.freeze({
    validateDevelopmentRequest,
    validateGitArgs,
    sanitizeEnvironment,
    resolveTrustedDevelopmentExecutable,
    resolveDevelopmentCwd,
    effectiveArgs,
    executeBoundedProcess,
    terminateProcessTree,
    constants: Object.freeze({
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: MAX_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES
    })
  });
