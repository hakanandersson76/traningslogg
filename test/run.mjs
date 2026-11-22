// Local tests: run the Worker against a fake D1 (node:sqlite) and check the API,
// accounts, the migration from the single-user database, the parser and the coach.
// Usage: npm test   (or: node --experimental-sqlite test/run.mjs [--serve PORT [--empty]])
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import worker from "../src/worker.js";
import { _resetForTests } from "../src/schema.js";
import { hashPassword } from "../src/auth.js";
import { parseSessionText, parseSets } from "../public/parse.js";
import { coachReport, nextTarget, history, groupOf, effectiveTag } from "../public/coach.js";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _p() { return this.db.prepare(this.sql); }
  async all() { return { results: this._p().all(...this.args) }; }
  async first() { return this._p().get(...this.args) ?? null; }
  async run() { this._p().run(...this.args); return { success: true }; }
  _sync() { const p = this._p(); return /^\s*select/i.test(this.sql) ? { results: p.all(...this.args) } : (p.run(...this.args), { results: [] }); }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); this.count = 0; }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.count += stmts.length;
    this.db.exec("BEGIN");
    try { const r = stmts.map((s) => s._sync()); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const f = join("public", p === "/" ? "index.html" : p);
    try { return new Response(await readFile(f), { headers: { "content-type": TYPES[extname(f)] || "application/octet-stream" } }); }
    catch { return new Response("not found", { status: 404 }); }
  },
};

const ADMIN_PW = "Test-admin-Lösen#2026";
const env = {
  DB: new FakeD1(), ASSETS,
  ADMIN_EMAIL: "Admin@Example.com", ADMIN_FIRST_NAME: "Håkan", ADMIN_LAST_NAME: "Andersson",
  ADMIN_PASSWORD_HASH: await hashPassword(ADMIN_PW),
};
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok  ", m); };

