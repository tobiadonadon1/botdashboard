# Dashboard - manual test commands

Quick curl scripts to verify the strategy_label plumbing end-to-end.
Covers the three cases called out in the strategy-split spec:

1. `strategy_label: "expiry_convergence"` - core strategy, no pill.
2. `strategy_label: "early_entry"` - orange EARLY pill.
3. `strategy_label: null` (field omitted) - must default to core.

After running, open the dashboard and confirm all three rows appear in
Recent Trades, only trade 2 has the EARLY pill, and the Strategy
Comparison panel shows n=2 for CORE and n=1 for EARLY once you add a
resolved outcome (see the resolved-state example at the bottom).

## Setup

```bash
# Point these at your environment. DASHBOARD_URL is whatever you run
# locally (uvicorn default = http://localhost:8787) or the Vercel URL.
export DASHBOARD_URL="http://localhost:8787"
export BOT_API_KEY="bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

The `BOT_API_KEY` is the raw token printed once by
`scripts/create_user.py`. If you lost it, rotate via Supabase SQL:

```sql
update public.users
   set bot_api_key_hash = encode(sha256(convert_to('bot_NEW_TOKEN','UTF8')), 'hex')
 where username = 'YOUR_USERNAME';
```

## 1. Core trade (explicit)

```bash
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "trade",
    "data": {
      "trade_id": "test-core-001",
      "timestamp": "2026-04-24T14:00:00Z",
      "asset": "BTC",
      "direction": "UP",
      "entry_price": 0.52,
      "size_usd": 50.0,
      "shares": 96.15,
      "confidence": 0.65,
      "status": "PLACED",
      "end_time": "2026-04-24T14:05:00Z",
      "timeframe": "5m",
      "strategy_label": "expiry_convergence"
    }
  }'
```

Expected dashboard row: `BTC LIVE` (no EARLY pill).

## 2. Early trade

```bash
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "trade",
    "data": {
      "trade_id": "test-early-001",
      "timestamp": "2026-04-24T14:01:00Z",
      "asset": "ETH",
      "direction": "DOWN",
      "entry_price": 0.48,
      "size_usd": 40.0,
      "shares": 83.33,
      "confidence": 0.58,
      "status": "PLACED",
      "end_time": "2026-04-24T14:06:00Z",
      "timeframe": "5m",
      "strategy_label": "early_entry"
    }
  }'
```

Expected dashboard row: `ETH LIVE EARLY` (amber EARLY pill right of LIVE).

## 3. Null / omitted strategy_label (must default to core)

```bash
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "trade",
    "data": {
      "trade_id": "test-null-001",
      "timestamp": "2026-04-24T14:02:00Z",
      "asset": "SOL",
      "direction": "UP",
      "entry_price": 0.55,
      "size_usd": 30.0,
      "shares": 54.55,
      "confidence": 0.62,
      "status": "PLACED",
      "end_time": "2026-04-24T14:07:00Z",
      "timeframe": "5m"
    }
  }'
```

Expected dashboard row: `SOL LIVE` (no EARLY pill - defaulted to core).

## 3a. Scalp_exit trades (3 cases: TP, SL, time_exit)

Scalp trades carry four extra fields - `exit_trigger`, `entry_bid`,
`exit_bid`, `realized_pnl_partial`. The dashboard renders them as a
purple SCALP pill in Recent Trades, a small grey trigger label under
the PNL value (TP / SL / TIME / RES), and a third column in the
Strategy Comparison card.

### TP (take-profit) hit

```bash
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "trade",
    "data": {
      "trade_id": "test-scalp-tp-001",
      "timestamp": "2026-04-24T14:10:00Z",
      "asset": "BTC",
      "direction": "UP",
      "entry_price": 0.51,
      "size_usd": 50.0,
      "shares": 98.04,
      "confidence": 0.68,
      "status": "CLOSED",
      "outcome": "WIN",
      "pnl": 4.5,
      "resolved_at": "2026-04-24T14:12:30Z",
      "end_time": "2026-04-24T14:15:00Z",
      "timeframe": "5m",
      "strategy_label": "scalp_exit",
      "exit_trigger": "take_profit",
      "entry_bid": 0.51,
      "exit_bid": 0.555,
      "realized_pnl_partial": 4.5
    }
  }'
```

Expected: `BTC LIVE SCALP` row, PNL `+$4.50` with `TP` underneath.

### SL (stop-loss) hit

```bash
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "trade",
    "data": {
      "trade_id": "test-scalp-sl-001",
      "timestamp": "2026-04-24T14:11:00Z",
      "asset": "ETH",
      "direction": "DOWN",
      "entry_price": 0.49,
      "size_usd": 40.0,
      "shares": 81.63,
      "confidence": 0.61,
      "status": "CLOSED",
      "outcome": "LOSS",
      "pnl": -3.0,
      "resolved_at": "2026-04-24T14:13:00Z",
      "end_time": "2026-04-24T14:16:00Z",
      "timeframe": "5m",
      "strategy_label": "scalp_exit",
      "exit_trigger": "stop_loss",
      "entry_bid": 0.49,
      "exit_bid": 0.46,
      "realized_pnl_partial": -3.0
    }
  }'
