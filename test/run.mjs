// Local test: runs the Worker against a fake D1 (node:sqlite) and checks the API.
// Usage: npm test   (or: node --experimental-sqlite test/run.mjs [--serve PORT])
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import worker from "../src/worker.js";
import { SCHEMA } from "../src/schema.js";
import { parseSessionText, parseSets } from "../public/parse.js";

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
const env = { DB: new FakeD1(), ASSETS };
const call = async (path, opt = {}) => {
  const r = await worker.fetch(new Request("http://x" + path, { headers: { "content-type": "application/json" }, ...opt }), env);
  return { status: r.status, body: await r.json() };
};
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok  ", m); };

// import
let next = 0, maxStmts = 0;
while (next != null) {
  const before = env.DB.count;
  const r = await call("/api/import?offset=" + next, { method: "POST" });
  maxStmts = Math.max(maxStmts, env.DB.count - before);
  if (r.status !== 200) { console.error(r); process.exit(1); }
  next = r.body.next;
}
assert(maxStmts <= 50, `import stays under 50 statements per request (max ${maxStmts})`);
let d = (await call("/api/data")).body;
assert(d.sessions.length === 88, `88 sessions imported (${d.sessions.length})`);
const tags = d.sessions.reduce((a, s) => ((a[s.tag || "-"] = (a[s.tag || "-"] || 0) + 1), a), {});
assert(!tags.UK && !tags.FK, "only ÖK/NK/HK/untyped tags " + JSON.stringify(tags));
const nSets = env.DB.db.prepare("SELECT COUNT(*) n FROM sets").get().n;
assert(nSets > 1000, `parsed sets stored (${nSets})`);
const top = env.DB.db.prepare(`SELECT s.date, x.reps, x.weight_kg FROM sets x JOIN exercises e ON e.session_id=x.session_id AND e.pos=x.ex_pos JOIN sessions s ON s.id=x.session_id WHERE e.name='Bänkpress (incline)' ORDER BY x.weight_kg DESC, x.reps DESC LIMIT 1`).get();
assert(top.weight_kg === 25, `SQL query works: best incline ${top.reps}@${top.weight_kg} on ${top.date}`);
assert((await call("/api/import?offset=0", { method: "POST" })).status === 409, "re-import refused on non-empty db");

// sessions CRUD
let r = await call("/api/sessions/2026-11-23-test", { method: "PUT", body: JSON.stringify({ date: "2026-11-23", tag: "UK", note: "test", ex: [{ n: "Kabelrodd", s: "8@33,5+2kg, 6@35kg x2" }, { n: "", s: "skip" }] }) });
assert(r.status === 200, "save session");
d = (await call("/api/data")).body;
const t = d.sessions.find((s) => s.id === "2026-11-23-test");
assert(t && t.tag === "NK" && t.ex.length === 1 && t.ex[0].s === "8@33,5+2kg, 6@35kg x2", "session stored, UK→NK, empty row dropped, raw text kept");
assert(env.DB.db.prepare("SELECT COUNT(*) n FROM sets WHERE session_id='2026-11-23-test'").get().n === 3, "x2 expands to 3 parsed sets");
assert((await call("/api/sessions/bad id!", { method: "PUT", body: "{}" })).status === 404, "bad id rejected");
assert((await call("/api/sessions/x1", { method: "PUT", body: JSON.stringify({ date: "nope", ex: [] }) })).status === 400, "bad date rejected");

// plans
r = await call("/api/plans/2026-11-24", { method: "PUT", body: JSON.stringify({ tag: "ÖK", note: "", ex: [{ n: "Bänkpress (incline)", s: "7@22,5" }], done: null }) });
assert(r.status === 200, "save plan");
r = await call("/api/plans/2026-11-24", { method: "PUT", body: JSON.stringify({ tag: "ÖK", note: "", ex: [{ n: "Bänkpress (incline)", s: "7@22,5" }], done: "2026-11-23-test" }) });
d = (await call("/api/data")).body;
assert(d.plans.length === 1 && d.plans[0].done === "2026-11-23-test" && d.plans[0].ex[0].s === "7@22,5", "plan marked done");
await call("/api/sessions/2026-11-23-test", { method: "DELETE" });
d = (await call("/api/data")).body;
assert(d.sessions.length === 88 && d.plans[0].done === null, "delete session clears plan link");
await call("/api/plans/2026-11-24", { method: "DELETE" });
assert((await call("/api/data")).body.plans.length === 0, "delete plan");

// pasting from Notes
const ps = parseSessionText("22/11 ök (Kyrkbyn)\n- Bänkpress (incline) 4@15, 6@22,5 kg, 7@20KG\n• Preachercurl (hantel) 8@15\nPull-ups 6, 6\nPlankan 2:30\n\n261123 UK\nHip abductor x2 10@30kg", "2026-11-22");
assert(ps.length === 2 && ps[0].date === "2026-11-22" && ps[0].tag === "ÖK" && ps[0].note === "Kyrkbyn", "paste: header with date, type and note");
assert(ps[0].ex[1].n === "Preacher curl (hantel)" && ps[0].ex.length === 4, "paste: bullets stripped, name variants mapped");
assert(ps[1].tag === "NK" && ps[1].ex[0].n === "Hip abductor x2", "paste: second session, UK→NK, x2 stays in name");
assert(JSON.stringify(parseSets("6@22,5 kg, 7@20KG, 4@15")) === JSON.stringify([{ r: 6, w: 22.5 }, { r: 7, w: 20 }, { r: 4, w: 15 }]), "kg optional and case-insensitive");

const serveAt = process.argv.indexOf("--serve");
if (serveAt > 0) {
  const port = +process.argv[serveAt + 1] || 8787;
  if (process.argv.includes("--empty")) { env.DB = new FakeD1(); for (const s of SCHEMA) env.DB.db.exec(s); }
  createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const resp = await worker.fetch(new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(resp.status, Object.fromEntries(resp.headers)); res.end(Buffer.from(await resp.arrayBuffer()));
  }).listen(port, () => console.log("serving on", port));
}
