/**
 * Unit tests for the /personalize handler (src/personalize.js).
 *
 * Fully self-contained — OpenRouter, the guide fetch and the Cloudflare
 * Cache API are all mocked, so no network and no running worker are needed:
 *
 *   node --test test/personalize.test.mjs
 *
 * (The sibling routes.test.mjs hits a live `wrangler dev` worker; these
 *  don't, so run this file on its own if no worker is running.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  handlePersonalize,
  normalizeAnswers,
  rateLimitCacheKey,
  RATE_LIMIT_MAX,
  PERSONALIZE_MODEL,
  QUESTION_KEYS,
} from "../src/personalize.js";

const SECRET = "fadi-test-secret";
const ENV = { PERSONALIZE_SECRET: SECRET, OPENROUTER_API_KEY: "test-key" };

const SAMPLE_ANSWERS = {
  what_is_this: "It is a small CLI tool.",
  how_does_it_work: "It reads a config and runs steps.",
  why_should_i_use_this: "It removes a manual step.",
  difficulty_to_setup: "Low — one npm install.",
  how_will_this_affect_me: "Faster guide builds.",
};

/** Minimal Cache API stand-in backed by a Map of url -> body text. */
function makeCache() {
  const store = new Map();
  return {
    store,
    async match(key) {
      const k = String(key);
      return store.has(k) ? new Response(store.get(k)) : undefined;
    },
    async put(key, res) {
      store.set(String(key), await res.text());
    },
  };
}

/** fetch mock: OpenRouter URL -> fake completion; anything else -> guide HTML. */
function makeFetch(answers) {
  const calls = { guide: 0, openrouter: 0 };
  const fetchImpl = async (url) => {
    if (String(url).includes("openrouter.ai")) {
      calls.openrouter++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    calls.guide++;
    return new Response(
      "<html><body><h1>An AI guide</h1><p>It explains things.</p></body></html>",
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  };
  return { fetchImpl, calls };
}

function req(guideUrl, secret) {
  return new Request(
    `https://w.dev/personalize?url=${encodeURIComponent(guideUrl)}` +
      `&secret=${encodeURIComponent(secret)}`
  );
}

test("valid secret returns the 5-answer JSON shape (X-Cache: MISS)", async () => {
  const cache = makeCache();
  const { fetchImpl, calls } = makeFetch(SAMPLE_ANSWERS);
  const res = await handlePersonalize(req("https://example.com/guide-a", SECRET), ENV, {
    contextMd: "context",
    fetchImpl,
    cache,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Cache"), "MISS");

  const json = await res.json();
  assert.equal(json.url, "https://example.com/guide-a");
  assert.equal(json.model, PERSONALIZE_MODEL);
  assert.deepEqual(Object.keys(json.answers), QUESTION_KEYS);
  for (const k of QUESTION_KEYS) {
    assert.equal(typeof json.answers[k], "string");
    assert.ok(json.answers[k].length > 0, `${k} must be non-empty`);
  }
  assert.equal(json.answers.what_is_this, SAMPLE_ANSWERS.what_is_this);
  assert.equal(calls.openrouter, 1);
});

test("invalid secret returns 403 and never fetches or bills", async () => {
  const cache = makeCache();
  const { fetchImpl, calls } = makeFetch(SAMPLE_ANSWERS);
  const res = await handlePersonalize(req("https://example.com/guide-b", "wrong-secret"), ENV, {
    contextMd: "context",
    fetchImpl,
    cache,
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "forbidden");
  assert.equal(calls.openrouter, 0);
  assert.equal(calls.guide, 0);
});

test("repeat call for the same URL is a cache HIT and does not re-bill", async () => {
  const cache = makeCache();
  const { fetchImpl, calls } = makeFetch(SAMPLE_ANSWERS);
  const url = "https://example.com/guide-c";

  const first = await handlePersonalize(req(url, SECRET), ENV, {
    contextMd: "context",
    fetchImpl,
    cache,
  });
  assert.equal(first.headers.get("X-Cache"), "MISS");
  assert.equal(calls.openrouter, 1);

  const second = await handlePersonalize(req(url, SECRET), ENV, {
    contextMd: "context",
    fetchImpl,
    cache,
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("X-Cache"), "HIT");
  assert.equal(calls.openrouter, 1, "a HIT must not call OpenRouter again");
  assert.equal((await second.json()).answers.what_is_this, SAMPLE_ANSWERS.what_is_this);
});

test("rate limit triggers a 429 once the window is full", async () => {
  const cache = makeCache();
  const { fetchImpl, calls } = makeFetch(SAMPLE_ANSWERS);
  // Pre-seed the rate record at the cap for this secret.
  cache.store.set(
    rateLimitCacheKey(SECRET),
    JSON.stringify({ count: RATE_LIMIT_MAX, windowStart: Date.now() })
  );
  const res = await handlePersonalize(req("https://example.com/fresh-guide", SECRET), ENV, {
    contextMd: "context",
    fetchImpl,
    cache,
  });
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.equal(json.error, "rate limit exceeded");
  assert.equal(json.limit, RATE_LIMIT_MAX);
  assert.equal(calls.openrouter, 0, "a rate-limited call must not bill OpenRouter");
});

test("normalizeAnswers coerces fenced / partial JSON into 5 string keys", () => {
  const fenced = "```json\n" + JSON.stringify(SAMPLE_ANSWERS) + "\n```";
  const out = normalizeAnswers(fenced);
  assert.deepEqual(Object.keys(out), QUESTION_KEYS);
  assert.equal(out.what_is_this, SAMPLE_ANSWERS.what_is_this);

  const empty = normalizeAnswers("the model said something non-JSON");
  for (const k of QUESTION_KEYS) assert.equal(empty[k], "");
});
