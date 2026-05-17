/**
 * ai-news-cors
 *
 * Cloudflare Worker powering https://0xmortuex.github.io/ai-news-tracker/
 *
 * Routes:
 *   GET /?url=<encoded>        -> CORS passthrough fetch (origin body verbatim + CORS headers)
 *   GET /trendshift           -> scrape trendshift.io homepage, normalized repo JSON, 1h cache
 *
 *   --- Guides expansion (all return the normalized {items:[...]} shape, 15min cache) ---
 *   GET /blogs/<slug>         -> personal AI blog / dev.to tag feed (see BLOG_FEEDS)
 *   GET /youtube/ai-channels  -> curated YouTube AI channels via channel RSS
 *   GET /bluesky/ai-accounts  -> curated Bluesky AI accounts via public API
 *   GET /github/topics        -> GitHub repos across AI topics, sorted by stars
 *   GET /github/discussions   -> recent discussions/issues from key AI repos
 *   GET /guides/aggregate     -> all guide routes merged, deduped, sorted, top 100
 *
 * Normalized item shape:
 *   { title, url, source, published (ISO), summary?, tags?[] }
 *
 * Optional binding: GITHUB_TOKEN (wrangler secret) — raises GitHub rate limits
 * and enables GraphQL Discussions. Falls back gracefully to unauthenticated REST.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const POLITE_UA =
  "Mozilla/5.0 (compatible; AINewsTracker/1.0; +https://0xmortuex.github.io/ai-news-tracker/)";

const GUIDE_CACHE_TTL = 900; // 15 minutes

// Personal AI blogs + dev.to tutorial feeds. Slug -> { url, source }.
const BLOG_FEEDS = {
  "simon-willison":    { url: "https://simonwillison.net/atom/everything/",    source: "Simon Willison",    tags: ["blog"] },
  "maxime-labonne":    { url: "https://maximelabonne.substack.com/feed",       source: "Maxime Labonne",    tags: ["blog"] },
  "eugene-yan":        { url: "https://eugeneyan.com/rss/",                    source: "Eugene Yan",        tags: ["blog"] },
  "lilian-weng":       { url: "https://lilianweng.github.io/index.xml",        source: "Lilian Weng",       tags: ["blog"] },
  "sebastian-raschka": { url: "https://magazine.sebastianraschka.com/feed",    source: "Sebastian Raschka", tags: ["blog"] },
  "chip-huyen":        { url: "https://huyenchip.com/feed.xml",                source: "Chip Huyen",        tags: ["blog"] },
  "devto-ai":          { url: "https://dev.to/feed/tag/ai",                    source: "dev.to",            tags: ["dev.to", "ai"] },
  "devto-llm":         { url: "https://dev.to/feed/tag/llm",                   source: "dev.to",            tags: ["dev.to", "llm"] },
  "devto-claude":      { url: "https://dev.to/feed/tag/claude",                source: "dev.to",            tags: ["dev.to", "claude"] },
};

// YouTube AI channels — channel RSS at /feeds/videos.xml?channel_id=<id>.
const YT_CHANNELS = [
  { id: "UCZHmQk67mSJgfCCTn7xBfew", name: "Yannic Kilcher" },
  { id: "UCNJ1Ymd5yFuUPtn21xtRbbw", name: "AI Explained" },
  { id: "UCbfYPyITQ-7l4upoX8nvctg", name: "Two Minute Papers" },
  { id: "UCfzlCWGWYyIQ0aLC5w48gBQ", name: "Sentdex" },
  { id: "UCPk8m_r6fkUSYmvgCBwq-sw", name: "Andrej Karpathy" },
];

// Bluesky AI accounts (public API, no auth).
const BSKY_HANDLES = [
  "simonwillison.net",
  "karpathy.bsky.social",
  "swyx.io",
  "ethanmollick.bsky.social",
];

// GitHub topics to sweep for trending repos.
const GH_TOPICS = ["ai", "llm", "claude", "mcp", "agentic", "langchain", "prompt-engineering"];

// Key AI repos to pull discussions/issues from.
const GH_DISCUSSION_REPOS = [
  "anthropics/anthropic-sdk-python",
  "langchain-ai/langchain",
  "microsoft/autogen",
  "openai/openai-python",
  "simonw/llm",
];

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/trendshift") return handleTrendshift();
    if (path === "/guides/aggregate") return handleAggregate(env);
    if (path === "/youtube/ai-channels") return cachedRoute("youtube:ai", () => fetchYouTube());
    if (path === "/bluesky/ai-accounts") return cachedRoute("bluesky:ai", () => fetchBluesky());
    if (path === "/github/topics") return cachedRoute("github:topics", () => fetchGitHubTopics(env));
    if (path === "/github/discussions") return cachedRoute("github:discussions", () => fetchGitHubDiscussions(env));

    if (path.startsWith("/blogs/")) {
      const slug = path.slice("/blogs/".length);
      const def = BLOG_FEEDS[slug];
      if (!def) return jsonError(404, `Unknown blog slug: ${slug}`, { items: [] });
      return cachedRoute(`blog:${slug}`, () => fetchRSSItems(def.url, def.source, def.tags));
    }

    // Default: CORS passthrough on /?url=<encoded>
    return handlePassthrough(url);
  },
};

// =========================================================================
// CACHE HELPER — 15-min Cache API wrapper for guide routes
// =========================================================================
async function cachedRoute(key, producer, ttl = GUIDE_CACHE_TTL) {
  const cacheKey = new Request(`https://ai-news-cache.invalid/${encodeURIComponent(key)}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Cache", "HIT");
    return hit;
  }

  let items;
  try {
    items = await producer();
  } catch (err) {
    // Don't cache failures — let the next request retry.
    return jsonError(502, `Fetch failed: ${err.message}`, { items: [] });
  }

  const body = JSON.stringify({ items, fetchedAt: Date.now(), count: items.length });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
      "X-Cache": "MISS",
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

// =========================================================================
// AGGREGATE — calls every guide route in parallel, dedupes, sorts, top 100
// =========================================================================
async function handleAggregate(env) {
  // Bump the version segment whenever the aggregation logic changes,
  // so a new deploy isn't shadowed by the 15-minute edge cache.
  return cachedRoute("guides:aggregate:v2", async () => {
    const tasks = [
      ...Object.values(BLOG_FEEDS).map((d) => () => fetchRSSItems(d.url, d.source, d.tags)),
      () => fetchYouTube(),
      () => fetchBluesky(),
      () => fetchGitHubTopics(env),
      () => fetchGitHubDiscussions(env),
    ];

    const settled = await Promise.allSettled(tasks.map((t) => t()));
    const all = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && Array.isArray(s.value)) all.push(...s.value);
    }

    // Dedupe by URL, then sort newest-first.
    const byUrl = new Map();
    for (const it of all) {
      const k = (it.url || "").trim();
      if (k && !byUrl.has(k)) byUrl.set(k, it);
    }
    const sorted = Array.from(byUrl.values()).sort(
      (a, b) => new Date(b.published) - new Date(a.published)
    );

    // Diversity cap: GitHub `pushed_at` and dev.to volume are always fresh, so
    // a raw date-sort top-100 would be ~all GitHub + dev.to and bury blogs,
    // YouTube and Bluesky. Cap each `source` so the top 100 stays diverse
    // (still newest-first within each source).
    const PER_SOURCE_CAP = 12;
    const counts = Object.create(null);
    const out = [];
    for (const it of sorted) {
      if (out.length >= 100) break;
      const src = it.source || "unknown";
      counts[src] = (counts[src] || 0) + 1;
      if (counts[src] > PER_SOURCE_CAP) continue;
      out.push(it);
    }
    return out;
  });
}

// =========================================================================
// RSS / ATOM FETCHERS
// =========================================================================
async function fetchRSSItems(feedUrl, sourceName, tags) {
  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent": POLITE_UA,
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    cf: { cacheTtl: GUIDE_CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`${sourceName}: HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseFeed(xml, sourceName);
  if (tags && tags.length) for (const it of items) it.tags = tags.slice();
  return items;
}

async function fetchYouTube() {
  const results = await Promise.all(
    YT_CHANNELS.map(async (ch) => {
      try {
        const res = await fetch(
          `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`,
          {
            headers: { "User-Agent": POLITE_UA, Accept: "application/atom+xml, application/xml" },
            cf: { cacheTtl: GUIDE_CACHE_TTL, cacheEverything: true },
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        return parseFeed(xml, `YouTube: ${ch.name}`, 10).map((it) => ({
          ...it,
          tags: ["youtube", "video"],
        }));
      } catch (err) {
        console.warn(`[youtube:${ch.name}] ${err.message}`);
        return [];
      }
    })
  );
  return results.flat();
}

async function fetchBluesky() {
  const results = await Promise.all(
    BSKY_HANDLES.map(async (handle) => {
      try {
        const res = await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(
            handle
          )}&limit=20`,
          { headers: { "User-Agent": POLITE_UA, Accept: "application/json" } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const feed = json.feed || [];
        const items = [];
        for (const fi of feed) {
          if (fi.reason) continue; // skip reposts
          const post = fi.post;
          if (!post || !post.record) continue;

          const text = (post.record.text || "").trim();
          const embedExternal =
            post.embed?.external?.uri || post.record?.embed?.external?.uri || "";
          const hasLink = /https?:\/\//.test(text) || !!embedExternal;

          // Keep only posts that look like guides/links.
          if (!hasLink && text.length <= 200) continue;

          const rkey = (post.uri || "").split("/").pop();
          const authorHandle = post.author?.handle || handle;
          const display = post.author?.displayName || authorHandle;

          items.push({
            title: text.slice(0, 100) || `Post by ${display}`,
            url: `https://bsky.app/profile/${authorHandle}/post/${rkey}`,
            source: `Bluesky: ${display}`,
            published: post.record.createdAt || post.indexedAt || new Date().toISOString(),
            summary: text.slice(0, 200),
            tags: ["bluesky"],
          });
        }
        return items;
      } catch (err) {
        console.warn(`[bluesky:${handle}] ${err.message}`);
        return [];
      }
    })
  );
  return results.flat();
}

// =========================================================================
// GITHUB
// =========================================================================
function ghHeaders(env) {
  const h = {
    "User-Agent": POLITE_UA,
    Accept: "application/vnd.github+json",
  };
  if (env && env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function fetchGitHubTopics(env) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const results = await Promise.all(
    GH_TOPICS.map(async (topic) => {
      try {
        const q = encodeURIComponent(`topic:${topic} pushed:>${since}`);
        const res = await fetch(
          `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`,
          { headers: ghHeaders(env), cf: { cacheTtl: GUIDE_CACHE_TTL, cacheEverything: true } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.items || []).map((r) => ({
          title: r.full_name,
          url: r.html_url,
          source: "GitHub",
          published: r.pushed_at || r.updated_at || new Date().toISOString(),
          summary: (r.description || "").slice(0, 200),
          tags: ["github", topic, ...((r.topics || []).slice(0, 3))],
        }));
      } catch (err) {
        console.warn(`[github:topic:${topic}] ${err.message}`);
        return [];
      }
    })
  );

  // Dedupe — a repo can match multiple topics.
  const byUrl = new Map();
  for (const it of results.flat()) {
    if (!byUrl.has(it.url)) byUrl.set(it.url, it);
  }
  return Array.from(byUrl.values());
}

async function fetchGitHubDiscussions(env) {
  const token = env && env.GITHUB_TOKEN;
  const results = await Promise.all(
    GH_DISCUSSION_REPOS.map(async (repo) => {
      try {
        return token
          ? await fetchDiscussionsGraphQL(repo, token)
          : await fetchRepoIssues(repo, env);
      } catch (err) {
        console.warn(`[github:discussions:${repo}] ${err.message}`);
        return [];
      }
    })
  );
  return results.flat();
}

// REST fallback (no token): recent issues stand in as discussion-style guide items.
async function fetchRepoIssues(repo, env) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=10`,
    { headers: ghHeaders(env), cf: { cacheTtl: GUIDE_CACHE_TTL, cacheEverything: true } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json || [])
    .filter((i) => !i.pull_request) // issues only, not PRs
    .map((i) => ({
      title: i.title,
      url: i.html_url,
      source: `GitHub Discussions: ${repo}`,
      published: i.updated_at || i.created_at || new Date().toISOString(),
      summary: (i.body || "").replace(/\s+/g, " ").trim().slice(0, 200),
      tags: [
        "github",
        "discussion",
        ...(i.labels || []).map((l) => (typeof l === "string" ? l : l.name)).slice(0, 3),
      ],
    }));
}

// GraphQL path (token present): real Discussions.
async function fetchDiscussionsGraphQL(repo, token) {
  const [owner, name] = repo.split("/");
  const query = `query{repository(owner:"${owner}",name:"${name}"){discussions(first:10,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{title url updatedAt bodyText category{name}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "User-Agent": POLITE_UA,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  const nodes = json?.data?.repository?.discussions?.nodes || [];
  return nodes.map((d) => ({
    title: d.title,
    url: d.url,
    source: `GitHub Discussions: ${repo}`,
    published: d.updatedAt || new Date().toISOString(),
    summary: (d.bodyText || "").replace(/\s+/g, " ").trim().slice(0, 200),
    tags: ["github", "discussion", d.category?.name].filter(Boolean),
  }));
}

// =========================================================================
// FEED PARSER — regex-based RSS 2.0 + Atom extraction.
// Chosen over fast-xml-parser: zero dependencies, no bundler/install step,
// and these are all well-formed standard feeds. Handles CDATA, entities,
// namespaced tags (content:encoded, dc:date, media:description).
// =========================================================================
function parseFeed(xml, sourceName, limit = 30) {
  const items = [];

  // --- RSS 2.0 <item> ---
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    if (items.length >= limit) break;
    const title = clean(extractTag(block, "title"));
    let link = clean(extractTag(block, "link"));
    if (!isHttp(link)) {
      const guid = clean(extractTag(block, "guid"));
      if (isHttp(guid)) link = guid;
    }
    const descHtml =
      extractTag(block, "content:encoded") ||
      extractTag(block, "description") ||
      extractTag(block, "summary");
    const pub =
      clean(extractTag(block, "pubDate")) ||
      clean(extractTag(block, "dc:date")) ||
      clean(extractTag(block, "published"));
    if (title && isHttp(link)) items.push(normalizeItem(title, link, sourceName, pub, descHtml));
  }
  if (items.length > 0) return items;

  // --- Atom <entry> ---
  const entryBlocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const block of entryBlocks) {
    if (items.length >= limit) break;
    const title = clean(extractTag(block, "title"));
    const link = pickAtomLink(block);
    const descHtml =
      extractTag(block, "summary") ||
      extractTag(block, "content") ||
      extractTag(block, "media:description");
    const pub =
      clean(extractTag(block, "published")) || clean(extractTag(block, "updated"));
    if (title && isHttp(link)) items.push(normalizeItem(title, link, sourceName, pub, descHtml));
  }
  return items;
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function pickAtomLink(block) {
  const links = block.match(/<link\b[^>]*\/?>/gi) || [];
  const href = (tag) => {
    const m = tag.match(/href=["']([^"']+)["']/i);
    return m ? m[1] : "";
  };
  // Prefer rel="alternate", then a link with no rel, then anything.
  const alt = links.find((l) => /rel=["']alternate["']/i.test(l));
  if (alt) return href(alt);
  const noRel = links.find((l) => !/rel=/i.test(l));
  if (noRel) return href(noRel);
  return links.length ? href(links[0]) : "";
}

function normalizeItem(title, link, source, pubRaw, descHtml) {
  const d = pubRaw ? new Date(pubRaw) : null;
  const published = d && !isNaN(d) ? d.toISOString() : new Date().toISOString();
  return {
    title: clean(title),
    url: link.trim(),
    source,
    published,
    summary: toText(descHtml).slice(0, 200),
  };
}

function isHttp(s) {
  return /^https?:\/\//i.test((s || "").trim());
}

function clean(s) {
  if (!s) return "";
  return decodeEntities(stripCDATA(s)).replace(/\s+/g, " ").trim();
}

function toText(html) {
  if (!html) return "";
  let s = stripCDATA(html).replace(/<[^>]+>/g, " ");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function stripCDATA(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

// =========================================================================
// PASSTHROUGH (unchanged)
// =========================================================================
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
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8, */*;q=0.5",
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

// =========================================================================
// TRENDSHIFT (unchanged)
// =========================================================================
async function handleTrendshift() {
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

  const cardRe = /<a[^>]+href="\/repositories\/(\d+)"[^>]*>([^<]+)<\/a>([\s\S]{0,4000}?)(?=<a[^>]+href="\/repositories\/|$)/g;
  const starRe = /lucide-star[\s\S]{0,500}?<span[^>]*font-medium[^>]*>([^<]+)<\/span>/;
  const forkRe = /lucide-git-fork[\s\S]{0,500}?<span[^>]*font-medium[^>]*>([^<]+)<\/span>/;

  let m;
  while ((m = cardRe.exec(html)) && items.length < 15) {
    const id = m[1];
    const fullName = m[2].trim();

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
      source: "Trendshift",
      category: "repo",
    });
  }

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
