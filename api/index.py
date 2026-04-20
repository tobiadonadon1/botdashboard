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
from datetime import datetime, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

# User's local tz — drives "today" windowing for P&L and daily stop displays.
# Override via env var if the user moves.
USER_TZ = ZoneInfo(os.getenv("USER_TZ", "America/Chicago"))

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

    out: Dict = {
        "status": status,
        "control_state": control_state,
        "pnl": {"today": 0.0, "net": 0.0},
        "win_rate": {"overall": 0.5, "recent20": 0.5, "recent50": 0.5},
        "trades": {"total": 0, "open": 0, "wins": 0, "losses": 0},
        "brier": 0.25,
        "consec_losses": 0,
        "last_10": [],
        "now_utc": datetime.now(timezone.utc).isoformat(),
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
    for t in trades:
        pt = _parse_ts(t.get("timestamp") or "")
        if pt and pt >= day_start_utc:
            today_pnl += float(t["pnl"] or 0)
    net_pnl = sum(float(t["pnl"] or 0) for t in trades)
    out["pnl"] = {"today": today_pnl, "net": net_pnl}

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


@app.get("/api/trades")
async def trades(
    limit: int = 25,
    shadow: Optional[str] = None,
    polybot_session: Optional[str] = Cookie(None),
):
    """
    Trade list.
      • shadow=1 | true  → only shadow-mode rows
      • shadow=0 | false → only live rows (shadow is NULL or false)
      • omit            → all rows (backwards-compatible)
    """
    sess = require_session(polybot_session)
    filters = {"user_id": f"eq.{sess['user_id']}"}
    if shadow is not None:
        want = str(shadow).strip().lower() in ("1", "true", "yes")
        # Supabase/PostgREST filter. For the "live only" case include
        # legacy rows where shadow IS NULL, so pre-migration data stays
        # visible in the live tab.
        filters["shadow"] = "is.true" if want else "not.is.true"
    try:
        rows = db().select(
            "trades",
            columns="trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode,shadow",
            filters=filters,
            order="timestamp.desc",
            limit=int(limit),
        )
    except Exception:
        # Fallback 1: no shadow column yet
        filters.pop("shadow", None)
        try:
            rows = db().select(
                "trades",
                columns="trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time,mode",
                filters=filters,
                order="timestamp.desc",
                limit=int(limit),
            )
        except Exception:
            rows = db().select(
                "trades",
                columns="trade_id,timestamp,asset,direction,entry_price,size_usd,shares,confidence,status,outcome,pnl,resolved_at,end_time",
                filters=filters,
                order="timestamp.desc",
                limit=int(limit),
            )
    for r in rows:
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
        for r in rows:
            if not r.get("trade_id"):
                raise HTTPException(status_code=400, detail="trade.data.trade_id required")
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
            })
        try:
            s.upsert("trades", payload, on_conflict="user_id,trade_id")
        except Exception:
            # Retry without optional cols if schema hasn't been migrated yet.
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
        return {"ok": True, "type": "trade", "count": len(payload)}

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
