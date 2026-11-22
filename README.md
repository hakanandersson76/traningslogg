# Träningslogg

Personal gym planner and training log for Håkan. It replaces the first version, which was a claude.ai artifact (`reference/current-app.html`).

**Target stack:** Cloudflare Pages (frontend) + Pages Functions/Workers (API) + D1 (SQLite) + Cloudflare Access (login). Everything is free tier, single user, used mainly on iPad in Safari (Add to Home Screen).

## Features (parity with v1)
- **Plan:** week view (ISO weeks, Mon–Sun). Plan a session per day; "fill from last ÖK/NK/HK" copies the last session of that type with suggested targets.
- **Logga pass:** log a session. Starting a planned session prefills targets ("Mål") and marks the plan done.
- **Klistra in från Anteckningar:** paste one or more sessions written in Notes (e.g. on the iPhone). Header lines `261122 ÖK`, `2026-11-22 nk` or `22/11 HK (note)` start a session; every other line is `Exercise name sets`. Bullets are ignored, name variants are mapped to existing names (case-insensitive), and sessions that already exist are skipped. One session fills the form; several can be saved directly. Parser: `parseSessionText` in `public/parse.js`.
- **Historik:** list, filter by type (incl. untyped), search exercise, edit or delete, and export everything as text in the note format.
- **Coach:** rule-based personal trainer (`public/coach.js`, pure functions, tested): which session type is due and why (upper ~every 3rd day, legs ~every 6th, rest warnings), a concrete session from his usual exercises with targets (double progression: +1 rep up to 10, then +2,5 kg / +5 kg ≥100 kg / +1 kg <10 kg; ~90 % after >28 days; plateau → lighter higher-rep set or variant), notes (frequency, upper/lower balance, weekly hard sets per muscle group vs 10–20, regressions, PRs), and lists of progressing / plateaued / regressed / forgotten exercises. "Starta passet" opens the log form with targets; "Lägg i planen" saves it as a plan. Untyped sessions get a type inferred from their exercises. Phase 3 can add Claude-written advice on top (Anthropic API key as a Worker secret).
- **Utveckling:** per exercise: latest/best top set, change since first, estimated 1RM (Epley, reps capped at 12), chart and table.
- **Header:** year grid, one cell per day coloured by session type, planned days outlined, today marked; stats (sessions this year/month, sessions per week over the last 8 weeks, days since last).
- UI language is Swedish; dates are Swedish style.

## Session types
| Tag | Name | Colour |
|---|---|---|
| ÖK | Överkropp (upper) | red `#d7263d` |
| NK | Nederkropp (lower) | blue `#2563c9` |
| HK | Helkropp (full) | yellow `#f2b705` |
| "" | untyped (legacy) | grey |

## Set format (keep exactly; this is how Håkan writes)
- `8@22,5kg, 6@25kg`: reps@weight with a decimal comma; sets are separated by comma + space. `kg` is optional and case-insensitive (`22,5`, `22,5kg`, `22,5 kg`, `22,5KG`).
- `10x65kg` is also reps×weight. `33,5+2kg` is stacked weight (total 35,5, keep the label).
- `x@72,5kg` means unknown reps. `10/8@16,25kg` means split reps (use the first number). `6@36,25kg x2` means two identical sets.
- Bodyweight reps: `10, 8`. Time: `2:30`. Notes go in `(parentheses)`.
- Store the raw text **and** parsed sets. The reference parser is in `reference/current-app.html` (`parseSets`), with a Python equivalent in `reference/parse_notes.py`.
- **Progression suggestion:** if the top set has ≥10 reps → 8 reps at +2,5 kg (+5 kg from 100 kg); otherwise +1 rep at the same weight. Bodyweight: max reps + 1. Time: best + 0:15.

