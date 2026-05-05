#!/usr/bin/env bash
# scripts/diagnose_bot.sh
# Run this on the BOT'S Mac, in the BOT's project directory (the one
# with the bot's .env). It tells us in one go:
#   1. What URL the bot is configured to push to
#   2. Whether the URL is reachable
#   3. Whether the bot's API key authenticates
#   4. Whether a sample trade push lands as 200
#   5. What's in data/trades.db (count of fills)
#
# Paste the entire output back. No secrets are printed verbatim — keys
# are truncated to a fingerprint that's safe to share.

set -u

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERR: no $ENV_FILE in $(pwd). Pass the path as first arg, e.g.:"
  echo "  ./diagnose_bot.sh /path/to/copy-bot/.env"
  exit 1
fi

URL=$(grep -E '^DASHBOARD_URL' "$ENV_FILE" | head -1 | sed 's/^DASHBOARD_URL=//' | tr -d '\"' | tr -d "'" | sed 's:/*$::')
KEY=$(grep -E '^BOT_API_KEY' "$ENV_FILE" | head -1 | sed 's/^BOT_API_KEY=//' | tr -d '\"' | tr -d "'")

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "ERR: DASHBOARD_URL or BOT_API_KEY not found in $ENV_FILE"
  exit 1
fi

KEY_PREFIX="${KEY:0:8}"
KEY_LEN=${#KEY}
KEY_SHA=$(printf '%s' "$KEY" | shasum -a 256 | awk '{print $1}')

echo "═══════════════════════════════════════════════════════════"
echo "  COPY-BOT DIAGNOSTIC"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "1. Bot config (.env)"
echo "   DASHBOARD_URL = $URL"
echo "   BOT_API_KEY   = ${KEY_PREFIX}... (${KEY_LEN} chars total)"
echo "   key sha256    = $KEY_SHA"
echo "   (sha256 is safe to share — it's what the dashboard stores)"
echo ""

echo "2. Is the URL reachable?"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${URL}/api/health")
echo "   GET ${URL}/api/health -> HTTP $HEALTH"
if [ "$HEALTH" != "200" ]; then
  echo "   ✗ URL not reachable. Bot would never deliver pushes here."
  exit 1
fi
echo "   ✓ reachable"
echo ""

echo "3. Does the API key authenticate?"
AUTH_TEST=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${URL}/api/bot/push" \
  -H "Authorization: Bearer ${KEY}" \
  -H "Content-Type: application/json" \
  -d '{"type":"status","data":{}}')
echo "   POST status with this key -> HTTP $AUTH_TEST"
if [ "$AUTH_TEST" = "401" ]; then
  echo "   ✗ Key does not match any user on this dashboard."
  echo "     Either the bot is pushing to a DIFFERENT dashboard (different"
  echo "     SUPABASE), or the key has been rotated."
elif [ "$AUTH_TEST" = "200" ]; then
  echo "   ✓ key authenticates"
else
  echo "   ? unexpected status $AUTH_TEST"
fi
echo ""

echo "4. Sample TRADE push (the one that was 500-ing)"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESP=$(curl -s -X POST "${URL}/api/bot/push" \
  -H "Authorization: Bearer ${KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\":\"trade\",
    \"data\":{
      \"trade_id\":\"diag-$$-$(date +%s)\",
      \"timestamp\":\"$NOW\",
      \"action\":\"OPEN\",
      \"wallet_label\":\"diag-test-wallet\",
      \"is_shadow\":false,
      \"amount_usd\":1.0,
      \"bot_type\":\"copy\",
      \"asset_label\":\"DIAG TEST (delete me)\",
      \"condition_id\":\"0xDIAG-$$\",
      \"side\":\"BUY\",
      \"intended_price\":0.5,
      \"shares\":2.0
    }
  }" -w "\nHTTP %{http_code}")
echo "$RESP" | sed 's/^/   /'
echo ""

echo "5. Local SQLite journal"
if [ -f "data/trades.db" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    N=$(sqlite3 data/trades.db "select count(*) from sqlite_master where type='table';" 2>/dev/null)
    echo "   data/trades.db exists, $N tables"
    sqlite3 data/trades.db ".tables" 2>/dev/null | sed 's/^/     /'
    # Try to get total fill count from common table names
    for t in trades fills events; do
      C=$(sqlite3 data/trades.db "select count(*) from $t;" 2>/dev/null)
      [ -n "$C" ] && echo "   $t: $C rows"
    done
  else
    echo "   data/trades.db exists ($(du -h data/trades.db | awk '{print $1}')) but sqlite3 CLI missing"
  fi
else
  echo "   no data/trades.db at $(pwd)/data/trades.db"
fi
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "Done. Paste the above (it's safe — no secrets) into the chat."
echo "═══════════════════════════════════════════════════════════"
