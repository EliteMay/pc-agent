import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { pipeline } from "npm:@supabase/middleware@^0.5.0";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@^1.6.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_ISSUER = SUPABASE_URL + "/auth/v1";
const VERSION = "5";
const MCP_WAIT_MS = 45000;

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

const DEVICE_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  ...WRITE_TOOLS,
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
    description: "Send a read-only ping through the existing Kaito command queue to the paired Windows PC Agent.",
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

async function enqueueTool(ctx: any, toolName: string, args: unknown) {
  if (!DEVICE_TOOLS.has(toolName)) {
    throw new Error("Tool is not allowed by the PC Agent OAuth gateway.");
  }

  validateToolArgs(toolName, args);

  const device = await newestDevice(ctx);
  if (!device) throw new Error("No paired PC Agent device is registered.");

  const useAgentV1 = toolName !== "ping";
  const isWriteTool = WRITE_TOOLS.has(toolName);
  const queuedStatus = useAgentV1 ? "agent_queued" : "queued";
  const claimedStatus = useAgentV1 ? "agent_claimed" : "claimed";

  const { data: created, error: createError } = await ctx.supabaseAdmin
    .from("kaito_pc_commands")
    .insert({
      device_id: device.device_id,
      tool_name: toolName,
      tool_version: "1",
      protocol_version: 1,
      arguments: args ?? {},
      request_metadata: {
        source: "oauth-gateway",
        transport: useAgentV1 ? "pc-agent-v1" : "legacy",
        local_approval_required: isWriteTool
      },
      status: queuedStatus,
      expires_at: new Date(Date.now() + (isWriteTool ? 60000 : 45000)).toISOString(),
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
      return { success: true, result: row.result };
    }

    if (row?.status === "failed") {
      let parsed: any = row.error_text;
      try { parsed = JSON.parse(row.error_text); } catch {}
      return { success: false, error: parsed };
    }

    if (row?.status === "expired") {
      return {
        success: false,
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