// A tiny browser: keeps the session cookie per client.
function client() {
  let cookie = "";
  return async (path, opt = {}) => {
    const headers = { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opt.headers || {}) };
    const r = await worker.fetch(new Request("https://app.test" + path, { ...opt, headers, redirect: "manual" }), env);
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = /Max-Age=0/.test(sc) ? "" : sc.split(";")[0];
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : null, location: r.headers.get("location") };
  };
}
const post = (c, p, b) => c(p, { method: "POST", body: JSON.stringify(b) });
const put = (c, p, b) => c(p, { method: "PUT", body: JSON.stringify(b) });
const lastLink = (kind) => env.DB.db.prepare("SELECT link FROM outbox WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind)?.link;
const pathOf = (link) => link.replace("https://app.test", "");

// ---- 1. Migration: the live database (single user, no accounts) ----
{
  const old = env.DB.db;
  old.exec(`CREATE TABLE sessions ( id TEXT PRIMARY KEY, date TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
    CREATE TABLE exercises ( session_id TEXT NOT NULL, pos INTEGER NOT NULL, name TEXT NOT NULL, sets_text TEXT NOT NULL DEFAULT '', PRIMARY KEY (session_id, pos) );
    CREATE TABLE sets ( session_id TEXT NOT NULL, ex_pos INTEGER NOT NULL, pos INTEGER NOT NULL, reps REAL, weight_kg REAL, weight_label TEXT, seconds INTEGER, PRIMARY KEY (session_id, ex_pos, pos) );
    CREATE TABLE plans ( date TEXT PRIMARY KEY, tag TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', done_session_id TEXT );
    CREATE TABLE plan_exercises ( plan_date TEXT NOT NULL, pos INTEGER NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', PRIMARY KEY (plan_date, pos) );
    CREATE TABLE runs ( id TEXT PRIMARY KEY, start_time TEXT NOT NULL, distance_m REAL, duration_s INTEGER, avg_hr INTEGER, source TEXT NOT NULL DEFAULT 'garmin' );`);
  const seed = JSON.parse(await readFile("data/sessions.json", "utf8")).sessions;
  const ins = old.prepare("INSERT INTO sessions (id, date, tag, note) VALUES (?, ?, ?, ?)");
  const insE = old.prepare("INSERT INTO exercises (session_id, pos, name, sets_text) VALUES (?, ?, ?, ?)");
  for (const s of seed) { ins.run(s.id, s.date, s.tag, s.note); s.exercises.forEach((e, i) => insE.run(s.id, i, e.name, e.sets)); }
  old.exec("INSERT INTO plans VALUES ('2026-11-24','ÖK','',NULL); INSERT INTO plan_exercises VALUES ('2026-11-24',0,'Kabelrodd','7@33,5');");
}
const admin = client();
assert((await admin("/api/data")).status === 401, "data requires login");
let r = await post(admin, "/api/auth/login", { email: "admin@example.com", password: "wrong-password-123" });
assert(r.status === 401 && !r.body.user, "wrong password refused");
r = await post(admin, "/api/auth/login", { email: " ADMIN@example.com ", password: ADMIN_PW });
assert(r.status === 200 && r.body.user.role === "admin" && r.body.user.firstName === "Håkan", "admin bootstrapped from settings and can log in");
let d = (await admin("/api/data")).body;
assert(d.sessions.length === 88 && d.plans.length === 1 && d.plans[0].ex[0].n === "Kabelrodd", "migration: existing 88 sessions and plan now belong to admin");
const stored = env.DB.db.prepare("SELECT pw_hash FROM users").get().pw_hash;
assert(stored.startsWith("pbkdf2$100000$") && !stored.includes(ADMIN_PW), "password stored only as PBKDF2 hash");

// ---- 2. Registration and email verification ----
const anna = client();
r = await post(anna, "/api/auth/register", { email: "anna@example.com", password: "kort", firstName: "Anna", lastName: "Berg" });
assert(r.status === 400 && /12 tecken/.test(r.body.error), "weak password refused (length)");
r = await post(anna, "/api/auth/register", { email: "anna@example.com", password: "annaberg-Hej123!", firstName: "Anna", lastName: "Berg" });
assert(r.status === 400 && /namn/.test(r.body.error), "password containing the name refused");
r = await post(anna, "/api/auth/register", { email: "anna@example.com", password: "Gröna-Hästar-91", firstName: "Anna", lastName: "Berg" });
assert(r.status === 200, "registration accepted");
r = await post(anna, "/api/auth/login", { email: "anna@example.com", password: "Gröna-Hästar-91" });
assert(r.status === 401 && r.body.unverified, "cannot log in before verifying email");
const vlink = lastLink("verify");
assert(vlink && vlink.includes("/api/auth/verify?token="), "verification email queued in outbox with link");
r = await anna(pathOf(vlink));
assert(r.status === 302 && r.location === "/?msg=verified", "verification link works");
assert((await anna(pathOf(vlink))).location === "/?msg=verify-failed", "verification link is single-use");
r = await post(anna, "/api/auth/login", { email: "anna@example.com", password: "Gröna-Hästar-91" });
assert(r.status === 200 && r.body.user.role === "user", "verified user logs in");
assert((await anna("/api/data")).body.sessions.length === 0, "new user sees no one else's data");
r = await post(client(), "/api/auth/register", { email: "anna@example.com", password: "Andra-Lösen-77x", firstName: "X", lastName: "Y" });
assert(r.status === 200 && env.DB.db.prepare("SELECT COUNT(*) n FROM users").get().n === 2 && lastLink("already"), "duplicate email: same answer, no new account, warning mail");

// ---- 3. Data is private per user ----
r = await put(anna, "/api/sessions/2026-11-23-a", { date: "2026-11-23", tag: "NK", note: "", ex: [{ n: "Squats", s: "8@60" }] });
assert(r.status === 200 && (await anna("/api/data")).body.sessions.length === 1, "user saves own session");
assert((await admin("/api/data")).body.sessions.length === 88, "admin does not see Anna's session");
r = await put(anna, "/api/sessions/2026-01-02-00", { date: "2026-01-02", tag: "", note: "", ex: [{ n: "X", s: "1@1" }] });
assert(r.status === 404, "cannot overwrite another user's session");
r = await anna("/api/sessions/2026-01-02-00", { method: "DELETE" });
assert(r.status === 404 && (await admin("/api/data")).body.sessions.length === 88, "cannot delete another user's session");
await put(anna, "/api/plans/2026-11-24", { tag: "HK", note: "", ex: [{ n: "Squats", s: "9@60" }], done: null });
d = (await admin("/api/data")).body;
assert(d.plans[0].tag === "ÖK" && (await anna("/api/data")).body.plans[0].tag === "HK", "plans on the same date are separate per user");
assert((await post(anna, "/api/import", {})).status === 403, "only admin may import");

// ---- 4. Settings: name and password change with email confirmation ----
r = await put(anna, "/api/account/name", { firstName: "Annie", lastName: "Berg-Lind" });
assert(r.status === 200 && (await anna("/api/me")).body.user.firstName === "Annie", "change name");
r = await post(anna, "/api/account/password", { current: "fel-lösen-123A", password: "Blå-Kaffe-Kopp-8" });
assert(r.status === 400, "password change needs the current password");
r = await post(anna, "/api/account/password", { current: "Gröna-Hästar-91", password: "Blå-Kaffe-Kopp-8" });
assert(r.status === 200, "password change requested");
r = await post(client(), "/api/auth/login", { email: "anna@example.com", password: "Blå-Kaffe-Kopp-8" });
assert(r.status === 401, "new password not active before email confirmation");
const other = client(); await post(other, "/api/auth/login", { email: "anna@example.com", password: "Gröna-Hästar-91" });
r = await anna(pathOf(lastLink("pwchange")));
assert(r.location === "/?msg=pw-changed", "confirmation link applies the new password");
assert((await other("/api/data")).status === 401, "all other logins are signed out after the change");
assert(env.DB.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='changed'").get().n > 0, "'password changed' notice sent");
r = await post(anna, "/api/auth/login", { email: "anna@example.com", password: "Blå-Kaffe-Kopp-8" });
assert(r.status === 200, "log in with the new password");

// ---- 5. Forgot password ----
await post(client(), "/api/auth/forgot", { email: "anna@example.com" });
const tok = new URL(lastLink("reset")).searchParams.get("reset");
r = await post(client(), "/api/auth/reset", { token: tok, password: "svag" });
assert(r.status === 400, "reset with weak password refused (token not used up)");
r = await post(client(), "/api/auth/reset", { token: tok, password: "Röda-Äpplen-2026" });
assert(r.status === 200, "reset password with emailed link");
assert((await post(client(), "/api/auth/reset", { token: tok, password: "Röda-Äpplen-2027" })).status === 400, "reset link is single-use");
r = await post(client(), "/api/auth/forgot", { email: "nobody@example.com" });
assert(r.status === 200, "forgot password does not reveal unknown emails");

// ---- 6. Lockout ----
const mallory = client();
for (let i = 0; i < 5; i++) await post(mallory, "/api/auth/login", { email: "anna@example.com", password: "guess-" + i + "Xx!" });
r = await post(mallory, "/api/auth/login", { email: "anna@example.com", password: "Röda-Äpplen-2026" });
assert(r.status === 401 && /För många/.test(r.body.error), "account locked after 5 wrong passwords");
env.DB.db.prepare("UPDATE users SET locked_until = NULL WHERE email = 'anna@example.com'").run();
assert((await post(anna, "/api/auth/login", { email: "anna@example.com", password: "Röda-Äpplen-2026" })).status === 200, "login works again after the lock expires");

// ---- 7. Admin ----
r = await anna("/api/admin/users");
assert(r.status === 403, "non-admin cannot open admin");
r = await admin("/api/admin/users");
assert(r.status === 200 && r.body.users.length === 2 && r.body.users.some((u) => u.email === "anna@example.com" && u.sessions === 1), "admin lists users with session counts");
const annaId = r.body.users.find((u) => u.email === "anna@example.com").id;
r = await admin("/api/admin/outbox");
assert(r.body.mails.length >= 5 && r.body.mailConfigured === false, "admin sees the email outbox");
await post(admin, `/api/admin/users/${annaId}/disable`, { disabled: true });
assert((await anna("/api/data")).status === 401, "disabled user is signed out");
await post(admin, `/api/admin/users/${annaId}/disable`, { disabled: false });
const meId = (await admin("/api/admin/users")).body.me;
assert((await post(admin, `/api/admin/users/${meId}/disable`, { disabled: true })).status === 400, "admin cannot disable self");
assert((await admin("/api/data", { method: "PUT", headers: { origin: "https://evil.test" } })).status === 403, "cross-site write refused");

// ---- 8. Logout ----
await post(admin, "/api/auth/logout", {});
assert((await admin("/api/data")).status === 401, "logout ends the session");

// ---- 9. Parser and coach ----
const ps = parseSessionText("22/11 ök (Kyrkbyn)\n- Bänkpress (incline) 4@15, 6@22,5 kg, 7@20KG\n• Preachercurl (hantel) 8@15\nPull-ups 6, 6\nPlankan 2:30\n\n261123 UK\nHip abductor x2 10@30kg", "2026-11-22");
assert(ps.length === 2 && ps[0].date === "2026-11-22" && ps[0].tag === "ÖK" && ps[0].note === "Kyrkbyn", "paste: header with date, type and note");
assert(ps[0].ex[1].n === "Preacher curl (hantel)" && ps[0].ex.length === 4, "paste: bullets stripped, name variants mapped");
assert(ps[1].tag === "NK" && ps[1].ex[0].n === "Hip abductor x2", "paste: second session, UK→NK, x2 stays in name");
assert(JSON.stringify(parseSets("6@22,5 kg, 7@20KG, 4@15")) === JSON.stringify([{ r: 6, w: 22.5 }, { r: 7, w: 20 }, { r: 4, w: 15 }]), "kg optional and case-insensitive");
const seedS = JSON.parse(await readFile("data/sessions.json", "utf8")).sessions.map((s) => ({ id: s.id, date: s.date, tag: s.tag, ex: s.exercises.map((e) => ({ n: e.name, s: e.sets })) }));
const rep = coachReport(seedS, "2026-11-22");
assert(rep.next.tag === "NK" && !rep.next.rest, `coach: legs due after ${rep.next.gl} days → NK`);
assert(rep.plan.length >= 3 && rep.plan.every((p) => groupOf(p.n) === "ben" || groupOf(p.n) === "core"), "coach: proposed NK session uses leg/core exercises");
assert(rep.plan.find((p) => p.n === "Vadpress (maskin)")?.kind === "plateau", "coach: calf press flagged as plateau");
const h1 = history([{ date: "2026-01-01", ex: [{ n: "X", s: "10@20" }] }]).get("X");
assert(nextTarget(h1, "2026-01-05").target === "8@22,5", "coach: 10 reps → +2,5 kg");
assert(nextTarget(h1, "2026-03-01").kind === "comeback", "coach: long break → comeback");
assert(groupOf("Leg curl") === "ben" && groupOf("Jefferson curls (skivstång)") === "ben" && groupOf("Preacher curl") === "armar", "coach: muscle groups");
assert(effectiveTag({ tag: "", ex: [{ n: "Squats" }, { n: "Leg extensions" }] }) === "NK", "coach: untyped session inferred");

// ---- local server for browser tests ----
const serveAt = process.argv.indexOf("--serve");
if (serveAt > 0) {
  const port = +process.argv[serveAt + 1] || 8787;
  if (process.argv.includes("--empty")) { env.DB = new FakeD1(); _resetForTests(); }
  createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const resp = await worker.fetch(new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" }), env);
    const headers = Object.fromEntries(resp.headers);
    if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].replace("; Secure", "");
    res.writeHead(resp.status, headers); res.end(Buffer.from(await resp.arrayBuffer()));
  }).listen(port, () => console.log("serving on", port));
}
