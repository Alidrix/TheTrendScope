import crypto from "node:crypto";

type BootstrapResult = {
  success: boolean;
  message: string;
  details?: unknown;
};

const SQL_ENDPOINT_PATH = "/rest/v1/rpc/supabase_sql";

function assertEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function hashAdminPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

function buildSchemaSql(defaultAdmin?: { username: string; passwordHash: string }) {
  const adminSql = defaultAdmin
    ? `
insert into public.admins (username, password_hash)
values ('${escapeLiteral(defaultAdmin.username)}', '${escapeLiteral(defaultAdmin.passwordHash)}')
on conflict (username) do update set password_hash = excluded.password_hash;
`
    : "";

  return `
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
  created_at timestamptz not null default timezone('utc', now()),
  unique(youtube_id)
);

alter table public.videos add column if not exists description text default '';
alter table public.videos add column if not exists channel_title text default '';
alter table public.videos add column if not exists thumbnail_url text;
alter table public.videos add column if not exists duration text;
alter table public.videos add column if not exists published_at timestamptz;

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

${adminSql}
`.trim();
}

export async function createSchema(): Promise<BootstrapResult> {
  const supabaseUrl = assertEnv("SUPABASE_URL");
  const serviceKey = assertEnv("SUPABASE_SERVICE_ROLE_KEY");

  const adminUser = process.env.ADMIN_USER?.trim();
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  const defaultAdmin =
    adminUser && adminPassword
      ? { username: adminUser, passwordHash: hashAdminPassword(adminPassword) }
      : undefined;

  const sql = buildSchemaSql(defaultAdmin);
  const endpoint = new URL(SQL_ENDPOINT_PATH, supabaseUrl);

  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "params=single-object",
    },
    body: JSON.stringify({ query: sql }),
  });

  const responseText = await response.text();
  let payload: unknown = responseText;
  try {
    payload = responseText ? JSON.parse(responseText) : responseText;
  } catch {
    // Response is not JSON; keep raw text for logging.
  }

  if (!response.ok) {
    throw new Error(
      `Supabase SQL API failed with status ${response.status}: ${responseText || response.statusText}`
    );
  }

  return {
    success: true,
    message: "Schema ensured for videos, stats_snapshots, notes, and admins tables",
    details: payload,
  };
}

if (require.main === module) {
  createSchema()
    .then((result) => {
      console.info(result.message);
      if (result.details) {
        console.debug("Supabase response:", result.details);
      }
    })
    .catch((error) => {
      console.error("Failed to ensure schema", error);
      process.exitCode = 1;
    });
}
