# Träningslogg

Personal gym planner and training log for Håkan. It replaces the first version, which was a claude.ai artifact (`reference/current-app.html`).

**Target stack:** Cloudflare Pages (frontend) + Pages Functions/Workers (API) + D1 (SQLite) + Cloudflare Access (login). Everything is free tier, single user, used mainly on iPad in Safari (Add to Home Screen).

## Features (parity with v1)
- **Plan:** week view (ISO weeks, Mon–Sun). Plan a session per day; "fill from last ÖK/NK/HK" copies the last session of that type with suggested targets.
- **Logga pass:** log a session. Starting a planned session prefills targets ("Mål") and marks the plan done.
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
- `8@22,5kg, 6@25kg`: reps@weight with a decimal comma; sets are separated by comma + space. `kg` is optional.
- `10x65kg` is also reps×weight. `33,5+2kg` is stacked weight (total 35,5, keep the label).
- `x@72,5kg` means unknown reps. `10/8@16,25kg` means split reps (use the first number). `6@36,25kg x2` means two identical sets.
- Bodyweight reps: `10, 8`. Time: `2:30`. Notes go in `(parentheses)`.
- Store the raw text **and** parsed sets. The reference parser is in `reference/current-app.html` (`parseSets`), with a Python equivalent in `reference/parse_notes.py`.
- **Progression suggestion:** if the top set has ≥10 reps → 8 reps at +2,5 kg (+5 kg from 100 kg); otherwise +1 rep at the same weight. Bodyweight: max reps + 1. Time: best + 0:15.

## Suggested D1 schema
```sql
CREATE TABLE sessions (id TEXT PRIMARY KEY, date TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '', note TEXT DEFAULT '', updated_at TEXT);
CREATE TABLE exercises (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, pos INTEGER NOT NULL, name TEXT NOT NULL, sets_text TEXT NOT NULL);
CREATE TABLE sets (id INTEGER PRIMARY KEY, exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE, pos INTEGER NOT NULL, reps REAL, weight_kg REAL, weight_label TEXT, seconds INTEGER);
CREATE TABLE plans (date TEXT PRIMARY KEY, tag TEXT NOT NULL, note TEXT DEFAULT '', done_session_id TEXT);
CREATE TABLE plan_exercises (id INTEGER PRIMARY KEY, plan_date TEXT NOT NULL REFERENCES plans(date) ON DELETE CASCADE, pos INTEGER NOT NULL, name TEXT NOT NULL, target TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, start_time TEXT NOT NULL, distance_m REAL, duration_s INTEGER, avg_hr INTEGER, source TEXT DEFAULT 'garmin');
CREATE INDEX idx_sessions_date ON sessions(date);
CREATE INDEX idx_exercises_name ON exercises(name);
```

## Data
`data/sessions.json` holds 88 sessions (2026-01-02 → 2026-11-20) exported from v1. Import it once with a seed script. 42 sessions are untyped.

## Phase 2: Garmin runs
- A Worker with a **cron trigger** (nightly) pulls activities from the Garmin Connect **personal API** and upserts running activities into `runs`.
- The Garmin key/token is stored **only** as a Worker secret (`wrangler secret put`), never in the repo.
- Show runs in the year grid and week view, plus a running progress view (distance and pace).

## Security
- Put Cloudflare Access (one-time PIN to Håkan's email) in front of both the Pages site and the API.
- No secrets in the repo. Add `.dev.vars` to `.gitignore`.
