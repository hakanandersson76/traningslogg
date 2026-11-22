// Träningslogg API. Static files in /public are served by Workers Assets;
// requests that match no file (i.e. /api/*) reach this Worker.
import { SCHEMA } from "./schema.js";
import { parseSets } from "../public/parse.js";
import seed from "../data/sessions.json" with { type: "json" };

const TAGS = new Set(["ÖK", "NK", "HK", ""]);
const MERGE = { UK: "NK", FK: "HK" };
const IMPORT_CHUNK = 5; // ~25 statements per request; D1 on the free plan allows 50 queries per invocation

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isId = (s) => typeof s === "string" && /^[\w.:-]{1,80}$/.test(s);
const str = (s, max = 2000) => String(s ?? "").slice(0, max);
const normTag = (t) => {
  const v = MERGE[t] ?? (t || "");
  return TAGS.has(v) ? v : "";
};

function cleanExercises(ex) {
  if (!Array.isArray(ex)) return null;
  return ex
    .map((e) => ({ n: str(e?.n, 120).trim(), s: str(e?.s, 1000).trim() }))
    .filter((e) => e.n)
    .slice(0, 60);
}

// Statements that replace one session (and its exercises and parsed sets).
function sessionStatements(db, id, s) {
  const exRows = s.ex.map((e, i) => ({ p: i, n: e.n, s: e.s }));
  const setRows = s.ex.flatMap((e, i) =>
    parseSets(e.s).map((x, j) => ({
      e: i,
      p: j,
      r: x.r ?? null,
      w: x.w ?? null,
      l: x.wl ?? null,
      t: x.t ?? null,
    })),
  );
  return [
    db.prepare("DELETE FROM sets WHERE session_id = ?1").bind(id),
    db.prepare("DELETE FROM exercises WHERE session_id = ?1").bind(id),
    db
      .prepare(
        `INSERT INTO sessions (id, date, tag, note, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET date = excluded.date, tag = excluded.tag, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .bind(id, s.date, s.tag, s.note),
    db
      .prepare(
        `INSERT INTO exercises (session_id, pos, name, sets_text)
         SELECT ?1, json_extract(value, '$.p'), json_extract(value, '$.n'), json_extract(value, '$.s') FROM json_each(?2)`,
      )
      .bind(id, JSON.stringify(exRows)),
    db
      .prepare(
        `INSERT INTO sets (session_id, ex_pos, pos, reps, weight_kg, weight_label, seconds)
         SELECT ?1, json_extract(value, '$.e'), json_extract(value, '$.p'), json_extract(value, '$.r'),
                json_extract(value, '$.w'), json_extract(value, '$.l'), json_extract(value, '$.t') FROM json_each(?2)`,
      )
      .bind(id, JSON.stringify(setRows)),
  ];
}

async function getData(db) {
  const [sess, ex, plans, pex] = await db.batch([
    db.prepare("SELECT id, date, tag, note FROM sessions ORDER BY date, id"),
    db.prepare("SELECT session_id, pos, name, sets_text FROM exercises ORDER BY session_id, pos"),
    db.prepare("SELECT date, tag, note, done_session_id FROM plans ORDER BY date"),
    db.prepare("SELECT plan_date, pos, name, target FROM plan_exercises ORDER BY plan_date, pos"),
  ]);
  const exBy = new Map();
  for (const r of ex.results) {
    if (!exBy.has(r.session_id)) exBy.set(r.session_id, []);
    exBy.get(r.session_id).push({ n: r.name, s: r.sets_text });
  }
  const pexBy = new Map();
  for (const r of pex.results) {
    if (!pexBy.has(r.plan_date)) pexBy.set(r.plan_date, []);
    pexBy.get(r.plan_date).push({ n: r.name, s: r.target });
  }
  return {
    sessions: sess.results.map((r) => ({ id: r.id, date: r.date, tag: r.tag, note: r.note, ex: exBy.get(r.id) || [] })),
    plans: plans.results.map((r) => ({
      id: r.date,
      date: r.date,
      tag: r.tag,
      note: r.note,
      done: r.done_session_id,
      ex: pexBy.get(r.date) || [],
    })),
  };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleApi(request, env, url) {
  const db = env.DB;
  if (!db) return bad("Databasen är inte kopplad (D1-bindningen DB saknas).", 500);
  await ensureSchema(db);
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
  const [resource, key] = parts;
  const method = request.method;

  if (resource === "health") return json({ ok: true });

  if (resource === "data" && method === "GET") return json(await getData(db));

  if (resource === "sessions" && isId(key)) {
    if (method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM sets WHERE session_id = ?1").bind(key),
        db.prepare("DELETE FROM exercises WHERE session_id = ?1").bind(key),
        db.prepare("DELETE FROM sessions WHERE id = ?1").bind(key),
        db.prepare("UPDATE plans SET done_session_id = NULL WHERE done_session_id = ?1").bind(key),
      ]);
      return json({ ok: true });
    }
    if (method === "PUT") {
      const b = await readBody(request);
      const ex = cleanExercises(b?.ex);
      if (!b || !isDate(b.date) || !ex) return bad("Ogiltigt pass.");
      const s = { date: b.date, tag: normTag(b.tag), note: str(b.note, 300), ex };
      await db.batch(sessionStatements(db, key, s));
      return json({ ok: true, id: key });
    }
  }

  if (resource === "plans" && isDate(key)) {
    if (method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM plan_exercises WHERE plan_date = ?1").bind(key),
        db.prepare("DELETE FROM plans WHERE date = ?1").bind(key),
      ]);
      return json({ ok: true });
    }
    if (method === "PUT") {
      const b = await readBody(request);
      const ex = cleanExercises(b?.ex);
      if (!b || !ex) return bad("Ogiltig plan.");
      const done = b.done && isId(b.done) ? b.done : null;
      const rows = ex.map((e, i) => ({ p: i, n: e.n, s: e.s }));
      await db.batch([
        db.prepare("DELETE FROM plan_exercises WHERE plan_date = ?1").bind(key),
        db
          .prepare(
            `INSERT INTO plans (date, tag, note, done_session_id) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(date) DO UPDATE SET tag = excluded.tag, note = excluded.note, done_session_id = excluded.done_session_id`,
          )
          .bind(key, normTag(b.tag), str(b.note, 300), done),
        db
          .prepare(
            `INSERT INTO plan_exercises (plan_date, pos, name, target)
             SELECT ?1, json_extract(value, '$.p'), json_extract(value, '$.n'), json_extract(value, '$.s') FROM json_each(?2)`,
          )
          .bind(key, JSON.stringify(rows)),
      ]);
      return json({ ok: true });
    }
  }

  // One-time import of the v1 export (data/sessions.json), in chunks to stay
  // well inside D1's per-request query limits. Only allowed into an empty database.
  if (resource === "import" && method === "POST") {
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const total = seed.sessions.length;
    if (offset === 0) {
      const c = await db.prepare("SELECT COUNT(*) AS n FROM sessions").first();
      if (c.n > 0) return bad("Databasen har redan pass. Importen körs bara mot en tom databas.", 409);
    }
    const chunk = seed.sessions.slice(offset, offset + IMPORT_CHUNK);
    const stmts = chunk.flatMap((s) =>
      sessionStatements(db, s.id, {
        date: s.date,
        tag: normTag(s.tag),
        note: str(s.note, 300),
        ex: cleanExercises(s.exercises.map((e) => ({ n: e.name, s: e.sets }))),
      }),
    );
    if (stmts.length) await db.batch(stmts);
    const next = offset + chunk.length;
    return json({ ok: true, imported: next, total, done: next >= total, next: next >= total ? null : next });
  }

  return bad("Hittades inte.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return bad("Serverfel: " + (e?.message || e), 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
