// Rule-based personal trainer. Pure functions over the session history, so
// they run in the browser and in tests. Swedish text is produced for the UI.
import { parseSets } from "./parse.js";

// ---- dates ----
const pd = (s) => { const [a, b, c] = s.split("-").map(Number); return Date.UTC(a, b - 1, c); };
export const daysBetween = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);
const addDays = (s, n) => new Date(pd(s) + n * 864e5).toISOString().slice(0, 10);
const mondayOf = (s) => addDays(s, -((new Date(pd(s)).getUTCDay() + 6) % 7));

// ---- muscle groups ----
// Order matters: legs before arms so "Leg curl" and "Jefferson curls" are legs.
const GROUPS = [
  ["core", /mage|plank|maghjul|\bab(s)?\b|crunch/],
  ["ben", /squat|knäböj|\bleg\b|hamstring|vad|calf|glute|\bhip\b|rdl|jefferson|utfall|lunge|marklyft|deadlift|benpress/],
  ["bröst", /bänk|bröst|chest|dips|incline|flyes?\b|push-?up/],
  ["rygg", /rodd|pulldown|chin|pull-?up|scapular|\brow\b|latsdrag/],
  ["axlar", /axel|lateral|rear delt|face ?pull|shrug|rotator/],
  ["armar", /curl|triceps|preacher|underarm/],
];
export const GROUP_NAMES = { bröst: "Bröst", rygg: "Rygg", axlar: "Axlar", armar: "Armar", ben: "Ben", core: "Bål" };
export function groupOf(name) {
  const n = String(name).toLowerCase();
  for (const [g, re] of GROUPS) if (re.test(n)) return g;
  return null;
}
const UPPER = new Set(["bröst", "rygg", "axlar", "armar"]);

// Session type; untyped sessions get one inferred from their exercises.
export function effectiveTag(s) {
  if (s.tag) return s.tag;
  let up = 0, lo = 0;
  for (const e of s.ex || []) { const g = groupOf(e.n); if (g === "ben") lo++; else if (UPPER.has(g)) up++; }
  if (!up && !lo) return "";
  if (lo === 0) return "ÖK";
  if (up === 0) return "NK";
  return up >= 2 && lo >= 2 ? "HK" : up > lo ? "ÖK" : "NK";
}
const regions = (t) => (t === "ÖK" ? ["upper"] : t === "NK" ? ["lower"] : t === "HK" ? ["upper", "lower"] : []);

// ---- per-exercise history ----
const topSet = (sets) => {
  const ws = sets.filter((s) => s.w != null && s.r);
  return ws.length ? ws.reduce((a, b) => (b.w > a.w || (b.w === a.w && b.r > a.r) ? b : a)) : null;
};
export const e1rm = (s) => (s && s.w > 0 ? s.w * (1 + Math.min(s.r, 12) / 30) : null);

export function history(sessions) {
  const m = new Map();
  for (const s of [...sessions].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    (s.ex || []).forEach((e, pos) => {
      if (!e.n) return;
      const sets = parseSets(e.s);
      if (!sets.length) return;
      const top = topSet(sets);
      const reps = sets.filter((x) => x.r && x.w == null).map((x) => x.r);
      const secs = sets.filter((x) => x.t).map((x) => x.t);
      if (!m.has(e.n)) m.set(e.n, []);
      m.get(e.n).push({ date: s.date, pos, s: e.s, sets, top, e1: e1rm(top), bw: reps.length ? Math.max(...reps) : 0, sec: secs.length ? Math.max(...secs) : 0 });
    });
  }
  return m;
}

