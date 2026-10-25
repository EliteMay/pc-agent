// Restrict each OAuth client using only claims verified by @supabase/server.
// Never derive the client identity from HTTP headers, JSON-RPC arguments or Site cookies.
// Milestone 1: Site and individually confirmed ChatGPT MCP OAuth clients may
// only probe authenticated Gateway reachability. No Windows queue or metadata.
// Expanding this scope requires an explicitly approved later stage.
export const SITE_ALLOWED_TOOLS = Object.freeze([
  "gateway_probe",
]);

const SITE_TOOL_NAMES = new Set(SITE_ALLOWED_TOOLS);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isValidClientId(value) {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

function parseClientIdList(value) {
  if (typeof value !== "string") return null;
  if (value === "") return [];
  const ids = value.split(",").map((id) => id.trim());
  if (ids.some((id) => !isValidClientId(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

/**
 * `jwtClaims` must be provided by the JWT-verifying Supabase middleware.
 * Any missing/malformed configuration or claim denies the entire client.
 * Privileged client IDs must be explicitly identified and cannot overlap with
 * either the Site or probe-only MCP IDs.
 * @param {{client_id?: unknown} | null | undefined} jwtClaims
 * @param {{siteClientId?: string, mcpProbeClientIds?: string, privilegedClientIds?: string}} [config]
 */
export function resolveClientPolicy(jwtClaims, {
  siteClientId = "",
  mcpProbeClientIds = "",
  privilegedClientIds = "",
} = {}) {
  if (!isValidClientId(siteClientId)) return "deny";
  const probeClients = parseClientIdList(mcpProbeClientIds);
  const privileged = parseClientIdList(privilegedClientIds);
  if (!probeClients || !privileged) return "deny";
  // Overlaps are a deployment mistake: reject every client, including the Site.
  if (probeClients.includes(siteClientId) || privileged.includes(siteClientId) ||
      probeClients.some((id) => privileged.includes(id))) return "deny";

  const clientId = jwtClaims?.client_id;
  if (!isValidClientId(clientId)) return "deny";
  if (clientId === siteClientId) return "site";
  if (probeClients.includes(clientId)) return "mcp_probe";
  if (privileged.includes(clientId)) return "privileged";
  return "deny";
}

/**
 * The auth middleware supplies both fields from one verified Supabase JWT.
 * Never accept a claimed email/header as a fallback when the identity differs.
 * This is a consistency check, NOT a JWT signature verifier.
 */
export function consistentJwtUserId(userClaims, jwtClaims) {
  const userId = userClaims?.id;
  const subject = jwtClaims?.sub;
  return typeof userId === "string" && userId.length > 0
    && typeof subject === "string" && subject === userId ? userId : null;
}

export function isToolAllowed(policy, toolName) {
  if (typeof toolName !== "string") return false;
  if (policy === "site" || policy === "mcp_probe") return SITE_TOOL_NAMES.has(toolName);
  return policy === "privileged";
}

export function visibleTools(allTools, policy) {
  if (policy === "privileged") return allTools;
  if (policy === "site" || policy === "mcp_probe") return allTools.filter((tool) => SITE_TOOL_NAMES.has(tool.name));
  return [];
}

/** Only advertise capabilities actually available to this verified OAuth client. */
export function clientCapabilities(policy) {
  return {
    readOnly: policy === "site" || policy === "mcp_probe",
    safeWrite: policy === "privileged",
    orchestration: policy === "privileged",
  };
}
