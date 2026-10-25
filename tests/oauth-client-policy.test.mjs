import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SITE_ALLOWED_TOOLS,
  clientCapabilities,
  consistentJwtUserId,
  isToolAllowed,
  resolveClientPolicy,
  visibleTools,
} from "../gateway/oauth-pc-agent/client-policy.mjs";

const config = Object.freeze({
  siteClientId: "site-client-uuid",
  privilegedClientIds: "trusted-desktop-client",
});
const siteClaims = Object.freeze({ client_id: config.siteClientId, sub: "owner" });

test("Sites client is restricted to the three bootstrap tools", () => {
  assert.equal(resolveClientPolicy(siteClaims, config), "site");
  assert.deepEqual([...SITE_ALLOWED_TOOLS], ["gateway_probe", "relay_ping", "ping"]);
  for (const tool of SITE_ALLOWED_TOOLS) assert.equal(isToolAllowed("site", tool), true);
  for (const tool of [
    "capture_notepad", "notepad_gui", "write_text_file", "edit_text_file",
    "create_directory", "read_text_file", "system_info", "list_directory",
    "find_paths", "search_text", "list_processes", "run_development_command",
    "task_begin", "task_status", "task_step", "task_finish", "unknown",
  ]) assert.equal(isToolAllowed("site", tool), false, tool);
});

test("Only explicitly allowlisted other clients retain existing tools", () => {
  assert.equal(resolveClientPolicy({ client_id: "trusted-desktop-client" }, config), "privileged");
  assert.equal(isToolAllowed("privileged", "notepad_gui"), true);
  assert.equal(resolveClientPolicy({ client_id: "unregistered-client" }, config), "deny");
  assert.equal(isToolAllowed("deny", "ping"), false);
});

test("Missing or tampered signed claims fail closed", () => {
  for (const claims of [null, undefined, {}, { client_id: "" }, { client_id: 3 },
    { client_id: [config.siteClientId] }, { client_id: " site-client-uuid" },
    { client_id: "site-client-uuid,other" }]) {
    assert.equal(resolveClientPolicy(claims, config), "deny");
  }
  // These fields are untrusted. Only ctx.jwtClaims.client_id is used.
  assert.equal(resolveClientPolicy({ headers: { "oai-authenticated-user-id": "owner" } }, config), "deny");
});

test("JWT user identity mismatch is denied even when owner email matches", () => {
  const ownerId = "owner-user-id";
  const email = "owner@example.invalid";
  assert.equal(consistentJwtUserId({ id: ownerId, email }, { sub: ownerId }), ownerId);

  for (const [userClaims, jwtClaims] of [
    [{ id: "different-user-id", email }, { sub: ownerId }],
    [{ id: ownerId, email }, { sub: "different-user-id" }],
    [{ email }, { sub: ownerId }],
    [{ id: ownerId, email }, {}],
    [null, { sub: ownerId }],
    [{ id: ownerId, email }, null],
    [{ id: 123, email }, { sub: ownerId }],
    [{ id: ownerId, email }, { sub: [ownerId] }],
  ]) {
    assert.equal(consistentJwtUserId(userClaims, jwtClaims), null);
  }

  // This helper is called before querying the owner allowlist in the Gateway.
  const source = readFileSync(new URL("../gateway/oauth-pc-agent/index.ts", import.meta.url), "utf8");
  const gate = source.slice(source.indexOf("async function isAllowedUser("));
  assert.match(gate, /consistentJwtUserId\(ctx\?\.userClaims, ctx\?\.jwtClaims\)/);
  assert.ok(gate.indexOf("consistentJwtUserId(") < gate.indexOf('.from("kaito_pc_relay_config")'));
});

test("Missing and malformed deployment config fails closed", () => {
  for (const bad of [
    {}, { siteClientId: "" }, { siteClientId: "site-client-uuid", privilegedClientIds: 0 },
    { siteClientId: "site-client-uuid", privilegedClientIds: "trusted-desktop-client," },
    { siteClientId: "site-client-uuid", privilegedClientIds: "trusted-desktop-client,trusted-desktop-client" },
    { siteClientId: "site-client-uuid", privilegedClientIds: "site-client-uuid" },
  ]) assert.equal(resolveClientPolicy(siteClaims, bad), "deny");
});

test("Tools list is filtered, not merely advertised", () => {
  const tools = ["gateway_probe", "relay_ping", "ping", "task_step", "notepad_gui", "capture_notepad"].map((name) => ({ name }));
  assert.deepEqual(visibleTools(tools, "site").map((t) => t.name), [...SITE_ALLOWED_TOOLS]);
  assert.deepEqual(visibleTools(tools, "deny"), []);
  assert.equal(visibleTools(tools, "privileged"), tools);
});

test("Gateway routes deny disallowed calls before task and queue dispatch", () => {
  const source = readFileSync(new URL("../gateway/oauth-pc-agent/index.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("const handler = async"));
  assert.match(handler, /resolveClientPolicy\(ctx\?\.jwtClaims,/);
  assert.match(handler, /if \(clientPolicy === "deny"\)/);
  assert.match(handler, /visibleTools\(TOOLS, clientPolicy\)/);
  assert.match(handler, /if \(!isToolAllowed\(clientPolicy, name\)\)/);
  const guard = handler.indexOf("if (!isToolAllowed(clientPolicy, name))");
  assert.ok(guard >= 0 && guard < handler.indexOf('if (name === "task_begin")'));
  assert.ok(guard < handler.indexOf('if (name === "task_step")'));
  assert.ok(guard < handler.indexOf("await enqueueTool(ctx, name, args)"));
  assert.doesNotMatch(handler.slice(0, guard), /req\.headers\.get\(.*client_id/);
});

test("Site capability metadata cannot advertise write or orchestration", () => {
  assert.deepEqual(clientCapabilities("site"), {
    readOnly: true, safeWrite: false, orchestration: false,
  });
  assert.deepEqual(clientCapabilities("privileged"), {
    readOnly: false, safeWrite: true, orchestration: true,
  });
  assert.deepEqual(clientCapabilities("deny"), {
    readOnly: false, safeWrite: false, orchestration: false,
  });

  const source = readFileSync(new URL("../gateway/oauth-pc-agent/index.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("const handler = async"));
  const getRoute = handler.slice(handler.indexOf('if (req.method === "GET")'), handler.indexOf('if (req.method !== "POST")'));
  const probeRoute = handler.slice(handler.indexOf('if (name === "gateway_probe")'), handler.indexOf('if (name === "relay_ping")'));
  assert.match(getRoute, /\.\.\.clientCapabilities\(clientPolicy\)/);
  assert.match(probeRoute, /\.\.\.clientCapabilities\(clientPolicy\)/);
  assert.doesNotMatch(probeRoute, /safeWrite:\s*true|orchestration:\s*true|readOnly:\s*false/);
});
