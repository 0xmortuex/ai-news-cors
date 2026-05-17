/**
 * Route smoke tests for ai-news-cors.
 *
 * Each new guide route gets at least one test that asserts the normalized
 * JSON shape ({ items: [{ title, url, source, published }, ...] }).
 *
 * Usage:
 *   1. Start the worker:   npm run dev      (wrangler dev -> http://localhost:8787)
 *   2. In another shell:   npm test
 *
 * Point at a deployed worker instead with:
 *   WORKER_URL=https://ai-news-cors.mortuexhavoc.workers.dev npm test
 */
import test from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.WORKER_URL || "http://localhost:8787").replace(/\/$/, "");

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  return { res, json };
}

/** Assert the normalized guide-item shape. Empty item lists are tolerated
 *  (a source may be down) but any returned item must be well-formed. */
function assertItemsShape(path, json) {
  assert.ok(Array.isArray(json.items), `${path}: 'items' must be an array`);
  for (const it of json.items) {
    assert.equal(typeof it.title, "string", `${path}: item.title must be a string`);
    assert.ok(it.title.length > 0, `${path}: item.title must be non-empty`);
    assert.match(it.url, /^https?:\/\//, `${path}: item.url must be an http(s) URL`);
    assert.equal(typeof it.source, "string", `${path}: item.source must be a string`);
    assert.ok(
      !isNaN(new Date(it.published)),
      `${path}: item.published must parse as a date`
    );
  }
}

const BLOG_ROUTES = [
  "/blogs/simon-willison",
  "/blogs/maxime-labonne",
  "/blogs/eugene-yan",
  "/blogs/lilian-weng",
  "/blogs/sebastian-raschka",
  "/blogs/chip-huyen",
  "/blogs/devto-ai",
  "/blogs/devto-llm",
  "/blogs/devto-claude",
];

for (const route of BLOG_ROUTES) {
  test(`GET ${route} returns normalized items`, async () => {
    const { res, json } = await getJSON(route);
    assert.equal(res.status, 200, `${route}: expected HTTP 200`);
    assertItemsShape(route, json);
  });
}

test("GET /youtube/ai-channels returns video items", async () => {
  const { res, json } = await getJSON("/youtube/ai-channels");
  assert.equal(res.status, 200);
  assertItemsShape("/youtube/ai-channels", json);
});

test("GET /bluesky/ai-accounts returns post items", async () => {
  const { res, json } = await getJSON("/bluesky/ai-accounts");
  assert.equal(res.status, 200);
  assertItemsShape("/bluesky/ai-accounts", json);
});

test("GET /github/topics returns repo items", async () => {
  const { res, json } = await getJSON("/github/topics");
  assert.equal(res.status, 200);
  assertItemsShape("/github/topics", json);
});

test("GET /github/discussions returns discussion items", async () => {
  const { res, json } = await getJSON("/github/discussions");
  assert.equal(res.status, 200);
  assertItemsShape("/github/discussions", json);
});

test("GET /guides/aggregate merges, dedupes and caps at 100", async () => {
  const { res, json } = await getJSON("/guides/aggregate");
  assert.equal(res.status, 200);
  assertItemsShape("/guides/aggregate", json);
  assert.ok(json.items.length <= 100, "aggregate must return at most 100 items");

  const urls = json.items.map((i) => i.url);
  assert.equal(new Set(urls).size, urls.length, "aggregate items must be deduped by URL");

  // Sorted by published date descending.
  for (let i = 1; i < json.items.length; i++) {
    assert.ok(
      new Date(json.items[i - 1].published) >= new Date(json.items[i].published),
      "aggregate items must be sorted newest-first"
    );
  }
});

test("unknown blog slug returns 404 with empty items", async () => {
  const { res, json } = await getJSON("/blogs/does-not-exist");
  assert.equal(res.status, 404);
  assert.deepEqual(json.items, []);
});
