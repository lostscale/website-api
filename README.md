# LostScale Website API

Read-only API worker for lostscale.com homepage.

## Endpoints

- `GET /todays-brief` — picks a random cached section from today's email worker run
- `GET /book-of-week` — returns current book of week
- `GET /health` — health check

## Cache

Reads from D1 `brief_cache` table populated by email-worker (cron at 12:00 UTC).
This worker runs at 13:00 UTC as safety net.

## Deploy

```bash
npx wrangler deploy
```

## Environment

- D1: `lostscale-db` (shared with email-worker)
- No LLM/search pipeline — pure cache reads
