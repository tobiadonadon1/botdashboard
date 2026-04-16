#!/usr/bin/env python3
"""
Create a dashboard user + generate their bot API key.

Prints the SQL INSERT you need to run on Supabase (SQL Editor), and the
plaintext BOT_API_KEY you need to give to the user (show ONCE).

Usage:
    python scripts/create_user.py <username> <password> [--role user|admin]

Example:
    python scripts/create_user.py tobia mysecret --role admin
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

from _security import generate_bot_api_key, hash_bot_api_key, hash_password  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="Create a dashboard user")
    p.add_argument("username")
    p.add_argument("password")
    p.add_argument("--role", choices=["user", "admin"], default="user")
    args = p.parse_args()

    salt_b64, hash_b64 = hash_password(args.password)
    api_key = generate_bot_api_key()
    api_key_hash = hash_bot_api_key(api_key)

    print("\n" + "=" * 72)
    print(f"User:      {args.username}")
    print(f"Role:      {args.role}")
    print("=" * 72)
    print("\n-- 1. Run this SQL on your Supabase SQL Editor --\n")
    print(f"""insert into public.users
  (username, password_salt, password_hash, bot_api_key_hash, role)
values
  ('{args.username}', '{salt_b64}', '{hash_b64}', '{api_key_hash}', '{args.role}');
""")
    print("-- 2. Give this BOT API KEY to the user --")
    print("--    (will NEVER be shown again — store securely!) --\n")
    print(f"   BOT_API_KEY={api_key}\n")
    print("-- 3. The user sets this on their bot's .env:")
    print(f"   DASHBOARD_URL=https://YOUR-DEPLOYMENT.vercel.app")
    print(f"   BOT_API_KEY={api_key}\n")
    print("=" * 72 + "\n")


if __name__ == "__main__":
    main()
