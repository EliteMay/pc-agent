// Restrict each OAuth client using only claims verified by @supabase/server.
// Never derive the client identity from HTTP headers, JSON-RPC arguments or Site cookies.
export const SITE_ALLOWED_TOOLS = Object.freeze([
  "gateway_probe",
  "relay_ping",
  "ping",
]);

const SITE_TOOL_NAMES = new Set(SITE_ALLOWED_TOOLS);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isValidClientId(value) {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

function parsePrivilegedIds(value) {
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
 * Privileged client IDs are explicit and must never include the Site ID.
 * @param {{client_id?: unknown} | null | undefined} jwtClaims
 * @param {{siteClientId?: string, privilegedClientIds?: string}} [config]
 */
export function resolveClientPolicy(jwtClaims, { siteClientId = "", privilegedClientIds = "" } = {}) {
  if (!isValidClientId(siteClientId)) return "deny";
  const privileged = parsePrivilegedIds(privilegedClientIds);
  if (!privileged || privileged.includes(siteClientId)) return "deny";

  const clientId = jwtClaims?.client_id;
  if (!isValidClientId(clientId)) return "deny";
  if (clientId === siteClientId) return "site";
  if (privileged.includes(clientId)) return "privileged";
  return "deny";
}

export function isToolAllowed(policy, toolName) {
  if (typeof toolName !== "string") return false;
  if (policy === "site") return SITE_TOOL_NAMES.has(toolName);
  return policy === "privileged";
}

export function visibleTools(allTools, policy) {
  if (policy === "privileged") return allTools;
  if (policy === "site") return allTools.filter((tool) => SITE_TOOL_NAMES.has(tool.name));
  return [];
}
