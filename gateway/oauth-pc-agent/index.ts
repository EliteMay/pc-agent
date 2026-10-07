import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { pipeline } from "npm:@supabase/middleware@^0.5.0";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@^1.6.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_ISSUER = SUPABASE_URL + "/auth/v1";
const VERSION = "8.2";
const MCP_WAIT_MS = 120000;

const READ_ONLY_TOOLS = new Set([
  "ping",
  "system_info",
  "list_directory",
  "read_text_file",
  "list_processes",
]);

const WRITE_TOOLS = new Set([
  "create_directory",
  "write_text_file",
  "edit_text_file",
]);

const DEVELOPMENT_TOOLS = new Set([
  "run_development_command",
]);

const DEVICE_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  ...WRITE_TOOLS,
  ...DEVELOPMENT_TOOLS,
]);

const TOOLS = [
  {
    name: "gateway_probe",
    title: "Probe OAuth read-only gateway",
    description: "Confirm that ChatGPT loaded the OAuth-protected read-only PC Agent gateway.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "relay_ping",
    title: "Ping PC Agent relay",
    description: "Check the Supabase relay and paired-device registration without sending a command to Windows.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ping",
    title: "Ping paired Windows PC",
    description: "Send a read-only ping through the production v1 command queue to the paired Windows PC Agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "system_info",
    title: "Get Windows PC system info",
    description: "Read basic system information from the paired Windows PC.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_directory",
    title: "List a directory",
    description: "List files and folders in one directory on the paired Windows PC. Read-only; maximum 200 entries.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        maxEntries: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "read_text_file",
    title: "Read a text file",
    description: "Read a bounded byte range from a text file on the paired Windows PC. Maximum 64 KiB per call.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        maxBytes: { type: "integer", minimum: 1, maximum: 65536 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_processes",
    title: "List Windows processes",
    description: "Return the current Windows process list from the paired PC Agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "create_directory",
    title: "Create a directory",
    description: "Create a directory inside an allowed PC Agent root. Requires explicit approval in the local PC Agent Manager before execution.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "write_text_file",
    title: "Write a text file",
    description: "Create or replace a UTF-8 text file inside an allowed PC Agent root. Requires explicit local approval. Replacing an existing file also requires its current SHA-256 hash.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        text: { type: "string", maxLength: 262144 },
        expected_sha256: {
          anyOf: [
            { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
            { type: "null" }
          ]
        },
      },
      required: ["path", "text", "expected_sha256"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "run_development_command",
    title: "Run an approved development command",
    description: "Run a tightly allowlisted development command inside an allowed root. Requires explicit local approval. Allowed programs are git inspection commands, npm test, and node --test.",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", enum: ["git", "npm", "node"] },
        args: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 256 } },
        cwd: { type: "string", minLength: 1 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 }
      },
      required: ["program", "args", "cwd"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "task_begin",
    title: "Begin a bounded PC task",
    description: "Create a bounded Observe -> Plan -> Act -> Verify task. This does not authorize any PC operation by itself.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        completion_criteria: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 256 }
        },
        max_actions: { type: "integer", minimum: 1, maximum: 12 },
        max_retries: { type: "integer", minimum: 0, maximum: 5 },
        max_duration_ms: { type: "integer", minimum: 1000, maximum: 900000 }
      },
      required: ["title", "completion_criteria"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "task_status",
    title: "Get bounded PC task status",
    description: "Read task budget, phase counts, verification state, and block/expiry status.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", format: "uuid" }
      },
      required: ["task_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "task_step",
    title: "Run one bounded PC task step",
    description: "Run exactly one existing PC Agent tool under task budgets. Observe may use reads/git inspection; Act uses safe-write tools; Verify may use reads/git inspection/npm test/node --test. Agent policy and local approval remain mandatory.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", format: "uuid" },
        step_id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._:-]+$" },
        phase: { type: "string", enum: ["observe", "act", "verify"] },
        tool: { type: "string", enum: [...DEVICE_TOOLS] },
        arguments: { type: "object" }
      },
      required: ["task_id", "step_id", "phase", "tool", "arguments"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "task_finish",
    title: "Finish a bounded PC task",
    description: "Finish a task as succeeded, partial, failed, or cancelled. Success requires a successful verify step.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", format: "uuid" },
        outcome: { type: "string", enum: ["succeeded", "partial", "failed", "cancelled"] },
        summary: { type: "string", maxLength: 2000 }
      },
      required: ["task_id", "outcome"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "edit_text_file",
    title: "Edit one exact text occurrence",
    description: "Replace exactly one expected text occurrence in a UTF-8 file inside an allowed PC Agent root. Requires the current SHA-256 and explicit local approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        old_text: { type: "string", minLength: 1, maxLength: 131072 },
        new_text: { type: "string", maxLength: 131072 },
        expected_sha256: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
      },
      required: ["path", "old_text", "new_text", "expected_sha256"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, last-event-id, mcp-protocol-version",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function mcpResult(id: unknown, payload: unknown, isError = false) {
  return json({
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError,
    },
  });
}

