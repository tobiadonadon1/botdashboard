-- ═══════════════════════════════════════════════════════════════════
-- 2026-05-05 — add the missing `timeframe` column on trades
-- ═══════════════════════════════════════════════════════════════════
-- Run this ONCE in the Supabase SQL Editor.
--
-- WHY
--   The dashboard's /api/bot/push handler always sends a `timeframe`
--   field (defaults to '5m'). The live trades table is missing this
--   column, so every upsert returned PGRST204 ("column does not
--   exist"). The handler's cascading fallback then drops EVERY new
--   column to recover, which is why every copy-bot trade landed with
--   bot_type=NULL (defaulting to 'bachelier') and all v2 fields NULL.
--
-- SAFETY
--   Single ALTER, IF NOT EXISTS, no defaults that touch existing rows.
-- ═══════════════════════════════════════════════════════════════════

alter table public.trades add column if not exists timeframe text default '5m';

-- Verify (optional):
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='trades'
--      and column_name='timeframe';
--   -- should return 1 row.
