"""
Stateless auth primitives — PBKDF2 password hashing + HMAC-signed session
tokens + bot API key hashing. Stdlib only, audit-able, side-effect free.

Session tokens are stateless (no DB lookup per request beyond the user
existence check), perfect for Vercel serverless cold starts.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from typing import Optional, Tuple

PBKDF2_ITERATIONS = 200_000
SESSION_HOURS = 24


def _session_secret() -> bytes:
    """Load SESSION_SECRET from env. Fails loudly in production."""
    s = os.getenv("SESSION_SECRET", "").strip()
    if not s:
        # Dev fallback — NEVER happens in prod because env is required.
        raise RuntimeError(
            "SESSION_SECRET environment variable is required. "
            "Generate one with: python -c 'import secrets; print(secrets.token_hex(32))'"
        )
    return s.encode()


# ─────────────────────────────────────────────────────────
# PASSWORD HASHING
# ─────────────────────────────────────────────────────────
def hash_password(password: str, salt: Optional[bytes] = None) -> Tuple[str, str]:
    """Return (salt_b64, hash_b64) using PBKDF2-SHA256 + 16-byte salt."""
    if salt is None:
        salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return (
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored_salt_b64: str, stored_hash_b64: str) -> bool:
    """Constant-time password check."""
    try:
        salt = base64.b64decode(stored_salt_b64)
        expected = base64.b64decode(stored_hash_b64)
    except Exception:
        return False
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return hmac.compare_digest(digest, expected)


# ─────────────────────────────────────────────────────────
# SESSION TOKENS — signed, stateless
# Format:  base64url( "<user_id>|<username>|<exp>|<sig>" )
# sig = HMAC-SHA256( secret, "<user_id>|<username>|<exp>" )
# ─────────────────────────────────────────────────────────
def create_session_token(user_id: str, username: str) -> str:
    exp = int(time.time()) + SESSION_HOURS * 3600
    payload = f"{user_id}|{username}|{exp}"
    sig = hmac.new(_session_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode().rstrip("=")


def verify_session_token(token: Optional[str]) -> Optional[dict]:
    """Return {'user_id', 'username'} if token is valid & unexpired, else None."""
    if not token:
        return None
    try:
        # Restore padding for urlsafe_b64decode
        padding = "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode((token + padding).encode()).decode()
        user_id, username, exp_str, sig = raw.rsplit("|", 3)
        exp = int(exp_str)
    except Exception:
        return None
    if time.time() > exp:
        return None
    expected = hmac.new(
        _session_secret(), f"{user_id}|{username}|{exp}".encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    return {"user_id": user_id, "username": username}


# ─────────────────────────────────────────────────────────
# BOT API KEY — one per user, stored as SHA-256 hash only
# ─────────────────────────────────────────────────────────
def generate_bot_api_key() -> str:
    """Return a fresh 32-byte urlsafe bot key (shown ONCE to user)."""
    return "bot_" + secrets.token_urlsafe(32)


def hash_bot_api_key(raw_key: str) -> str:
    """Return SHA-256 hex digest — what we store in DB."""
    return hashlib.sha256(raw_key.encode()).hexdigest()
