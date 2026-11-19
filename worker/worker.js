// TurnSense AI relay — a Cloudflare Worker between the website and Google Gemini.
// Google rejects Gemini keys sent from a web page, so the page talks to this worker and the worker adds the key.
//
// Setup (Cloudflare dashboard, works from an iPad):
//   Workers & Pages -> Create -> Start with Hello World -> name it "turnsense" -> Deploy
//   Edit code -> delete everything -> paste this whole file -> Deploy
//   Settings -> Variables and Secrets -> Add -> Type: Secret, Name: GEMINI_KEYS,
//     Value: one or more Gemini keys separated by commas -> Deploy/Save
//
// The page calls:  POST  https://<worker>/v1beta/models/<model>:generateContent   (same body as Gemini)
//                  GET   https://<worker>/check                                    (is the key accepted?)

const ALLOWED_ORIGINS = ["https://reemaothsa.github.io"];    // only the website may use this relay
const MODEL_RE = /^[a-z0-9.\-]+$/;                           // e.g. gemini-3.8-flash-lite
const MAX_BODY = 6 * 1024 * 1024;                            // audio clips are well below this

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors(origin) } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: { message: "origin not allowed" } }, 403, origin);

    const keys = String(env.GEMINI_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!keys.length) return json({ error: { message: "GEMINI_KEYS secret is missing on the worker" } }, 500, origin);

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/check") {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=" + encodeURIComponent(keys[0]));
      const body = await r.json().catch(() => ({}));
      return json(r.ok ? { ok: true, keys: keys.length } : { ok: false, error: body.error || { message: "HTTP " + r.status } }, r.ok ? 200 : 502, origin);
    }

    const m = url.pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
    if (request.method !== "POST" || !m || !MODEL_RE.test(m[1])) return json({ error: { message: "not found" } }, 404, origin);
    const body = await request.text();
    if (body.length > MAX_BODY) return json({ error: { message: "request too large" } }, 413, origin);

    // try each key in turn: a key that is rate-limited or rejected hands over to the next one
    let last = null;
    const start = Math.floor(Math.random() * keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m[1]}:generateContent?key=${encodeURIComponent(key)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body });
      if (r.ok || ![401, 403, 429].includes(r.status)) {
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", ...cors(origin) } });
      }
      last = { status: r.status, text: await r.text() };
    }
    return new Response(last.text, { status: last.status, headers: { "content-type": "application/json", ...cors(origin) } });
  },
};
