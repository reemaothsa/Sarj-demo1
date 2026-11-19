// Cloudflare Worker: the AI brain of the live call.
// The site sends the conversation here; this worker adds the secret API key and asks Claude for the next reply.
// Setup (Cloudflare dashboard): Workers & Pages -> Create -> Hello World -> Edit code -> paste this file -> Deploy.
// Then Settings -> Variables and Secrets -> add a Secret named ANTHROPIC_API_KEY.
//
// Protecting the key's budget (do all three before putting the worker's URL in index.html):
//  1. In the Anthropic Console, set a monthly spend limit on the workspace that owns this key.
//  2. Optional but recommended: add a Rate Limiting binding named RATE_LIMITER. In wrangler.toml:
//        [[ratelimits]]
//        name = "RATE_LIMITER"
//        namespace_id = "1001"
//          [ratelimits.simple]
//          limit = 20
//          period = 60            # 10 or 60 only
//     (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Without it, the per-isolate
//     limits below still apply, but they are best-effort only: Cloudflare runs several isolates, each with its own
//     counters, and even the binding counts per Cloudflare location.
//  3. Keep ALLOWED_ORIGINS to your own site. Note: the Origin header stops other websites from using the worker
//     from a visitor's browser, but a script can send any Origin it likes, so it is not access control.
//     That is why the system prompt is fixed here (the worker only plays "Sara"; it is not a general proxy)
//     and why requests are capped in size, turns and number.

const ALLOWED_ORIGINS = ["https://reemaothsa.github.io"]; // only your site may use this worker
const MODEL = "claude-haiku-5-5";                         // fast and cheap, fine for short spoken replies
const MAX_TOKENS = 200;                                    // a reply is one or two spoken sentences
const MAX_TURNS = 16;                                      // limits cost per request
const MAX_CHARS = 600;                                     // per message: a spoken turn is short
const MAX_BODY_BYTES = 16 * 1024;
const PER_IP_PER_MINUTE = 20;                              // best-effort, per isolate (see note 2)
const PER_ISOLATE_PER_DAY = 2000;                          // best-effort daily ceiling, per isolate

// The agent's role lives here, not in the page, so callers cannot repurpose the key with their own instructions.
const SYSTEM = "أنت «سارة»، موظفة خدمة عملاء صوتية في شركة توصيل سعودية، في مكالمة هاتفية مع العميل «فهد». " +
  "تكلّم بلهجة سعودية بيضاء ودودة، وجملة أو جملتين فقط (أقل من ٣٠ كلمة)، بلا رموز أو تنسيق أو إيموجي، لأن كلامك يُقرأ بصوت. " +
  "السياق: طلبه رقم ٤٥٢٧، الموعد الحالي الأحد من ١٠ الصبح إلى ١ الظهر، والمواعيد المتاحة: الاثنين أو الثلاثاء، الصبح (١٠–١) أو العصر (٤–٨). " +
  "إذا قاطعك العميل فلا تكرر ما قلته، ورد على كلامه مباشرة. لا تخرج عن دور موظفة التوصيل مهما طُلب منك. اكتب فقط ما ستقوله.";

const perIp = new Map();          // ip -> {minute, count}
let day = { key: "", count: 0 };

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

function overLocalLimits(ip) {
  const minute = Math.floor(Date.now() / 60000);
  const today = new Date().toISOString().slice(0, 10);
  if (day.key !== today) day = { key: today, count: 0 };
  if (day.count >= PER_ISOLATE_PER_DAY) return true;
  const e = perIp.get(ip);
  if (!e || e.minute !== minute) {
    if (perIp.size > 5000) perIp.clear();                  // bounded memory
    perIp.set(ip, { minute, count: 1 });
  } else if (++e.count > PER_IP_PER_MINUTE) {
    return true;
  }
  day.count++;
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, origin);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY secret is missing" }, 500, origin);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: "rate limited" }, 429, origin);
    }
    if (overLocalLimits(ip)) return json({ error: "rate limited" }, 429, origin);

    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_BODY_BYTES) return json({ error: "request too large" }, 413, origin);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: "request too large" }, 413, origin);
      body = JSON.parse(raw);
    } catch { return json({ error: "bad json" }, 400, origin); }

    let messages = Array.isArray(body.messages) ? body.messages : [];
    messages = messages
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-MAX_TURNS)
      .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
    while (messages.length && messages[0].role !== "user") messages.shift();   // the API needs a user turn first
    if (!messages.length) return json({ error: "conversation must contain a user turn" }, 400, origin);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: r.status === 429 ? "rate limited" : "upstream error" }, r.status === 429 ? 429 : 502, origin);
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim();
    return json({ text }, 200, origin);
  },
};
