-- Träningslogg schema. The Worker also runs this on startup (CREATE ... IF NOT EXISTS),
-- so no manual migration step is needed.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,              -- YYYY-MM-DD
  tag TEXT NOT NULL DEFAULT '',    -- 'ÖK' | 'NK' | 'HK' | ''
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);

-- One row per exercise in a session; sets_text is the source of truth.
CREATE TABLE IF NOT EXISTS exercises (
  session_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  name TEXT NOT NULL,
  sets_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, pos)
);
CREATE INDEX IF NOT EXISTS idx_exercises_name ON exercises(name);

-- Parsed from sets_text on every save, for querying (top sets, volume, ...).
CREATE TABLE IF NOT EXISTS sets (
  session_id TEXT NOT NULL,
  ex_pos INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  reps REAL,
  weight_kg REAL,
  weight_label TEXT,
  seconds INTEGER,
  PRIMARY KEY (session_id, ex_pos, pos)
);

CREATE TABLE IF NOT EXISTS plans (
  date TEXT PRIMARY KEY,
  tag TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  done_session_id TEXT
);

CREATE TABLE IF NOT EXISTS plan_exercises (
  plan_date TEXT NOT NULL,
  pos INTEGER NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (plan_date, pos)
);

-- Phase 2: filled by a scheduled Worker from Garmin.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  start_time TEXT NOT NULL,
  distance_m REAL,
  duration_s INTEGER,
  avg_hr INTEGER,
  source TEXT NOT NULL DEFAULT 'garmin'
);
