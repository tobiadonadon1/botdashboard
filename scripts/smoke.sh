#!/usr/bin/env bash
#
# scripts/smoke.sh - hit every dashboard endpoint once, assert shape.
#
# Usage:
#   DASHBOARD_URL=https://botdashboard.vercel.app \
#   USERNAME=tobia \
#   PASSWORD=... \
#   ./scripts/smoke.sh
#
#   # Optional bot-side push tests (writes throwaway rows to Supabase):
#   BOT_API_KEY=bot_xxx ./scripts/smoke.sh --with-push
#
# Exits non-zero on the first failed assertion.

set -e -u -o pipefail

: "${DASHBOARD_URL:=http://127.0.0.1:8787}"
: "${USERNAME:?USERNAME env var required}"
: "${PASSWORD:?PASSWORD env var required}"
WITH_PUSH=0
[[ "${1:-}" == "--with-push" ]] && WITH_PUSH=1

JAR=$(mktemp -t polybot-smoke.XXXXXX)
trap "rm -f $JAR" EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
DIM=$'\033[2m'
RST=$'\033[0m'

pass=0
fail=0

assert_http() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ${GREEN}OK${RST}  $label  HTTP $actual"
    pass=$((pass + 1))
  else
    echo "  ${RED}FAIL${RST} $label  HTTP $actual (expected $expected)"
    fail=$((fail + 1))
  fi
}

assert_jq() {
  local label="$1" body="$2" filter="$3"
  if printf '%s' "$body" | jq -e "$filter" >/dev/null 2>&1; then
    echo "  ${GREEN}OK${RST}  $label  $DIM($filter)$RST"
    pass=$((pass + 1))
  else
    echo "  ${RED}FAIL${RST} $label  $DIM($filter)$RST"
    echo "${DIM}    body: $(printf '%s' "$body" | head -c 200)$RST"
    fail=$((fail + 1))
  fi
}

# Helper: GET an authenticated endpoint, return body + status separated by '|'.
get() {
  local path="$1"
  local tmp; tmp=$(mktemp)
  local status; status=$(curl -s -o "$tmp" -w "%{http_code}" -b "$JAR" -c "$JAR" "$DASHBOARD_URL$path")
  printf '%s|' "$status"
  cat "$tmp"
  rm -f "$tmp"
}

echo "${DIM}--- health (unauth) ---${RST}"
H=$(curl -s -o /dev/null -w "%{http_code}" "$DASHBOARD_URL/api/health")
assert_http "/api/health" 200 "$H"

echo "${DIM}--- login ---${RST}"
LOGIN=$(curl -s -c "$JAR" -X POST "$DASHBOARD_URL/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
  -w "\n%{http_code}")
LOGIN_STATUS=$(printf '%s' "$LOGIN" | tail -1)
LOGIN_BODY=$(printf '%s' "$LOGIN" | head -n -1)
assert_http "/api/login" 200 "$LOGIN_STATUS"
assert_jq "/api/login.ok" "$LOGIN_BODY" '.ok == true'

echo "${DIM}--- read endpoints (default + bot_type=copy + bot_type=bachelier) ---${RST}"
for path in \
  "/api/me" \
  "/api/summary" \
  "/api/summary?bot_type=copy" \
  "/api/summary?bot_type=bachelier" \
  "/api/wallet" \
  "/api/trades?limit=5" \
  "/api/trades?limit=5&bot_type=copy" \
  "/api/trades?limit=5&bot_type=bachelier" \
  "/api/strategy_compare" \
  "/api/per_asset" \
  "/api/per_asset?bot_type=copy" \
  "/api/wr_by_timeframe" \
  "/api/hourly" \
  "/api/pnl_series?limit=20" \
  "/api/combined_summary" \
  "/api/copy_wallets"
do
  R=$(get "$path")
  status=${R%%|*}
  body=${R#*|}
  assert_http "$path" 200 "$status"
done

# Shape checks for the new endpoints.
echo "${DIM}--- combined_summary shape ---${RST}"
R=$(get "/api/combined_summary"); body=${R#*|}
assert_jq "combined_summary.copy" "$body" '.copy | type == "object"'
assert_jq "combined_summary.bachelier" "$body" '.bachelier | type == "object"'
assert_jq "combined_summary.combined" "$body" '.combined | type == "object"'
assert_jq "combined_summary.combined.kill_state" "$body" '.combined.kill_state | IN("green", "amber", "red")'
assert_jq "combined_summary.copy.configured" "$body" '.copy.configured | type == "boolean"'
assert_jq "combined_summary.bachelier.configured" "$body" '.bachelier.configured | type == "boolean"'

echo "${DIM}--- copy_wallets shape ---${RST}"
R=$(get "/api/copy_wallets"); body=${R#*|}
assert_jq "copy_wallets.wallets" "$body" '.wallets | type == "array"'
assert_jq "copy_wallets.active_wallets" "$body" '.active_wallets | type == "number"'
assert_jq "copy_wallets.configured" "$body" '.configured | type == "boolean"'

# Optional push smoke. Writes 2 throwaway trades (one per bot_type).
if [[ "$WITH_PUSH" == "1" ]]; then
  if [[ -z "${BOT_API_KEY:-}" ]]; then
    echo "${RED}--with-push set but BOT_API_KEY missing${RST}"
    fail=$((fail + 1))
  else
    echo "${DIM}--- bot push (--with-push) ---${RST}"
    TS=$(python3 -c 'from datetime import datetime,timezone; print(datetime.now(timezone.utc).isoformat())')
    PUSH=$(curl -s -X POST "$DASHBOARD_URL/api/bot/push" \
      -H "Authorization: Bearer $BOT_API_KEY" -H "Content-Type: application/json" \
      -d "{\"type\":\"trade\",\"bot_type\":\"copy\",\"data\":{\"trade_id\":\"smoke-copy-$$\",\"timestamp\":\"$TS\",\"asset\":\"BTC\",\"direction\":\"UP\",\"entry_price\":0.55,\"size_usd\":10,\"shares\":18,\"confidence\":0.6,\"status\":\"PLACED\",\"end_time\":\"$TS\",\"source_wallet\":\"0xsmoketest1\"}}" \
      -w "\n%{http_code}")
    PUSH_STATUS=$(printf '%s' "$PUSH" | tail -1)
    assert_http "POST /api/bot/push (copy)" 200 "$PUSH_STATUS"

    PUSH=$(curl -s -X POST "$DASHBOARD_URL/api/bot/push" \
      -H "Authorization: Bearer $BOT_API_KEY" -H "Content-Type: application/json" \
      -d "{\"type\":\"trade\",\"bot_type\":\"bachelier\",\"data\":{\"trade_id\":\"smoke-bach-$$\",\"timestamp\":\"$TS\",\"asset\":\"BTC\",\"direction\":\"UP\",\"entry_price\":0.55,\"size_usd\":10,\"shares\":18,\"confidence\":0.6,\"status\":\"PLACED\",\"end_time\":\"$TS\"}}" \
      -w "\n%{http_code}")
    PUSH_STATUS=$(printf '%s' "$PUSH" | tail -1)
    assert_http "POST /api/bot/push (bachelier)" 200 "$PUSH_STATUS"
  fi
fi

echo ""
echo "${GREEN}pass:${RST} $pass   ${RED}fail:${RST} $fail"
[[ $fail -eq 0 ]] || exit 1
