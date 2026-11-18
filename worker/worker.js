// Cloudflare Worker: the AI brain of the live call.
// The site sends the conversation here; this worker adds the secret API key and asks Claude for the next reply.
// Setup (Cloudflare dashboard): Workers & Pages -> Create -> Hello World -> Edit code -> paste this file -> Deploy.
// Then Settings -> Variables and Secrets -> add a Secret named ANTHROPIC_API_KEY.

const ALLOWED_ORIGINS = ["https://reemaothsa.github.io"]; // only your site may use this worker
const MODEL = "claude-haiku-5-5";                         // fast and cheap, fine for short spoken replies
const MAX_TURNS = 30;                                      // limits cost per request
const MAX_CHARS = 6000;

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}
const json = (body, status, origin) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(origin) } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, origin);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY secret is missing" }, 500, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, origin); }
    let messages = Array.isArray(body.messages) ? body.messages : [];
    messages = messages
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_TURNS)
      .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
    if (!messages.length || messages[0].role !== "user") return json({ error: "conversation must start with user" }, 400, origin);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 200, messages }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: (data.error && data.error.message) || "upstream error" }, r.status === 429 ? 429 : 502, origin);
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim();
    return json({ text }, 200, origin);
  },
};
