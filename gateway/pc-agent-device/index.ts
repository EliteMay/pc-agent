import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const VERSION = "2";
const MAX_POLL_MS = 15_000;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Supabase server environment is incomplete.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function responseJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function bearerToken(req: Request) {
  const value = req.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function resolveDevice(req: Request) {
  const token = bearerToken(req);

  if (!token) {
    return null;
  }

  const hash = await sha256Hex(token);
  const { data, error } = await supabase
    .from("kaito_pc_devices")
    .select("device_id,display_name,last_seen_at,agent_version")
    .eq("token_hash", hash)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function touchDevice(
  deviceId: string,
  agentVersion: string | undefined
) {
  const patch: Record<string, unknown> = {
    last_seen_at: new Date().toISOString()
  };

  if (typeof agentVersion === "string" && agentVersion.length > 0) {
    patch.agent_version = agentVersion.slice(0, 128);
  }

  const { error } = await supabase
    .from("kaito_pc_devices")
    .update(patch)
    .eq("device_id", deviceId);

  if (error) {
    throw error;
  }
}

async function claimCommand(deviceId: string) {
  const { data, error } = await supabase.rpc(
    "claim_pc_agent_command_v1",
    { p_device_id: deviceId }
  );

  if (error) {
    throw error;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function commandEnvelope(row: Record<string, unknown>) {
  return {
    command_id: row.command_id,
    operation_id: row.operation_id,
    device_id: row.device_id,
    tool: row.tool_name,
    tool_version: row.tool_version,
    protocol_version: row.protocol_version,
    args: row.arguments ?? {},
    request_metadata: row.request_metadata ?? {},
    created_at: row.created_at,
    expires_at: row.expires_at
  };
}

function boundedWaitMs(value: unknown) {
  const parsed = Number(value ?? 0);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.min(Math.trunc(parsed), MAX_POLL_MS));
}

async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function handlePoll(req: Request, device: any) {
  const body = await readJson(req);
  const waitMs = boundedWaitMs(body?.wait_ms);
  const agentVersion =
    typeof body?.agent_version === "string"
      ? body.agent_version
      : undefined;

  await touchDevice(device.device_id, agentVersion);

  const deadline = Date.now() + waitMs;

  while (true) {
    const command = await claimCommand(device.device_id);

    if (command) {
      return responseJson({
        success: true,
        command: commandEnvelope(command)
      });
    }

    if (Date.now() >= deadline) {
      return responseJson({
        success: true,
        command: null
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function resultPayloadBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
}

async function handleResult(req: Request, device: any) {
  const body = await readJson(req);
  const commandId =
    typeof body?.command_id === "string" ? body.command_id : "";
  const operationId =
    typeof body?.operation_id === "string" ? body.operation_id : "";
  const status =
    typeof body?.status === "string" ? body.status : "";

  if (!commandId || !operationId) {
    return responseJson({
      success: false,
      error: "invalid_result_identity",
      message: "command_id and operation_id are required."
    }, 400);
  }

  if (status !== "succeeded" && status !== "failed") {
    return responseJson({
      success: false,
      error: "invalid_result_status",
      message: "status must be succeeded or failed."
    }, 400);
  }

  const outcome = status === "succeeded" ? body?.result : body?.error;

  if (resultPayloadBytes(outcome) > MAX_RESULT_BYTES) {
    return responseJson({
      success: false,
      error: "result_too_large",
      message: "Agent result exceeds the 2 MiB queue result limit."
    }, 413);
  }

  const patch: Record<string, unknown> = {
    status: status === "succeeded" ? "completed" : "failed",
    completed_at: new Date().toISOString(),
    result: status === "succeeded" ? (body?.result ?? null) : null,
    error_text:
      status === "failed"
        ? JSON.stringify(body?.error ?? {
            code: "UNKNOWN_ERROR",
            message: "Unknown Agent failure.",
            retryable: false
          })
        : null
  };

  const { data, error } = await supabase
    .from("kaito_pc_commands")
    .update(patch)
    .eq("command_id", commandId)
    .eq("operation_id", operationId)
    .eq("device_id", device.device_id)
    .eq("status", "agent_claimed")
    .select("command_id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return responseJson({
      success: false,
      error: "command_not_claimed",
      message:
        "The command is no longer claimed by this device or its identity does not match."
    }, 409);
  }

  await touchDevice(device.device_id, undefined);

  return responseJson({ success: true });
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      return responseJson({
        service: "pc-agent-device",
        version: VERSION,
        authenticated_device_api: true
      });
    }

    if (req.method !== "POST") {
      return responseJson({
        success: false,
        error: "method_not_allowed"
      }, 405);
    }

    const device = await resolveDevice(req);

    if (!device) {
      return responseJson({
        success: false,
        error: "device_unauthorized",
        message: "Device authorization rejected."
      }, 401);
    }

    if (url.pathname.endsWith("/poll")) {
      return handlePoll(req, device);
    }

    if (url.pathname.endsWith("/result")) {
      return handleResult(req, device);
    }

    return responseJson({
      success: false,
      error: "not_found"
    }, 404);
  } catch (error) {
    console.error(JSON.stringify({
      event: "pc_agent_device_error",
      message: error instanceof Error ? error.message : String(error)
    }));

    return responseJson({
      success: false,
      error: "internal_error",
      message: "PC Agent device gateway failed."
    }, 500);
  }
});