function mcpError(id: unknown, code: number, message: string) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function isAllowedUser(ctx: any) {
  const userId = ctx?.userClaims?.id;
  if (!userId) return false;

  const { data, error } = await ctx.supabaseAdmin
    .from("kaito_pc_relay_config")
    .select("config_value")
    .eq("config_key", "oauth_allowed_user_id")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.config_value === userId;
}

async function newestDevice(ctx: any) {
  const { data, error } = await ctx.supabaseAdmin
    .from("kaito_pc_devices")
    .select("device_id,display_name,last_seen_at,agent_version")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

function validateToolArgs(name: string, args: any) {
  if (name === "list_directory") {
    if (!args || typeof args.path !== "string" || !args.path.trim()) {
      throw new Error("path is required");
    }
    if (args.maxEntries !== undefined) {
      const n = Number(args.maxEntries);
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        throw new Error("maxEntries must be an integer from 1 to 200");
      }
    }
  }

  if (name === "read_text_file") {
    if (!args || typeof args.path !== "string" || !args.path.trim()) {
      throw new Error("path is required");
    }
    if (args.offset !== undefined) {
      const n = Number(args.offset);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("offset must be a non-negative integer");
      }
    }
    if (args.maxBytes !== undefined) {
      const n = Number(args.maxBytes);
      if (!Number.isInteger(n) || n < 1 || n > 65536) {
        throw new Error("maxBytes must be an integer from 1 to 65536");
      }
    }
  }

  if (name === "create_directory") {
    if (!args || typeof args.path !== "string" || !args.path.trim()) {
      throw new Error("path is required");
    }
  }

  if (name === "write_text_file") {
    if (!args || typeof args.path !== "string" || !args.path.trim()) {
      throw new Error("path is required");
    }
    if (typeof args.text !== "string") {
      throw new Error("text is required");
    }
    if (new TextEncoder().encode(args.text).length > 262144) {
      throw new Error("text must be at most 262144 UTF-8 bytes");
    }
    if (
      args.expected_sha256 !== null
      && (
        typeof args.expected_sha256 !== "string"
        || !/^[A-Fa-f0-9]{64}$/.test(args.expected_sha256)
      )
    ) {
      throw new Error("expected_sha256 must be null or a 64-character SHA-256 hex string");
    }
  }

  if (name === "run_development_command") {
    if (!args || !["git","npm","node"].includes(args.program)) throw new Error("program must be git, npm, or node");
    if (!Array.isArray(args.args) || args.args.length < 1 || args.args.length > 12 || args.args.some((v:any) => typeof v !== "string" || v.length < 1 || v.length > 256)) throw new Error("args must contain 1..12 bounded strings");
    if (typeof args.cwd !== "string" || !args.cwd.trim()) throw new Error("cwd is required");
    if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 60000)) throw new Error("timeout_ms must be 1000..60000");
  }

  if (name === "edit_text_file") {
    if (!args || typeof args.path !== "string" || !args.path.trim()) {
      throw new Error("path is required");
    }
    if (typeof args.old_text !== "string" || args.old_text.length === 0) {
      throw new Error("old_text is required");
    }
    if (typeof args.new_text !== "string") {
      throw new Error("new_text is required");
    }
    if (new TextEncoder().encode(args.old_text).length > 131072) {
      throw new Error("old_text must be at most 131072 UTF-8 bytes");
    }
    if (new TextEncoder().encode(args.new_text).length > 131072) {
      throw new Error("new_text must be at most 131072 UTF-8 bytes");
    }
    if (
      typeof args.expected_sha256 !== "string"
      || !/^[A-Fa-f0-9]{64}$/.test(args.expected_sha256)
    ) {
      throw new Error("expected_sha256 must be a 64-character SHA-256 hex string");
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_PHASES = new Set(["observe", "act", "verify"]);

function requireUuid(value: unknown, name: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(name + " must be a UUID");
  }
  return value;
}

function isGitInspectionRequest(args: any) {
  return args?.program === "git"
    && Array.isArray(args?.args)
    && ["status", "diff", "log", "rev-parse"].includes(args.args[0]);
}

function isVerificationDevelopmentRequest(args: any) {
  if (isGitInspectionRequest(args)) return true;
  if (args?.program === "npm" && Array.isArray(args?.args)) {
    return args.args.length === 1 && args.args[0] === "test";
  }
  if (args?.program === "node" && Array.isArray(args?.args)) {
    return args.args.length === 1 && args.args[0] === "--test";
  }
  return false;
}

function validateTaskStepArgs(args: any) {
  requireUuid(args?.task_id, "task_id");
  if (typeof args?.step_id !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(args.step_id)) {
    throw new Error("step_id is invalid");
  }
  if (!TASK_PHASES.has(args?.phase)) throw new Error("phase is invalid");
  if (!DEVICE_TOOLS.has(args?.tool)) throw new Error("tool is not allowed");
  if (!args?.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) {
    throw new Error("arguments must be an object");
  }

  validateToolArgs(args.tool, args.arguments);

  if (args.phase === "observe") {
    const allowed =
      READ_ONLY_TOOLS.has(args.tool)
      || (
        args.tool === "run_development_command"
        && isGitInspectionRequest(args.arguments)
      );
    if (!allowed) {
      throw new Error("observe may use read-only tools or approved git inspection only");
    }
  }

  if (args.phase === "verify") {
    const allowed =
      READ_ONLY_TOOLS.has(args.tool)
      || (
        args.tool === "run_development_command"
        && isVerificationDevelopmentRequest(args.arguments)
      );
    if (!allowed) {
      throw new Error("verify may use read-only tools, git inspection, npm test, or node --test only");
    }
  }

  if (args.phase === "act" && !WRITE_TOOLS.has(args.tool)) {
    throw new Error("act must use an existing locally approved safe-write tool");
  }
}

function taskPublicView(row: any) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    device_id: row.device_id,
    title: row.title,
    status: row.status,
    completion_criteria: row.completion_criteria,
    budgets: {
      max_actions: row.max_actions,
      max_retries: row.max_retries,
      max_steps: row.max_steps,
      max_duration_ms: row.max_duration_ms,
    },
    usage: {
      step_count: row.step_count,
      action_count: row.action_count,
      retry_count: row.retry_count,
      observe_count: row.observe_count,
      verify_count: row.verify_count,
    },
    last_phase: row.last_phase,
    last_step_success: row.last_step_success,
    last_result_fingerprint: row.last_result_fingerprint,
    repeated_failure_count: row.repeated_failure_count,
    blocked_reason: row.blocked_reason,
    started_at: row.started_at,
    deadline_at: row.deadline_at,
    completed_at: row.completed_at,
    summary: row.summary,
  };
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function failureFingerprint(toolName: string, error: any) {
  const code = String(error?.errorCode ?? error?.code ?? "UNKNOWN_ERROR").slice(0, 128);
  const message = String(error?.message ?? error ?? "Unknown error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
  return sha256Hex(toolName + "|" + code + "|" + message);
}

async function resultFingerprint(result: unknown) {
  return sha256Hex(JSON.stringify(result ?? null));
}

async function beginTask(ctx: any, args: any) {
  const userId = requireUuid(ctx?.userClaims?.id, "OAuth user id");
  const device = await newestDevice(ctx);
  if (!device) throw new Error("No paired PC Agent device is registered.");

  if (typeof args?.title !== "string" || args.title.trim().length < 1 || args.title.length > 200) {
    throw new Error("title must be 1..200 characters");
  }
  if (!Array.isArray(args?.completion_criteria)
      || args.completion_criteria.length < 1
      || args.completion_criteria.length > 8
      || args.completion_criteria.some((v: any) => typeof v !== "string" || v.trim().length < 1 || v.length > 256)) {
    throw new Error("completion_criteria must contain 1..8 bounded strings");
  }

  const maxActions = args.max_actions ?? 6;
  const maxRetries = args.max_retries ?? 2;
  const maxDurationMs = args.max_duration_ms ?? 300000;
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 12) throw new Error("max_actions must be 1..12");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error("max_retries must be 0..5");
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > 900000) throw new Error("max_duration_ms must be 1000..900000");
  const maxSteps = Math.min(32, maxActions * 3 + maxRetries + 4);

  const { data, error } = await ctx.supabaseAdmin
    .from("kaito_pc_task_runs")
    .insert({
      user_id: userId,
      device_id: device.device_id,
      title: args.title.trim(),
      completion_criteria: args.completion_criteria.map((v: string) => v.trim()),
      max_actions: maxActions,
      max_retries: maxRetries,
      max_steps: maxSteps,
      max_duration_ms: maxDurationMs,
      deadline_at: new Date(Date.now() + maxDurationMs).toISOString(),
    })
    .select("*")
    .single();

  if (error) throw error;
  return taskPublicView(data);
}

