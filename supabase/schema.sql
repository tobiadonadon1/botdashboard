-- ═══════════════════════════════════════════════════════════════════
-- BOTDASHBOARD — Supabase Postgres schema (multi-tenant)
-- Run this ONCE on your Supabase project via SQL Editor.
--   https://app.supabase.com/project/_/sql
-- ═══════════════════════════════════════════════════════════════════

-- Enable UUID generator (pgcrypto is available on Supabase by default)
create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────
-- USERS (bot owners) — one row per human who logs into the dashboard
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id                  uuid        primary key default gen_random_uuid(),
  username            text        unique not null,
  password_salt       text        not null,
  password_hash       text        not null,      -- PBKDF2-SHA256, base64
  bot_api_key_hash    text        not null,      -- sha256 hex of bot's bearer token
  role                text        not null default 'user',   -- 'user' | 'admin'
  created_at          timestamptz not null default now(),
  last_login_at       timestamptz
);

-- ─────────────────────────────────────────────────────────────────
-- BOT STATUS — one upserted row per user, latest snapshot
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.bot_status (
  user_id        uuid        primary key references public.users(id) on delete cascade,
  updated_at     timestamptz not null default now(),
  status         jsonb       not null      -- {running, dry_run, scale_level, next_cycle_at, net_pnl, ...}
);

-- ─────────────────────────────────────────────────────────────────
-- TRADES — append-only (upsert on user_id + trade_id for idempotency)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.trades (
  id             bigserial   primary key,
  user_id        uuid        not null references public.users(id) on delete cascade,
  trade_id       text        not null,
  timestamp      timestamptz not null,
  asset          text,
  direction      text,        -- 'UP' | 'DOWN'
  entry_price    numeric,
  size_usd       numeric,
  shares         numeric,
  confidence     numeric,
  status         text,        -- 'PLACED' | 'CLOSED' | ...
  outcome        text,        -- 'WIN' | 'LOSS' | null (pending)
  pnl            numeric     default 0,
  resolved_at    timestamptz,
  end_time       timestamptz,
  timeframe      text        default '5m',
  mode           text,        -- 'paper' | 'live' | 'shadow' | null (legacy rows)
  shadow         boolean     default false,  -- true = shadow-mode journal row, never real $
  strategy_label text        default 'expiry_convergence',  -- 'expiry_convergence' | 'early_entry' | 'scalp_exit'
  -- scalp_exit-specific telemetry. NULL on the other two strategies. Float4
  -- (real) precision is fine for sub-cent prediction-market prices + small PNL.
  exit_trigger          text,    -- 'take_profit' | 'stop_loss' | 'time_exit' | 'resolution' | other
  entry_bid             real,    -- bid price at entry
  exit_bid              real,    -- bid price at exit (NULL until resolved)
  realized_pnl_partial  real,    -- partial PNL realized via early scalp (subset of pnl)
  created_at     timestamptz not null default now(),
  unique (user_id, trade_id)
);

-- ─────────────────────────────────────────────────────────────────
-- COPY-BOT v2 columns (additive). Captured from /api/bot/push payload.
-- All nullable so the bachelier bot's existing payload keeps working.
-- ─────────────────────────────────────────────────────────────────
alter table public.trades add column if not exists wallet_address    text;
alter table public.trades add column if not exists wallet_label      text;
alter table public.trades add column if not exists asset_label       text;     -- "Cavaliers vs. Pistons"
alter table public.trades add column if not exists market_slug       text;     -- "nba-cle-det-2026-05-05"
alter table public.trades add column if not exists condition_id      text;     -- groups OPEN+CLOSE per market
alter table public.trades add column if not exists token_id          text;     -- outcome side
alter table public.trades add column if not exists action            text;     -- 'OPEN' | 'CLOSE'
alter table public.trades add column if not exists side              text;     -- 'BUY' | 'SELL'
alter table public.trades add column if not exists amount_usd        numeric;  -- v2 size; old rows use size_usd
alter table public.trades add column if not exists intended_price    real;
alter table public.trades add column if not exists executed_price    real;     -- NULL on shadow
alter table public.trades add column if not exists realized_pnl_usd  numeric;  -- only on CLOSE rows
alter table public.trades add column if not exists submitted_at_utc  timestamptz;
alter table public.trades add column if not exists latency_ms        int;
alter table public.trades add column if not exists bot_type          text default 'bachelier';
-- Note: is_shadow is intentionally NOT added. Handler maps payload's is_shadow
-- onto the existing `shadow` boolean column so reads stay consistent.

