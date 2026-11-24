// Database schema and migrations. Runs once per Worker instance on the first
// request (idempotent), so no manual migration step is needed.

// Version 1: training data (single user).
const V1 = [
  `CREATE TABLE IF NOT EXISTS sessions ( id TEXT PRIMARY KEY, date TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')) )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`,
  `CREATE TABLE IF NOT EXISTS exercises ( session_id TEXT NOT NULL, pos INTEGER NOT NULL, name TEXT NOT NULL, sets_text TEXT NOT NULL DEFAULT '', PRIMARY KEY (session_id, pos) )`,
  `CREATE INDEX IF NOT EXISTS idx_exercises_name ON exercises(name)`,
  `CREATE TABLE IF NOT EXISTS sets ( session_id TEXT NOT NULL, ex_pos INTEGER NOT NULL, pos INTEGER NOT NULL, reps REAL, weight_kg REAL, weight_label TEXT, seconds INTEGER, PRIMARY KEY (session_id, ex_pos, pos) )`,
  `CREATE TABLE IF NOT EXISTS plans ( date TEXT PRIMARY KEY, tag TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', done_session_id TEXT )`,
  `CREATE TABLE IF NOT EXISTS plan_exercises ( plan_date TEXT NOT NULL, pos INTEGER NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', PRIMARY KEY (plan_date, pos) )`,
  `CREATE TABLE IF NOT EXISTS runs ( id TEXT PRIMARY KEY, start_time TEXT NOT NULL, distance_m REAL, duration_s INTEGER, avg_hr INTEGER, source TEXT NOT NULL DEFAULT 'garmin' )`,
  `CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT )`,
];

// Version 2: user accounts. Training data gets a user_id; plans are keyed by (user_id, date).
const V2 = [
  `CREATE TABLE IF NOT EXISTS users ( id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', verified_at TEXT, disabled INTEGER NOT NULL DEFAULT 0, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT, pw_changed_at TEXT )`,
  `CREATE TABLE IF NOT EXISTS auth_sessions ( token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, user_agent TEXT )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS tokens ( token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT )`,
  `CREATE TABLE IF NOT EXISTS outbox ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, link TEXT, kind TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, error TEXT )`,
  `ALTER TABLE sessions ADD COLUMN user_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions(user_id, date)`,
  `CREATE TABLE plans_v2 ( user_id TEXT, date TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', done_session_id TEXT, PRIMARY KEY (user_id, date) )`,
  `INSERT INTO plans_v2 (user_id, date, tag, note, done_session_id) SELECT NULL, date, tag, note, done_session_id FROM plans`,
  `DROP TABLE plans`,
  `ALTER TABLE plans_v2 RENAME TO plans`,
  `CREATE TABLE plan_exercises_v2 ( user_id TEXT, plan_date TEXT NOT NULL, pos INTEGER NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, plan_date, pos) )`,
  `INSERT INTO plan_exercises_v2 (user_id, plan_date, pos, name, target) SELECT NULL, plan_date, pos, name, target FROM plan_exercises`,
  `DROP TABLE plan_exercises`,
  `ALTER TABLE plan_exercises_v2 RENAME TO plan_exercises`,
  `ALTER TABLE runs ADD COLUMN user_id TEXT`,
  `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')`,
];

// Version 3: no email. Accounts have a status set by admins:
// pending (waiting for approval) → active; active ⇄ frozen; any → banned (and back).
const V3 = [
  `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`,
  `UPDATE users SET status = CASE WHEN disabled = 1 THEN 'frozen' WHEN verified_at IS NOT NULL OR role = 'admin' THEN 'active' ELSE 'pending' END`,
  `ALTER TABLE users ADD COLUMN status_changed_at TEXT`,
  `ALTER TABLE users ADD COLUMN reset_requested_at TEXT`,
  `DELETE FROM tokens WHERE kind IN ('verify', 'pwchange')`,
  `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')`,
];

// Version 4: effort per exercise (RIR = reps in reserve, 0–5) and a training goal per user.
const V4 = [
  `ALTER TABLE exercises ADD COLUMN rir INTEGER`,
  `ALTER TABLE users ADD COLUMN goal TEXT NOT NULL DEFAULT 'muscle'`,
  `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')`,
];

// Version 5: chosen UI language per user ('' = follow the device).
const V5 = [
  `ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT ''`,
  `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')`,
];

// Version 6: normal session length in minutes; the coach fits its proposals to it.
// New users get 40. The admin (Håkan, the only admin at this point) asked for 35.
const V6 = [
  `ALTER TABLE users ADD COLUMN session_min INTEGER NOT NULL DEFAULT 40`,
  `UPDATE users SET session_min = 35 WHERE role = 'admin'`,
  `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6')`,
];

export const SCHEMA_VERSION = 6;

let ready = null;
export function ensureSchema(db) {
  ready ??= migrate(db).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

async function migrate(db) {
  await db.batch(V1.map((s) => db.prepare(s)));
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
  const v = row ? +row.value : 1;
  // One batch = one transaction in D1, so v2 is applied all or nothing.
  if (v < 2) await db.batch(V2.map((s) => db.prepare(s)));
  if (v < 3) await db.batch(V3.map((s) => db.prepare(s)));
  if (v < 4) await db.batch(V4.map((s) => db.prepare(s)));
  if (v < 5) await db.batch(V5.map((s) => db.prepare(s)));
  if (v < 6) await db.batch(V6.map((s) => db.prepare(s)));
}

// Create the admin account on first start (from the ADMIN_EMAIL and
// ADMIN_PASSWORD_HASH settings) and give it all training data that has no owner yet.
let adminReady = null;
export function ensureAdmin(db, env) {
  adminReady ??= (async () => {
    const c = await db.prepare("SELECT COUNT(*) AS n FROM users").first();
    if (c.n > 0 || !env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH) return;
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare(
        `INSERT INTO users (id, email, first_name, last_name, pw_hash, role, verified_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'admin', datetime('now'), 'active')`,
      ).bind(id, String(env.ADMIN_EMAIL).trim().toLowerCase(), env.ADMIN_FIRST_NAME || "Admin", env.ADMIN_LAST_NAME || "", env.ADMIN_PASSWORD_HASH),
      db.prepare("UPDATE sessions SET user_id = ?1 WHERE user_id IS NULL").bind(id),
      db.prepare("UPDATE plans SET user_id = ?1 WHERE user_id IS NULL").bind(id),
      db.prepare("UPDATE plan_exercises SET user_id = ?1 WHERE user_id IS NULL").bind(id),
      db.prepare("UPDATE runs SET user_id = ?1 WHERE user_id IS NULL").bind(id),
    ]);
  })().catch((e) => {
    adminReady = null;
    throw e;
  });
  return adminReady;
}

// For tests: forget that migrations ran (a new database was swapped in).
export function _resetForTests() {
  ready = null;
  adminReady = null;
}
