/**
 * personalize.js — "Explain for me" personalization handler for ai-news-cors.
 *
 * Given a guide URL and a valid secret, this fetches the guide, feeds it plus
 * a private context profile (my-context.md) to OpenRouter, and returns 5
 * personalized answers as JSON.
 *
 * Kept as a standalone module (no `import` of the bundled .md, no Worker-only
 * globals at module scope) so it can be unit-tested under `node --test` —
 * worker.js wires in the real context string, fetch and Cache API.
 *
 * Cost protection:
 *   - secret gate (403 on mismatch)
 *   - result cache keyed by guide URL, 24h TTL — repeat clicks never re-bill
 *   - rate limit: RATE_LIMIT_MAX calls per RATE_WINDOW_SEC per secret
 *   - guide text truncated to MAX_GUIDE_CHARS before the LLM call
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const POLITE_UA =
  "Mozilla/5.0 (compatible; AINewsTracker/1.0; +https://0xmortuex.github.io/ai-news-tracker/)";

// Gemini Flash 1.5 — chosen over gpt-4o-mini: ~$0.075/M input vs $0.15/M,
// and faster. One click is ~1.3k input + ~0.35k output tokens ≈ $0.0002.
export const PERSONALIZE_MODEL = "google/gemini-flash-1.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const MAX_GUIDE_CHARS = 2000; // truncate guide content before the LLM call
export const RATE_LIMIT_MAX = 50; // personalize calls ...
export const RATE_WINDOW_SEC = 3600; // ... per this window, per secret
export const RESULT_TTL_SEC = 86400; // 24h result cache
const GUIDE_FETCH_TIMEOUT_MS = 8000;

// The 5 questions answered for every guide, in render order.
export const QUESTION_KEYS = [
  "what_is_this",
  "how_does_it_work",
  "why_should_i_use_this",
  "difficulty_to_setup",
  "how_will_this_affect_me",
];

// Cache keys live on a synthetic origin so they never collide with real URLs.
export function resultCacheKey(guideUrl) {
  return `https://personalize.invalid/result/${encodeURIComponent(guideUrl)}`;
}
export function rateLimitCacheKey(secret) {
  return `https://personalize.invalid/rate/${encodeURIComponent(secret)}`;
}

/**
 * GET /personalize?url=<guide-url>&secret=<secret>
 *
 * @param {Request} request
 * @param {object}  env   — { PERSONALIZE_SECRET, OPENROUTER_API_KEY }
 * @param {object}  deps  — { contextMd, fetchImpl?, cache? } (injectable for tests)
 */
