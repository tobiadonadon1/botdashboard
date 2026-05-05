-- ═══════════════════════════════════════════════════════════════════
-- 2026-05-05 — copy-bot v2 columns
-- ═══════════════════════════════════════════════════════════════════
-- Run this ONCE in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/_/sql
--
-- WHAT IT DOES
--   Adds the columns that the v2 copy bot pushes (wallet_address,
--   asset_label, condition_id, executed_price, etc.). Without these,
--   the dashboard's /api/bot/push handler silently drops them and
--   stores a row with NULLs in the bachelier-shaped columns.
--
-- SAFETY
--   - Every statement is `IF NOT EXISTS` / additive only.
--   - Safe to run twice (no-op on re-run).
--   - Bachelier bot's existing pushes are unaffected.
--   - No PK changes, no constraint changes, no destructive ops.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. New columns on public.trades ───
alter table public.trades add column if not exists wallet_address    text;
alter table public.trades add column if not exists wallet_label      text;
alter table public.trades add column if not exists asset_label       text;     -- "Cavaliers vs. Pistons"
alter table public.trades add column if not exists market_slug       text;     -- "nba-cle-det-2026-05-05"
alter table public.trades add column if not exists condition_id      text;     -- groups OPEN+CLOSE per market
alter table public.trades add column if not exists token_id          text;     -- outcome side
alter table public.trades add column if not exists action            text;     -- 'OPEN' | 'CLOSE'
alter table public.trades add column if not exists side              text;     -- 'BUY' | 'SELL'
alter table public.trades add column if not exists amount_usd        numeric;  -- v2 size
alter table public.trades add column if not exists intended_price    real;
alter table public.trades add column if not exists executed_price    real;     -- NULL on shadow
alter table public.trades add column if not exists realized_pnl_usd  numeric;  -- only on CLOSE rows
alter table public.trades add column if not exists submitted_at_utc  timestamptz;
alter table public.trades add column if not exists latency_ms        int;
alter table public.trades add column if not exists bot_type          text default 'bachelier';

-- ─── 2. Indexes for the new dashboard endpoints ───
-- /api/copy_open groups by condition_id; /api/copy_summary filters by bot_type.
create index if not exists trades_user_bot_idx
  on public.trades (user_id, bot_type);
create index if not exists trades_user_cond_idx
  on public.trades (user_id, condition_id)
  where condition_id is not null;

-- ─── 3. Backfill: any rows already inserted as bot_type=NULL get
--                  treated as bachelier (consistent with the handler). ───
update public.trades set bot_type = 'bachelier' where bot_type is null;

-- ─── DONE ───────────────────────────────────────────────────────────
-- Verify (optional):
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='trades'
--      and column_name in ('wallet_address','asset_label','condition_id',
--                          'executed_price','realized_pnl_usd','bot_type');
--   -- should return 6 rows.
