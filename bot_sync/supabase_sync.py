"""
bot_sync.supabase_sync — drop-in client for the PolyMarket bot to push
live data to the Vercel dashboard.

USAGE on the local bot:
    import os
    os.environ["DASHBOARD_URL"] = "https://botdashboard.vercel.app"
    os.environ["BOT_API_KEY"]   = "bot_xxxxxxxxxxxxxxxx"

    from bot_sync.supabase_sync import DashboardSync
    sync = DashboardSync()

    sync.push_status({
        "running": True, "dry_run": False,
        "scale_level": {"id": 2, "base_bet": 50, ...},
        "next_cycle_at": "2026-04-16T14:30:00Z",
        "net_pnl": 127.34,
    })

    sync.push_trade({
        "trade_id": "abc123",
        "timestamp": "2026-04-16T14:05:00Z",
        "asset": "BTC", "direction": "UP",
        "entry_price": 0.52, "size_usd": 50.0, "shares": 96.15,
        "confidence": 0.71, "status": "PLACED",
        "end_time": "2026-04-16T14:10:00Z",
        # strategy_label: 'expiry_convergence' (default if omitted),
        # 'early_entry', or 'scalp_exit'. Anything else is normalised to
        # expiry_convergence.
        "strategy_label": "scalp_exit",
        # scalp_exit-only telemetry. Omit / NULL on core + early rows.
        "exit_trigger": "take_profit",   # 'take_profit' | 'stop_loss' | 'time_exit' | 'resolution'
        "entry_bid": 0.51,
        "exit_bid": 0.58,
        "realized_pnl_partial": 7.0,     # subset of pnl realised via the scalp exit
    })

    sync.push_signal({"signal_name": "rsi_oversold", "times_seen": 42,
                       "times_correct": 25, "win_rate": 0.595, "weight": 1.2})

Designed to never crash the bot — all errors are swallowed and logged.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, List, Optional, Union
from urllib import error, request

log = logging.getLogger("bot_sync")


class DashboardSync:
    """Lightweight client — stdlib only (no requests/httpx needed on bot side)."""

    def __init__(
        self,
        dashboard_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 8.0,
        retries: int = 2,
        silent: bool = False,
    ):
        self.url = (dashboard_url or os.getenv("DASHBOARD_URL", "")).rstrip("/")
        self.key = api_key or os.getenv("BOT_API_KEY", "")
        self.timeout = timeout
        self.retries = retries
        self.silent = silent
        self._last_err_at: float = 0.0  # throttle error logs

    @property
    def enabled(self) -> bool:
        return bool(self.url and self.key)

    def _log(self, level: int, msg: str) -> None:
        if self.silent:
            return
        # Throttle: max 1 error log / 60s (bots push a lot)
        if level >= logging.WARNING:
            now = time.time()
            if now - self._last_err_at < 60:
                return
            self._last_err_at = now
        log.log(level, msg)

    def _post(self, payload: Dict[str, Any]) -> bool:
        if not self.enabled:
            return False
        body = json.dumps(payload).encode()
        req = request.Request(
            f"{self.url}/api/bot/push",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.key}",
                "User-Agent": "polybot-sync/1.0",
            },
            method="POST",
        )
        for attempt in range(self.retries + 1):
            try:
                with request.urlopen(req, timeout=self.timeout) as resp:
                    if 200 <= resp.status < 300:
                        return True
                    self._log(logging.WARNING, f"push {payload.get('type')} → {resp.status}")
                    return False
            except error.HTTPError as e:
                body_preview = ""
                try:
                    body_preview = e.read().decode()[:200]
                except Exception:
                    pass
                self._log(logging.WARNING, f"push {payload.get('type')} HTTP {e.code}: {body_preview}")
                # 4xx = client error, don't retry
                if 400 <= e.code < 500:
                    return False
            except Exception as e:
                self._log(logging.WARNING, f"push {payload.get('type')} attempt {attempt+1}: {e}")
            if attempt < self.retries:
                time.sleep(0.5 * (attempt + 1))
        return False

    # ── Public API ──────────────────────────────────────
    def push_status(self, status: Dict[str, Any]) -> bool:
        """Upsert the bot's current status snapshot (called every cycle)."""
        return self._post({"type": "status", "data": status})

    def push_trade(self, trade: Union[Dict[str, Any], List[Dict[str, Any]]]) -> bool:
        """Upsert one or many trades by trade_id (idempotent)."""
        return self._post({"type": "trade", "data": trade})

    def push_signal(self, signal: Union[Dict[str, Any], List[Dict[str, Any]]]) -> bool:
        """Upsert signal performance row(s)."""
        return self._post({"type": "signal", "data": signal})