const fmt = (w) => String(Math.round(w * 100) / 100).replace(".", ",");
const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
const roundTo = (w, st) => Math.round(w / st) * st;
const stepFor = (w) => (w >= 100 ? 5 : w >= 10 ? 2.5 : 1);
const pct = (x) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(Math.round(x * 100))} %`;

// Trend of one exercise: compare best e1RM of the last 3 sessions with the 3 before.
export function trendOf(entries, today) {
  const w = entries.filter((e) => e.e1);
  if (w.length < 4) return null;
  const last = w.slice(-3), prev = w.slice(-6, -3).length ? w.slice(-6, -3) : w.slice(0, -3);
  const best = (a) => Math.max(...a.map((e) => e.e1));
  const r = best(last), p = best(prev);
  const delta = (r - p) / p;
  const tops = w.slice(-4).map((e) => e.e1);
  const flat = Math.max(...tops) / Math.min(...tops) < 1.025;
  const status = delta >= 0.025 ? "up" : delta <= -0.05 ? "down" : "flat";
  return { status: flat && status !== "down" ? "flat" : status, delta, recent: r, prev: p, lastDate: w.at(-1).date, since: daysBetween(w.at(-1).date, today), count: w.length, lastTop: w.at(-1).top };
}

// Target for the next time this exercise is done, with the reason in Swedish.
export function nextTarget(entries, today) {
  const last = entries?.at(-1);
  if (!last) return { target: "", why: "Ny övning: hitta en vikt du klarar 8–10 gånger.", kind: "new" };
  const gap = daysBetween(last.date, today);
  const t = last.top;
  if (t && t.w > 0) {
    if (gap > 28) {
      const w = roundTo(t.w * 0.9, stepFor(t.w));
      return { target: `${t.r}@${fmt(w)}`, why: `${gap} dagar sedan sist. Börja på ~90 % och bygg upp igen.`, kind: "comeback" };
    }
    const tr = trendOf(entries, today);
    const sameTop = entries.slice(-3).filter((e) => e.top && e.top.w === t.w && e.top.r <= t.r).length === 3;
    if (tr && tr.status === "flat" && sameTop && entries.length >= 4) {
      const w = roundTo(t.w * 0.9, stepFor(t.w));
      return { target: `3×${Math.min(t.r + 2, 10)}@${fmt(w)}`, why: `Stått still på ${t.r}@${fmt(t.w)} tre pass. Kör fler reps på lägre vikt en gång, eller byt variant.`, kind: "plateau" };
    }
    if (t.r >= 10) {
      const w = t.w + stepFor(t.w);
      return { target: `8@${fmt(w)}`, why: `Klarade ${t.r} reps förra gången. Dags att öka vikten.`, kind: "weight" };
    }
    const lbl = t.wl ? t.wl.replace(".", ",") : fmt(t.w);
    return { target: `${t.r + 1}@${lbl}`, why: `En rep till än förra gången (${t.r}@${lbl}). Vid 10 reps ökar du vikten.`, kind: "reps" };
  }
  if (last.sec) return { target: mmss(last.sec + 15), why: `Förra gången ${mmss(last.sec)}. Sikta på 15 s längre.`, kind: "time" };
  if (last.bw) return { target: `${last.bw + 1}`, why: `Förra gången ${last.bw} reps. En till.`, kind: "reps" };
  return { target: "", why: "", kind: "none" };
}

// Which session type is due, and why.
export function nextType(sessions, today) {
  const done = [...sessions].filter((s) => s.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!done.length) return { tag: "HK", date: today, why: "Inga pass än. Börja med ett helkroppspass.", rest: false };
  const lastFor = (r) => done.find((s) => regions(effectiveTag(s)).includes(r))?.date;
  const lu = lastFor("upper"), ll = lastFor("lower");
  const gu = lu ? daysBetween(lu, today) : 99, gl = ll ? daysBetween(ll, today) : 99;
  const n7 = done.filter((s) => daysBetween(s.date, today) < 7).length;
  const doneToday = done[0].date === today;
  const from8 = done.filter((s) => daysBetween(s.date, today) < 56);
  const hkShare = from8.length ? from8.filter((s) => effectiveTag(s) === "HK").length / from8.length : 0;
  // Upper body is trained more often than legs in this history: aim for ~every 3rd day vs ~every 6th.
  const ru = gu / 3, rl = gl / 6;
  let tag, why;
  const dTxt = (g) => (g >= 99 ? "aldrig" : g === 0 ? "idag" : g === 1 ? "i går" : `för ${g} dagar sedan`);
  if (ru >= 1 && rl >= 1) {
    tag = hkShare >= 0.2 || Math.abs(ru - rl) < 0.5 ? "HK" : rl > ru ? "NK" : "ÖK";
    why = `Både överkropp (${dTxt(gu)}) och ben (${dTxt(gl)}) är redo.`;
  } else if (rl >= ru) {
    tag = "NK"; why = `Benen tränades senast ${dTxt(gl)}, överkroppen ${dTxt(gu)}.`;
  } else {
    tag = "ÖK"; why = `Överkroppen tränades senast ${dTxt(gu)}, benen ${dTxt(gl)}.`;
  }
  const rest = doneToday || n7 >= 5 || (ru < 0.67 && rl < 0.67);
  const date = doneToday ? addDays(today, 1) : today;
  let restWhy = "";
  if (doneToday) restWhy = "Du har redan tränat idag. Förslaget gäller i morgon.";
  else if (n7 >= 5) restWhy = `${n7} pass senaste 7 dagarna. En vilodag gör mer nytta än ett pass till.`;
  else if (rest) restWhy = "Allt är nyligen tränat. Vila idag eller kör ett lätt pass.";
  return { tag, date, why, rest, restWhy, gu, gl, n7 };
}

// A concrete session of the given type: the exercises he usually does, with targets.
export function proposeSession(sessions, tag, date) {
  const hist = history(sessions);
  const same = [...sessions].filter((s) => effectiveTag(s) === tag && s.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
  const recent = same.filter((s) => daysBetween(s.date, date) <= 60);
  const pool = (recent.length >= 2 ? recent : same).slice(0, 4);
  if (!pool.length) return [];
  const score = new Map();
  pool.forEach((s, i) => (s.ex || []).forEach((e, pos) => {
    if (!e.n || !parseSets(e.s).length) return;
    const c = score.get(e.n) || { n: e.n, w: 0, pos: 0, k: 0 };
    c.w += 4 - i; c.pos += pos; c.k++; score.set(e.n, c);
  }));
  const sizes = pool.map((s) => (s.ex || []).length).sort((a, b) => a - b);
  const size = Math.max(3, Math.min(8, sizes[Math.floor(sizes.length / 2)]));
  const chosen = [...score.values()].sort((a, b) => b.w - a.w).slice(0, size).sort((a, b) => a.pos / a.k - b.pos / b.k);
  return chosen.map((c) => ({ n: c.n, ...nextTarget(hist.get(c.n), date), last: hist.get(c.n)?.at(-1) }));
}

// Weekly hard sets per muscle group over the last 4 weeks. A set counts as hard
// when it is at least 70 % of that exercise's top weight that day (warm-ups excluded).
export function weeklyVolume(sessions, today, weeks = 4) {
  const vol = Object.fromEntries(Object.keys(GROUP_NAMES).map((g) => [g, 0]));
  for (const s of sessions) {
    const d = daysBetween(s.date, today);
    if (d < 0 || d >= weeks * 7) continue;
    for (const e of s.ex || []) {
      const g = groupOf(e.n);
      if (!g) continue;
      const sets = parseSets(e.s);
      const top = Math.max(0, ...sets.filter((x) => x.w > 0).map((x) => x.w));
      vol[g] += sets.filter((x) => (x.w > 0 ? x.w >= top * 0.7 : true)).length;
    }
  }
  return Object.entries(vol).map(([g, n]) => ({ g, name: GROUP_NAMES[g], perWeek: n / weeks }));
}

// Sessions per ISO week, split by type, for the last n weeks.
export function weeklyCounts(sessions, today, n = 12) {
  const start = addDays(mondayOf(today), -7 * (n - 1));
  const weeks = Array.from({ length: n }, (_, i) => ({ start: addDays(start, 7 * i), ÖK: 0, NK: 0, HK: 0, "": 0, total: 0 }));
  for (const s of sessions) {
    if (s.date < start || s.date > today) continue;
    const w = weeks[Math.floor(daysBetween(start, s.date) / 7)];
    w[effectiveTag(s)]++; w.total++;
  }
  return weeks;
}

// Everything the coach view shows.
export function coachReport(sessions, today) {
  const hist = history(sessions);
  const next = nextType(sessions, today);
  const plan = proposeSession(sessions, next.tag, next.date);
  const trends = [];
  for (const [n, entries] of hist) {
    const t = trendOf(entries, today);
    if (t && t.since <= 60) trends.push({ n, ...t });
  }
  const up = trends.filter((t) => t.status === "up").sort((a, b) => b.delta - a.delta);
  const flat = trends.filter((t) => t.status === "flat").sort((a, b) => b.count - a.count);
  const down = trends.filter((t) => t.status === "down").sort((a, b) => a.delta - b.delta);
  const prs = [];
  for (const [n, entries] of hist) {
    const w = entries.filter((e) => e.e1);
    const before = w.filter((e) => daysBetween(e.date, today) > 30);
    const recent = w.filter((e) => daysBetween(e.date, today) <= 30);
    if (before.length >= 3 && recent.length) {
      const b = recent.reduce((a, e) => (e.e1 > a.e1 ? e : a));
      const old = Math.max(...before.map((e) => e.e1));
      if (b.e1 > old * 1.005) prs.push({ n, date: b.date, top: b.top, gain: b.e1 / old - 1 });
    }
  }
  prs.sort((a, b) => (a.date < b.date ? 1 : -1));
  const neglected = [...hist].filter(([, e]) => e.length >= 5 && daysBetween(e.at(-1).date, today) > 45)
    .map(([n, e]) => ({ n, count: e.length, since: daysBetween(e.at(-1).date, today), last: e.at(-1) }))
    .sort((a, b) => b.count - a.count).slice(0, 6);
  const weeks = weeklyCounts(sessions, today, 12);
  const last4 = weeks.slice(-4).reduce((a, w) => a + w.total, 0) / 4;
  const prev4 = weeks.slice(-8, -4).reduce((a, w) => a + w.total, 0) / 4;
  const vol = weeklyVolume(sessions, today, 4);
  const s8 = sessions.filter((s) => s.date <= today && daysBetween(s.date, today) < 56);
  const upper = s8.filter((s) => regions(effectiveTag(s)).includes("upper")).length;
  const lower = s8.filter((s) => regions(effectiveTag(s)).includes("lower")).length;
  // Short list of the most useful observations, most important first.
  const notes = [];
  if (last4 < prev4 - 0.4) notes.push({ k: "warn", t: `Färre pass: ${fmt(Math.round(last4 * 10) / 10)} per vecka senaste 4 veckorna mot ${fmt(Math.round(prev4 * 10) / 10)} veckorna innan.` });
  else if (last4 > prev4 + 0.4) notes.push({ k: "good", t: `Fler pass: ${fmt(Math.round(last4 * 10) / 10)} per vecka senaste 4 veckorna mot ${fmt(Math.round(prev4 * 10) / 10)} innan.` });
  if (upper + lower >= 4 && lower / (upper + lower) < 0.3) notes.push({ k: "warn", t: `Benen får lite: ${lower} benpass mot ${upper} överkroppspass senaste 8 veckorna. Sikta på minst ett benpass i veckan.` });
  const low = vol.filter((v) => v.g !== "core" && v.perWeek < 6).map((v) => v.name.toLowerCase());
  if (low.length) notes.push({ k: "warn", t: `Låg volym för ${low.join(", ")}: under 6 tunga set i veckan. 10–20 set per muskelgrupp och vecka brukar ge bäst utveckling.` });
  if (down.length) notes.push({ k: "warn", t: `Tappat i ${down.slice(0, 3).map((d) => d.n).join(", ")}. Kolla sömn och återhämtning, eller kör ett par pass lite lättare.` });
  if (flat.length >= 3) notes.push({ k: "info", t: `${flat.length} övningar står still. Variera reps (t.ex. 3×12 lättare eller 5×5 tyngre) under några veckor.` });
  if (prs.length) notes.push({ k: "good", t: `Nya rekord senaste månaden: ${prs.slice(0, 3).map((p) => p.n).join(", ")}.` });
  return { next, plan, up, flat, down, prs, neglected, weeks, last4, prev4, vol, upper, lower, notes };
}
