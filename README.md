# ai-news-cors

Cloudflare Worker powering [AI News Tracker](https://0xmortuex.github.io/ai-news-tracker/).

## Routes

| Method | Path           | Purpose                                                                     |
|--------|----------------|-----------------------------------------------------------------------------|
| GET    | `/?url=<enc>`  | CORS passthrough — fetches the upstream URL and returns its body with `Access-Control-Allow-Origin: *`. Used by the tracker to pull RSS/Atom feeds and JSON APIs from origins that don't serve CORS. |
| GET    | `/trendshift`  | Scrapes `https://trendshift.io/` (no public RSS/API), returns `{items: [{title, url, excerpt, dateISO, source, category}], fetchedAt, count}`. Cached for 1 hour at the edge. |

### Guide routes (Guides tab sources)

These return the normalized shape `{items: [{title, url, source, published, summary?, tags?}], fetchedAt, count}` and are cached for **15 minutes** via the Cloudflare Cache API.

| Method | Path                     | Source |
|--------|--------------------------|--------|
| GET    | `/blogs/<slug>`          | Personal AI blogs + dev.to tag feeds. Slugs: `simon-willison`, `maxime-labonne`, `eugene-yan`, `lilian-weng`, `sebastian-raschka`, `chip-huyen`, `devto-ai`, `devto-llm`, `devto-claude`. |
| GET    | `/youtube/ai-channels`   | Curated YouTube AI channels via channel RSS (Yannic Kilcher, AI Explained, Two Minute Papers, Sentdex, Andrej Karpathy). |
| GET    | `/bluesky/ai-accounts`   | Curated Bluesky AI accounts via the public API, filtered to guide-like posts. |
| GET    | `/github/topics`         | GitHub repos across topics `ai, llm, claude, mcp, agentic, langchain, prompt-engineering`, sorted by stars, pushed in the last 30 days. |
| GET    | `/github/discussions`    | Recent discussions/issues from key AI repos. Uses GraphQL Discussions when `GITHUB_TOKEN` is set, else unauthenticated REST issues. |
| GET    | `/guides/aggregate`      | All guide routes merged in parallel, deduped by URL, sorted newest-first, top 100. |

All routes always emit `Access-Control-Allow-Origin: *`.

### Optional binding

Set a `GITHUB_TOKEN` secret to raise GitHub rate limits and enable real Discussions:

```bash
npx wrangler secret put GITHUB_TOKEN
```

Without it the worker still works (unauthenticated REST, lower rate limits).

## Tests

```bash
npm run dev        # terminal 1 — starts wrangler dev on :8787
npm test           # terminal 2 — route smoke tests (node:test)
```

## Deploy

```bash
npm install
npx wrangler deploy
```

The worker name (`ai-news-cors`) matches the existing dashboard-edited worker, so deploying overwrites it. The public URL `https://ai-news-cors.mortuexhavoc.workers.dev/` is unchanged.

## Local dev

```bash
npx wrangler dev
```
