# PolyBot Dashboard

Multi-tenant command center for PolyMarket trading bots. Built for
**Vercel (serverless)** + **Supabase (Postgres)**. Each user (bot owner)
logs in, sees **only their own** bot's live status, trades, P&L curve,
win-rate breakdowns, and learning signals.

```
┌───────────────────┐   HTTPS+Bearer   ┌────────────────────┐
│  Local PolyBot    │ ───────────────> │  /api/bot/push     │
│  (your machine)   │                  │  (Vercel Python)   │
└───────────────────┘                  └─────────┬──────────┘
                                                 │
                                    upsert by user_id
                                                 ▼
                                       ┌─────────────────────┐
                                       │   Supabase Postgres │
                                       └─────────┬───────────┘
                                                 │
                                   read (session cookie → user_id)
                                                 ▼
┌───────────────────┐   HTTPS+Cookie   ┌────────────────────┐
│  Dashboard UI     │ <─────────────── │  /api/summary, ... │
│  (any browser)    │                  │  (Vercel Python)   │
└───────────────────┘                  └────────────────────┘
```

---

## Deploy — 15 minutes

### 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. **SQL Editor** → paste and run `supabase/schema.sql`.
3. **Settings → API**, copy:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_KEY` *(server-only, never expose)*

### 2. Generate a session secret

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 3. Deploy to Vercel

Either push this repo and import on [vercel.com](https://vercel.com/new),
or run `vercel` in the project root.

Set these **Environment Variables** in the Vercel project settings
(Production + Preview):

| Name | Value |
|------|-------|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJhbG...` (the service_role key) |
| `SESSION_SECRET` | 64-hex string from step 2 |

### 4. Create the first user

```bash
python scripts/create_user.py tobia YOUR_STRONG_PASSWORD --role admin
```

The script prints:
- an `insert into public.users ...` SQL statement → run it on Supabase
- a `BOT_API_KEY=bot_xxxxx` → shown **once**, save it securely

### 5. Connect your local bot

Copy `bot_sync/` into your bot project (it's stdlib-only, no pip needed),
then in your bot's `.env`:

```env
DASHBOARD_URL=https://YOUR-DEPLOYMENT.vercel.app
BOT_API_KEY=bot_xxxxxxxxxxxxxxxx
```

And in your bot code:

```python
from bot_sync import DashboardSync
sync = DashboardSync()
sync.push_status({...})      # every cycle
sync.push_trade({...})       # on trade placed & on trade resolved
sync.push_signal({...})      # when learning updates weights
```

See `bot_sync/README.md` for the full integration guide.

### 6. Log in

Open `https://YOUR-DEPLOYMENT.vercel.app` and enter the credentials you
created in step 4.

---

## Multi-tenant model

- **Each user** (`tobia`, `partner`, ...) has:
  - username + PBKDF2-hashed password (for dashboard login)
  - unique `BOT_API_KEY` (for their bot to push data)
  - their own set of rows in `trades`, `bot_status`, `signal_performance`

- **Data isolation** is enforced on two layers:
  1. **API level**: every query is filtered by the `user_id` pulled from
     the session cookie / bearer-token lookup.
  2. **Database level**: Row-Level Security is enabled on all tables;
     the anon key has zero policies → reads nothing.

- **Service role key** lives on Vercel only — never shipped to the browser.

---

## Local development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in Supabase URL + keys

# Run locally
uvicorn api.index:app --reload --port 8787

# Serve the frontend separately (or use `npx serve public -p 3000`)
```

Point the frontend at `http://localhost:8787` by editing `/api/` paths
or running both on the same port via a reverse proxy.

---

## Security checklist before going live

- [ ] `SESSION_SECRET` is unique per deployment (64 random hex chars)
- [ ] `SUPABASE_SERVICE_KEY` is set ONLY in Vercel env vars (never in git)
- [ ] Supabase RLS is enabled on all tables (schema.sql already does this)
- [ ] Strong passwords for every dashboard user
- [ ] Bot API keys rotated if exposed (`update users set bot_api_key_hash = ... where id = ...`)
- [ ] `.env` is in `.gitignore` (already is)

---

## Project layout

```
botdashboard/
├── api/
│   ├── index.py            # FastAPI app — all /api/* routes
│   ├── _db.py              # Supabase PostgREST client (stdlib+httpx)
│   └── _security.py        # PBKDF2 + session tokens + API key hashing
├── public/
│   ├── index.html          # Dashboard (Batcave terminal theme)
│   ├── login.html          # Matrix-rain login
│   ├── app.js              # Live polling / rendering
│   └── styles.css          # Theme
├── bot_sync/               # Client library for the LOCAL bot
│   ├── __init__.py
│   ├── supabase_sync.py
│   └── README.md
├── supabase/
│   └── schema.sql          # One-time DB migration
├── scripts/
│   └── create_user.py      # Generate password hash + bot API key
├── requirements.txt
├── vercel.json
├── .env.example
└── README.md
```

---

## License

Private — for the operators of this bot ecosystem only.