-- If upgrading an existing table (older migrations, kept for reference):
--   alter table public.trades add column if not exists mode text;
--   alter table public.trades add column if not exists shadow boolean default false;
--   alter table public.trades add column if not exists strategy_label text default 'expiry_convergence';
--   alter table public.trades add column if not exists exit_trigger text;
--   alter table public.trades add column if not exists entry_bid real;
--   alter table public.trades add column if not exists exit_bid real;
--   alter table public.trades add column if not exists realized_pnl_partial real;
--   update public.trades set strategy_label = 'expiry_convergence' where strategy_label is null;

create index if not exists trades_user_ts_idx
  on public.trades (user_id, timestamp desc);
create index if not exists trades_user_outcome_idx
  on public.trades (user_id, outcome);
create index if not exists trades_user_asset_idx
  on public.trades (user_id, asset);
create index if not exists trades_user_shadow_idx
  on public.trades (user_id, shadow);
create index if not exists trades_user_strategy_idx
  on public.trades (user_id, strategy_label);
create index if not exists trades_user_bot_idx
  on public.trades (user_id, bot_type);
-- Per-condition lookup for "group fills by market" in /api/copy_open.
create index if not exists trades_user_cond_idx
  on public.trades (user_id, condition_id) where condition_id is not null;

-- ─────────────────────────────────────────────────────────────────
-- SIGNAL PERFORMANCE — per-user learning state
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.signal_performance (
  user_id        uuid        not null references public.users(id) on delete cascade,
  asset          text        not null default 'ALL',
  signal_name    text        not null,
  times_seen     int         default 0,
  times_correct  int         default 0,
  win_rate       numeric     default 0.5,
  weight         numeric     default 1.0,
  updated_at     timestamptz not null default now(),
  primary key (user_id, asset, signal_name)
);

-- ─────────────────────────────────────────────────────────────────
-- BOT CONTROL — dashboard → bot commands (pause/start)
-- One row per user. Bot polls GET /api/bot/control every ~5s.
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.bot_control (
  user_id        uuid        primary key references public.users(id) on delete cascade,
  command        text        not null default 'start',   -- 'start' | 'pause'
  issued_at      timestamptz not null default now(),
  issued_by      text
);

-- ─────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY
-- The dashboard uses the service_role key (bypasses RLS), but we
-- still enable RLS so that anyone using the anon key can never read
-- another tenant's data even by accident.
-- ─────────────────────────────────────────────────────────────────
alter table public.users              enable row level security;
alter table public.bot_status         enable row level security;
alter table public.trades             enable row level security;
alter table public.signal_performance enable row level security;
alter table public.bot_control        enable row level security;

-- No policies defined → anon key sees nothing. The service_role key
-- (used server-side only) bypasses RLS automatically.

-- ─────────────────────────────────────────────────────────────────
-- HELPER VIEW: hourly win rate (per user)
-- ─────────────────────────────────────────────────────────────────
create or replace view public.trades_hourly as
select
  user_id,
  extract(hour from timestamp)::int as hour_utc,
  count(*)                          as total,
  sum(case when outcome = 'WIN'  then 1 else 0 end) as wins,
  sum(case when outcome = 'LOSS' then 1 else 0 end) as losses,
  coalesce(sum(pnl), 0)             as pnl
from public.trades
where outcome is not null
group by user_id, hour_utc;
