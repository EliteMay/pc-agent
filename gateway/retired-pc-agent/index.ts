import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CURRENT_GATEWAY =
  "https://vtnwbgejlaqpnwmlzbjy.supabase.co/functions/v1/kaito-pc-agent-oauth-readonly";

Deno.serve(() => {
  return new Response(
    JSON.stringify({
      error: "pc_agent_endpoint_retired",
      message:
        "This legacy PC Agent endpoint has been retired. Use the OAuth pc-agent-v1 gateway.",
      replacement: CURRENT_GATEWAY,
      retired: true,
    }),
    {
      status: 410,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
});
