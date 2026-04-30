/**
 * ai-news-cors
 *
 * Two routes:
 *   GET /?url=<encoded>   -> CORS passthrough fetch (returns origin body verbatim with CORS headers)
 *   GET /trendshift       -> scrape https://trendshift.io homepage, return normalized repo JSON, 1h cache
 *
 * Used by https://0xmortuex.github.io/ai-news-tracker/
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const POLITE_UA =
  "Mozilla/5.0 (compatible; AINewsTracker/1.0; +https://0xmortuex.github.io/ai-news-tracker/)";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/trendshift") {
      return handleTrendshift();
    }

    // Default: CORS passthrough on /?url=<encoded>
    return handlePassthrough(url);
  },
};

async function handlePassthrough(url) {
  const target = url.searchParams.get("url");
  if (!target) {
    return jsonError(400, "Missing ?url=<encoded> query parameter");
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return jsonError(400, "Invalid url parameter");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return jsonError(400, "Only http(s) URLs are allowed");
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8, */*;q=0.5",
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    const headers = new Headers(CORS_HEADERS);
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("Content-Type", ct);
    headers.set("Cache-Control", "public, max-age=300");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (err) {
    return jsonError(502, `Upstream fetch failed: ${err.message}`);
  }
}

async function handleTrendshift() {
  // Bump the version segment whenever the response shape changes to force a cache refresh.
  const cacheKey = new Request("https://trendshift-cache.invalid/v2");
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Cache", "HIT");
    return hit;
  }

  let res;
  try {
    res = await fetch("https://trendshift.io/", {
      headers: {
        "User-Agent": POLITE_UA,
        Accept: "text/html,application/xhtml+xml",
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch (err) {
    return jsonError(502, `Trendshift fetch failed: ${err.message}`, { items: [] });
  }

  if (!res.ok) {
    return jsonError(502, `Trendshift returned ${res.status}`, { items: [] });
  }

  const html = await res.text();
  const items = parseTrendshiftHTML(html);

  if (items.length === 0) {
    // Don't cache an empty result — Trendshift may have changed markup
    return jsonError(
      502,
      "Trendshift HTML parse returned 0 items (markup may have changed)",
      { items: [] }
    );
  }

  const body = JSON.stringify({ items, fetchedAt: Date.now(), count: items.length });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "X-Cache": "MISS",
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

function parseTrendshiftHTML(html) {
  const items = [];
  const seen = new Set();

  // Each card contains <a href="/repositories/<id>">owner/name</a> followed shortly by
  // an <svg class="lucide lucide-star ..."> + <span class="text-foreground font-medium">26.5k</span>
  // and the same pattern for git-fork.
  const cardRe = /<a[^>]+href="\/repositories\/(\d+)"[^>]*>([^<]+)<\/a>([\s\S]{0,4000}?)(?=<a[^>]+href="\/repositories\/|$)/g;
  const starRe = /lucide-star[\s\S]{0,500}?<span[^>]*font-medium[^>]*>([^<]+)<\/span>/;
  const forkRe = /lucide-git-fork[\s\S]{0,500}?<span[^>]*font-medium[^>]*>([^<]+)<\/span>/;

  let m;
  while ((m = cardRe.exec(html)) && items.length < 15) {
    const id = m[1];
    const fullName = m[2].trim();

    // Sanity: must look like owner/repo
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) continue;
    if (seen.has(fullName)) continue;
    seen.add(fullName);

    const tail = m[3];
    const stars = (tail.match(starRe)?.[1] || "").trim();
    const forks = (tail.match(forkRe)?.[1] || "").trim();

    const metricBits = [];
    if (stars) metricBits.push(`★ ${stars}`);
    if (forks) metricBits.push(`⑂ ${forks}`);

    items.push({
      id,
      title: fullName,
      url: `https://github.com/${fullName}`,
      excerpt: metricBits.join(" · ") || "trending on Trendshift",
      // dateISO assigned after the loop so we know each item's final rank index
      source: "Trendshift",
      category: "repo",
    });
  }

  // Stagger timestamps by rank: item[0]=now, item[1]=now-60s, item[2]=now-120s, ...
  // This preserves Trendshift's internal trending order when the tracker sorts by dateISO desc.
  const now = Date.now();
  for (let i = 0; i < items.length; i++) {
    items[i].dateISO = new Date(now - i * 60_000).toISOString();
  }

  return items;
}

function jsonError(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}
