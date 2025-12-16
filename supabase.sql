-- Extensions
create extension if not exists "uuid-ossp";

-- Tables
create table if not exists public.videos (
  id text primary key,
  title text not null,
  description text,
  country char(2) not null,
  category text,
  view_count bigint,
  like_count bigint,
  published_at timestamptz,
  duration_seconds integer,
  is_short boolean default false,
  velocity_per_hour numeric,
  used boolean default false,
  note text,
  thumbnail_url text,
  refreshed_at timestamptz default now()
);

create index if not exists idx_videos_velocity on public.videos (velocity_per_hour desc);
create index if not exists idx_videos_country on public.videos (country);
create index if not exists idx_videos_category on public.videos (category);

create table if not exists public.video_history (
  id uuid default uuid_generate_v4() primary key,
  video_id text references public.videos(id) on delete cascade,
  view_count bigint,
  like_count bigint,
  recorded_at timestamptz default now()
);

create table if not exists public.admins (
  id uuid default uuid_generate_v4() primary key,
  username text unique not null,
  password text not null,
  created_at timestamptz default now()
);

-- RLS
alter table public.videos enable row level security;
alter table public.video_history enable row level security;
alter table public.admins enable row level security;

-- Policies: VIDEOS
drop policy if exists "Public read videos" on public.videos;
create policy "Public read videos" on public.videos
  for select
  using (true);

drop policy if exists "Service role manage videos" on public.videos;
create policy "Service role manage videos" on public.videos
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Policies: VIDEO_HISTORY
drop policy if exists "Public read history" on public.video_history;
create policy "Public read history" on public.video_history
  for select
  using (true);

drop policy if exists "Service role manage history" on public.video_history;
create policy "Service role manage history" on public.video_history
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Policies: ADMINS
drop policy if exists "Service role manage admins" on public.admins;
create policy "Service role manage admins" on public.admins
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Seed / upsert admin
insert into public.admins (username, password)
values ('zakamon', '4GS49PFJ$64@Nr*eXEPa9z%4')
on conflict (username) do update
set password = excluded.password;
