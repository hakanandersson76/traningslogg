// AI help (Claude via the Anthropic API) with a cost log and spending caps.
// The rule-based app works without it: when there is no API key, or a cap is
// reached, the AI endpoints answer with a message and nothing else changes.
//
// Config (wrangler.jsonc vars; the key itself is a Worker secret):
//   ANTHROPIC_API_KEY  secret, set in the Cloudflare dashboard
//   AI_MODEL           default claude-haiku-5-5
//   AI_PRICE_IN_USD    USD per million input tokens (default 0.10)
//   AI_PRICE_OUT_USD   USD per million output tokens (default 0.50)
//   USD_SEK            exchange rate used for the cost log (default 11, on the safe side)
//   AI_USER_CAP_SEK    per user and calendar month (default 20)
//   AI_TOTAL_CAP_SEK   all users together per calendar month (default 100)

const MUSCLE_IDS = ["bröst", "rygg", "trapets", "axlar", "bakaxlar", "biceps", "triceps", "underarmar", "framlår", "baklår", "säte", "höft", "vader", "bål"];
const MUSCLE_HELP = `bröst = chest; rygg = lats and upper back; trapets = traps; axlar = front/side delts;
bakaxlar = rear delts and rotator cuff; biceps; triceps; underarmar = forearms; framlår = quads;
baklår = hamstrings; säte = glutes; höft = hip abductors/adductors; vader = calves; bål = core/abs`;

export const aiConfig = (env) => ({
  key: env.ANTHROPIC_API_KEY || "",
  model: env.AI_MODEL || "claude-haiku-5-5",
  priceIn: Number(env.AI_PRICE_IN_USD ?? 0.1),
  priceOut: Number(env.AI_PRICE_OUT_USD ?? 0.5),
  usdSek: Number(env.USD_SEK ?? 11),
  userCap: Number(env.AI_USER_CAP_SEK ?? 20),
  totalCap: Number(env.AI_TOTAL_CAP_SEK ?? 100),
});
export const aiEnabled = (env) => !!env.ANTHROPIC_API_KEY;

const month = () => new Date().toISOString().slice(0, 7); // UTC calendar month, "2026-11"
const norm = (n) => String(n).toLowerCase().replace(/\s+/g, " ").trim();

export async function spent(db, userId) {
  const m = month() + "%";
  const [u, t] = await db.batch([
    db.prepare("SELECT COALESCE(SUM(cost_sek), 0) AS s FROM ai_usage WHERE user_id = ?1 AND at LIKE ?2").bind(userId, m),
    db.prepare("SELECT COALESCE(SUM(cost_sek), 0) AS s FROM ai_usage WHERE at LIKE ?1").bind(m),
  ]);
  return { user: u.results[0].s, total: t.results[0].s };
}

// For the admin page: this month per user and in total, with the caps.
export async function usageReport(db, env) {
  const c = aiConfig(env);
  const m = month();
  const r = await db.prepare(
    `SELECT u.id, u.first_name, u.last_name, COALESCE(SUM(a.cost_sek), 0) AS sek, COUNT(a.id) AS calls
     FROM ai_usage a JOIN users u ON u.id = a.user_id WHERE a.at LIKE ?1 GROUP BY u.id ORDER BY sek DESC`,
  ).bind(m + "%").all();
  const total = r.results.reduce((a, x) => a + x.sek, 0);
  return { enabled: aiEnabled(env), month: m, model: c.model, total, totalCap: c.totalCap, userCap: c.userCap, users: r.results };
}

