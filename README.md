# TheTrendScope

This repository now includes a minimal server bootstrap that prepares the Supabase schema before serving requests.

## Prerequisites

- Node.js 18+ and npm.
- Environment variables for your Supabase project:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - Optional defaults: `ADMIN_USER` and `ADMIN_PASSWORD` for seeding the `admins` table.

You can place these in a local `.env` file in the project root. The server reads it automatically on startup.

## Running the schema bootstrap locally

Install dependencies and run the bootstrap script:

```bash
npm install
npm run bootstrap
```

The script calls the Supabase SQL API (using the service role key) to idempotently create or update the `videos`, `stats_snapshots`, `notes`, and `admins` tables.

## Starting the server

To run the lightweight HTTP server (it bootstraps the schema first and then begins listening):

```bash
npm install
npm start
```

The server listens on `PORT` (default: `3000`) and returns a simple JSON payload to confirm it is running.

## Manual Supabase setup (SQL copy/paste)

If you need to create the database objects directly from the Supabase SQL editor, paste and run the following statement in the **SQL** tab of your project (schema `public`). It creates the required tables and the `video_feed` view used by the dashboard:

```sql
create extension if not exists "pgcrypto";

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  youtube_id text not null,
  title text not null default '',
  description text default '',
  channel_title text default '',
  thumbnail_url text,
  duration text,
  published_at timestamptz,
  region text,
  category text,
  language text,
  is_short boolean not null default false,
  status text not null default 'active',
  used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (youtube_id)
);

create table if not exists public.stats_snapshots (
  id bigint generated always as identity primary key,
  video_id uuid references public.videos(id) on delete cascade,
  views bigint not null default 0,
  likes bigint not null default 0,
  comments bigint not null default 0,
  collected_at timestamptz not null default timezone('utc', now())
);

create index if not exists stats_snapshots_video_id_idx on public.stats_snapshots(video_id);
create index if not exists stats_snapshots_collected_at_idx on public.stats_snapshots(collected_at);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  video_id uuid references public.videos(id) on delete cascade,
  author text,
  body text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists notes_video_id_idx on public.notes(video_id);

create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create or replace view public.video_feed as
select
  v.id,
  v.youtube_id,
  v.title,
  v.channel_title,
  v.thumbnail_url,
  v.published_at,
  v.region,
  v.category,
  v.language,
  v.is_short,
  v.status,
  v.used_at,
  latest.views,
  latest.likes,
  latest.comments,
  latest.collected_at,
  case
    when previous.collected_at is null then null
    when extract(epoch from (latest.collected_at - previous.collected_at)) <= 0 then null
    else greatest(
      0,
      round(
        (latest.views - previous.views) * 3600.0 /
        extract(epoch from (latest.collected_at - previous.collected_at))
      )
    )
  end as views_per_hour
from public.videos v
left join lateral (
  select s.*
  from public.stats_snapshots s
  where s.video_id = v.id
  order by s.collected_at desc
  limit 1
) latest on true
left join lateral (
  select s.*
  from public.stats_snapshots s
  where s.video_id = v.id
    and s.collected_at < coalesce(latest.collected_at, now())
  order by s.collected_at desc
  limit 1
) previous on true;
```

After running the SQL, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in your Vercel project so the client loads without the “Supabase client is not available” error. Optional: create Supabase Auth users if you want to add authentication later, but the current dashboard is publicly accessible for rapid validation.
