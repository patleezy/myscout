# MyScout

Save anything you find interesting. Ask questions about it later.

A personal AI knowledge base and second brain. Save notes, links, and images — Claude summarizes and tags each item automatically. Search by meaning and chat with your full collection to surface patterns and insights.

## Stack

- **Frontend** — Single-file `index.html`, no framework, no build step
- **Auth + DB + Storage** — Supabase (Postgres + pgvector + Supabase Auth)
- **Embeddings** — Voyage AI (`voyage-3-lite`)
- **AI** — Anthropic Claude Sonnet via Vercel serverless proxy
- **Hosting** — Vercel (GitHub auto-deploy)
- **Rate limiting** — Upstash (Redis, free tier)

## Setup

### 1. Supabase

Run the SQL in `supabase/schema.sql` in your Supabase SQL Editor to create the `notes` table with RLS enabled.

### 2. Environment variables

For local development, create `.env.local` (never commit this):

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key
ANTHROPIC_API_KEY=your-anthropic-key
VOYAGE_API_KEY=your-voyage-key
UPSTASH_REDIS_REST_URL=your-upstash-url
UPSTASH_REDIS_REST_TOKEN=your-upstash-token
```

The Supabase URL and anon key are public values (safe for frontend use — RLS policies protect all data). Add all variables to Vercel project settings for production.

In `index.html`, replace the two placeholders near the top of the `<script>` block with your actual Supabase URL and anon key.

### 3. Deploy

Connect this repo to a Vercel project. It auto-deploys on every push to `main`.

To test locally, run any static file server from the project root:

```
npx serve .
```

## Project structure

```
myscout/
├── index.html        # Entire frontend
├── vercel.json       # Vercel routing config
├── supabase/
│   └── schema.sql    # Table definitions and RLS policies
└── api/              # Vercel serverless functions (Phase 2+)
    └── chat.js       # Claude proxy (Phase 2+)
```

## Build phases

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Auth + save + display notes | ✅ Done |
| 2 | Voyage AI embeddings on save, semantic search | Planned |
| 3 | Chat with your collection via Claude | Planned |
| 4 | Link and image saving | Planned |