## How it is built
```
public/            static app (served by Workers Assets)
  index.html       the whole UI (Swedish), talks to /api
  parse.js         set-notation parser, shared with the Worker
  manifest.webmanifest, icon-*.png   home-screen app on iPad
src/worker.js      API: /api/auth/*, /api/account/*, /api/admin/*, /api/data, /api/sessions/:id, /api/plans/:date, /api/import
src/auth.js        password hashing, login sessions, reset tokens, password rules
src/schema.js      D1 schema + migrations (v2 = accounts, v3 = approval/status, no email), run automatically on first request
data/sessions.json export from v1 (seed for /api/import)
test/run.mjs       local tests with a fake D1 (npm test)
wrangler.jsonc     Worker + Assets + D1 binding
```
- `GET /api/data` returns all sessions and plans: `{sessions:[{id,date,tag,note,ex:[{n,s}]}], plans:[{date,tag,note,done,ex:[{n,s}]}]}`.
- `PUT/DELETE /api/sessions/:id`, `PUT/DELETE /api/plans/:date`. On save, the Worker stores the raw text and re-parses it into `sets`.
- `POST /api/import?offset=N` seeds from `data/sessions.json` in chunks of 5 sessions (D1 free plan: max 50 queries per request). Only allowed on an empty DB; the app shows an "Importera pass" button when the DB is empty.
- Tables: `sessions`, `exercises(session_id,pos,name,sets_text)`, `sets(session_id,ex_pos,pos,reps,weight_kg,weight_label,seconds)`, `plans`, `plan_exercises`, `runs` (for Garmin). See `src/schema.js`.

## Deploy (Cloudflare dashboard, works from iPad)
1. **Storage & Databases → D1 → Create database**, name it `traningslogg`. Copy its **Database ID** into `wrangler.jsonc` (`database_id`).
2. **Workers & Pages → Create → Import a repository**, pick `traningslogg`. Keep the defaults (deploy command `npx wrangler deploy`).
3. Open the app URL (`traningslogg.<account>.workers.dev`) and turn on **Access** for it (Workers & Pages → traningslogg → Access; protect production and preview). Only then tap **Importera pass**.
4. Every push to `main` deploys automatically.

## Accounts and security
- **No email.** Anyone can register with first name, last name, email and a strong password (≥12 characters, ≥3 of lower/upper/digit/symbol, not containing their name/email or common words). New accounts are **pending** until an admin approves them.
- **Account status:** `pending` → `active` (approve) or deleted (reject); `active` ⇄ `frozen` (temporary, data kept); any → `banned` (cannot log in, the email cannot register again; can be lifted).
- **Security:**
  - Passwords are stored only as PBKDF2-SHA256 hashes (100 000 iterations, random salt).
  - Login gives a random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie (30 days); only its SHA-256 is stored.
  - 5 wrong passwords lock the account for 15 minutes. Account status is only revealed after a correct password. Writes from other origins are refused.
- **Settings:** change name; change password (needs the current password; all other devices are logged out); log out / log out everywhere.
- **Forgot password:** the user asks from the login screen, which becomes an admin task. The admin creates a one-time link (valid 24 h) and passes it on, e.g. by text message.
- **Admin** (role `admin`): user list (pending and reset requests first, highlighted) with approve / reject / freeze / activate / ban / lift ban / password link / make or remove admin. Admins never act on their own account.
  - Open tasks show as a red badge on the Admin tab and a banner on the Plan page (`GET /api/admin/tasks`, also in `/api/me`).
- Every user only sees and changes their own sessions and plans.
- **First admin:** created on first start from `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` in `wrangler.jsonc` when there are no users. Existing data without an owner is assigned to it.
- Schema v3 migrates v2 accounts: verified → active, unverified → pending, disabled → frozen.

## Data
`data/sessions.json` holds 88 sessions (2026-01-02 → 2026-11-20) exported from v1. Import it once with a seed script. 42 sessions are untyped.

## Phase 2: Garmin runs
- A Worker with a **cron trigger** (nightly) pulls activities from the Garmin Connect **personal API** and upserts running activities into `runs`.
- The Garmin key/token is stored **only** as a Worker secret (`wrangler secret put`), never in the repo.
- Show runs in the year grid and week view, plus a running progress view (distance and pace).

## Security
- The app has its own login, so Cloudflare Access is turned off for the app.
- No secrets in the repo. Add `.dev.vars` to `.gitignore`.
