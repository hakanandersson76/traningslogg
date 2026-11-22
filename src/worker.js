// Träningslogg API. Static files in /public are served by Workers Assets;
// requests that match no file (i.e. /api/*) reach this Worker.
import { ensureSchema, ensureAdmin } from "./schema.js";
import { parseSets } from "../public/parse.js";
import seed from "../data/sessions.json" with { type: "json" };
import {
  hashPassword, verifyPassword, passwordProblem, normEmail, validEmail, cleanName, userOut, sha256,
  createSession, currentUser, endSession, sessionCookie, clearCookie, login, createToken, useToken,
} from "./auth.js";
import { sendMail, MAILS } from "./mail.js";

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

function cleanExercises(ex) {
  if (!Array.isArray(ex)) return null;
  return ex
    .map((e) => ({ n: str(e?.n, 120).trim(), s: str(e?.s, 1000).trim() }))
    .filter((e) => e.n)
    .slice(0, 60);
}

// Statements that replace one session (and its exercises and parsed sets).
function sessionStatements(db, userId, id, s) {
  const exRows = s.ex.map((e, i) => ({ p: i, n: e.n, s: e.s }));
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

async function getData(db, userId) {
  const [sess, ex, plans, pex] = await db.batch([
    db.prepare("SELECT id, date, tag, note FROM sessions WHERE user_id = ?1 ORDER BY date, id").bind(userId),
    db.prepare(
      `SELECT e.session_id, e.pos, e.name, e.sets_text FROM exercises e JOIN sessions s ON s.id = e.session_id
       WHERE s.user_id = ?1 ORDER BY e.session_id, e.pos`,
    ).bind(userId),
    db.prepare("SELECT date, tag, note, done_session_id FROM plans WHERE user_id = ?1 ORDER BY date").bind(userId),
    db.prepare("SELECT plan_date, pos, name, target FROM plan_exercises WHERE user_id = ?1 ORDER BY plan_date, pos").bind(userId),
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
    plans: plans.results.map((r) => ({ id: r.date, date: r.date, tag: r.tag, note: r.note, done: r.done_session_id, ex: pexBy.get(r.date) || [] })),
  };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const hi = (u) => u.first_name || "där";

// ---- account routes (no login needed) ----
async function handleAuth(request, env, url, db, action) {
  const method = request.method;
  const origin = url.origin;

  if (action === "register" && method === "POST") {
    const b = (await readBody(request)) || {};
    const email = normEmail(b.email);
    const firstName = cleanName(b.firstName), lastName = cleanName(b.lastName);
    if (!validEmail(email)) return bad("Ange en giltig e-postadress.");
    if (!firstName || !lastName) return bad("Ange förnamn och efternamn.");
    const prob = passwordProblem(b.password, { email, firstName, lastName });
    if (prob) return bad(prob);
    const done = { ok: true, message: "Kontot är skapat. Vi har skickat ett mejl till dig – öppna länken för att bekräfta adressen innan du loggar in." };
    const existing = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(email).first();
    if (existing) {
      // Same answer as for a new account, so nobody can probe which emails are registered.
      const t = await createToken(db, existing.id, "reset");
      await sendMail(db, env, { userId: existing.id, to: email, ...MAILS.alreadyRegistered(hi(existing)), link: `${origin}/?reset=${t}`, kind: "already" });
      return json(done);
    }
    const id = crypto.randomUUID();
    await db
      .prepare(`INSERT INTO users (id, email, first_name, last_name, pw_hash) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(id, email, firstName, lastName, await hashPassword(b.password))
      .run();
    const t = await createToken(db, id, "verify");
    await sendMail(db, env, { userId: id, to: email, ...MAILS.verify(firstName), link: `${origin}/api/auth/verify?token=${t}`, kind: "verify" });
    return json(done);
  }

  if (action === "verify" && method === "GET") {
    const t = await useToken(db, url.searchParams.get("token"), "verify");
    if (!t) return redirect("/?msg=verify-failed");
    await db.prepare("UPDATE users SET verified_at = COALESCE(verified_at, datetime('now')) WHERE id = ?1").bind(t.user_id).run();
    return redirect("/?msg=verified");
  }

  if (action === "resend" && method === "POST") {
    const b = (await readBody(request)) || {};
    const u = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(normEmail(b.email)).first();
    if (u && !u.verified_at && !u.disabled) {
      const t = await createToken(db, u.id, "verify");
      await sendMail(db, env, { userId: u.id, to: u.email, ...MAILS.verify(hi(u)), link: `${origin}/api/auth/verify?token=${t}`, kind: "verify" });
    }
    return json({ ok: true, message: "Om adressen finns och inte är bekräftad har vi skickat ett nytt mejl." });
  }

  if (action === "login" && method === "POST") {
    const b = (await readBody(request)) || {};
    const r = await login(db, b.email, b.password);
    if (r.error) return bad(r.error, 401, r.unverified ? { unverified: true } : {});
    const token = await createSession(db, r.user.id, request);
    return json({ ok: true, user: userOut(r.user) }, 200, { "set-cookie": sessionCookie(token) });
  }

  if (action === "logout" && method === "POST") {
    await endSession(db, request);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  if (action === "forgot" && method === "POST") {
    const b = (await readBody(request)) || {};
    const u = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(normEmail(b.email)).first();
    if (u && !u.disabled) {
      const t = await createToken(db, u.id, "reset");
      await sendMail(db, env, { userId: u.id, to: u.email, ...MAILS.reset(hi(u)), link: `${origin}/?reset=${t}`, kind: "reset" });
    }
    return json({ ok: true, message: "Om adressen finns har vi skickat en länk för att välja nytt lösenord. Den gäller en timme." });
  }

  if (action === "reset" && method === "POST") {
    const b = (await readBody(request)) || {};
    const tok = String(b.token || "").slice(0, 100);
    // Check the new password before using up the token.
    const u = tok && (await db.prepare(
      `SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?1 AND t.kind = 'reset' AND t.used_at IS NULL AND t.expires_at > datetime('now')`,
    ).bind(await sha256(tok)).first());
    if (!u) return bad("Länken är ogiltig eller har gått ut. Begär en ny.");
    const prob = passwordProblem(b.password, { email: u.email, firstName: u.first_name, lastName: u.last_name });
    if (prob) return bad(prob);
    if (!(await useToken(db, tok, "reset"))) return bad("Länken är ogiltig eller har gått ut. Begär en ny.");
    await db.batch([
      db.prepare(`UPDATE users SET pw_hash = ?2, pw_changed_at = datetime('now'), failed_logins = 0, locked_until = NULL,
                  verified_at = COALESCE(verified_at, datetime('now')) WHERE id = ?1`).bind(u.id, await hashPassword(b.password)),
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1").bind(u.id),
      db.prepare("DELETE FROM tokens WHERE user_id = ?1 AND kind = 'pwchange'").bind(u.id),
    ]);
    await sendMail(db, env, { userId: u.id, to: u.email, ...MAILS.changed(hi(u)), kind: "changed" });
    return json({ ok: true, message: "Lösenordet är bytt. Logga in med det nya." });
  }

  if (action === "confirm-password" && method === "GET") {
    const t = await useToken(db, url.searchParams.get("token"), "pwchange");
    if (!t) return redirect("/?msg=pw-failed");
    const u = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(t.user_id).first();
    await db.batch([
      db.prepare("UPDATE users SET pw_hash = ?2, pw_changed_at = datetime('now') WHERE id = ?1").bind(t.user_id, t.payload),
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1").bind(t.user_id),
    ]);
    await sendMail(db, env, { userId: u.id, to: u.email, ...MAILS.changed(hi(u)), kind: "changed" });
    return redirect("/?msg=pw-changed", { "set-cookie": clearCookie() });
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
    return json({ ok: true, user: userOut({ ...user, first_name: f, last_name: l }) });
  }
  if (action === "password" && request.method === "POST") {
    const b = (await readBody(request)) || {};
    if (!(await verifyPassword(String(b.current || ""), user.pw_hash))) return bad("Nuvarande lösenord stämmer inte.");
    const prob = passwordProblem(b.password, { email: user.email, firstName: user.first_name, lastName: user.last_name });
    if (prob) return bad(prob);
    if (await verifyPassword(String(b.password), user.pw_hash)) return bad("Det nya lösenordet är samma som det gamla.");
    // The new password only takes effect after it is confirmed from the email inbox.
    const t = await createToken(db, user.id, "pwchange", await hashPassword(b.password));
    await sendMail(db, env, { userId: user.id, to: user.email, ...MAILS.confirmChange(hi(user)), link: `${url.origin}/api/auth/confirm-password?token=${t}`, kind: "pwchange" });
    return json({ ok: true, message: `Vi har skickat en bekräftelselänk till ${user.email}. Det nya lösenordet gäller först när du öppnat länken (inom en timme). Därefter loggas alla enheter ut.` });
  }
  if (action === "logout-all" && request.method === "POST") {
    await db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1").bind(user.id).run();
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }
  return bad("Hittades inte.", 404);
}

// ---- admin ----
async function handleAdmin(request, env, url, db, user, parts) {
  if (user.role !== "admin") return bad("Endast för administratörer.", 403);
  const [what, id, sub] = parts;
  if (what === "users" && !id && request.method === "GET") {
    const r = await db.prepare(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.verified_at, u.disabled, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
              (SELECT MAX(date) FROM sessions s WHERE s.user_id = u.id) AS last_session
       FROM users u ORDER BY u.created_at`,
    ).all();
    return json({ users: r.results, me: user.id });
  }
  if (what === "users" && id && request.method === "POST") {
    const target = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first();
    if (!target) return bad("Användaren finns inte.", 404);
    const b = (await readBody(request)) || {};
    if (sub === "verify") {
      await db.prepare("UPDATE users SET verified_at = COALESCE(verified_at, datetime('now')) WHERE id = ?1").bind(id).run();
      return json({ ok: true });
    }
    if (sub === "disable") {
      if (id === user.id) return bad("Du kan inte stänga av ditt eget konto.");
      const on = b.disabled ? 1 : 0;
      await db.batch([
        db.prepare("UPDATE users SET disabled = ?2 WHERE id = ?1").bind(id, on),
        ...(on ? [db.prepare("DELETE FROM auth_sessions WHERE user_id = ?1").bind(id)] : []),
      ]);
      return json({ ok: true });
    }
    if (sub === "role") {
      if (id === user.id) return bad("Du kan inte ändra din egen roll.");
      await db.prepare("UPDATE users SET role = ?2 WHERE id = ?1").bind(id, b.role === "admin" ? "admin" : "user").run();
      return json({ ok: true });
    }
  }
  if (what === "outbox" && request.method === "GET") {
    const r = await db.prepare(
      `SELECT id, to_email, subject, link, kind, created_at, sent_at, error FROM outbox ORDER BY id DESC LIMIT 100`,
    ).all();
    return json({ mails: r.results, mailConfigured: !!(env.BREVO_API_KEY && env.MAIL_FROM) });
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

  if (resource === "me" && method === "GET") return json({ user: userOut(user) });
  if (resource === "account") return handleAccount(request, env, url, db, user, key);
  if (resource === "admin") return handleAdmin(request, env, url, db, user, parts.slice(1));

  if (resource === "data" && method === "GET") return json(await getData(db, user.id));

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
