# Träningslogg

Personal gym planner and training log for Håkan. It replaces the first version, which was a claude.ai artifact (`reference/current-app.html`).

**Target stack:** Cloudflare Pages (frontend) + Pages Functions/Workers (API) + D1 (SQLite) + Cloudflare Access (login). Everything is free tier, single user, used mainly on iPad in Safari (Add to Home Screen).

## Features (parity with v1)
- **Plan:** week view (ISO weeks, Mon–Sun). Plan a session per day; "fill from last ÖK/NK/HK" copies the last session of that type with suggested targets.
- **Logga pass:** log a session. Starting a planned session prefills targets ("Mål") and marks the plan done.
- **Klistra in från Anteckningar:** paste one or more sessions written in Notes (e.g. on the iPhone). Header lines `261122 ÖK`, `2026-11-22 nk` or `22/11 HK (note)` start a session; every other line is `Exercise name sets`. Bullets are ignored, name variants are mapped to existing names (case-insensitive), and sessions that already exist are skipped. One session fills the form; several can be saved directly. Parser: `parseSessionText` in `public/parse.js`.
- **Historik:** list, filter by type (incl. untyped), search exercise, edit or delete, and export everything as text in the note format.
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
src/worker.js      API: /api/data, /api/sessions/:id, /api/plans/:date, /api/import
src/schema.js      D1 schema, created automatically on first request
schema.sql         same schema, readable
data/sessions.json export from v1 (seed for /api/import)
test/run.mjs       local tests with a fake D1 (npm test)
wrangler.jsonc     Worker + Assets + D1 binding
```
- `GET /api/data` returns all sessions and plans: `{sessions:[{id,date,tag,note,ex:[{n,s}]}], plans:[{date,tag,note,done,ex:[{n,s}]}]}`.
- `PUT/DELETE /api/sessions/:id`, `PUT/DELETE /api/plans/:date`. On save, the Worker stores the raw text and re-parses it into `sets`.
- `POST /api/import?offset=N` seeds from `data/sessions.json` in chunks of 5 sessions (D1 free plan: max 50 queries per request). Only allowed on an empty DB; the app shows an "Importera pass" button when the DB is empty.
- Tables: `sessions`, `exercises(session_id,pos,name,sets_text)`, `sets(session_id,ex_pos,pos,reps,weight_kg,weight_label,seconds)`, `plans`, `plan_exercises`, `runs` (for Garmin). See `schema.sql`.

## Deploy (Cloudflare dashboard, works from iPad)
1. **Storage & Databases → D1 → Create database**, name it `traningslogg`. Copy its **Database ID** into `wrangler.jsonc` (`database_id`).
2. **Workers & Pages → Create → Import a repository**, pick `traningslogg`. Keep the defaults (deploy command `npx wrangler deploy`).
3. Open the app URL (`traningslogg.<account>.workers.dev`) and turn on **Access** for it (Workers & Pages → traningslogg → Access; protect production and preview). Only then tap **Importera pass**.
4. Every push to `main` deploys automatically.

## Data
`data/sessions.json` holds 88 sessions (2026-01-02 → 2026-11-20) exported from v1. Import it once with a seed script. 42 sessions are untyped.

## Phase 2: Garmin runs
- A Worker with a **cron trigger** (nightly) pulls activities from the Garmin Connect **personal API** and upserts running activities into `runs`.
- The Garmin key/token is stored **only** as a Worker secret (`wrangler secret put`), never in the repo.
- Show runs in the year grid and week view, plus a running progress view (distance and pace).

## Security
- Put Cloudflare Access (one-time PIN to Håkan's email) in front of both the Pages site and the API.
- No secrets in the repo. Add `.dev.vars` to `.gitignore`.
