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
async def summary(
    response: Response,
    bot_type: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    s = db()
    # bot_type defaults to bachelier so legacy /api/summary callers keep working.
    bt = _normalize_bot_type(bot_type)

    # Status blob (latest bot push for this bot_type).
    # Try composite filter first, fall back to single user_id read on
    # pre-migration DBs.
    try:
        status_rows = s.select(
            "bot_status",
            filters={"user_id": f"eq.{uid}", "bot_type": f"eq.{bt}"},
            limit=1,
        )
    except Exception:
        status_rows = s.select("bot_status", filters={"user_id": f"eq.{uid}"}, limit=1)
    status = status_rows[0]["status"] if status_rows else {"running": False}

    # Current control command (dashboard → bot). Source of truth for button state.
    control_state = "start"
    try:
        try:
            ctrl_rows = s.select(
                "bot_control",
                filters={"user_id": f"eq.{uid}", "bot_type": f"eq.{bt}"},
                limit=1,
            )
        except Exception:
            ctrl_rows = s.select("bot_control", filters={"user_id": f"eq.{uid}"}, limit=1)
        if ctrl_rows:
            control_state = str(ctrl_rows[0].get("command") or "start").lower()
    except Exception:
        pass  # table not yet migrated — fall back to 'start'

    # All resolved trades for the user (reasonable cap — dashboard doesn't need more)
    trades = _select_trades_bot_aware(
        columns="timestamp,outcome,pnl,confidence",
        filters={"user_id": f"eq.{uid}", **_trades_bot_filter(bt)},
        wanted_bt=bt,
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


@app.get("/api/trades")
async def trades(
    limit: int = 25,
    shadow: Optional[str] = None,
    strategy: Optional[str] = None,
    bot_type: Optional[str] = None,
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
      • bot_type=copy | bachelier   → restrict to one bot. Legacy NULL
                                       rows fold into 'bachelier' (matches
                                       the storage default).
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
    bt_norm: Optional[str] = None
    if bot_type:
        bt_norm = _normalize_bot_type(bot_type)
        if bt_norm == "bachelier":
            # Legacy rows have NULL bot_type → fold them into the bachelier view.
            existing_or = filters.pop("or", None)
            bt_or = "(bot_type.eq.bachelier,bot_type.is.null)"
            # If a strategy 'or' is already set, the two ORs would compose
            # incorrectly under PostgREST. Detect + skip the bot_type fold-in
            # because all strategy_label rows are bachelier-only anyway.
            if existing_or:
                filters["or"] = existing_or
            else:
                filters["or"] = bt_or
        else:
            filters["bot_type"] = "eq.copy"
    # Column lists per fallback layer. Newest-added columns first so they
    # get dropped earliest if the DB schema hasn't caught up.
    _COLS_FULL = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow,strategy_label,exit_trigger,entry_bid,exit_bid,realized_pnl_partial,bot_type,source_wallet"
    _COLS_NO_BOT = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow,strategy_label,exit_trigger,entry_bid,exit_bid,realized_pnl_partial"
    _COLS_NO_SCALP = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow,strategy_label"
    _COLS_NO_STRAT = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow"
    _COLS_NO_SHADOW = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode"
    _COLS_BASE = "trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time"
    try:
        rows = db().select("trades", columns=_COLS_FULL, filters=filters, order="timestamp.desc", limit=int(limit))
    except Exception:
        # Fallback 0: bot_type / source_wallet columns missing. Drop the
        # bot_type filter too if it was set.
        filters.pop("bot_type", None)
        # The 'or' filter might be the bot_type fold-in OR the strategy fold-in.
        # We can't tell here, so drop both - the strategy filter falls back below.
        had_or = filters.pop("or", None)
        try:
            rows = db().select("trades", columns=_COLS_NO_BOT, filters=filters, order="timestamp.desc", limit=int(limit))
        except Exception:
            # Fallback 1: scalp_exit telemetry columns missing.
            try:
                rows = db().select("trades", columns=_COLS_NO_SCALP, filters=filters, order="timestamp.desc", limit=int(limit))
            except Exception:
                # Fallback 2: no strategy_label column yet - drop the filter too,
                # otherwise PostgREST would still 4xx on the missing column.
                filters.pop("strategy_label", None)
                try:
                    rows = db().select("trades", columns=_COLS_NO_STRAT, filters=filters, order="timestamp.desc", limit=int(limit))
                except Exception:
                    # Fallback 3: no shadow column yet.
                    filters.pop("shadow", None)
                    try:
                        rows = db().select("trades", columns=_COLS_NO_SHADOW, filters=filters, order="timestamp.desc", limit=int(limit))
                    except Exception:
                        rows = db().select("trades", columns=_COLS_BASE, filters=filters, order="timestamp.desc", limit=int(limit))
    # If we successfully fetched but the bot_type filter was dropped due to
    # a missing column, post-filter in Python so the caller still gets the
    # expected scope. Legacy rows have no bot_type → treat as bachelier.
    if bt_norm and rows and "bot_type" not in (rows[0] or {}):
        # bot_type column doesn't exist → all rows are implicitly bachelier.
        if bt_norm == "copy":
            rows = []
    for r in rows:
        # Backfill: legacy rows without strategy_label default to core
        # (expiry_convergence) so the dashboard renders consistently.
        if not r.get("strategy_label"):
            r["strategy_label"] = "expiry_convergence"
        if not r.get("bot_type"):
            r["bot_type"] = "bachelier"
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
async def strategy_compare(
    bot_type: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    """Per-strategy aggregate (n, W/L, net PNL, mean ask, profit factor).

    Wilson 95% CI is computed client-side from n and W (cheaper than
    sending two extra floats and keeps the math co-located with the
    display). Open trades are excluded - resolved rows only, matching
    the rest of the dashboard's WR/PNL math.

    For scalp_exit, additionally returns a 'triggers' dict counting how
    many resolved scalp trades exited via take_profit / stop_loss /
    time_exit / resolution / other. Frontend renders this as a single
    extra row inside the SCALP column.

    bot_type defaults to bachelier - strategies are a bachelier-only concept.
    Caller may pass bot_type=bachelier explicitly; copy or 'all' is silently
    coerced to bachelier here since copy bot has no strategy_label.
    """
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    # Coerce: this endpoint only makes sense for bachelier. Avoid surprising
    # the caller by silently re-scoping if they passed bot_type=copy.
    _ = _normalize_bot_type(bot_type)  # validate format only
    base_filters = {"user_id": f"eq.{uid}"}
    bachelier_filters = {**base_filters, "or": "(bot_type.eq.bachelier,bot_type.is.null)"}
    # Try with exit_trigger + bot_type filter; fall back through migration layers.
    try:
        rows = db().select(
            "trades",
            columns="outcome,pnl,entry_price,strategy_label,exit_trigger",
            filters=bachelier_filters,
            limit=10000,
        )
    except Exception:
        # Drop bot_type filter (column may not exist).
        try:
            rows = db().select(
                "trades",
                columns="outcome,pnl,entry_price,strategy_label,exit_trigger",
                filters=base_filters,
                limit=10000,
            )
        except Exception:
            try:
                rows = db().select(
                    "trades",
                    columns="outcome,pnl,entry_price,strategy_label",
                    filters=base_filters,
                    limit=10000,
                )
                for r in rows:
                    r["exit_trigger"] = None
            except Exception:
                # Pre-strategy-split DB: no strategy_label column. Treat as all core.
                rows = db().select(
                    "trades",
                    columns="outcome,pnl,entry_price",
                    filters=base_filters,
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


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def _kill_state_from_status(status: Dict) -> str:
    """Derive a single severity label from a status payload's killswitches.
    'red'   = at least one rail FIRED (action != cooldown/cooling)
    'amber' = at least one rail in COOLING (no fired)
    'green' = none active
    """
    halts = status.get("killswitches") if isinstance(status, dict) else None
    if not isinstance(halts, list) or not halts:
        return "green"
    cooling_only = True
    for h in halts:
        if not isinstance(h, dict):
            continue
        action = str(h.get("action") or "").lower()
        if action not in ("cooldown", "cooling"):
            return "red"
    return "amber" if cooling_only else "green"


def _per_bot_summary(uid: str, bt: str, day_start_utc: datetime) -> Dict:
    """Compact per-bot rollup for the combined endpoint. Returns the same
    shape regardless of whether the bot has data, so the frontend can
    branch on `configured`."""
    s = db()
    # Status row.
    try:
        status_rows = s.select("bot_status",
                               filters={"user_id": f"eq.{uid}", "bot_type": f"eq.{bt}"},
                               limit=1)
    except Exception:
        # Pre-migration: only one status row per user, attribute it to bachelier.
        status_rows = s.select("bot_status", filters={"user_id": f"eq.{uid}"}, limit=1) if bt == "bachelier" else []
    status = status_rows[0]["status"] if status_rows else {}
    status_updated_at = status_rows[0]["updated_at"] if status_rows else None
    age_sec = None
    if status_updated_at:
        ts = _parse_iso(status_updated_at)
        if ts is not None:
            age_sec = int((datetime.now(timezone.utc) - ts).total_seconds())
    STALE_AFTER_SEC = int(os.getenv("STALE_AFTER_SEC", "420"))
    fresh = age_sec is not None and age_sec < STALE_AFTER_SEC

    # Control row.
    control_state = "start"
    try:
        try:
            ctrl_rows = s.select("bot_control",
                                 filters={"user_id": f"eq.{uid}", "bot_type": f"eq.{bt}"},
                                 limit=1)
        except Exception:
            ctrl_rows = s.select("bot_control", filters={"user_id": f"eq.{uid}"}, limit=1) if bt == "bachelier" else []
        if ctrl_rows:
            control_state = str(ctrl_rows[0].get("command") or "start").lower()
    except Exception:
        pass

    # Trades: count today vs total, sum today's PNL, open positions.
    trades = _select_trades_bot_aware(
        columns="timestamp,outcome,pnl",
        filters={"user_id": f"eq.{uid}", **_trades_bot_filter(bt)},
        wanted_bt=bt,
        order="timestamp.desc",
        limit=2000,
    )
    today_pnl = 0.0
    n_today = 0
    wins_today = 0
    losses_today = 0
    open_positions = 0
    for t in trades:
        if t.get("outcome") is None:
            open_positions += 1
            continue
        ts = _parse_iso(t.get("timestamp") or "")
        if ts is None or ts < day_start_utc:
            continue
        n_today += 1
        today_pnl += float(t.get("pnl") or 0)
        if t["outcome"] == "WIN":
            wins_today += 1
        elif t["outcome"] == "LOSS":
            losses_today += 1

    # 'configured' = the user has ever pushed status OR has any trades for this bot.
    configured = bool(status_rows) or bool(trades)

    return {
        "bot_type": bt,
        "configured": configured,
        "running": bool(status.get("running")),
        "shadow_mode": bool(status.get("shadow_mode")),
        "control_state": control_state,
        "heartbeat": {
            "age_sec": age_sec,
            "is_fresh": fresh,
            "stale_after_sec": STALE_AFTER_SEC,
            "updated_at": status_updated_at,
        },
        "wallet_usdc": status.get("wallet_usdc"),
        "bankroll_target": status.get("bankroll_target"),
        "pnl_today": today_pnl,
        "n_trades_today": n_today,
        "wins_today": wins_today,
        "losses_today": losses_today,
        "open_positions": open_positions,
        "kill_state": _kill_state_from_status(status),
        "live_authorized": bool(status.get("live_authorized")),
    }


@app.get("/api/combined_summary")
async def combined_summary(
    response: Response,
    polybot_session: Optional[str] = Cookie(None),
):
    """Per-bot rollups + merged totals. Single endpoint feeds the top bar
    + both panes' header strips on the two-pane layout. Always returns
    both bots; `configured: false` flags an empty pane."""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    # Day window (user's local tz) for today_pnl etc.
    now_local = datetime.now(USER_TZ)
    local_midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    day_start_utc = local_midnight.astimezone(timezone.utc)

    copy = _per_bot_summary(uid, "copy", day_start_utc)
    bachelier = _per_bot_summary(uid, "bachelier", day_start_utc)

    # Merge rules.
    severity = {"green": 0, "amber": 1, "red": 2}
    combined_kill = max((copy["kill_state"], bachelier["kill_state"]),
                        key=lambda k: severity.get(k, 0))
    combined_pnl_today = float(copy["pnl_today"]) + float(bachelier["pnl_today"])
    combined_bankroll = sum(
        float(b["wallet_usdc"]) for b in (copy, bachelier)
        if b["wallet_usdc"] is not None
    ) or None
    # live_authorized: amber/false unless BOTH configured bots agree they're live.
    cfg_bots = [b for b in (copy, bachelier) if b["configured"]]
    live_authorized = bool(cfg_bots) and all(b["live_authorized"] for b in cfg_bots)

    return {
        "copy": copy,
        "bachelier": bachelier,
        "combined": {
            "pnl_today": combined_pnl_today,
            "bankroll_usdc": combined_bankroll,
            "kill_state": combined_kill,
            "live_authorized": live_authorized,
        },
        "now_utc": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/copy_wallets")
async def copy_wallets(polybot_session: Optional[str] = Cookie(None)):
    """Per-wallet aggregates for the copy-bot pane.
    Returns one row per source_wallet seen in the user's copy trades,
    plus an 'active_wallets' count (distinct wallets with trades in the
    last 24h). Empty list + active=0 if the bot isn't pushing yet."""
    sess = require_session(polybot_session)
    uid = sess["user_id"]
    s = db()

    # Pull copy-bot trades. If schema isn't migrated, we get [] back.
    try:
        rows = s.select(
            "trades",
            columns="source_wallet,outcome,pnl,timestamp",
            filters={"user_id": f"eq.{uid}", "bot_type": "eq.copy"},
            limit=10000,
        )
    except Exception:
        # Pre-migration: source_wallet / bot_type columns missing.
        return {"wallets": [], "active_wallets": 0, "configured": False}

    if not rows:
        return {"wallets": [], "active_wallets": 0, "configured": False}

    # Pull wallet labels + paused-state from bot_status.wallet_labels /
    # bot_status.paused_wallets if the bot pushes them.
    wallet_labels: Dict[str, str] = {}
    paused_set: set = set()
    try:
        st_rows = s.select(
            "bot_status",
            filters={"user_id": f"eq.{uid}", "bot_type": "eq.copy"},
            limit=1,
        )
        if st_rows:
            st = st_rows[0].get("status") or {}
            if isinstance(st.get("wallet_labels"), dict):
                wallet_labels = {str(k).lower(): str(v) for k, v in st["wallet_labels"].items()}
            if isinstance(st.get("paused_wallets"), list):
                paused_set = {str(w).lower() for w in st["paused_wallets"]}
    except Exception:
        pass

    cutoff_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    active_wallets: set = set()
    agg: Dict[str, Dict] = {}
    for r in rows:
        wallet = (r.get("source_wallet") or "").lower()
        if not wallet:
            wallet = "(unknown)"
        b = agg.setdefault(wallet, {"trades": 0, "wins": 0, "losses": 0, "pnl": 0.0, "last_ts": None})
        b["trades"] += 1
        oc = r.get("outcome")
        if oc == "WIN":
            b["wins"] += 1
        elif oc == "LOSS":
            b["losses"] += 1
        b["pnl"] += float(r.get("pnl") or 0)
        ts = _parse_iso(r.get("timestamp") or "")
        if ts is not None and (b["last_ts"] is None or ts > b["last_ts"]):
            b["last_ts"] = ts
        if ts is not None and ts >= cutoff_24h and wallet != "(unknown)":
            active_wallets.add(wallet)

    out = []
    for wallet, b in agg.items():
        resolved = b["wins"] + b["losses"]
        wr = (b["wins"] / resolved) if resolved else 0.0
        out.append({
            "wallet": wallet,
            "label": wallet_labels.get(wallet, wallet[:10] if len(wallet) > 10 else wallet),
            "mode": "paused" if wallet in paused_set else "active",
            "trades": b["trades"],
            "wins": b["wins"],
            "losses": b["losses"],
            "win_rate": wr,
            "pnl": b["pnl"],
            "last_ts": b["last_ts"].isoformat() if b["last_ts"] else None,
        })
    out.sort(key=lambda x: x["pnl"], reverse=True)
    return {"wallets": out, "active_wallets": len(active_wallets), "configured": True}


@app.get("/api/per_asset")
async def per_asset(
    bot_type: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    sess = require_session(polybot_session)
    filters = {"user_id": f"eq.{sess['user_id']}", **_trades_bot_filter(bot_type)}
    rows = _select_trades_bot_aware(
        columns="asset,outcome,pnl",
        filters=filters,
        wanted_bt=bot_type,
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
async def wr_by_timeframe(
    bot_type: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    sess = require_session(polybot_session)
    filters = {"user_id": f"eq.{sess['user_id']}", **_trades_bot_filter(bot_type)}
    rows = _select_trades_bot_aware(
        columns="timestamp,end_time,outcome,pnl",
        filters=filters,
        wanted_bt=bot_type,
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
async def hourly(
    bot_type: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    sess = require_session(polybot_session)
    filters = {"user_id": f"eq.{sess['user_id']}", **_trades_bot_filter(bot_type)}
    rows = _select_trades_bot_aware(
        columns="timestamp,outcome",
        filters=filters,
        wanted_bt=bot_type,
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
    bot_type: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    sess = require_session(polybot_session)
    filters = {"user_id": f"eq.{sess['user_id']}", **_trades_bot_filter(bot_type)}
    rows = _select_trades_bot_aware(
        columns="timestamp,pnl,outcome",
        filters=filters,
        wanted_bt=bot_type,
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
    """Set pause/start for a single bot, or for both if body.bot_type='all'."""
    sess = require_session(polybot_session)
    body = await request.json()
    cmd = str(body.get("command", "")).lower().strip()
    if cmd not in ("start", "pause"):
        raise HTTPException(status_code=400, detail="command must be 'start' or 'pause'")
    raw_bt = body.get("bot_type")
    target_bots = ("copy", "bachelier") if str(raw_bt or "").lower() == "all" else (_normalize_bot_type(raw_bt),)
    issued_by = sess.get("username") or "dashboard"
    issued_at = datetime.now(timezone.utc).isoformat()
    written: List[str] = []
    for bt in target_bots:
        row = {
            "user_id": sess["user_id"],
            "bot_type": bt,
            "command": cmd,
            "issued_at": issued_at,
            "issued_by": issued_by,
        }
        try:
            # Migrated DB: composite PK
            db().upsert("bot_control", row, on_conflict="user_id,bot_type")
        except Exception:
            # Pre-migration: drop bot_type, fall back to single-PK upsert.
            # On a pre-migration DB, halting one bot halts the only row.
            try:
                row.pop("bot_type", None)
                db().upsert("bot_control", row, on_conflict="user_id")
            except Exception as e:
                raise HTTPException(
                    status_code=503,
                    detail=f"bot_control table missing? Run SQL migration. ({str(e)[:140]})",
                )
        written.append(bt)
    return {"ok": True, "command": cmd, "bot_types": written}


@app.get("/api/bot/control")
async def bot_control_get(
    authorization: Optional[str] = Header(None),
    bot_type: Optional[str] = None,
):
    """Bot polls this. Pass ?bot_type=copy or bachelier; defaults to bachelier
    so pre-two-bot bots keep working without a code change."""
    user = require_bot_key(authorization)
    bt = _normalize_bot_type(bot_type)
    filters = {"user_id": f"eq.{user['id']}", "bot_type": f"eq.{bt}"}
    try:
        rows = db().select("bot_control", filters=filters, limit=1)
    except Exception:
        # Pre-migration: bot_type column missing. Fall back to single-row read.
        rows = db().select("bot_control", filters={"user_id": f"eq.{user['id']}"}, limit=1)
    if not rows:
        return {"command": "start", "issued_at": None, "bot_type": bt}
    return {
        "command": rows[0].get("command") or "start",
        "issued_at": rows[0].get("issued_at"),
        "bot_type": bt,
    }


# ─────────────────────────────────────────────────────────
# BOT PUSH ENDPOINT
#   Bot POSTs: {"type": "status"|"trade"|"signal", "data": {...}}
#   Authenticates via Authorization: Bearer <bot_api_key>
# ─────────────────────────────────────────────────────────
def _normalize_bot_type(raw) -> str:
    """Validate bot_type to one of {'copy', 'bachelier'}; default bachelier.
    Pre-two-bot pushes (no bot_type field) collapse to 'bachelier' so existing
    single-bot tenants keep working without a bot-side change."""
    if not raw:
        return "bachelier"
    s = str(raw).strip().lower()
    return s if s in ("copy", "bachelier") else "bachelier"


def _trades_bot_filter(bot_type: Optional[str]) -> Dict[str, str]:
    """Return the filter fragment to scope trades by bot_type, or {} for no filter.
    Legacy rows (NULL bot_type) fold into bachelier so single-bot tenants
    keep showing their trades after migration."""
    if not bot_type:
        return {}
    bt = _normalize_bot_type(bot_type)
    if bt == "bachelier":
        return {"or": "(bot_type.eq.bachelier,bot_type.is.null)"}
    return {"bot_type": "eq.copy"}


def _select_trades_bot_aware(columns: str, filters: Dict[str, str], wanted_bt: Optional[str], **kwargs) -> List[Dict]:
    """db().select on trades, with bot_type filter degraded if the column is missing.
    If the column doesn't exist and the caller wanted bot_type='copy', returns []
    (because every row is implicitly bachelier on a pre-migration DB)."""
    try:
        return db().select("trades", columns=columns, filters=filters, **kwargs)
    except Exception:
        f2 = dict(filters)
        f2.pop("bot_type", None)
        f2.pop("or", None)
        rows = db().select("trades", columns=columns, filters=f2, **kwargs)
        if wanted_bt and _normalize_bot_type(wanted_bt) == "copy":
            return []
        return rows


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
    # bot_type lives at the top level of the push envelope (not inside `data`)
    # so it applies to every row in a batch trade-push. Pre-two-bot bots that
    # don't send the field default to 'bachelier'.
    bot_type = _normalize_bot_type(body.get("bot_type"))
    if not isinstance(data, (dict, list)):
        raise HTTPException(status_code=400, detail="`data` must be an object or list")

    s = db()
    if kind == "status":
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="status `data` must be object")
        status_row = {
            "user_id": uid,
            "bot_type": bot_type,
            "status": data,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            # Migrated DB: composite PK (user_id, bot_type).
            s.upsert("bot_status", status_row, on_conflict="user_id,bot_type")
        except Exception:
            # Pre-migration DB: single PK on user_id, no bot_type column.
            # Drop bot_type, fall back to legacy upsert. Means both bots would
            # overwrite each other's status row, but we degrade gracefully
            # instead of 500-ing.
            status_row.pop("bot_type", None)
            s.upsert("bot_status", status_row, on_conflict="user_id")
        return {"ok": True, "type": "status", "bot_type": bot_type}

    if kind == "trade":
        rows = data if isinstance(data, list) else [data]
        payload = []
        for r in rows:
            if not r.get("trade_id"):
                raise HTTPException(status_code=400, detail="trade.data.trade_id required")
            # Strategy label: known values are expiry_convergence, early_entry,
            # scalp_exit. Null/missing/unknown falls back to expiry_convergence.
            # Keeps older bot builds (pre-strategy-split) compatible.
            raw_strat = r.get("strategy_label")
            strat = str(raw_strat).strip() if raw_strat else "expiry_convergence"
            if strat not in ("expiry_convergence", "early_entry", "scalp_exit"):
                strat = "expiry_convergence"
            payload.append({
                "user_id": uid,
                "trade_id": str(r["trade_id"]),
                "timestamp": r.get("timestamp"),
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
                "shadow": bool(r.get("shadow", False)),
                "strategy_label": strat,
                # scalp_exit telemetry. Stored on every row but only meaningful
                # for scalp_exit; NULL on core/early. No server-side validation
                # of exit_trigger string - bot is the source of truth.
                "exit_trigger": r.get("exit_trigger"),
                "entry_bid": r.get("entry_bid"),
                "exit_bid": r.get("exit_bid"),
                "realized_pnl_partial": r.get("realized_pnl_partial"),
                # Two-bot model: bot_type at envelope-level applies to whole batch.
                # source_wallet is per-row because the copy bot mirrors many wallets.
                "bot_type": bot_type,
                "source_wallet": r.get("source_wallet") if bot_type == "copy" else None,
            })
        try:
            s.upsert("trades", payload, on_conflict="user_id,trade_id")
        except Exception:
            # Cascading retry - drop newest optional columns first, fall back to
            # progressively older shapes if the DB hasn't been migrated yet.
            # Layer 0 = bot_type + source_wallet (two-bot migration, newest).
            for p in payload:
                p.pop("bot_type", None)
                p.pop("source_wallet", None)
            try:
                s.upsert("trades", payload, on_conflict="user_id,trade_id")
            except Exception:
                # Layer 1 = scalp_exit telemetry (4 cols added together).
                for p in payload:
                    p.pop("exit_trigger", None)
                    p.pop("entry_bid", None)
                    p.pop("exit_bid", None)
                    p.pop("realized_pnl_partial", None)
                try:
                    s.upsert("trades", payload, on_conflict="user_id,trade_id")
                except Exception:
                    for p in payload:
                        p.pop("strategy_label", None)
                    try:
                        s.upsert("trades", payload, on_conflict="user_id,trade_id")
                    except Exception:
                        for p in payload:
                            p.pop("shadow", None)
                        try:
                            s.upsert("trades", payload, on_conflict="user_id,trade_id")
                        except Exception:
                            for p in payload:
                                p.pop("mode", None)
                            try:
                                s.upsert("trades", payload, on_conflict="user_id,trade_id")
                            except Exception:
                                for p in payload:
                                    p.pop("timeframe", None)
                                s.upsert("trades", payload, on_conflict="user_id,trade_id")
        return {"ok": True, "type": "trade", "count": len(payload), "bot_type": bot_type}

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
                "bot_type": bot_type,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        try:
            s.upsert("signal_performance", payload, on_conflict="user_id,asset,signal_name")
        except Exception:
            # Pre-migration: drop bot_type and retry.
            for p in payload:
                p.pop("bot_type", None)
            s.upsert("signal_performance", payload, on_conflict="user_id,asset,signal_name")
        return {"ok": True, "type": "signal", "count": len(payload), "bot_type": bot_type}

    if kind == "reset":
        # Wipe user data, optionally scoped to a single bot_type. Idempotent.
        # Scope: user_id (+ optional bot_type). No cross-user impact.
        scope = data.get("scope") if isinstance(data, dict) else None
        scopes = set(scope) if isinstance(scope, list) else {"trades", "signals", "status"}
        # If body.bot_type was set, only wipe that bot's rows.
        # If not set (backward-compat / pre-two-bot bots), wipe everything for the user.
        scope_filter: Dict[str, str] = {"user_id": f"eq.{uid}"}
        if body.get("bot_type"):
            scope_filter["bot_type"] = f"eq.{bot_type}"
        deleted = {}
        try:
            if "trades" in scopes:
                try:
                    r = s.delete("trades", filters=scope_filter)
                except Exception:
                    # Pre-migration: bot_type column missing. Drop the filter
                    # and fall back to wiping every trade for the user.
                    r = s.delete("trades", filters={"user_id": f"eq.{uid}"})
                deleted["trades"] = r
            if "signals" in scopes:
                try:
                    r = s.delete("signal_performance", filters=scope_filter)
                except Exception:
                    r = s.delete("signal_performance", filters={"user_id": f"eq.{uid}"})
                deleted["signals"] = r
            if "status" in scopes:
                empty_status = {
                    "running": False, "dry_run": False,
                    "net_pnl": 0, "today_pnl": 0,
                    "scale_level": None, "last_update": None,
                }
                status_row = {
                    "user_id": uid,
                    "bot_type": bot_type,
                    "status": empty_status,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                try:
                    s.upsert("bot_status", status_row, on_conflict="user_id,bot_type")
                except Exception:
                    status_row.pop("bot_type", None)
                    s.upsert("bot_status", status_row, on_conflict="user_id")
                deleted["status"] = "reset"
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"reset failed: {e}")
        return {"ok": True, "type": "reset", "deleted": deleted, "bot_type": bot_type}

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
