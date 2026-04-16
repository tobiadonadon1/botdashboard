"""
Minimal Supabase PostgREST HTTP client — stdlib-only (no `supabase-py`).

Why direct HTTP: serverless cold starts matter, and the official
`supabase-py` pulls in gotrue+postgrest+realtime clients we don't need.
This tiny wrapper does exactly what the dashboard requires — queries,
upserts, filters — in ~200 lines with `httpx`.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import httpx


class SupabaseError(RuntimeError):
    """Raised on any non-2xx from Supabase PostgREST."""


class Supabase:
    def __init__(self) -> None:
        url = os.getenv("SUPABASE_URL", "").rstrip("/")
        key = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required."
            )
        self.base = f"{url}/rest/v1"
        self.headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        self._client = httpx.Client(timeout=10.0, headers=self.headers)

    # ── Raw HTTP ────────────────────────────────────────
    def _raise_for_status(self, r: httpx.Response) -> None:
        if r.status_code >= 300:
            raise SupabaseError(f"{r.status_code} {r.text[:300]}")

    def select(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: Optional[Dict[str, str]] = None,
        order: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """GET /rest/v1/<table>?select=...&<col>=eq.<val>&order=...&limit=..."""
        params: Dict[str, Any] = {"select": columns}
        if filters:
            params.update(filters)
        if order:
            params["order"] = order
        if limit:
            params["limit"] = str(limit)
        r = self._client.get(f"{self.base}/{table}", params=params)
        self._raise_for_status(r)
        return r.json()

    def rpc(self, fn: str, body: Dict[str, Any]) -> Any:
        r = self._client.post(f"{self.base}/rpc/{fn}", json=body)
        self._raise_for_status(r)
        return r.json() if r.text else None

    def upsert(
        self,
        table: str,
        row: Dict[str, Any] | List[Dict[str, Any]],
        *,
        on_conflict: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {}
        if on_conflict:
            params["on_conflict"] = on_conflict
        r = self._client.post(
            f"{self.base}/{table}",
            params=params,
            json=row,
            headers={
                **self.headers,
                "Prefer": "resolution=merge-duplicates,return=representation",
            },
        )
        self._raise_for_status(r)
        return r.json() if r.text else []

    def insert(self, table: str, row: Dict[str, Any] | List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        r = self._client.post(
            f"{self.base}/{table}",
            json=row,
            headers={**self.headers, "Prefer": "return=representation"},
        )
        self._raise_for_status(r)
        return r.json() if r.text else []

    def update(
        self,
        table: str,
        filters: Dict[str, str],
        patch: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        r = self._client.patch(
            f"{self.base}/{table}",
            params=filters,
            json=patch,
            headers={**self.headers, "Prefer": "return=representation"},
        )
        self._raise_for_status(r)
        return r.json() if r.text else []

    # ── Convenience ─────────────────────────────────────
    def find_user_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        rows = self.select(
            "users",
            filters={"username": f"eq.{username}"},
            limit=1,
        )
        return rows[0] if rows else None

    def find_user_by_api_key_hash(self, api_key_hash: str) -> Optional[Dict[str, Any]]:
        rows = self.select(
            "users",
            filters={"bot_api_key_hash": f"eq.{api_key_hash}"},
            limit=1,
        )
        return rows[0] if rows else None

    def find_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        rows = self.select("users", filters={"id": f"eq.{user_id}"}, limit=1)
        return rows[0] if rows else None


# One shared instance per serverless process (reused across warm invocations)
_db_instance: Optional[Supabase] = None


def db() -> Supabase:
    global _db_instance
    if _db_instance is None:
        _db_instance = Supabase()
    return _db_instance
