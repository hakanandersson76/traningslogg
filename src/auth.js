// Accounts, login sessions and one-time tokens.
// Passwords: PBKDF2-SHA256, 100 000 iterations (the Workers maximum), 16-byte random salt.
// Login: random 256-bit token in an HttpOnly, Secure, SameSite=Lax cookie; only its SHA-256 is stored.

const enc = new TextEncoder();
const ITER = 100000;
export const SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iter = ITER) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2" || !iter || !salt || !hash) return false;
  const again = (await hashPassword(password, fromB64(salt), +iter)).split("$")[3];
  return timingSafeEqual(again, hash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Strong password: at least 12 characters, at least 3 of lower/upper/digit/symbol,
// not containing the email name or the person's names, not a common password.
const COMMON = ["password", "lösenord", "losenord", "qwerty", "123456", "abc123", "letmein", "welcome", "admin", "träning", "traning", "iloveyou", "sommar", "vinter"];
export function passwordProblem(pw, { email = "", firstName = "", lastName = "" } = {}) {
  pw = String(pw || "");
  if (pw.length < 12) return "Lösenordet måste ha minst 12 tecken.";
  if (pw.length > 200) return "Lösenordet är för långt.";
  const classes = [/[a-zåäö]/, /[A-ZÅÄÖ]/, /\d/, /[^A-Za-zÅÄÖåäö\d]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return "Blanda minst tre av: små bokstäver, stora bokstäver, siffror och specialtecken.";
  const low = pw.toLowerCase();
  const parts = [email.split("@")[0], firstName, lastName].map((x) => String(x).toLowerCase()).filter((x) => x.length >= 3);
  if (parts.some((p) => low.includes(p))) return "Lösenordet får inte innehålla ditt namn eller din e-post.";
  if (COMMON.some((c) => low.includes(c))) return "Lösenordet innehåller ett vanligt ord. Välj något svårare att gissa.";
  if (/(.)\1{3,}/.test(pw)) return "Undvik många upprepade tecken.";
  return null;
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
export const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 60);

export function userOut(u) {
  return { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, role: u.role, status: u.status, goal: u.goal || "muscle", lang: u.lang || "", sessionMin: u.session_min || 40 };
}

// ---- login sessions ----
const cookieName = "sid";
export function readCookie(request, name = cookieName) {
  const c = request.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
export const sessionCookie = (token) => `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function createSession(db, userId, request) {
  const token = randomToken();
  await db
    .prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, user_agent) VALUES (?1, ?2, datetime('now', ?3), ?4)`)
    .bind(await sha256(token), userId, `+${SESSION_DAYS} days`, (request.headers.get("user-agent") || "").slice(0, 200))
    .run();
  return token;
}

export async function currentUser(db, request) {
  const token = readCookie(request);
  if (!token || token.length > 100) return null;
  const u = await db
    .prepare(
      `SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.expires_at > datetime('now') AND u.status = 'active'`,
    )
    .bind(await sha256(token))
    .first();
  return u || null;
}

export async function endSession(db, request) {
  const token = readCookie(request);
  if (token) await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?1").bind(await sha256(token)).run();
}

// ---- login with lockout ----
export async function login(db, email, password) {
  const u = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(normEmail(email)).first();
  // Same work whether or not the user exists, so timing does not reveal accounts.
  if (!u) {
    await hashPassword(String(password || "x"));
    return { error: "Fel e-post eller lösenord." };
  }
  if (u.locked_until && u.locked_until > new Date().toISOString().replace("T", " ").slice(0, 19)) {
    return { error: `För många felaktiga försök. Försök igen om en stund (spärrat ${LOCK_MINUTES} min).` };
  }
  const ok = await verifyPassword(String(password || ""), u.pw_hash);
  if (!ok) {
    const n = u.failed_logins + 1;
    await db
      .prepare(`UPDATE users SET failed_logins = ?2, locked_until = CASE WHEN ?3 = 1 THEN datetime('now', ?4) ELSE NULL END WHERE id = ?1`)
      .bind(u.id, n >= MAX_FAILED ? 0 : n, n >= MAX_FAILED ? 1 : 0, `+${LOCK_MINUTES} minutes`)
      .run();
    return { error: "Fel e-post eller lösenord." };
  }
  // Account status is only revealed after a correct password.
  if (u.status === "pending") return { error: "Ditt konto väntar på att en administratör godkänner det. Försök igen senare.", status: "pending" };
  if (u.status === "frozen") return { error: "Kontot är fryst. Kontakta administratören.", status: "frozen" };
  if (u.status === "banned") return { error: "Kontot är spärrat.", status: "banned" };
  if (u.status !== "active") return { error: "Kontot är inte aktivt." };
  await db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?1").bind(u.id).run();
  return { user: u };
}

// ---- one-time tokens (password reset links created by an admin) ----
const TOKEN_HOURS = { reset: 24 };
export async function createToken(db, userId, kind, payload = null) {
  const token = randomToken();
  await db.batch([
    // Only the newest token of each kind is valid.
    db.prepare("DELETE FROM tokens WHERE user_id = ?1 AND kind = ?2").bind(userId, kind),
    db
      .prepare(`INSERT INTO tokens (token_hash, user_id, kind, payload, expires_at) VALUES (?1, ?2, ?3, ?4, datetime('now', ?5))`)
      .bind(await sha256(token), userId, kind, payload, `+${TOKEN_HOURS[kind]} hours`),
  ]);
  return token;
}

export async function useToken(db, token, kind) {
  if (!token || token.length > 100) return null;
  const h = await sha256(token);
  const t = await db
    .prepare(`SELECT * FROM tokens WHERE token_hash = ?1 AND kind = ?2 AND used_at IS NULL AND expires_at > datetime('now')`)
    .bind(h, kind)
    .first();
  if (!t) return null;
  await db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE token_hash = ?1").bind(h).run();
  return t;
}

export async function currentTokenHash(request) {
  const token = readCookie(request);
  return token ? sha256(token) : null;
}