async function getTask(ctx: any, taskId: string) {
  const userId = requireUuid(ctx?.userClaims?.id, "OAuth user id");
  requireUuid(taskId, "task_id");

  const nowIso = new Date().toISOString();
  await ctx.supabaseAdmin
    .from("kaito_pc_task_runs")
    .update({ status: "expired", completed_at: nowIso })
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .eq("status", "active")
    .lte("deadline_at", nowIso);

  const { data, error } = await ctx.supabaseAdmin
    .from("kaito_pc_task_runs")
    .select("*")
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Task not found.");
  return taskPublicView(data);
}

async function beginTaskStep(ctx: any, args: any) {
  validateTaskStepArgs(args);
  const userId = requireUuid(ctx?.userClaims?.id, "OAuth user id");
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "begin_pc_agent_task_step_v1",
    {
      p_task_id: args.task_id,
      p_user_id: userId,
      p_logical_step_id: args.step_id,
      p_phase: args.phase,
      p_tool_name: args.tool,
    },
  );
  if (error) throw error;
  const row = data?.[0];
  if (!row?.accepted) {
    return { accepted: false, reason: row?.reason ?? "task_step_rejected", task_status: row?.task_status ?? null };
  }
  return row;
}

async function finishTaskStep(ctx: any, {
  taskId,
  stepRunId,
  success,
  resultFingerprintValue = null,
  fingerprint = null,
  errorCode = null,
  commandId = null,
}: any) {
  const userId = requireUuid(ctx?.userClaims?.id, "OAuth user id");
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "finish_pc_agent_task_step_v2",
    {
      p_task_id: taskId,
      p_user_id: userId,
      p_step_run_id: stepRunId,
      p_success: success,
      p_result_fingerprint: resultFingerprintValue,
      p_failure_fingerprint: fingerprint,
      p_error_code: errorCode,
      p_command_id: commandId,
    },
  );
  if (error) throw error;
  return data?.[0] ?? { accepted: false, reason: "empty_task_step_finish" };
}