export async function handlePersonalize(request, env, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const cache = deps.cache || caches.default;
  const contextMd = deps.contextMd || "";

  const url = new URL(request.url);
  const guideUrl = (url.searchParams.get("url") || "").trim();
  const secret = url.searchParams.get("secret") || "";

  // 1. Secret gate — no secret configured, or mismatch, is a flat 403.
  if (!env || !env.PERSONALIZE_SECRET || secret !== env.PERSONALIZE_SECRET) {
    console.log("[personalize] 403 — bad or missing secret");
    return jsonResponse(403, { error: "forbidden" });
  }

  // 2. Validate the guide URL.
  if (!guideUrl) return jsonResponse(400, { error: "missing url parameter" });
  let parsed;
  try {
    parsed = new URL(guideUrl);
  } catch {
    return jsonResponse(400, { error: "invalid url parameter" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return jsonResponse(400, { error: "only http(s) URLs are allowed" });
  }

  // 3. Result cache — a HIT never touches the rate limit or the LLM.
  const hitKey = resultCacheKey(guideUrl);
  const cached = await cache.match(hitKey);
  if (cached) {
    console.log(`[personalize] HIT ${guideUrl}`);
    const body = await cached.text();
    return new Response(body, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${RESULT_TTL_SEC}`,
        "X-Cache": "HIT",
      },
    });
  }

  // 4. Rate limit (only reached on a cache MISS — i.e. a billable call).
  const rl = await checkRateLimit(cache, secret);
  if (!rl.ok) {
    console.log(
      `[personalize] 429 RATE-LIMITED secret=${maskSecret(secret)} count=${rl.count}`
    );
    return jsonResponse(429, {
      error: "rate limit exceeded",
      limit: RATE_LIMIT_MAX,
      windowSeconds: RATE_WINDOW_SEC,
      retryAfterSeconds: rl.retryAfter,
    });
  }

  // 5. Fetch the guide content (truncated downstream).
  let guideText;
  try {
    guideText = await fetchGuideText(guideUrl, fetchImpl);
  } catch (err) {
    console.log(`[personalize] 502 guide fetch failed ${guideUrl}: ${err.message}`);
    return jsonResponse(502, { error: `guide fetch failed: ${err.message}` });
  }

  // 6. Call OpenRouter.
  if (!env.OPENROUTER_API_KEY) {
    return jsonResponse(500, { error: "OPENROUTER_API_KEY not configured" });
  }
  let answers;
  try {
    answers = await callOpenRouter(env.OPENROUTER_API_KEY, contextMd, guideText, fetchImpl);
  } catch (err) {
    console.log(`[personalize] 502 LLM call failed ${guideUrl}: ${err.message}`);
    return jsonResponse(502, { error: `LLM call failed: ${err.message}` });
  }

  console.log(
    `[personalize] MISS ${guideUrl} model=${PERSONALIZE_MODEL} ` +
      `secret=${maskSecret(secret)} callsThisWindow=${rl.count}`
  );

  // 7. Build the result, cache it for 24h, return it.
  const payload = {
    url: guideUrl,
    model: PERSONALIZE_MODEL,
    generatedAt: new Date().toISOString(),
    answers,
  };
  const response = new Response(JSON.stringify(payload), {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${RESULT_TTL_SEC}`,
      "X-Cache": "MISS",
    },
  });
  try {
    await cache.put(hitKey, response.clone());
  } catch (err) {
    console.log(`[personalize] cache put failed: ${err.message}`);
  }
  return response;
}

// =========================================================================
// RATE LIMITING — a tiny {count, windowStart} record stored in the Cache API.
// =========================================================================
async function checkRateLimit(cache, secret) {
  const key = rateLimitCacheKey(secret);
  const now = Date.now();
  let count = 0;
  let windowStart = now;

  const existing = await cache.match(key);
  if (existing) {
    try {
      const d = await existing.json();
      if (d && now - d.windowStart < RATE_WINDOW_SEC * 1000) {
        count = d.count || 0;
        windowStart = d.windowStart;
      }
    } catch {
      /* corrupt record — treat as a fresh window */
    }
  }

  if (count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.max(
      1,
      Math.ceil((windowStart + RATE_WINDOW_SEC * 1000 - now) / 1000)
    );
    return { ok: false, count, retryAfter };
  }

  count += 1;
  const record = new Response(JSON.stringify({ count, windowStart }), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${RATE_WINDOW_SEC}` },
  });
  try {
    await cache.put(key, record);
  } catch {
    /* best-effort — a failed put just means a looser limit */
  }
  return { ok: true, count };
}

// =========================================================================
// GUIDE FETCH — direct fetch with a hard timeout. (A server-side fetch needs
// no CORS, so re-routing through the /?url= passthrough would add nothing.)
// =========================================================================
async function fetchGuideText(guideUrl, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GUIDE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(guideUrl, {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    return htmlToText(raw).slice(0, MAX_GUIDE_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// =========================================================================
// OPENROUTER
// =========================================================================
export function buildPrompt(contextMd, guideText) {
  return (
    `Given this context about me: ${contextMd}\n\n` +
    `And this guide: ${String(guideText).slice(0, MAX_GUIDE_CHARS)}\n\n` +
    `Answer these 5 questions in JSON format: ` +
    `{what_is_this, how_does_it_work, why_should_i_use_this, difficulty_to_setup, ` +
    `how_will_this_affect_me}. Each answer ~2-3 sentences, direct, no marketing ` +
    `language, factually grounded in the guide content. Respond with the JSON ` +
    `object only.`
  );
}

async function callOpenRouter(apiKey, contextMd, guideText, fetchImpl) {
  const res = await fetchImpl(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter attribution headers.
      "HTTP-Referer": "https://0xmortuex.github.io/ai-news-tracker/",
      "X-Title": "AI News Tracker",
    },
    body: JSON.stringify({
      model: PERSONALIZE_MODEL,
      messages: [{ role: "user", content: buildPrompt(contextMd, guideText) }],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 700,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status} ${detail.slice(0, 160)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeAnswers(content);
}

/** Coerce whatever the model returned into exactly the 5 expected string keys. */
export function normalizeAnswers(content) {
  let obj = {};
  const cleaned = String(content)
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        /* leave obj empty */
      }
    }
  }
  const out = {};
  for (const k of QUESTION_KEYS) {
    const v = obj && obj[k];
    out[k] = typeof v === "string" ? v.trim() : v != null ? String(v) : "";
  }
  return out;
}

// =========================================================================
// HELPERS
// =========================================================================
function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function maskSecret(s) {
  s = String(s || "");
  return s.length <= 10 ? s : `${s.slice(0, 10)}…`;
}