```

Expected: `ETH LIVE SCALP` row, PNL `-$3.00` with `SL` underneath.

### time_exit (timeout, no TP / SL hit)

```bash
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "trade",
    "data": {
      "trade_id": "test-scalp-time-001",
      "timestamp": "2026-04-24T14:12:00Z",
      "asset": "SOL",
      "direction": "UP",
      "entry_price": 0.53,
      "size_usd": 35.0,
      "shares": 66.04,
      "confidence": 0.59,
      "status": "CLOSED",
      "outcome": "WIN",
      "pnl": 0.7,
      "resolved_at": "2026-04-24T14:17:00Z",
      "end_time": "2026-04-24T14:17:00Z",
      "timeframe": "5m",
      "strategy_label": "scalp_exit",
      "exit_trigger": "time_exit",
      "entry_bid": 0.53,
      "exit_bid": 0.54,
      "realized_pnl_partial": 0.7
    }
  }'
```

Expected: `SOL LIVE SCALP` row, PNL `+$0.70` with `TIME` underneath.

### After all three pushes

The Strategy Comparison panel's SCALP column should read:

```
n             3
w / l         2 / 1
wr            66.7%
wilson 95%    20.8 - 93.9%
net pnl       +$2.20
mean ask      $0.510
profit factor 1.73

EXIT TRIGGERS
TP 33% · SL 33% · TIME 33%
```

## 4. Resolve a trade to populate WR / PNL / Wilson CI

The Strategy Comparison panel only counts resolved trades (WIN/LOSS),
matching the rest of the dashboard. Upsert with the same trade_id to
flip a row from PLACED to CLOSED:

```bash
# Resolve test-early-001 as a WIN +$20
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "trade",
    "data": {
      "trade_id": "test-early-001",
      "timestamp": "2026-04-24T14:01:00Z",
      "asset": "ETH", "direction": "DOWN",
      "entry_price": 0.48, "size_usd": 40.0, "shares": 83.33,
      "confidence": 0.58,
      "status": "CLOSED", "outcome": "WIN", "pnl": 20.0,
      "resolved_at": "2026-04-24T14:06:00Z",
      "end_time": "2026-04-24T14:06:00Z",
      "strategy_label": "early_entry"
    }
  }'
```

After this, the Strategy Comparison panel should show EARLY with n=1,
W/L=1/0, WR=100.0%, Wilson 95% ~[20.7-100.0%], Net PNL +$20.00,
Profit factor ∞ (no losses yet).

## 5. Filter dropdown sanity

Direct API calls (same auth as the browser - use `-b cookie.txt` after
logging in, or swap to the bot bearer for the server):

```bash
# All strategies (default)
curl -s "$DASHBOARD_URL/api/trades?limit=10"   -b cookie.txt | jq 'length'

# Core only - legacy NULL rows included
curl -s "$DASHBOARD_URL/api/trades?limit=10&strategy=expiry_convergence" \
  -b cookie.txt | jq '.[] | {trade_id, strategy_label}'

# Early only
curl -s "$DASHBOARD_URL/api/trades?limit=10&strategy=early_entry" \
  -b cookie.txt | jq '.[] | {trade_id, strategy_label}'
```

To get the session cookie:

```bash
curl -c cookie.txt -X POST "$DASHBOARD_URL/api/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'
```

## 6. Comparison endpoint

```bash
curl -s "$DASHBOARD_URL/api/strategy_compare" -b cookie.txt | jq
```

Expected shape:

```json
{
  "expiry_convergence": {"n": 2, "w": 1, "l": 1, "wr": 0.5, "net_pnl": 5.0, "mean_ask": 0.535, "profit_factor": 1.5},
  "early_entry":        {"n": 1, "w": 1, "l": 0, "wr": 1.0, "net_pnl": 20.0, "mean_ask": 0.48, "profit_factor": null}
}
```

`profit_factor: null` means the server saw no losses for that strategy;
the client renders this as ∞ when wins > 0, otherwise `--`.

## Cleanup

After testing, wipe the synthetic rows via the reset endpoint (scoped
to your user only):

```bash
curl -X POST "$DASHBOARD_URL/api/bot/push" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"reset","data":{"scope":["trades"]}}'
```

Or delete just the three test rows via Supabase SQL:

```sql
delete from public.trades
 where trade_id in ('test-core-001','test-early-001','test-null-001');
```
