// Träningslogg API. Static files in /public are served by Workers Assets;
// requests that match no file (i.e. /api/*) reach this Worker.
import { ensureSchema, ensureAdmin } from "./schema.js";
import { parseSets } from "../public/parse.js";
import seed from "../data/sessions.json" with { type: "json" };
import {
  hashPassword, verifyPassword, passwordProblem, normEmail, validEmail, cleanName, userOut, sha256,
  createSession, currentUser, endSession, sessionCookie, clearCookie, login, createToken, useToken, currentTokenHash,
} from "./auth.js";

const TAGS = new Set(["ÖK", "NK", "HK", ""]);
const MERGE = { UK: "NK", FK: "HK" };
const IMPORT_CHUNK = 5; // ~25 statements per request; D1 on the free plan allows 50 queries per invocation

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const bad = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", ...headers } });

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isId = (s) => typeof s === "string" && /^[\w.:-]{1,80}$/.test(s);
const str = (s, max = 2000) => String(s ?? "").slice(0, max);
const normTag = (t) => {
  const v = MERGE[t] ?? (t || "");
  return TAGS.has(v) ? v : "";
};

// Reps in reserve (how many more reps were left in the tank): 0–5, or unknown.
const cleanRir = (r) => (r === null || r === undefined || r === "" || !Number.isFinite(+r) ? null : Math.max(0, Math.min(5, Math.round(+r))));
const GOALS = new Set(["strength", "muscle", "health"]);
// UI languages (must match LANGS in public/i18n.js). "" = follow the device.
import { aiEnabled, suggestMuscles, usageReport, spent, aiConfig } from "./ai.js";
const LANGS = new Set(["sv", "en"]);
// Muscle ids (must match MUSCLES in public/muscles.js).
const MUSCLE_IDS = new Set(["bröst", "rygg", "trapets", "axlar", "bakaxlar", "biceps", "triceps", "underarmar", "framlår", "baklår", "säte", "höft", "vader", "bål"]);

function cleanExercises(ex) {
  if (!Array.isArray(ex)) return null;
  return ex
    .map((e) => ({ n: str(e?.n, 120).trim(), s: str(e?.s, 1000).trim(), r: cleanRir(e?.r) }))
    .filter((e) => e.n)
    .slice(0, 60);
}

