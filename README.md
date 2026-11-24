# Träningslogg

Personal gym planner and training log for Håkan. It replaces the first version, which was a claude.ai artifact (`reference/current-app.html`).

**Target stack:** Cloudflare Pages (frontend) + Pages Functions/Workers (API) + D1 (SQLite) + Cloudflare Access (login). Everything is free tier, single user, used mainly on iPad in Safari (Add to Home Screen).

## Features (parity with v1)
- **Plan:** week view (ISO weeks, Mon–Sun). Plan a session per day; "fill from last ÖK/NK/HK" copies the last session of that type with suggested targets.
- **Logga pass:** log a session. Starting a planned session prefills targets ("Mål") and marks the plan done.
- **Klistra in från Anteckningar:** paste one or more sessions written in Notes (e.g. on the iPhone). Header lines `261122 ÖK`, `2026-11-22 nk` or `22/11 HK (note)` start a session; every other line is `Exercise name sets`. Bullets are ignored, name variants are mapped to existing names (case-insensitive), and sessions that already exist are skipped. One session fills the form; several can be saved directly. Parser: `parseSessionText` in `public/parse.js`.
- **Historik:** list, filter by type (incl. untyped), search exercise, edit or delete, and export everything as text in the note format.
- **Coach (v2, research-referenced):** rule-based personal trainer in `public/coach.js` (pure functions, tested). Every piece of advice carries `src` ids into `SOURCES`. The UI shows these under "Varför?", with a full source list at the bottom of the Coach tab. Rules that are practical judgement point to `rule` ("Tumregel").
  - **Goal** (Inställningar; `users.goal`): `strength` (4–6 reps compound / 8–12 isolation, 2–3 RIR), `muscle` (6–10 / 8–15, 1–2 RIR, default), `health` (8–12 / 10–15, 2–3 RIR). Rep ranges and effort follow Currier 2023, Robinson 2024 and Refalo 2024.
  - **Progression:** double progression inside the goal's range (Plotkin 2022): +1 rep (+2 when the last set had ≥3 reps left); at the top of the range, or near it with ≥3 left, add weight (+2,5 kg; +5 kg from 100 kg; +1 kg under 10 kg) and drop to the bottom of the range; below the range with 0 left → lower the weight.
  - **Rules of thumb:** ~90 % after >28 days off; plateau when the top set has been unchanged for 3 sessions (unless it felt easy) → a higher-rep set at ~90 % or a different variant.
  - **Frequency:** each muscle group ≥2×/week (Schoenfeld 2016/2019, Pelland 2024). Upper/lower are due every ~3,5 days; when both are due, the clearly more overdue one wins, otherwise HK. Rest warnings at ≥5 sessions in 7 days, or when everything was trained in the last ~2 days.
  - **Hard sets:** working sets = ≥80 % of that day's top weight, plus bodyweight/timed sets. With RIR logged: 0–3 counts 1, 4 counts 0,5, 5+ counts 0. Band 10–20 per muscle and week (Ralston 2017, Pelland 2024); health 4–10 (rule of thumb).
  - **Notes:** groups under 2×/week, low volume, missing RIR, change in sessions per week, regressions, plateaus, PRs. Lists: progress / plateau / regressed / PRs / forgotten exercises. A chart shows times per week per muscle group.
- **Reps kvar (RIR):** optional per exercise in the log form (0–5+), stored in `exercises.rir`, shown in history and exported as `RIR n`. Paste understands `RIR 2`, `rir2` and `2 kvar`.
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

In English the labels are UB / LB / FB (Upper / Lower / Full body); the stored tag is always ÖK/NK/HK, and a pasted header may use either.

## Session length
- Each user sets a normal session length (Inställningar → Passlängd, warm-up included). New users: 40 min. Håkan: 35 min (schema v6 set the existing admin to 35).
- The coach estimates time per exercise: working sets incl. rest (compound 2,5 min, isolation 1,75 min, timed sets their duration + 1 min), 1 min per station change, 2 min warm-up sets before the first compound lift per muscle group, plus 5 min general warm-up.
- If the proposal is too long: sets above 2 go first, then whole exercises (core/ungrouped first, then a second exercise for an already-covered muscle group, then isolation), keeping at least 3. Then sets are added back while they fit. The coach card shows the estimate and what didn't fit. The editor's "fill with latest" uses the same rule.
- `PUT /api/account/session-length {minutes}` (15–180).

## Languages
- Swedish and English. Default: the iPhone/browser language if supported, else English. Override in Inställningar → Språk (saved per user in `users.lang`; `""` = follow the device). The login screen has Svenska/English links (remembered on the device).
- Swedish is the source text and the key: code calls `_("Logga pass")` (index.html) or `tx(...)` (coach.js); `public/locales/<code>.js` maps Swedish → translation. `{placeholders}` are filled in; numbers use the language's decimal mark. Server messages stay Swedish and are translated in the app.
- Add a language: copy `public/locales/en.js`, translate the values, register the code in `public/i18n.js` (LANGS, DICTS, DATE_NAMES, TAG_LABELS) and `src/worker.js` (LANGS). `node test/i18n-keys.mjs` lists missing keys; `npm test` fails if any are missing.
- The set text stays in Håkan's format (decimal comma) whatever the UI language.

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
  index.html       the whole UI (Swedish source text, translated via i18n.js), talks to /api
  i18n.js, locales/en.js   language detection, t(), date names, tag labels; English dictionary
  parse.js         set-notation parser, shared with the Worker
  manifest.webmanifest, icon-*.png   home-screen app on iPad
src/worker.js      API: /api/auth/*, /api/account/*, /api/admin/*, /api/data, /api/sessions/:id, /api/plans/:date, /api/import
src/auth.js        password hashing, login sessions, reset tokens, password rules
src/schema.js      D1 schema + migrations (v2 = accounts, v3 = approval/status, no email, v4 = RIR + goal, v5 = language, v6 = session length), run automatically on first request
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
