-- Archive App — Supabase schema
-- Run this in the Supabase SQL editor: https://app.supabase.com → SQL Editor

-- ─── Price cache ────────────────────────────────────────────────────────────
create table if not exists price_cache (
  id               bigserial primary key,
  item_id          text not null unique,       -- deterministic hash of name|cat|cond
  item_name        text not null,
  category         text not null,
  verified_price   numeric,
  confidence_score integer,
  price_range_low  numeric,
  price_range_high numeric,
  sources          jsonb default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);

-- Fast lookup by item_id (primary cache key)
create index if not exists price_cache_item_id_idx on price_cache (item_id);
-- Let the API filter expired rows cheaply
create index if not exists price_cache_expires_idx on price_cache (expires_at);

-- Automatically delete rows whose TTL has passed (runs nightly via pg_cron if enabled,
-- otherwise rows are ignored by the cache check query's expires_at > now() filter)
-- To enable: Extensions → pg_cron, then uncomment:
-- select cron.schedule('purge-price-cache', '0 3 * * *',
--   $$delete from price_cache where expires_at < now()$$);

-- ─── Row Level Security ──────────────────────────────────────────────────────
alter table price_cache enable row level security;

-- Serverless functions use the anon key — allow them full access
create policy "anon full access"
  on price_cache
  for all
  to anon
  using (true)
  with check (true);

-- ─── Optional: API error log ────────────────────────────────────────────────
create table if not exists api_error_log (
  id         bigserial primary key,
  endpoint   text,
  item_name  text,
  error_msg  text,
  created_at timestamptz not null default now()
);

alter table api_error_log enable row level security;
create policy "anon insert" on api_error_log for insert to anon with check (true);