async function finishTask(ctx: any, args: any) {
  const userId = requireUuid(ctx?.userClaims?.id, "OAuth user id");
  requireUuid(args?.task_id, "task_id");
  if (!["succeeded", "partial", "failed", "cancelled"].includes(args?.outcome)) {
    throw new Error("outcome is invalid");
  }
  if (args?.summary !== undefined && (typeof args.summary !== "string" || args.summary.length > 2000)) {
    throw new Error("summary must be at most 2000 characters");
  }
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "finish_pc_agent_task_v2",
    {
      p_task_id: args.task_id,
      p_user_id: userId,
      p_outcome: args.outcome,
      p_summary: args.summary ?? null,
    },
  );
  if (error) throw error;
  const row = data?.[0];
  if (!row?.accepted) {
    return {
      success: false,
      reason: row?.reason ?? "task_finish_rejected",
      status: row?.task_status ?? null,
      verification_fingerprint: row?.verification_fingerprint ?? null,
    };
  }
  return {
    success: true,
    status: row.task_status,
    verification_fingerprint: row.verification_fingerprint ?? null,
  };
}

async function enqueueTool(ctx: any, toolName: string, args: unknown, taskMetadata: Record<string, unknown> = {}) {
  if (!DEVICE_TOOLS.has(toolName)) {
    throw new Error("Tool is not allowed by the PC Agent OAuth gateway.");
  }

  validateToolArgs(toolName, args);

  const device = await newestDevice(ctx);
  if (!device) throw new Error("No paired PC Agent device is registered.");

  const isWriteTool = WRITE_TOOLS.has(toolName);
  const isDevelopmentTool = DEVELOPMENT_TOOLS.has(toolName);
  const requiresLocalApproval = isWriteTool || isDevelopmentTool;
  const queuedStatus = "agent_queued";
  const claimedStatus = "agent_claimed";

  const { data: created, error: createError } = await ctx.supabaseAdmin
    .from("kaito_pc_commands")
    .insert({
      device_id: device.device_id,
      tool_name: toolName,
      tool_version: "1",
      protocol_version: 1,
      arguments: args ?? {},
      request_metadata: {
        ...taskMetadata,
        source: "oauth-gateway",
        transport: "pc-agent-v1",
        local_approval_required: requiresLocalApproval
      },
      status: queuedStatus,
      expires_at: new Date(Date.now() + (isDevelopmentTool ? 135000 : isWriteTool ? 60000 : 45000)).toISOString(),
    })
    .select("command_id")
    .single();

  if (createError) throw createError;
  const commandId = created?.command_id;
  if (!commandId) throw new Error("Failed to create device command.");

  const deadline = Date.now() + MCP_WAIT_MS;

  while (Date.now() < deadline) {
    const { data: row, error } = await ctx.supabaseAdmin
      .from("kaito_pc_commands")
      .select("status,result,error_text,claimed_at,completed_at")
      .eq("command_id", commandId)
      .maybeSingle();

    if (error) throw error;

    if (row?.status === "completed") {
      return { success: true, result: row.result, commandId };
    }

    if (row?.status === "failed") {
      let parsed: any = row.error_text;
      try { parsed = JSON.parse(row.error_text); } catch {}
      return { success: false, error: parsed, commandId };
    }

    if (row?.status === "expired") {
      return {
        success: false,
        commandId,
        error: {
          errorCode: "expired",
          message: "PC command expired.",
          retryable: true,
        },
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  await ctx.supabaseAdmin
    .from("kaito_pc_commands")
    .update({
      status: "expired",
      completed_at: new Date().toISOString(),
    })
    .eq("command_id", commandId)
    .in("status", [queuedStatus, claimedStatus]);

  return {
    success: false,
    commandId,
    error: {
      errorCode: "device_timeout",
      message: "Timed out waiting for the Windows PC Agent.",
      retryable: true,
    },
  };
}

const handler = async (req: Request, ctx: any) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!(await isAllowedUser(ctx))) {
    return json({
      error: "forbidden",
      message: "This OAuth user is not authorized for PC Agent.",
    }, 403);
  }

  if (req.method === "GET") {
    return json({
      service: "pc-agent-oauth",
      version: VERSION,
      oauth: true,
      readOnly: false,
      safeWrite: true,
      orchestration: true,
      authenticated: true,
    });
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return mcpError(null, -32700, "Parse error");
  }

  const method = body?.method;

  if (method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        protocolVersion: body?.params?.protocolVersion ?? "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: {},
        },
        serverInfo: {
          name: "pc-agent-oauth",
          version: VERSION,
        },
      },
    });
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  if (method === "ping") {
    return json({ jsonrpc: "2.0", id: body.id ?? null, result: {} });
  }

  if (method === "tools/list") {
    return json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: { tools: TOOLS },
    });
  }

  if (method === "resources/list") {
    return json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: { resources: [] },
    });
  }

  if (method === "resources/templates/list") {
    return json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: { resourceTemplates: [] },
    });
  }

  if (method === "tools/call") {
    const name = String(body?.params?.name ?? "");
    const args = body?.params?.arguments ?? {};

    if (name === "gateway_probe") {
      return mcpResult(body.id, {
        success: true,
        authenticated: true,
        readOnly: false,
        safeWrite: true,
        orchestration: true,
        gateway: "supabase-oauth",
        service: "pc-agent-oauth",
        version: VERSION,
      });
    }

    if (name === "relay_ping") {
      const device = await newestDevice(ctx);
      return mcpResult(body.id, {
        success: true,
        message: "relay_pong",
        relay: "supabase-oauth",
        service: "kaito-pc-agent-oauth-readonly",
        version: VERSION,
        deviceRegistered: Boolean(device),
        lastSeenAt: device?.last_seen_at ?? null,
        agentVersion: device?.agent_version ?? null,
      });
    }


    if (name === "task_begin") {
      try {
        return mcpResult(body.id, await beginTask(ctx, args), false);
      } catch (error) {
        return mcpResult(body.id, {
          success: false,
          errorCode: "task_begin_error",
          message: error?.message ?? String(error),
          retryable: false,
        }, true);
      }
    }

    if (name === "task_status") {
      try {
        return mcpResult(body.id, await getTask(ctx, args?.task_id), false);
      } catch (error) {
        return mcpResult(body.id, {
          success: false,
          errorCode: "task_status_error",
          message: error?.message ?? String(error),
          retryable: false,
        }, true);
      }
    }

    if (name === "task_finish") {
      try {
        const outcome = await finishTask(ctx, args);
        return mcpResult(body.id, outcome, !outcome.success);
      } catch (error) {
        return mcpResult(body.id, {
          success: false,
          errorCode: "task_finish_error",
          message: error?.message ?? String(error),
          retryable: false,
        }, true);
      }
    }

    if (name === "task_step") {
      let reservation: any = null;
      try {
        reservation = await beginTaskStep(ctx, args);
        if (!reservation.accepted) {
          return mcpResult(body.id, {
            success: false,
            errorCode: reservation.reason,
            taskStatus: reservation.task_status,
            retryable: false,
          }, true);
        }

        const outcome = await enqueueTool(
          ctx,
          args.tool,
          args.arguments,
          {
            task_id: args.task_id,
            task_step_id: args.step_id,
            task_step_run_id: reservation.step_run_id,
            task_phase: args.phase,
            task_attempt: reservation.attempt,
          },
        );

        if (outcome.success) {
          const evidence = await resultFingerprint(outcome.result);
          const finish = await finishTaskStep(ctx, {
            taskId: args.task_id,
            stepRunId: reservation.step_run_id,
            success: true,
            resultFingerprintValue: evidence,
            commandId: outcome.commandId,
          });
          if (!finish?.accepted) {
            return mcpResult(body.id, {
              success: false,
              errorCode: finish?.reason ?? "task_step_finish_rejected",
              taskStatus: finish?.task_status ?? null,
              retryable: false,
            }, true);
          }
          return mcpResult(body.id, {
            success: true,
            task_id: args.task_id,
            step_id: args.step_id,
            phase: args.phase,
            tool: args.tool,
            attempt: reservation.attempt,
            task_status: finish.task_status,
            command_id: outcome.commandId,
            result_fingerprint: evidence,
            result: outcome.result,
          }, false);
        }

        const fingerprint = await failureFingerprint(args.tool, outcome.error);
        const finish = await finishTaskStep(ctx, {
          taskId: args.task_id,
          stepRunId: reservation.step_run_id,
          success: false,
          fingerprint,
          errorCode: String(outcome.error?.errorCode ?? outcome.error?.code ?? "UNKNOWN_ERROR"),
          commandId: outcome.commandId,
        });

        return mcpResult(body.id, {
          success: false,
          task_id: args.task_id,
          step_id: args.step_id,
          phase: args.phase,
          tool: args.tool,
          attempt: reservation.attempt,
          task_status: finish.task_status,
          repeated_failure_count: finish.repeated_failure_count,
          command_id: outcome.commandId,
          failure_fingerprint: fingerprint,
          error: outcome.error,
        }, true);
      } catch (error) {
        if (reservation?.accepted && reservation?.step_run_id) {
          try {
            const gatewayError = {
              errorCode: "gateway_error",
              message: error?.message ?? String(error),
            };
            await finishTaskStep(ctx, {
              taskId: args?.task_id,
              stepRunId: reservation.step_run_id,
              success: false,
              fingerprint: await failureFingerprint(String(args?.tool ?? "unknown"), gatewayError),
              errorCode: "gateway_error",
            });
          } catch {
            // Do not retry a PC action merely because task bookkeeping failed.
          }
        }
        return mcpResult(body.id, {
          success: false,
          errorCode: "task_step_error",
          message: error?.message ?? String(error),
          retryable: false,
        }, true);
      }
    }

    if (!DEVICE_TOOLS.has(name)) {
      return mcpResult(body.id, {
        success: false,
        errorCode: "tool_not_allowed",
        message: "This OAuth gateway does not expose that PC tool.",
        retryable: false,
      }, true);
    }

    try {
      const outcome = await enqueueTool(ctx, name, args);
      if (outcome.success) return mcpResult(body.id, outcome.result, false);
      return mcpResult(body.id, outcome.error, true);
    } catch (error) {
      return mcpResult(body.id, {
        success: false,
        errorCode: "gateway_error",
        message: error?.message ?? String(error),
        retryable: true,
      }, true);
    }
  }

  return mcpError(body?.id ?? null, -32601, "Method not found: " + String(method));
};

Deno.serve(
  pipeline(
    [
      withOAuthProtectedResource({ authorizationServer: AUTH_ISSUER }),
      withSupabase({ auth: "user" }),
    ],
    handler,
  ),
);
