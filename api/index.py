"""
BOTDASHBOARD — FastAPI serverless app (Vercel Python runtime).

Exposes:
  POST  /api/login              — username+password → HttpOnly session cookie
  POST  /api/logout
  GET   /api/me
  GET   /api/summary            — P&L, WR, Brier, level, streaks
  GET   /api/trades?limit=N
  GET   /api/per_asset
  GET   /api/wr_by_timeframe
  GET   /api/signals
  GET   /api/hourly
  GET   /api/pnl_series?limit=N
  POST  /api/bot/push           — bot pushes status/trade/signal (bearer auth)

All data endpoints are scoped to the authenticated user's user_id —
multi-tenant isolated at the query level (defense in depth on top of
Supabase RLS).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

# User's local tz — drives "today" windowing for P&L and daily stop displays.
# Override via env var if the user moves.
USER_TZ = ZoneInfo(os.getenv("USER_TZ", "America/Chicago"))

import time as _time

import httpx
from fastapi import Cookie, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

# Make sibling modules importable when deployed to Vercel
sys.path.insert(0, os.path.dirname(__file__))

from _db import Supabase, SupabaseError, db  # noqa: E402
from _security import (  # noqa: E402
    create_session_token,
    hash_bot_api_key,
    verify_password,
    verify_session_token,
)

SESSION_COOKIE = "polybot_session"

# Wallet address + Polygon RPC — matches what `core/trader.py:get_balance()` does.
# This is the operator's EOA (derived from POLY_PRIVATE_KEY on the bot side).
# Sourced from env var so rotating wallets does not require a code change.
WALLET_ADDRESS = os.getenv(
    "WALLET_ADDRESS",
    "0x78789Ca94AAC0ac697255DF7e429a6888Ac29b26",
).lower()
POLYGON_RPC_URL = os.getenv(
    "POLYGON_RPC_URL",
    "https://polygon-bor-rpc.publicnode.com",
)
USDC_E_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

# Cache the last successful on-chain read across warm serverless invocations
# so we do not hammer the public RPC on every dashboard poll (3s cadence).
_wallet_cache: Dict[str, Any] = {"balance": None, "fetched_at": 0.0}
_WALLET_CACHE_TTL_SEC = 30

app = FastAPI(
    title="PolyBot Dashboard",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# CORS — same-origin by default, widen if ALLOWED_ORIGINS env set (comma-sep)
_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )


# ─────────────────────────────────────────────────────────
# ON-CHAIN WALLET READER
#   Mirrors core/trader.py:get_balance() exactly — same RPC,
#   same USDC.e contract, same balanceOf() call. Raw JSON-RPC
#   avoids the web3.py cold-start overhead on Vercel.
# ─────────────────────────────────────────────────────────
def _fetch_wallet_usdc() -> Optional[float]:
    """Return on-chain USDC.e balance in USD, or None on failure."""
    now = _time.time()
    cached = _wallet_cache.get("balance")
    if cached is not None and now - _wallet_cache["fetched_at"] < _WALLET_CACHE_TTL_SEC:
        return float(cached)

    addr = WALLET_ADDRESS
    if not addr.startswith("0x") or len(addr) != 42:
        return None
    # balanceOf(address) selector = 0x70a08231
    padded = "0" * 24 + addr[2:].lower()
    data = "0x70a08231" + padded

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "params": [
            {"to": USDC_E_CONTRACT, "data": data},
            "latest",
        ],
    }
    try:
        with httpx.Client(timeout=4.0) as c:
            r = c.post(POLYGON_RPC_URL, json=payload)
            if r.status_code != 200:
                return cached if cached is not None else None
            result = r.json().get("result")
            if not result:
                return cached if cached is not None else None
            raw = int(result, 16)
            bal = raw / 1e6
            _wallet_cache["balance"] = bal
            _wallet_cache["fetched_at"] = now
            return bal
    except Exception:
        return cached if cached is not None else None


# ─────────────────────────────────────────────────────────
# AUTH HELPERS
# ─────────────────────────────────────────────────────────
def require_session(token: Optional[str]) -> dict:
    sess = verify_session_token(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Not authenticated")
    # Confirm user still exists (defense against deleted-but-valid-cookie)
    user = db().find_user_by_id(sess["user_id"])
    if not user:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return sess


def require_bot_key(authorization: Optional[str]) -> dict:
    """Parse `Authorization: Bearer <bot_api_key>` and resolve to user row."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    raw = authorization.split(" ", 1)[1].strip()
    if not raw:
        raise HTTPException(status_code=401, detail="Empty bearer token")
    key_hash = hash_bot_api_key(raw)
    user = db().find_user_by_api_key_hash(key_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid bot API key")
    return user


# ─────────────────────────────────────────────────────────
# AUTH ENDPOINTS
# ─────────────────────────────────────────────────────────
@app.post("/api/login")
async def login(request: Request, response: Response):
    body = await request.json()
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    if not username or not password:
        raise HTTPException(status_code=400, detail="Missing credentials")

    user = db().find_user_by_username(username)
    if not user or not verify_password(password, user["password_salt"], user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_session_token(user["id"], user["username"])
    response.set_cookie(
        SESSION_COOKIE, token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=24 * 3600,
        path="/",
    )

    # Fire-and-forget last_login_at update (best-effort)
    try:
        db().update("users", {"id": f"eq.{user['id']}"}, {"last_login_at": datetime.now(timezone.utc).isoformat()})
    except Exception:
        pass

    return {"ok": True, "username": user["username"]}


@app.post("/api/logout")
async def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/me")
async def me(polybot_session: Optional[str] = Cookie(None)):
    sess = require_session(polybot_session)
    return {"username": sess["username"]}


# ─────────────────────────────────────────────────────────
# DATA ENDPOINTS — all scoped to sess['user_id']
# ─────────────────────────────────────────────────────────
@app.get("/api/summary")
async def summary(response: Response, polybot_session: Optional[str] = Cookie(None)):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    s = db()

    # Status blob (latest bot push)
    status_rows = s.select("bot_status", filters={"user_id": f"eq.{uid}"}, limit=1)
    status = status_rows[0]["status"] if status_rows else {"running": False}

    # Current control command (dashboard → bot). Source of truth for button state.
    control_state = "start"
    try:
        ctrl_rows = s.select("bot_control", filters={"user_id": f"eq.{uid}"}, limit=1)
        if ctrl_rows:
            control_state = str(ctrl_rows[0].get("command") or "start").lower()
    except Exception:
        pass  # table not yet migrated — fall back to 'start'

    # All resolved trades for the user (reasonable cap — dashboard doesn't need more)
    trades = s.select(
        "trades",
        columns="timestamp,outcome,pnl,confidence",
        filters={"user_id": f"eq.{uid}"},
        order="timestamp.desc",
        limit=1000,
    )

    # On-chain wallet — ground-truth, independent of heartbeat freshness.
    onchain_usdc = _fetch_wallet_usdc()

    # Heartbeat freshness: bot pushes `status` at least every cycle (~5 min).
    # 7 min = 1 cycle + slack. Past that, the bot is either crashed or offline
    # and the dashboard must say so loudly rather than display a stale value.
    status_updated_at = status.get("updated_at")
    age_sec: Optional[int] = None
    if status_updated_at:
        try:
            ts = datetime.fromisoformat(str(status_updated_at).replace("Z", "+00:00"))
            age_sec = int((datetime.now(timezone.utc) - ts).total_seconds())
        except Exception:
            age_sec = None
    STALE_AFTER_SEC = int(os.getenv("STALE_AFTER_SEC", "420"))
    is_fresh = age_sec is not None and age_sec < STALE_AFTER_SEC

    out: Dict = {
        "status": status,
        "control_state": control_state,
        "pnl": {"today": 0.0, "net": 0.0},
        "win_rate": {"overall": 0.5, "recent20": 0.5, "recent50": 0.5},
        "trades": {"total": 0, "open": 0, "wins": 0, "losses": 0},
        "brier": 0.25,
        "consec_losses": 0,
        "max_loss_streak_today": 0,
        "losses_today": 0,
        "wins_today": 0,
        "last_10": [],
        "now_utc": datetime.now(timezone.utc).isoformat(),
        "wallet": {
            "onchain_usdc": onchain_usdc,
            "heartbeat_usdc": status.get("wallet_usdc"),
            "fetched_at": datetime.fromtimestamp(
                _wallet_cache["fetched_at"] or _time.time(), tz=timezone.utc,
            ).isoformat() if onchain_usdc is not None else None,
        },
        "heartbeat": {
            "age_sec": age_sec,
            "is_fresh": is_fresh,
            "stale_after_sec": STALE_AFTER_SEC,
            "updated_at": status_updated_at,
        },
    }

    if not trades:
        return out

    # "Today" window = from local-midnight (user's tz) to now, converted to UTC
    # so we can compare against trade.timestamp (ISO UTC from Supabase).
    now_local = datetime.now(USER_TZ)
    local_midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    day_start_utc = local_midnight.astimezone(timezone.utc)

    def _parse_ts(s: str) -> Optional[datetime]:
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None

    today_pnl = 0.0
    wins_today = 0
    losses_today = 0
    max_streak_today = 0
    cur_streak = 0
    # Trades are ordered timestamp.desc from the query. Walk chronologically
    # (oldest-first) to compute max-streak-today correctly.
    today_rows_asc = [
        t for t in reversed(trades)
        if (pt := _parse_ts(t.get("timestamp") or "")) and pt >= day_start_utc
    ]
    for t in today_rows_asc:
        pnl_val = float(t["pnl"] or 0)
        today_pnl += pnl_val
        oc = t.get("outcome")
        if oc == "WIN":
            wins_today += 1
            cur_streak = 0
        elif oc == "LOSS":
            losses_today += 1
            cur_streak += 1
            if cur_streak > max_streak_today:
                max_streak_today = cur_streak
    net_pnl = sum(float(t["pnl"] or 0) for t in trades)
    out["pnl"] = {"today": today_pnl, "net": net_pnl}
    out["wins_today"] = wins_today
    out["losses_today"] = losses_today
    out["max_loss_streak_today"] = max_streak_today

    wins = sum(1 for t in trades if t["outcome"] == "WIN")
    losses = sum(1 for t in trades if t["outcome"] == "LOSS")
    open_cnt = sum(1 for t in trades if t["outcome"] is None)
    out["trades"] = {"total": len(trades), "wins": wins, "losses": losses, "open": open_cnt}

    resolved = [t for t in trades if t["outcome"] is not None]
    if resolved:
        out["win_rate"]["overall"] = wins / len(resolved) if resolved else 0.5
        r20 = resolved[:20]
        r50 = resolved[:50]
        out["win_rate"]["recent20"] = sum(1 for t in r20 if t["outcome"] == "WIN") / len(r20) if r20 else 0.5
        out["win_rate"]["recent50"] = sum(1 for t in r50 if t["outcome"] == "WIN") / len(r50) if r50 else 0.5

        # Consecutive losses from most recent
        streak = 0
        for t in resolved[:20]:
            if t["outcome"] == "LOSS":
                streak += 1
            else:
                break
        out["consec_losses"] = streak

        # Brier on last 50
        if r50:
            b = sum(
                (float(t["confidence"] or 0) - (1.0 if t["outcome"] == "WIN" else 0.0)) ** 2
                for t in r50
            ) / len(r50)
            out["brier"] = b

        out["last_10"] = [t["outcome"] for t in resolved[:10]]

    return out


@app.get("/api/wallet")
async def wallet(polybot_session: Optional[str] = Cookie(None)):
    """On-chain USDC.e balance. Session-authenticated — same auth as
    all other data endpoints. Separate polling path so mobile refresh
    does not wait on Supabase when the user only needs the balance."""
    require_session(polybot_session)
    bal = _fetch_wallet_usdc()
    fetched_ts = _wallet_cache["fetched_at"]
    return {
        "onchain_usdc": bal,
        "address": WALLET_ADDRESS,
        "fetched_at": datetime.fromtimestamp(
            fetched_ts or _time.time(), tz=timezone.utc,
        ).isoformat() if bal is not None else None,
    }


# ─────────────────────────────────────────────────────────
# COPY-BOT v2 endpoints — feed the /copy.html page.
# All scoped to the authenticated session's user_id, copy-bot rows only.
# ─────────────────────────────────────────────────────────

def _copy_trade_filter(uid: str) -> Dict[str, str]:
    """PostgREST filter: this user's COPY-bot trades only.
    Excludes bachelier rows (strategy_label='expiry_convergence' and friends)."""
    return {"user_id": f"eq.{uid}", "bot_type": "eq.copy"}


def _utc_midnight() -> datetime:
    """Today's midnight in UTC (matches the bot's daily PnL anchor convention)."""
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


@app.get("/api/copy_summary")
async def copy_summary(
    response: Response,
    polybot_session: Optional[str] = Cookie(None),
):
    """Top-bar numbers: bankroll, cash, in-trades, today PnL, KS state.
    Reads bot_status for the bankroll/cash/exposure (heartbeat-driven) and
    derives today_pnl from copy-bot CLOSE rows since UTC midnight."""
    response.headers["Cache-Control"] = "no-store"
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    s = db()

    # Status row (the v2 bot pushes hourly with bankroll_usd, cash_usd, etc.)
    status_rows = s.select("bot_status", filters={"user_id": f"eq.{uid}"}, limit=1)
    status = status_rows[0]["status"] if status_rows else {}
    status_updated_at = status_rows[0]["updated_at"] if status_rows else None

    # Heartbeat freshness — bot pushes status hourly; >90 min = stale.
    age_sec: Optional[int] = None
    if status_updated_at:
        try:
            ts = datetime.fromisoformat(str(status_updated_at).replace("Z", "+00:00"))
            age_sec = int((datetime.now(timezone.utc) - ts).total_seconds())
        except Exception:
            pass
    fresh = age_sec is not None and age_sec < 5400  # 90 min

    # Today's PnL: sum realized_pnl_usd over CLOSE rows since UTC midnight.
    # Falls back to existing `pnl` column if realized_pnl_usd missing.
    midnight = _utc_midnight()
    try:
        rows = s.select(
            "trades",
            columns="action,realized_pnl_usd,pnl,timestamp,shadow",
            filters={**_copy_trade_filter(uid), "timestamp": f"gte.{midnight.isoformat()}"},
            limit=2000,
        )
    except Exception:
        # Pre-migration: no bot_type / realized_pnl_usd columns. Treat as no data.
        rows = []
    today_pnl = 0.0
    today_pnl_shadow = 0.0
    n_closes_today = 0
    for r in rows:
        is_shadow = bool(r.get("shadow")) or bool(r.get("is_shadow"))
        action = str(r.get("action") or "").upper()
        if action != "CLOSE":
            continue
        v = r.get("realized_pnl_usd")
        if v is None:
            v = r.get("pnl")
        try:
            v = float(v or 0)
            if is_shadow:
                today_pnl_shadow += v
            else:
                today_pnl += v
            n_closes_today += 1
        except (TypeError, ValueError):
            pass

    # Fall back to legacy bachelier-shape status fields if the v2 fields
    # aren't being pushed yet. wallet_usdc → bankroll. Live exposure is
    # COMPUTED from currently-open copy positions (sum of cost_basis).
    bankroll = status.get("bankroll_usd")
    if bankroll is None:
        bankroll = status.get("wallet_usdc")
    cash = status.get("cash_usd")
    if cash is None:
        # Best approximation: legacy status doesn't break out cash, but
        # 'wallet_usdc' minus open exposure is close enough.
        pass

    # Compute live exposure from open copy positions (sum of OPEN minus CLOSE
    # cost basis, only on rows with shares > 0). Cheap because we cap to
    # last 30d and only need cost_basis aggregation.
    live_exposure = 0.0
    n_open = 0
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        pos_rows = s.select(
            "trades",
            columns="condition_id,action,shares,amount_usd,executed_price,intended_price,shadow",
            filters={**_copy_trade_filter(uid), "timestamp": f"gte.{cutoff}", "shadow": "is.false"},
            limit=10000,
        )
        from collections import defaultdict as _dd
        grp = _dd(lambda: {"shares": 0.0, "cost": 0.0})
        for r in pos_rows:
            cid = r.get("condition_id")
            if not cid:
                continue
            sh = float(r.get("shares") or 0)
            px = r.get("executed_price")
            if px is None:
                px = r.get("intended_price")
            try:
                px = float(px) if px is not None else None
            except (TypeError, ValueError):
                px = None
            amt = float(r.get("amount_usd") or 0)
            a = (r.get("action") or "").upper()
            if a == "OPEN":
                grp[cid]["shares"] += sh
                grp[cid]["cost"] += amt if amt else (sh * (px or 0))
            elif a == "CLOSE":
                grp[cid]["shares"] -= sh
        for g in grp.values():
            if g["shares"] > 1e-6:
                live_exposure += g["cost"]
                n_open += 1
    except Exception:
        live_exposure = None
        n_open = 0

    if status.get("live_exposure_usd") is not None:
        live_exposure = float(status["live_exposure_usd"])

    if cash is None and bankroll is not None and live_exposure is not None:
        # Derived: cash = bankroll - in-trades
        cash = max(0.0, float(bankroll) - float(live_exposure))

    return {
        "bankroll_usd":       bankroll,
        "cash_usd":           cash,
        "live_exposure_usd":  live_exposure,
        "open_positions_n":   status.get("open_positions_n") or n_open,
        "today_pnl_usd":      today_pnl,
        "today_pnl_shadow_usd": today_pnl_shadow,
        "n_closes_today":     n_closes_today,
        "daily_cap_usd":      status.get("daily_cap_usd"),
        "daily_cap_remaining_usd": status.get("daily_cap_remaining_usd"),
        "ks_status":          status.get("ks_status") or "green",
        "live_authorized":    bool(status.get("live_authorized")),
        "n_paused_wallets":   status.get("n_paused_wallets"),
        "n_wallets_with_activity": status.get("n_wallets_with_activity"),
        "n_wallets_total":    status.get("n_wallets_total"),
        "heartbeat": {
            "age_sec":    age_sec,
            "is_fresh":   fresh,
            "updated_at": status_updated_at,
        },
        "now_utc": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/copy_open")
async def copy_open(polybot_session: Optional[str] = Cookie(None)):
    """Open live positions, grouped by condition_id (one row per market).
    Sums shares + cost across the OPEN fills minus any partial CLOSE fills
    for the same condition_id."""
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    s = db()
    # Pull recent live (non-shadow) copy fills. 30 days is comfortably wider
    # than any expected open-position lifespan for prediction markets.
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    try:
        rows = s.select(
            "trades",
            columns="trade_id,timestamp,wallet_label,wallet_address,asset_label,market_slug,condition_id,token_id,side,action,amount_usd,intended_price,executed_price,shares,realized_pnl_usd,shadow",
            filters={**_copy_trade_filter(uid), "timestamp": f"gte.{cutoff}"},
            order="timestamp.asc",
            limit=10000,
        )
    except Exception:
        # Pre-migration: columns don't exist. Empty.
        return {"positions": [], "now_utc": datetime.now(timezone.utc).isoformat()}

    # Group by condition_id, accumulate net shares + cost basis. Include
    # shadow rows but tag the position so the UI can dim them - we'd rather
    # show the operator their data with a 'shadow' badge than hide it
    # entirely if the bot is mislabelling shadow vs live.
    pos: Dict[str, Dict] = {}
    for r in rows:
        is_shadow = bool(r.get("shadow")) or bool(r.get("is_shadow"))
        cid = r.get("condition_id")
        if not cid:
            continue
        action = str(r.get("action") or "").upper()
        side = str(r.get("side") or "").upper()
        shares = float(r.get("shares") or 0)
        # Use executed_price when present (live fills), fall back to intended.
        px_raw = r.get("executed_price")
        if px_raw is None:
            px_raw = r.get("intended_price")
        try:
            px = float(px_raw) if px_raw is not None else None
        except (TypeError, ValueError):
            px = None
        amt = float(r.get("amount_usd") or 0)
        wallets = set()
        wallets.add(r.get("wallet_label") or r.get("wallet_address") or "?")
        b = pos.setdefault(cid, {
            "condition_id": cid,
            "asset_label":  r.get("asset_label") or r.get("market_slug") or cid[:12],
            "market_slug":  r.get("market_slug"),
            "token_id":     r.get("token_id"),
            "side":         side,
            "wallets":      set(),
            "net_shares":   0.0,
            "cost_basis":   0.0,
            "n_fills":      0,
            "first_ts":     r.get("timestamp"),
            "last_ts":      r.get("timestamp"),
            "realized_so_far": 0.0,
            "any_live":     False,
            "any_shadow":   False,
        })
        if is_shadow:
            b["any_shadow"] = True
        else:
            b["any_live"] = True
        b["wallets"].update(wallets)
        b["last_ts"] = r.get("timestamp") or b["last_ts"]
        b["n_fills"] += 1
        if action == "OPEN":
            b["net_shares"] += shares
            b["cost_basis"] += amt if amt else (shares * (px or 0))
        elif action == "CLOSE":
            b["net_shares"] -= shares
            # Reduce cost basis proportionally if we know per-share cost.
            try:
                b["realized_so_far"] += float(r.get("realized_pnl_usd") or 0)
            except (TypeError, ValueError):
                pass

    # Filter to actually-open (net_shares > tiny epsilon) and shape for response.
    out = []
    for cid, b in pos.items():
        if b["net_shares"] <= 1e-6:
            continue
        avg_entry = (b["cost_basis"] / b["net_shares"]) if b["net_shares"] > 0 else None
        # Shadow-only positions get tagged so the UI can dim them. A position
        # mixed live + shadow (rare) is shown as live.
        is_shadow_only = b["any_shadow"] and not b["any_live"]
        out.append({
            "condition_id": cid,
            "asset_label":  b["asset_label"],
            "market_slug":  b["market_slug"],
            "token_id":     b["token_id"],
            "side":         b["side"],
            "wallets":      sorted(w for w in b["wallets"] if w),
            "shares":       round(b["net_shares"], 4),
            "cost_basis":   round(b["cost_basis"], 2),
            "avg_entry":    round(avg_entry, 4) if avg_entry is not None else None,
            "n_fills":      b["n_fills"],
            "first_ts":     b["first_ts"],
            "last_ts":      b["last_ts"],
            "realized_partial": round(b["realized_so_far"], 2),
            "is_shadow":    is_shadow_only,
        })
    out.sort(key=lambda p: p["last_ts"] or "", reverse=True)
    return {"positions": out, "now_utc": datetime.now(timezone.utc).isoformat()}


@app.get("/api/copy_activity")
async def copy_activity(
    limit: int = 20,
    polybot_session: Optional[str] = Cookie(None),
):
    """Recent copy-bot activity (last N events). One row per fill.
    Sorted newest-first."""
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    s = db()
    try:
        rows = s.select(
            "trades",
            columns="trade_id,timestamp,wallet_label,wallet_address,asset_label,market_slug,condition_id,side,action,amount_usd,executed_price,intended_price,shares,realized_pnl_usd,shadow,latency_ms",
            filters=_copy_trade_filter(uid),
            order="timestamp.desc",
            limit=int(limit),
        )
    except Exception:
        return {"events": [], "now_utc": datetime.now(timezone.utc).isoformat()}
    out = []
    for r in rows:
        is_shadow = bool(r.get("shadow")) or bool(r.get("is_shadow"))
        out.append({
            "trade_id":     r.get("trade_id"),
            "timestamp":    r.get("timestamp"),
            "wallet":       r.get("wallet_label") or r.get("wallet_address"),
            "asset_label":  r.get("asset_label") or r.get("market_slug"),
            "side":         r.get("side"),
            "action":       r.get("action"),
            "amount_usd":   r.get("amount_usd"),
            "price":        r.get("executed_price") if r.get("executed_price") is not None else r.get("intended_price"),
            "shares":       r.get("shares"),
            "realized_pnl_usd": r.get("realized_pnl_usd"),
            "is_shadow":    is_shadow,
            "latency_ms":   r.get("latency_ms"),
        })
    return {"events": out, "now_utc": datetime.now(timezone.utc).isoformat()}


@app.get("/api/trades")
async def trades(
    limit: int = 25,
    shadow: Optional[str] = None,
    strategy: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    """
    Trade list.
      • shadow=1 | true            → only shadow-mode rows
      • shadow=0 | false           → only live rows (shadow is NULL or false)
      • strategy=expiry_convergence → core strategy only (NULLs included
                                       so legacy rows stay visible)
      • strategy=early_entry        → early strategy only
      • strategy=scalp_exit         → scalp strategy only
      • omit                        → all rows (backwards-compatible)
    """
    sess = require_session(polybot_session)
    filters = {"user_id": f"eq.{sess['user_id']}"}
    if shadow is not None:
        want = str(shadow).strip().lower() in ("1", "true", "yes")
        # Supabase/PostgREST filter. For the "live only" case include
        # legacy rows where shadow IS NULL, so pre-migration data stays
        # visible in the live tab.
        filters["shadow"] = "is.true" if want else "not.is.true"
    if strategy:
        s_norm = str(strategy).strip().lower()
        if s_norm == "expiry_convergence":
            # Include legacy NULL rows in the core view (they default to core).
            filters["or"] = "(strategy_label.eq.expiry_convergence,strategy_label.is.null)"
        elif s_norm == "early_entry":
            filters["strategy_label"] = "eq.early_entry"
        elif s_norm == "scalp_exit":
            filters["strategy_label"] = "eq.scalp_exit"
    # Column lists per fallback layer. Newest-added columns first so they
    # get dropped earliest if the DB schema hasn't caught up.
    _COLS_FULL = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow,strategy_label,exit_trigger,entry_bid,exit_bid,realized_pnl_partial"
    _COLS_NO_SCALP = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow,strategy_label"
    _COLS_NO_STRAT = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow"
    _COLS_NO_SHADOW = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode"
    _COLS_BASE = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time"
    try:
        rows = db().select("trades", columns=_COLS_FULL, filters=filters, order="timestamp.desc", limit=int(limit))
    except Exception:
        # Fallback 1: scalp_exit telemetry columns missing.
        try:
            rows = db().select("trades", columns=_COLS_NO_SCALP, filters=filters, order="timestamp.desc", limit=int(limit))
        except Exception:
            # Fallback 2: no strategy_label column yet — drop the filter too,
            # otherwise PostgREST would still 4xx on the missing column.
            filters.pop("strategy_label", None)
            filters.pop("or", None)
            try:
                rows = db().select("trades", columns=_COLS_NO_STRAT, filters=filters, order="timestamp.desc", limit=int(limit))
            except Exception:
                # Fallback 3: no shadow column yet.
                filters.pop("shadow", None)
                try:
                    rows = db().select("trades", columns=_COLS_NO_SHADOW, filters=filters, order="timestamp.desc", limit=int(limit))
                except Exception:
                    rows = db().select("trades", columns=_COLS_BASE, filters=filters, order="timestamp.desc", limit=int(limit))
    for r in rows:
        # Backfill: legacy rows without strategy_label default to core
        # (expiry_convergence) so the dashboard renders consistently.
        if not r.get("strategy_label"):
            r["strategy_label"] = "expiry_convergence"
        tf = "5m"
        if r.get("timestamp") and r.get("end_time"):
            try:
                t0 = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
                t1 = datetime.fromisoformat(r["end_time"].replace("Z", "+00:00"))
                mins = (t1 - t0).total_seconds() / 60.0
                if mins > 12:
                    tf = "15m"
                elif mins > 7:
                    tf = "10m"
            except Exception:
                pass
        r["timeframe"] = tf
    return rows


_SCALP_TRIGGER_BUCKETS = ("take_profit", "stop_loss", "time_exit", "resolution", "other")


def _bucket_trigger(raw: Optional[str]) -> str:
    """Normalise a free-form exit_trigger string to one of five buckets.
    Forgiving so the bot can send 'TP', 'tp', 'take_profit' interchangeably."""
    if not raw:
        return "other"
    s = str(raw).strip().lower()
    if s in ("tp", "take_profit", "takeprofit", "take-profit"):
        return "take_profit"
    if s in ("sl", "stop_loss", "stoploss", "stop-loss"):
        return "stop_loss"
    if s in ("time", "time_exit", "timeexit", "time-exit"):
        return "time_exit"
    if s in ("res", "resolution", "expiry", "expir", "expired"):
        return "resolution"
    return "other"


@app.get("/api/strategy_compare")
async def strategy_compare(polybot_session: Optional[str] = Cookie(None)):
    """Per-strategy aggregate (n, W/L, net PNL, mean ask, profit factor).

    Wilson 95% CI is computed client-side from n and W (cheaper than
    sending two extra floats and keeps the math co-located with the
    display). Open trades are excluded - resolved rows only, matching
    the rest of the dashboard's WR/PNL math.

    For scalp_exit, additionally returns a 'triggers' dict counting how
    many resolved scalp trades exited via take_profit / stop_loss /
    time_exit / resolution / other. Frontend renders this as a single
    extra row inside the SCALP column.
    """
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    # Try with exit_trigger first; fall back to without it (pre-scalp-migration),
    # then to without strategy_label (pre-strategy-split).
    try:
        rows = db().select(
            "trades",
            columns="outcome,pnl,entry_price,strategy_label,exit_trigger",
            filters={"user_id": f"eq.{uid}"},
            limit=10000,
        )
    except Exception:
        try:
            rows = db().select(
                "trades",
                columns="outcome,pnl,entry_price,strategy_label",
                filters={"user_id": f"eq.{uid}"},
                limit=10000,
            )
            for r in rows:
                r["exit_trigger"] = None
        except Exception:
            # Pre-strategy-split DB: no strategy_label column. Treat as all core.
            rows = db().select(
                "trades",
                columns="outcome,pnl,entry_price",
                filters={"user_id": f"eq.{uid}"},
                limit=10000,
            )
            for r in rows:
                r["strategy_label"] = "expiry_convergence"
                r["exit_trigger"] = None

    def _empty() -> Dict:
        return {"n": 0, "w": 0, "l": 0, "net": 0.0, "asks": [], "wins_pnl": 0.0, "loss_pnl": 0.0}

    agg = {
        "expiry_convergence": _empty(),
        "early_entry": _empty(),
        "scalp_exit": _empty(),
    }
    scalp_triggers = {b: 0 for b in _SCALP_TRIGGER_BUCKETS}
    for r in rows:
        oc = r.get("outcome")
        if oc not in ("WIN", "LOSS"):
            continue
        label = r.get("strategy_label") or "expiry_convergence"
        if label not in agg:
            label = "expiry_convergence"
        b = agg[label]
        b["n"] += 1
        if oc == "WIN":
            b["w"] += 1
        else:
            b["l"] += 1
        pnl = float(r.get("pnl") or 0)
        b["net"] += pnl
        if pnl > 0:
            b["wins_pnl"] += pnl
        elif pnl < 0:
            b["loss_pnl"] += abs(pnl)
        ep = r.get("entry_price")
        if ep is not None:
            try:
                b["asks"].append(float(ep))
            except (TypeError, ValueError):
                pass
        if label == "scalp_exit":
            scalp_triggers[_bucket_trigger(r.get("exit_trigger"))] += 1

    out: Dict[str, Dict] = {}
    for label, b in agg.items():
        wr = b["w"] / b["n"] if b["n"] else 0.0
        mean_ask = sum(b["asks"]) / len(b["asks"]) if b["asks"] else 0.0
        # Profit factor: sum(wins) / sum(|losses|). null when undefined
        # (no losses, or no resolved trades). Client handles 'no losses but
        # wins' as ∞ from the (l == 0, w > 0) condition.
        if b["loss_pnl"] > 0:
            pf: Optional[float] = b["wins_pnl"] / b["loss_pnl"]
        else:
            pf = None
        out[label] = {
            "n": b["n"],
            "w": b["w"],
            "l": b["l"],
            "wr": wr,
            "net_pnl": b["net"],
            "mean_ask": mean_ask,
            "profit_factor": pf,
        }
    # Scalp-only trigger counts. Always present (zeros if no scalp trades yet)
    # so the frontend can render the row without conditional null-checks.
    out["scalp_exit"]["triggers"] = scalp_triggers
    return out


@app.get("/api/per_asset")
async def per_asset(polybot_session: Optional[str] = Cookie(None)):
    sess = require_session(polybot_session)
    rows = db().select(
        "trades",
        columns="asset,outcome,pnl",
        filters={"user_id": f"eq.{sess['user_id']}"},
        limit=5000,
    )
    agg: Dict[str, Dict] = {}
    for r in rows:
        if r["outcome"] is None:
            continue
        a = r["asset"] or "?"
        bucket = agg.setdefault(a, {"total": 0, "wins": 0, "pnl": 0.0})
        bucket["total"] += 1
        bucket["wins"] += 1 if r["outcome"] == "WIN" else 0
        bucket["pnl"] += float(r["pnl"] or 0)
    out = [
        {
            "asset": a,
            "total": b["total"],
            "wins": b["wins"],
            "win_rate": (b["wins"] / b["total"]) if b["total"] else 0.0,
            "pnl": b["pnl"],
        }
        for a, b in agg.items()
    ]
    out.sort(key=lambda x: x["pnl"], reverse=True)
    return out


@app.get("/api/wr_by_timeframe")
async def wr_by_timeframe(polybot_session: Optional[str] = Cookie(None)):
    sess = require_session(polybot_session)
    rows = db().select(
        "trades",
        columns="timestamp,end_time,outcome,pnl",
        filters={"user_id": f"eq.{sess['user_id']}"},
        limit=5000,
    )
    agg: Dict[str, Dict] = {"5m": {"total": 0, "wins": 0, "pnl": 0.0},
                            "10m": {"total": 0, "wins": 0, "pnl": 0.0},
                            "15m": {"total": 0, "wins": 0, "pnl": 0.0}}
    for r in rows:
        if r["outcome"] is None or not r["timestamp"] or not r["end_time"]:
            continue
        try:
            t0 = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(r["end_time"].replace("Z", "+00:00"))
            minutes = (t1 - t0).total_seconds() / 60.0
        except Exception:
            continue
        if minutes <= 7:
            tf = "5m"
        elif minutes <= 12:
            tf = "10m"
        else:
            tf = "15m"
        bucket = agg[tf]
        bucket["total"] += 1
        bucket["wins"] += 1 if r["outcome"] == "WIN" else 0
        bucket["pnl"] += float(r["pnl"] or 0)
    return [
        {
            "timeframe": tf,
            "total": b["total"],
            "wins": b["wins"],
            "win_rate": (b["wins"] / b["total"]) if b["total"] else 0.0,
            "pnl": b["pnl"],
        }
        for tf, b in agg.items()
        if b["total"] > 0
    ]


@app.get("/api/signals")
async def signals(polybot_session: Optional[str] = Cookie(None)):
    sess = require_session(polybot_session)
    rows = db().select(
        "signal_performance",
        filters={"user_id": f"eq.{sess['user_id']}", "asset": "eq.ALL"},
        order="win_rate.desc",
        limit=50,
    )
    rows = [r for r in rows if (r.get("times_seen") or 0) >= 5]
    top = rows[:7]
    worst = sorted(rows, key=lambda r: r["win_rate"])[:5]
    return {"top": top, "worst": worst}


@app.get("/api/hourly")
async def hourly(polybot_session: Optional[str] = Cookie(None)):
    sess = require_session(polybot_session)
    rows = db().select(
        "trades",
        columns="timestamp,outcome",
        filters={"user_id": f"eq.{sess['user_id']}"},
        limit=5000,
    )
    agg: Dict[int, Dict] = {}
    for r in rows:
        if r["outcome"] is None or not r["timestamp"]:
            continue
        try:
            h = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")).hour
        except Exception:
            continue
        bucket = agg.setdefault(h, {"total": 0, "wins": 0})
        bucket["total"] += 1
        bucket["wins"] += 1 if r["outcome"] == "WIN" else 0
    return [
        {
            "hour": h,
            "total": b["total"],
            "wins": b["wins"],
            "win_rate": (b["wins"] / b["total"]) if b["total"] else 0.0,
        }
        for h, b in sorted(agg.items())
    ]


@app.get("/api/pnl_series")
async def pnl_series(
    limit: int = 200,
    polybot_session: Optional[str] = Cookie(None),
):
    sess = require_session(polybot_session)
    rows = db().select(
        "trades",
        columns="timestamp,pnl,outcome",
        filters={"user_id": f"eq.{sess['user_id']}"},
        order="timestamp.asc",
        limit=int(limit),
    )
    out: List[Dict] = []
    running = 0.0
    for r in rows:
        if r["outcome"] is None:
            continue
        running += float(r["pnl"] or 0)
        out.append({"ts": r["timestamp"], "cum_pnl": running})
    return out


# ─────────────────────────────────────────────────────────
# BOT CONTROL — dashboard → bot (pause/start)
#   Dashboard: POST /api/bot/control  (cookie auth, body={"command":"pause"|"start"})
#   Bot:        GET /api/bot/control  (bearer auth, returns current command)
# ─────────────────────────────────────────────────────────
@app.post("/api/bot/control")
async def bot_control_set(
    request: Request,
    polybot_session: Optional[str] = Cookie(None),
):
    sess = require_session(polybot_session)
    body = await request.json()
    cmd = str(body.get("command", "")).lower().strip()
    if cmd not in ("start", "pause"):
        raise HTTPException(status_code=400, detail="command must be 'start' or 'pause'")
    try:
        db().upsert(
            "bot_control",
            {
                "user_id": sess["user_id"],
                "command": cmd,
                "issued_at": datetime.now(timezone.utc).isoformat(),
                "issued_by": sess.get("username") or "dashboard",
            },
            on_conflict="user_id",
        )
    except Exception as e:
        # Most common: migration not run yet → table doesn't exist.
        raise HTTPException(
            status_code=503,
            detail=f"bot_control table missing? Run SQL migration. ({str(e)[:140]})",
        )
    return {"ok": True, "command": cmd}


@app.get("/api/bot/control")
async def bot_control_get(authorization: Optional[str] = Header(None)):
    user = require_bot_key(authorization)
    rows = db().select("bot_control", filters={"user_id": f"eq.{user['id']}"}, limit=1)
    if not rows:
        return {"command": "start", "issued_at": None}
    return {"command": rows[0].get("command") or "start", "issued_at": rows[0].get("issued_at")}


# ─────────────────────────────────────────────────────────
# BOT PUSH ENDPOINT
#   Bot POSTs: {"type": "status"|"trade"|"signal", "data": {...}}
#   Authenticates via Authorization: Bearer <bot_api_key>
# ─────────────────────────────────────────────────────────
@app.post("/api/bot/push")
async def bot_push(
    request: Request,
    authorization: Optional[str] = Header(None),
):
    user = require_bot_key(authorization)
    uid = user["id"]

    body = await request.json()
    kind = str(body.get("type", "")).lower()
    data = body.get("data") or {}
    if not isinstance(data, (dict, list)):
        raise HTTPException(status_code=400, detail="`data` must be an object or list")

    s = db()
    if kind == "status":
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="status `data` must be object")
        s.upsert(
            "bot_status",
            {
                "user_id": uid,
                "status": data,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="user_id",
        )
        return {"ok": True, "type": "status"}

    if kind == "trade":
        rows = data if isinstance(data, list) else [data]
        payload = []
        # Server-side default for `timestamp` so a payload that omits it
        # doesn't blow up against the NOT NULL constraint. Used per row only
        # if the bot didn't send one.
        _now_iso = datetime.now(timezone.utc).isoformat()
        for r in rows:
            if not r.get("trade_id"):
                raise HTTPException(status_code=400, detail="trade.data.trade_id required")
            # Timestamp: schema requires NOT NULL. Bot CAN send 'timestamp' or
            # 'submitted_at_utc' (v2 spec has both); we fall through them and
            # stamp NOW as a last resort. Same for submitted_at_utc.
            ts = r.get("timestamp") or r.get("submitted_at_utc") or _now_iso
            sub_ts = r.get("submitted_at_utc") or r.get("timestamp") or _now_iso
            # Strategy label: known values are expiry_convergence, early_entry,
            # scalp_exit. Null/missing/unknown falls back to expiry_convergence.
            # Keeps older bot builds (pre-strategy-split) compatible.
            raw_strat = r.get("strategy_label")
            strat = str(raw_strat).strip() if raw_strat else "expiry_convergence"
            if strat not in ("expiry_convergence", "early_entry", "scalp_exit"):
                strat = "expiry_convergence"
            # bot_type: 'copy' or 'bachelier'. Look in three places:
            #   1. data.bot_type (per-row, takes precedence)
            #   2. envelope-level body.bot_type (single value for whole batch)
            #   3. INFER from v2-field presence — if the row has wallet_label /
            #      condition_id / action / wallet_address / asset_label, it's a
            #      copy-bot trade by structure even if the field wasn't sent.
            #      This catches bots that forget to set bot_type but still send
            #      the rest of the v2 payload.
            raw_bt = r.get("bot_type") or body.get("bot_type")
            bt = str(raw_bt).strip().lower() if raw_bt else None
            if bt not in ("copy", "bachelier"):
                # Infer from shape: any of these fields existing = copy bot.
                v2_signal = any(r.get(k) for k in
                                ("wallet_label", "wallet_address", "condition_id",
                                 "asset_label", "market_slug", "action"))
                bt = "copy" if v2_signal else "bachelier"
            # is_shadow folds into the existing `shadow` boolean column. Bot
            # may send either name; we honor whichever it sends.
            shadow_val = bool(r.get("is_shadow", r.get("shadow", False)))
            payload.append({
                "user_id": uid,
                "trade_id": str(r["trade_id"]),
                "timestamp": ts,
                # ── legacy bachelier fields (NULL on copy-bot trades) ──
                "asset": r.get("asset"),
                "direction": r.get("direction"),
                "entry_price": r.get("entry_price"),
                "size_usd": r.get("size_usd"),
                "shares": r.get("shares"),
                "confidence": r.get("confidence"),
                "status": r.get("status"),
                "outcome": r.get("outcome"),
                "pnl": r.get("pnl", 0),
                "resolved_at": r.get("resolved_at"),
                "end_time": r.get("end_time"),
                "timeframe": r.get("timeframe", "5m"),
                "mode": r.get("mode"),
                "shadow": shadow_val,
                "strategy_label": strat,
                # ── scalp_exit telemetry (bachelier only, NULL on copy) ──
                "exit_trigger": r.get("exit_trigger"),
                "entry_bid": r.get("entry_bid"),
                "exit_bid": r.get("exit_bid"),
                "realized_pnl_partial": r.get("realized_pnl_partial"),
                # ── copy-bot v2 fields (NULL on bachelier trades) ──
                "wallet_address": r.get("wallet_address"),
                "wallet_label": r.get("wallet_label"),
                "asset_label": r.get("asset_label"),
                "market_slug": r.get("market_slug"),
                "condition_id": r.get("condition_id"),
                "token_id": r.get("token_id"),
                "action": r.get("action"),
                "side": r.get("side"),
                "amount_usd": r.get("amount_usd"),
                "intended_price": r.get("intended_price"),
                "executed_price": r.get("executed_price"),
                "realized_pnl_usd": r.get("realized_pnl_usd"),
                "submitted_at_utc": sub_ts,
                "latency_ms": r.get("latency_ms"),
                "bot_type": bt,
            })
        # Smart fallback: parse the PostgREST error to find the SPECIFIC
        # column the DB doesn't have, drop just that one, retry. Stops the
        # old "drop a whole group on every failure" behaviour, which was
        # silently nuking v2 fields whenever an unrelated column (e.g.
        # `timeframe`) was missing.
        import re as _re
        _col_err = _re.compile(
            r"(?:column [\w\.]*?\.?(\w+) (?:does not exist|of '\w+' in the schema cache))|"
            r"(?:Could not find the '(\w+)' column)",
            _re.IGNORECASE,
        )
        max_retries = 25  # bounded - never infinite-loop on an unreadable error
        last_exc: Optional[Exception] = None
        dropped: List[str] = []
        for _ in range(max_retries):
            try:
                s.upsert("trades", payload, on_conflict="user_id,trade_id")
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                msg = str(exc)
                m = _col_err.search(msg)
                col = (m.group(1) or m.group(2)) if m else None
                if not col:
                    # Error isn't about a missing column - can't fix by dropping.
                    break
                # Don't drop columns the schema requires (would 500 anyway).
                if col in ("user_id", "trade_id", "timestamp"):
                    break
                # Already dropped this column? Bail to avoid an infinite loop.
                if col in dropped:
                    break
                dropped.append(col)
                for p in payload:
                    p.pop(col, None)
        if last_exc is not None:
            # Surface the actual SQL error + which columns we dropped.
            raise HTTPException(
                status_code=500,
                detail=f"trade upsert failed (dropped={dropped}): {str(last_exc)[:300]}",
            )
        return {"ok": True, "type": "trade", "count": len(payload), "dropped_cols": dropped}

    if kind == "signal":
        rows = data if isinstance(data, list) else [data]
        payload = []
        for r in rows:
            if not r.get("signal_name"):
                raise HTTPException(status_code=400, detail="signal.data.signal_name required")
            payload.append({
                "user_id": uid,
                "asset": r.get("asset", "ALL"),
                "signal_name": r["signal_name"],
                "times_seen": r.get("times_seen", 0),
                "times_correct": r.get("times_correct", 0),
                "win_rate": r.get("win_rate", 0.5),
                "weight": r.get("weight", 1.0),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        s.upsert("signal_performance", payload, on_conflict="user_id,asset,signal_name")
        return {"ok": True, "type": "signal", "count": len(payload)}

    if kind == "reset":
        # Wipe all user data (trades, signals, status). Idempotent.
        # Scope: user_id only. No cross-user impact.
        scope = data.get("scope") if isinstance(data, dict) else None
        scopes = set(scope) if isinstance(scope, list) else {"trades", "signals", "status"}
        deleted = {}
        try:
            if "trades" in scopes:
                r = s.delete("trades", filters={"user_id": f"eq.{uid}"})
                deleted["trades"] = r
            if "signals" in scopes:
                r = s.delete("signal_performance", filters={"user_id": f"eq.{uid}"})
                deleted["signals"] = r
            if "status" in scopes:
                s.upsert(
                    "bot_status",
                    {
                        "user_id": uid,
                        "status": {
                            "running": False, "dry_run": False,
                            "net_pnl": 0, "today_pnl": 0,
                            "scale_level": None, "last_update": None,
                        },
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                    on_conflict="user_id",
                )
                deleted["status"] = "reset"
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"reset failed: {e}")
        return {"ok": True, "type": "reset", "deleted": deleted}

    raise HTTPException(status_code=400, detail=f"Unknown type: {kind}")


# ─────────────────────────────────────────────────────────
# HEALTH / ROOT (Vercel pings these)
# ─────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    try:
        db()  # init check
        return {"ok": True, "ts": datetime.now(timezone.utc).isoformat()}
    except Exception as e:
        return Response(
            content=f'{{"ok": false, "error": "{str(e)[:200]}"}}',
            media_type="application/json",
            status_code=500,
        )


# Catch-all 404 for any unknown /api path (keeps debugging clean)
@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def _fallback(path: str):
    raise HTTPException(status_code=404, detail=f"Unknown endpoint /api/{path}")
