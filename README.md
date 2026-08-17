# LostScale Website API

Read-only API worker for lostscale.com homepage.

## Endpoints

- `GET /todays-brief` — returns today's brief (same for all visitors, picked once per day)
- `GET /book-of-day` — returns today's recommended book (same for all visitors, picked once per day)
- `GET /health` — health check

## Cache

Reads from D1 tables:
- `brief_cache` — populated by email-worker (cron at 00:00 UTC)
- `daily_brief_cache` — one brief section picked per day, same for all visitors
- `daily_book_cache` — one book picked per day, same for all visitors
No cron — caches are pre-warmed by the email-worker calling this API after it finishes.

## Deploy

```bash
npx wrangler deploy
```

## Environment

- D1: `lostscale-db` (shared with email-worker)
- No LLM/search pipeline — pure cache reads