// One call to the Messages API. Logs the cost; throws {status, message} on errors.
async function callClaude(db, env, userId, feature, system, prompt, maxTokens = 1200) {
  const c = aiConfig(env);
  const s = await spent(db, userId);
  if (s.total >= c.totalCap) throw { status: 429, message: "AI-taket för hela appen är nått den här månaden." };
  if (s.user >= c.userCap) throw { status: 429, message: "Du har nått ditt AI-tak för den här månaden." };
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": c.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: c.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
    });
  } catch {
    throw { status: 502, message: "Når inte AI-tjänsten just nu." };
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw { status: 502, message: "AI-tjänsten svarade med ett fel." , detail: j?.error?.message };
  const inTok = j.usage?.input_tokens || 0, outTok = j.usage?.output_tokens || 0;
  const sek = ((inTok * c.priceIn + outTok * c.priceOut) / 1e6) * c.usdSek;
  await db.prepare("INSERT INTO ai_usage (user_id, at, feature, model, in_tok, out_tok, cost_sek) VALUES (?1, datetime('now'), ?2, ?3, ?4, ?5, ?6)")
    .bind(userId, feature, c.model, inTok, outTok, sek).run();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

// Suggest muscles for exercise names. Answers are cached for all users, so each
// name is only asked about once. Returns { name: {p, s, c, from: "ai"|"cache"} }.
export async function suggestMuscles(db, env, userId, names) {
  const list = [...new Set((names || []).map((n) => String(n).trim().slice(0, 120)).filter(Boolean))].slice(0, 25);
  const out = {};
  const missing = [];
  for (const n of list) {
    const r = await db.prepare("SELECT p, s, c FROM ai_muscle_cache WHERE name = ?1").bind(norm(n)).first();
    if (r) out[n] = { p: r.p.split(",").filter(Boolean), s: r.s.split(",").filter(Boolean), c: !!r.c, from: "cache" };
    else missing.push(n);
  }
  if (!missing.length) return out;
  const system = `You classify gym exercises by the muscles they train. Names are free text from a training log, often Swedish, sometimes with equipment in brackets.
Use only these muscle ids: ${MUSCLE_IDS.join(", ")}.
(${MUSCLE_HELP})
For each exercise give "p" (1–2 primary muscles), "s" (0–3 secondary muscles, not repeating p) and "c" (true if a multi-joint compound lift).
If a name is not an exercise or you cannot tell, give "p": [].
Answer with JSON only: {"results":[{"name":"<exactly as given>","p":[],"s":[],"c":false}]}`;
  const text = await callClaude(db, env, userId, "muscles", system, missing.map((n) => "- " + n).join("\n"));
  let parsed = null;
  try { parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { /* handled below */ }
  const ok = (a) => (Array.isArray(a) ? [...new Set(a.filter((m) => MUSCLE_IDS.includes(m)))] : []);
  for (const r of parsed?.results || []) {
    const name = missing.find((n) => norm(n) === norm(r.name));
    if (!name) continue;
    const p = ok(r.p).slice(0, 2), s = ok(r.s).filter((m) => !p.includes(m)).slice(0, 3), c = !!r.c;
    if (!p.length) continue;
    out[name] = { p, s, c, from: "ai" };
    await db.prepare("INSERT OR REPLACE INTO ai_muscle_cache (name, p, s, c, at) VALUES (?1, ?2, ?3, ?4, datetime('now'))")
      .bind(norm(name), p.join(","), s.join(","), c ? 1 : 0).run();
  }
  return out;
}

// ---- weekly insight ----
// One insight per user and week. Opening the app after 7 days makes a new one
// (automatic); the user can ask for a new one at most once a day (manual), which
// starts a new 7-day cycle. The AI gets the coach's own numbers so it comments on
// them instead of inventing its own; weights, reps and sets stay rule-based.
// It may propose up to 2 focus muscles that the user can switch on in the coach.
export const INSIGHT_DAYS = 7;
export const MANUAL_COOLDOWN_H = 24;
const FOCUS_OK = ["bröst", "rygg", "axlar", "bakaxlar", "biceps", "triceps", "framlår", "baklår", "säte", "vader", "höft", "bål"];

export async function latestInsight(db, userId) {
  const r = await db.prepare("SELECT * FROM ai_insights WHERE user_id = ?1 ORDER BY id DESC LIMIT 1").bind(userId).first();
  if (!r) return null;
  const created = r.created_at.replace(" ", "T") + "Z";
  return {
    id: r.id, createdAt: created, trigger: r.trigger, lang: r.lang, model: r.model, focusOn: !!r.focus_on,
    ...JSON.parse(r.body),
    nextAt: new Date(Date.parse(created) + INSIGHT_DAYS * 864e5).toISOString(),
    manualAt: new Date(Date.parse(created) + MANUAL_COOLDOWN_H * 36e5).toISOString(),
  };
}
export const insightDue = (ins) => !ins || Date.now() >= Date.parse(ins.nextAt);

export async function generateInsight(db, env, userId, facts, lang, trigger) {
  const language = lang === "en" ? "English" : "Swedish (svenska, natural and plain)";
  const system = `You are a knowledgeable, friendly personal trainer writing a short weekly check-in for one person who trains in a gym.
Base everything only on the data you get. Never invent numbers, exercises or events. Use the exercise names as written.
The person's app has a rule-based coach that sets weights, reps, sets and session type; do not give other numbers for those, and do not contradict it. Comment on patterns, consistency, balance between muscles, what went well and what to watch, and give practical advice for the coming week.
No medical advice. If notes mention pain or injury, advise easing off and seeing a professional if it persists.
Write in ${language}. Be concrete and brief; address the person as "du"/"you".
Answer with JSON only, in this shape:
{"title": "<max 8 words>", "summary": "<2–3 sentences>", "good": ["<max 3 short points>"], "watch": ["<max 3 short points>"], "advice": ["<max 3 short, concrete tips for this week>"], "focus": ["<0–2 muscle ids that most need extra work, from: ${FOCUS_OK.join(", ")}>"], "focus_why": "<one sentence, empty if no focus>"}`;
  const text = await callClaude(db, env, userId, "insight", system, "Training data (JSON):\n" + JSON.stringify(facts), 1500);
  let j;
  try { j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { throw { status: 502, message: "AI-svaret gick inte att läsa. Försök igen senare." }; }
  const str = (s, n) => String(s || "").trim().slice(0, n);
  const arr = (a) => (Array.isArray(a) ? a.map((x) => str(x, 300)).filter(Boolean).slice(0, 3) : []);
  const body = {
    title: str(j.title, 80), summary: str(j.summary, 700), good: arr(j.good), watch: arr(j.watch), advice: arr(j.advice),
    focus: (Array.isArray(j.focus) ? [...new Set(j.focus.filter((m) => FOCUS_OK.includes(m)))] : []).slice(0, 2),
    focusWhy: str(j.focus_why, 300),
  };
  if (!body.summary) throw { status: 502, message: "AI-svaret gick inte att läsa. Försök igen senare." };
  await db.prepare("INSERT INTO ai_insights (user_id, created_at, trigger, lang, model, body, focus_on) VALUES (?1, datetime('now'), ?2, ?3, ?4, ?5, 0)")
    .bind(userId, trigger, lang === "en" ? "en" : "sv", aiConfig(env).model, JSON.stringify(body)).run();
  return latestInsight(db, userId);
}
