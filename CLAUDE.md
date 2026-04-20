# MyScout — CLAUDE.md

Personal AI knowledge base. Save notes/links/images, get AI summaries and tags, search by meaning, chat with your collection.

## Stack

- **Frontend**: Single `index.html` — no framework, no build step, no npm
- **Auth + DB**: Supabase (Postgres + pgvector + Supabase Auth)
- **Embeddings**: Voyage AI (`voyage-3-lite`) — generated at save time, stored in pgvector column
- **AI**: Anthropic Claude Sonnet — proxied through `/api/chat.js`
- **Hosting**: Vercel — GitHub auto-deploy, serverless functions in `/api/`
- **Rate limiting**: Upstash Redis — 20 AI-processed items per user per day

## File structure

```
index.html        # Entire frontend
vercel.json       # Routes /api/* to serverless functions
supabase/
  schema.sql      # Tables + RLS policies
api/
  chat.js         # Anthropic proxy (Phase 2+)
```

## Security — non-negotiable

- RLS enabled on **all** Supabase tables, every table needs a policy
- Anthropic, Voyage AI, and Upstash keys live in Vercel env vars only — never in frontend code
- All calls to Anthropic and Voyage AI go through `/api/` serverless routes — never client-side
- Supabase URL + anon key are safe in frontend (they're public values; RLS protects data)
- Rate limit: 20 AI-processed saves per user per day via Upstash, fail gracefully with a clear UI message
- Embeddings generated once at save time — never regenerated on the fly

## Auth model

Supabase email/password auth. Anonymous sessions on first visit (Phase 2+), merged into real account on signup — no parallel data structures.

## Design system

- Background `#0f0f0f`, surface `#1a1a1a`, border `#2a2a2a`
- Accent amber `#f59e0b`, text `#e5e5e5`, muted `#737373`
- Mobile-first, max-width 640px centered, WCAG AA contrast minimum
- Cards for saved items, generous whitespace, no decorative clutter

## Dev commands

```bash
npx serve .          # Local static server
```

No build step. Edit `index.html` directly. Serverless functions in `/api/` are deployed by Vercel on push.

## Environment variables

| Variable | Used in | Notes |
|----------|---------|-------|
| `SUPABASE_URL` | `index.html` | Public — hardcode as placeholder |
| `SUPABASE_ANON_KEY` | `index.html` | Public — hardcode as placeholder |
| `ANTHROPIC_API_KEY` | `/api/chat.js` | Secret — Vercel env only |
| `VOYAGE_API_KEY` | `/api/embed.js` | Secret — Vercel env only |
| `UPSTASH_REDIS_REST_URL` | `/api/*.js` | Secret — Vercel env only |
| `UPSTASH_REDIS_REST_TOKEN` | `/api/*.js` | Secret — Vercel env only |

Local dev: `.env.local` (in `.gitignore`).

## Build phases

| Phase | What | Status |
|-------|------|--------|
| 1 | Auth + save + display notes | ✅ Done |
| 2 | Voyage AI embeddings + semantic search | Next |
| 3 | Chat with collection via Claude | Planned |
| 4 | Link and image saving | Planned |

## Key conventions

- One serverless function per concern (`/api/chat.js`, `/api/embed.js`, etc.)
- Never add a `/api/` route that exposes raw DB access — all queries go through Supabase client with RLS
- Keep `index.html` as a single file — split only if it exceeds ~1000 lines
- Rate limit check happens inside the serverless function before any AI call