// Statements that replace one session (and its exercises and parsed sets).
function sessionStatements(db, userId, id, s) {
  const exRows = s.ex.map((e, i) => ({ p: i, n: e.n, s: e.s, r: e.r ?? null }));
  const setRows = s.ex.flatMap((e, i) =>
    parseSets(e.s).map((x, j) => ({ e: i, p: j, r: x.r ?? null, w: x.w ?? null, l: x.wl ?? null, t: x.t ?? null })),
  );
  return [
    db.prepare("DELETE FROM sets WHERE session_id = ?1").bind(id),
    db.prepare("DELETE FROM exercises WHERE session_id = ?1").bind(id),
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, date, tag, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET date = excluded.date, tag = excluded.tag, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .bind(id, userId, s.date, s.tag, s.note),
    db
      .prepare(
        `INSERT INTO exercises (session_id, pos, name, sets_text, rir)
         SELECT ?1, json_extract(value, '$.p'), json_extract(value, '$.n'), json_extract(value, '$.s'), json_extract(value, '$.r') FROM json_each(?2)`,
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

async function getData(db, userId) {
  const [sess, ex, plans, pex, mus] = await db.batch([
    db.prepare("SELECT id, date, tag, note FROM sessions WHERE user_id = ?1 ORDER BY date, id").bind(userId),
    db.prepare(
      `SELECT e.session_id, e.pos, e.name, e.sets_text, e.rir FROM exercises e JOIN sessions s ON s.id = e.session_id
       WHERE s.user_id = ?1 ORDER BY e.session_id, e.pos`,
    ).bind(userId),
    db.prepare("SELECT date, tag, note, done_session_id FROM plans WHERE user_id = ?1 ORDER BY date").bind(userId),
    db.prepare("SELECT plan_date, pos, name, target FROM plan_exercises WHERE user_id = ?1 ORDER BY plan_date, pos").bind(userId),
    db.prepare("SELECT name, primary_m, secondary_m, compound FROM exercise_muscles WHERE user_id = ?1").bind(userId),
  ]);
  const split = (s) => String(s || "").split(",").filter(Boolean);
  const exBy = new Map();
  for (const r of ex.results) {
    if (!exBy.has(r.session_id)) exBy.set(r.session_id, []);
    exBy.get(r.session_id).push(r.rir === null || r.rir === undefined ? { n: r.name, s: r.sets_text } : { n: r.name, s: r.sets_text, r: r.rir });
  }
  const pexBy = new Map();
  for (const r of pex.results) {
    if (!pexBy.has(r.plan_date)) pexBy.set(r.plan_date, []);
    pexBy.get(r.plan_date).push({ n: r.name, s: r.target });
  }
  return {
    sessions: sess.results.map((r) => ({ id: r.id, date: r.date, tag: r.tag, note: r.note, ex: exBy.get(r.id) || [] })),
    plans: plans.results.map((r) => ({ id: r.date, date: r.date, tag: r.tag, note: r.note, done: r.done_session_id, ex: pexBy.get(r.date) || [] })),
    muscles: Object.fromEntries(mus.results.map((r) => [r.name, r.compound === null || r.compound === undefined ? { p: split(r.primary_m), s: split(r.secondary_m) } : { p: split(r.primary_m), s: split(r.secondary_m), c: !!r.compound }])),
  };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Open admin work: accounts waiting for approval and password-reset requests.
async function adminTasks(db) {
  const r = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE status = 'pending') AS pending,
            (SELECT COUNT(*) FROM users WHERE reset_requested_at IS NOT NULL AND status = 'active') AS resets`,
  ).first();
  return { pending: r.pending, resets: r.resets, total: r.pending + r.resets };
}
const meOut = async (db, u) => ({ ...userOut(u), ...(u.role === "admin" ? { tasks: await adminTasks(db) } : {}) });

// ---- account routes (no login needed) ----
async function handleAuth(request, env, url, db, action) {
  const method = request.method;

  if (action === "register" && method === "POST") {
    const b = (await readBody(request)) || {};
    const email = normEmail(b.email);
    const firstName = cleanName(b.firstName), lastName = cleanName(b.lastName);
    if (!validEmail(email)) return bad("Ange en giltig e-postadress.");
    if (!firstName || !lastName) return bad("Ange förnamn och efternamn.");
    const prob = passwordProblem(b.password, { email, firstName, lastName });
    if (prob) return bad(prob);
    // Same answer whether or not the email is already registered (or banned).
    const done = { ok: true, message: "Tack! Ditt konto är registrerat och väntar på att en administratör godkänner det. Du kan logga in när det är godkänt." };
    const existing = await db.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (existing) return json(done);
    await db
      .prepare(`INSERT INTO users (id, email, first_name, last_name, pw_hash, status, lang) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)`)
      .bind(crypto.randomUUID(), email, firstName, lastName, await hashPassword(b.password), LANGS.has(b.lang) ? b.lang : "")
      .run();
    return json(done);
  }

  if (action === "login" && method === "POST") {
    const b = (await readBody(request)) || {};
    const r = await login(db, b.email, b.password);
    if (r.error) return bad(r.error, 401, r.status ? { status: r.status } : {});
    const token = await createSession(db, r.user.id, request);
    return json({ ok: true, user: await meOut(db, r.user) }, 200, { "set-cookie": sessionCookie(token) });
  }

  if (action === "logout" && method === "POST") {
    await endSession(db, request);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  // Without email, a forgotten password becomes a request to the admins,
  // who create a one-time link and pass it on to the person.
  if (action === "forgot" && method === "POST") {
    const b = (await readBody(request)) || {};
    await db
      .prepare("UPDATE users SET reset_requested_at = datetime('now') WHERE email = ?1 AND status = 'active'")
      .bind(normEmail(b.email))
      .run();
    return json({ ok: true, message: "Om kontot finns har administratören fått en förfrågan. Du får en länk av hen för att välja nytt lösenord." });
  }

  if (action === "reset" && method === "POST") {
    const b = (await readBody(request)) || {};
    const tok = String(b.token || "").slice(0, 100);
    // Check the new password before using up the token.
    const u = tok && (await db.prepare(
      `SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?1 AND t.kind = 'reset' AND t.used_at IS NULL AND t.expires_at > datetime('now')`,
    ).bind(await sha256(tok)).first());
    if (!u) return bad("Länken är ogiltig eller har gått ut. Be administratören om en ny.");
    if (u.status !== "active") return bad("Kontot är inte aktivt.");
    const prob = passwordProblem(b.password, { email: u.email, firstName: u.first_name, lastName: u.last_name });
    if (prob) return bad(prob);
    if (!(await useToken(db, tok, "reset"))) return bad("Länken är ogiltig eller har gått ut. Be administratören om en ny.");
    await db.batch([
      db.prepare(`UPDATE users SET pw_hash = ?2, pw_changed_at = datetime('now'), failed_logins = 0, locked_until = NULL,
                  reset_requested_at = NULL WHERE id = ?1`).bind(u.id, await hashPassword(b.password)),
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1").bind(u.id),
    ]);
    return json({ ok: true, message: "Lösenordet är bytt. Logga in med det nya." });
  }

  return bad("Hittades inte.", 404);
}

// ---- logged-in account settings ----
async function handleAccount(request, env, url, db, user, action) {
  if (action === "name" && request.method === "PUT") {
    const b = (await readBody(request)) || {};
    const f = cleanName(b.firstName), l = cleanName(b.lastName);
    if (!f || !l) return bad("Ange förnamn och efternamn.");
    await db.prepare("UPDATE users SET first_name = ?2, last_name = ?3 WHERE id = ?1").bind(user.id, f, l).run();
    return json({ ok: true, user: await meOut(db, { ...user, first_name: f, last_name: l }) });
  }
  if (action === "session-length" && request.method === "PUT") {
    const b = (await readBody(request)) || {};
    const m = Number(b.minutes);
    if (!Number.isInteger(m) || m < 15 || m > 180) return bad("Ange en passlängd mellan 15 och 180 minuter.");
    await db.prepare("UPDATE users SET session_min = ?2 WHERE id = ?1").bind(user.id, m).run();
    return json({ ok: true, user: await meOut(db, { ...user, session_min: m }) });
  }
  if (action === "lang" && request.method === "PUT") {
    const b = (await readBody(request)) || {};
    const lang = b.lang ?? "";
    if (lang !== "" && !LANGS.has(lang)) return bad("Språket stöds inte.");
    await db.prepare("UPDATE users SET lang = ?2 WHERE id = ?1").bind(user.id, lang).run();
    return json({ ok: true, user: await meOut(db, { ...user, lang }) });
  }
  if (action === "goal" && request.method === "PUT") {
    const b = (await readBody(request)) || {};
    if (!GOALS.has(b.goal)) return bad("Välj styrka, muskler eller hälsa.");
    await db.prepare("UPDATE users SET goal = ?2 WHERE id = ?1").bind(user.id, b.goal).run();
    return json({ ok: true, user: await meOut(db, { ...user, goal: b.goal }) });
  }
  if (action === "password" && request.method === "POST") {
    const b = (await readBody(request)) || {};
    if (!(await verifyPassword(String(b.current || ""), user.pw_hash))) return bad("Nuvarande lösenord stämmer inte.");
    const prob = passwordProblem(b.password, { email: user.email, firstName: user.first_name, lastName: user.last_name });
    if (prob) return bad(prob);
    if (await verifyPassword(String(b.password), user.pw_hash)) return bad("Det nya lösenordet är samma som det gamla.");
    // Protect against tampering: the current password is required, and every
    // other device is logged out so a stolen login stops working.
    const keep = await currentTokenHash(request);
    await db.batch([
      db.prepare("UPDATE users SET pw_hash = ?2, pw_changed_at = datetime('now'), reset_requested_at = NULL WHERE id = ?1").bind(user.id, await hashPassword(b.password)),
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1 AND token_hash != ?2").bind(user.id, keep || ""),
      db.prepare("DELETE FROM tokens WHERE user_id = ?1").bind(user.id),
    ]);
    return json({ ok: true, message: "Lösenordet är bytt. Alla andra enheter har loggats ut." });
  }
  if (action === "logout-all" && request.method === "POST") {
    await db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1").bind(user.id).run();
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }
  return bad("Hittades inte.", 404);
}

// ---- admin ----
const STATUS_ACTIONS = {
  approve: { from: ["pending"], to: "active" },
  freeze: { from: ["active"], to: "frozen" },
  unfreeze: { from: ["frozen"], to: "active" },
  ban: { from: ["pending", "active", "frozen"], to: "banned" },
  unban: { from: ["banned"], to: "active" },
};

async function handleAdmin(request, env, url, db, user, parts) {
  if (user.role !== "admin") return bad("Endast för administratörer.", 403);
  const [what, id, sub] = parts;
  if (what === "tasks" && request.method === "GET") return json(await adminTasks(db));
  if (what === "ai" && request.method === "GET") return json(await usageReport(db, env));
  if (what === "users" && !id && request.method === "GET") {
    const r = await db.prepare(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.status, u.created_at, u.last_login_at, u.status_changed_at, u.reset_requested_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
              (SELECT MAX(date) FROM sessions s WHERE s.user_id = u.id) AS last_session
       FROM users u ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.reset_requested_at IS NULL, u.created_at`,
    ).all();
    return json({ users: r.results, me: user.id, tasks: await adminTasks(db) });
  }
  if (what === "users" && id && request.method === "POST") {
    const target = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first();
    if (!target) return bad("Användaren finns inte.", 404);
    if (id === user.id) return bad("Du kan inte ändra ditt eget konto här.");
    const b = (await readBody(request)) || {};
    const act = STATUS_ACTIONS[sub];
    if (act) {
      if (!act.from.includes(target.status)) return bad("Åtgärden passar inte kontots status.");
      await db.batch([
        db.prepare("UPDATE users SET status = ?2, status_changed_at = datetime('now'), failed_logins = 0, locked_until = NULL WHERE id = ?1").bind(id, act.to),
        ...(act.to !== "active" ? [db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1").bind(id)] : []),
      ]);
      return json({ ok: true });
    }
    if (sub === "reject") {
      // Remove a registration that was never approved (no training data).
      if (target.status !== "pending") return bad("Bara konton som väntar kan avslås.");
      await db.prepare("DELETE FROM users WHERE id = ?1 AND status = 'pending'").bind(id).run();
      return json({ ok: true });
    }
    if (sub === "role") {
      if (target.status !== "active") return bad("Kontot måste vara aktivt.");
      await db.prepare("UPDATE users SET role = ?2 WHERE id = ?1").bind(id, b.role === "admin" ? "admin" : "user").run();
      return json({ ok: true });
    }
    if (sub === "reset-link") {
      if (target.status !== "active") return bad("Kontot måste vara aktivt.");
      const t = await createToken(db, id, "reset");
      await db.prepare("UPDATE users SET reset_requested_at = NULL WHERE id = ?1").bind(id).run();
      return json({ ok: true, link: `${url.origin}/?reset=${t}`, hours: 24 });
    }
  }
  return bad("Hittades inte.", 404);
}

async function handleApi(request, env, url) {
  const db = env.DB;
  if (!db) return bad("Databasen är inte kopplad (D1-bindningen DB saknas).", 500);
  await ensureSchema(db);
  await ensureAdmin(db, env);

  // Cross-site requests must not change anything (in addition to SameSite cookies).
  if (request.method !== "GET" && request.method !== "HEAD") {
    const o = request.headers.get("origin");
    if (o && o !== url.origin) return bad("Ogiltig begäran.", 403);
  }

  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
  const [resource, key] = parts;
  const method = request.method;

  if (resource === "health") return json({ ok: true });
  if (resource === "auth") return handleAuth(request, env, url, db, key);

  const user = await currentUser(db, request);
  if (!user) return bad("Inte inloggad.", 401, { auth: true });

  if (resource === "me" && method === "GET") return json({ user: await meOut(db, user), ai: aiEnabled(env) });

  // AI help: muscle suggestions for exercise names the rules don't know.
  if (resource === "ai" && key === "muscles" && method === "POST") {
    if (!aiEnabled(env)) return bad("AI är inte aktiverat.", 503);
    const b = (await readBody(request)) || {};
    try {
      const suggestions = await suggestMuscles(db, env, user.id, b.names);
      const s = await spent(db, user.id), c = aiConfig(env);
      return json({ suggestions, spentSek: s.user, capSek: c.userCap });
    } catch (e) {
      if (e && e.status) { if (e.detail) console.log("AI error:", e.detail); return bad(e.message, e.status); }
      throw e;
    }
  }
  if (resource === "account") return handleAccount(request, env, url, db, user, key);
  if (resource === "admin") return handleAdmin(request, env, url, db, user, parts.slice(1));

  if (resource === "data" && method === "GET") return json(await getData(db, user.id));

  // The user's own muscle choice for an exercise. Empty primary list = back to automatic.
  if (resource === "muscles" && method === "PUT") {
    const b = (await readBody(request)) || {};
    const name = String(b.name || "").trim().slice(0, 120);
    const ok = (a) => Array.isArray(a) && a.every((m) => MUSCLE_IDS.has(m));
    if (!name || !ok(b.p || []) || !ok(b.s || [])) return bad("Ogiltig begäran.");
    const p = [...new Set(b.p || [])], s = [...new Set(b.s || [])].filter((m) => !p.includes(m));
    if (!p.length) await db.prepare("DELETE FROM exercise_muscles WHERE user_id = ?1 AND name = ?2").bind(user.id, name).run();
    else await db.prepare("INSERT OR REPLACE INTO exercise_muscles (user_id, name, primary_m, secondary_m, compound) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(user.id, name, p.join(","), s.join(","), typeof b.c === "boolean" ? (b.c ? 1 : 0) : null).run();
    return json({ ok: true });
  }

  if (resource === "sessions" && isId(key)) {
    const owner = await db.prepare("SELECT user_id FROM sessions WHERE id = ?1").bind(key).first();
    if (owner && owner.user_id !== user.id) return bad("Hittades inte.", 404);
    if (method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM sets WHERE session_id = ?1").bind(key),
        db.prepare("DELETE FROM exercises WHERE session_id = ?1").bind(key),
        db.prepare("DELETE FROM sessions WHERE id = ?1 AND user_id = ?2").bind(key, user.id),
        db.prepare("UPDATE plans SET done_session_id = NULL WHERE done_session_id = ?1 AND user_id = ?2").bind(key, user.id),
      ]);
      return json({ ok: true });
    }
    if (method === "PUT") {
      const b = await readBody(request);
      const ex = cleanExercises(b?.ex);
      if (!b || !isDate(b.date) || !ex) return bad("Ogiltigt pass.");
      await db.batch(sessionStatements(db, user.id, key, { date: b.date, tag: normTag(b.tag), note: str(b.note, 300), ex }));
      return json({ ok: true, id: key });
    }
  }

  if (resource === "plans" && isDate(key)) {
    if (method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM plan_exercises WHERE user_id = ?1 AND plan_date = ?2").bind(user.id, key),
        db.prepare("DELETE FROM plans WHERE user_id = ?1 AND date = ?2").bind(user.id, key),
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
        db.prepare("DELETE FROM plan_exercises WHERE user_id = ?1 AND plan_date = ?2").bind(user.id, key),
        db.prepare(
          `INSERT INTO plans (user_id, date, tag, note, done_session_id) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(user_id, date) DO UPDATE SET tag = excluded.tag, note = excluded.note, done_session_id = excluded.done_session_id`,
        ).bind(user.id, key, normTag(b.tag), str(b.note, 300), done),
        db.prepare(
          `INSERT INTO plan_exercises (user_id, plan_date, pos, name, target)
           SELECT ?1, ?2, json_extract(value, '$.p'), json_extract(value, '$.n'), json_extract(value, '$.s') FROM json_each(?3)`,
        ).bind(user.id, key, JSON.stringify(rows)),
      ]);
      return json({ ok: true });
    }
  }

  // One-time import of the v1 export (data/sessions.json) for the admin, in chunks.
  if (resource === "import" && method === "POST") {
    if (user.role !== "admin") return bad("Endast för administratörer.", 403);
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const total = seed.sessions.length;
    if (offset === 0) {
      const c = await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1").bind(user.id).first();
      if (c.n > 0) return bad("Du har redan pass. Importen körs bara mot ett tomt konto.", 409);
    }
    const chunk = seed.sessions.slice(offset, offset + IMPORT_CHUNK);
    const stmts = chunk.flatMap((s) =>
      sessionStatements(db, user.id, s.id, {
        date: s.date, tag: normTag(s.tag), note: str(s.note, 300),
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
