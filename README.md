# ai-news-cors

Cloudflare Worker powering [AI News Tracker](https://0xmortuex.github.io/ai-news-tracker/).

## Routes

| Method | Path           | Purpose                                                                     |
|--------|----------------|-----------------------------------------------------------------------------|
| GET    | `/?url=<enc>`  | CORS passthrough — fetches the upstream URL and returns its body with `Access-Control-Allow-Origin: *`. Used by the tracker to pull RSS/Atom feeds and JSON APIs from origins that don't serve CORS. |
| GET    | `/trendshift`  | Scrapes `https://trendshift.io/` (no public RSS/API), returns `{items: [{title, url, excerpt, dateISO, source, category}], fetchedAt, count}`. Cached for 1 hour at the edge. |

Both routes always emit `Access-Control-Allow-Origin: *`.

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
