// Rule-based personal trainer. Pure functions over the session history, so
// they run in the browser and in tests. Texts go through t() (Swedish source,
// translated per locale in i18n.js).
// Every piece of advice carries `src`: ids into SOURCES, so the app can show
// what it is based on. Rules that are practical judgement rather than research
// point to "rule" and are shown as such.
import { parseSets } from "./parse.js";
import { t as tx, fmtNum } from "./i18n.js";

export const SOURCES = {
  plotkin2022: { s: "Plotkin 2022", t: "Plotkin m.fl. 2022 (PeerJ): att öka vikten eller öka antalet reps gav liknande ökning av styrka och muskler hos tränade.", u: "https://peerj.com/articles/14142" },
  ralston2017: { s: "Ralston 2017", t: "Ralston m.fl. 2017 (Sports Med): fler set per vecka ger mer styrka – ett dos–respons-samband.", u: "https://pubmed.ncbi.nlm.nih.gov/28755103/" },
  pelland2024: { s: "Pelland 2024", t: "Pelland m.fl. 2024 (preprint, SportRχiv): volym och frekvens har var sitt dos–respons-samband med muskeltillväxt och styrka.", u: "https://sportrxiv.org/index.php/server/preprint/download/460/967/908" },
  schoenfeld2016: { s: "Schoenfeld 2016", t: "Schoenfeld m.fl. 2016 (Sports Med): med samma volym gav två pass per muskelgrupp och vecka mer muskeltillväxt än ett.", u: "https://pubmed.ncbi.nlm.nih.gov/27102172/" },
  schoenfeld2019: { s: "Schoenfeld 2019", t: "Schoenfeld m.fl. 2019 (J Sports Sci): med samma volym spelar frekvensen liten roll – fler pass är främst ett sätt att få in mer volym.", u: "https://www.pubmed.gov/30558493/" },
  robinson2024: { s: "Robinson 2024", t: "Robinson m.fl. 2024 (Sports Med): att stoppa närmare failure ger mer muskeltillväxt, men spelar mindre roll för styrka.", u: "https://rke.abertay.ac.uk/en/publications/exploring-the-dose-response-relationship-between-estimated-resist/" },
  refalo2024: { s: "Refalo 2024", t: "Refalo m.fl. 2024 (J Sports Sci): set som avslutas med 1–2 reps kvar gav lika mycket muskeltillväxt som set till failure.", u: "https://pubmed.ncbi.nlm.nih.gov/38393985/" },
  currier2023: { s: "Currier 2023", t: "Currier m.fl. 2023 (BJSM): stor jämförelse av belastning, set och frekvens – tyngre belastning gynnar styrka, muskeltillväxt fås med många upplägg.", u: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10579494/" },
  rule: { s: "Tumregel", t: "Tumregel – praktisk erfarenhet, inte en siffra hämtad direkt ur en studie.", u: null },
};

// Training goal decides rep ranges, how close to failure to go and the volume band.
export const GOALS = {
  strength: { label: "Styrka", comp: [4, 6], iso: [8, 12], rir: "2–3", band: [10, 20], src: ["currier2023", "robinson2024"] },
  muscle: { label: "Muskler", comp: [6, 10], iso: [8, 15], rir: "1–2", band: [10, 20], src: ["refalo2024", "robinson2024"] },
  health: { label: "Hälsa", comp: [8, 12], iso: [10, 15], rir: "2–3", band: [4, 10], src: ["rule"] },
};
const goalOf = (g) => GOALS[g] || GOALS.muscle;
const FREQ_TARGET = 2; // times per muscle group and week
const MAX_SETS = 24; // working sets in one session, so it stays about an hour
const INTERVAL = 7 / FREQ_TARGET;

// ---- dates ----
const pd = (s) => { const [a, b, c] = s.split("-").map(Number); return Date.UTC(a, b - 1, c); };
export const daysBetween = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);
const addDays = (s, n) => new Date(pd(s) + n * 864e5).toISOString().slice(0, 10);
const mondayOf = (s) => addDays(s, -((new Date(pd(s)).getUTCDay() + 6) % 7));

// ---- muscle groups and exercise kinds ----
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
const ISOLATION = /tricep|vad|calf|curl|lateral|extension|raise|fly|face ?pull|shrug|rotat|abduct|adduct|underarm|scapular|rear delt|preacher|mage|plank|maghjul/;
const COMPOUND = /bänk|bröstpress|chest press|squat|knäböj|rdl|marklyft|deadlift|press|rodd|\brow\b|pulldown|chin|pull-?up|dips|benpress|glute drive|hip thrust|jefferson/;
export const isCompound = (name) => { const n = String(name).toLowerCase(); return !ISOLATION.test(n) && COMPOUND.test(n); };
export const repRange = (name, goal) => (isCompound(name) ? goalOf(goal).comp : goalOf(goal).iso);

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
      m.get(e.n).push({ date: s.date, pos, s: e.s, rir: e.r ?? null, sets, top, e1: e1rm(top), bw: reps.length ? Math.max(...reps) : 0, sec: secs.length ? Math.max(...secs) : 0 });
    });
  }
  return m;
}

const fmt = (w) => fmtNum(w);
const fmt1 = (x) => fmt(Math.round(x * 10) / 10);
const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
const roundTo = (w, st) => Math.round(w / st) * st;
const stepFor = (w) => (w >= 100 ? 5 : w >= 10 ? 2.5 : 1);
const list = (a) => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " " + tx("och") + " " + a.at(-1));
const gname = (g) => tx(GROUP_NAMES[g]);

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

// Target for the next time this exercise is done: double progression inside the
// goal's rep range, adjusted by how hard the last time felt (reps in reserve).
export function nextTarget(entries, today, goal = "muscle", name = "") {
  const G = goalOf(goal);
  const [lo, hi] = repRange(name, goal);
  const effort = tx("Sikta på {rir} reps kvar i sista setet.", { rir: G.rir });
  const last = entries?.at(-1);
  if (!last) return { target: "", why: tx("Ny övning: välj en vikt du klarar {lo}–{hi} gånger med {rir} reps kvar.", { lo, hi, rir: G.rir }), kind: "new", src: [...G.src] };
  const gap = daysBetween(last.date, today);
  const t = last.top;
  const rir = last.rir;
  if (t && t.w > 0) {
    const lbl = t.wl ? t.wl.replace(/[.,]/g, fmtNum(0.5).charAt(1)) : fmt(t.w);
    if (gap > 28) {
      const w = roundTo(t.w * 0.9, stepFor(t.w));
      return { target: `${Math.min(Math.max(t.r, lo), hi)}@${fmt(w)}`, why: tx("{gap} dagar sedan sist. Börja på ~90 % och bygg upp igen.", { gap }) + " " + effort, kind: "comeback", src: ["rule"] };
    }
    const tr = trendOf(entries, today);
    const sameTop = entries.slice(-3).filter((e) => e.top && e.top.w === t.w && e.top.r <= t.r).length === 3;
    if (tr && tr.status === "flat" && sameTop && entries.length >= 4 && !(rir !== null && rir >= 3)) {
      const w = roundTo(t.w * 0.9, stepFor(t.w));
      return { target: `${hi}@${fmt(w)}`, why: tx("Stått still på {set} tre pass. Ge musklerna ett nytt stimulus: fler reps på ~90 % ett pass, eller byt variant.", { set: `${t.r}@${fmt(t.w)}` }), kind: "plateau", src: ["plotkin2022", "rule"] };
    }
    const easy = rir !== null && rir >= 3, failed = rir === 0;
    if (t.r >= hi || (easy && t.r >= hi - 2)) {
      const w = t.w + stepFor(t.w);
      return { target: `${lo}@${fmt(w)}`, why: (easy ? tx("Klarade {r} reps med {rir} kvar – toppen av ditt intervall {lo}–{hi}. Öka vikten och börja om på {lo}.", { r: t.r, rir, lo, hi }) : tx("Klarade {r} reps – toppen av ditt intervall {lo}–{hi}. Öka vikten och börja om på {lo}.", { r: t.r, lo, hi })) + " " + effort, kind: "weight", src: ["plotkin2022", ...G.src] };
    }
    if (t.r < lo) {
      if (failed) {
        const w = roundTo(t.w - stepFor(t.w), stepFor(t.w));
        return { target: `${lo}@${fmt(w)}`, why: tx("Bara {r} reps och inget kvar – under intervallet {lo}–{hi}. Sänk lite och bygg upp igen.", { r: t.r, lo, hi }) + " " + effort, kind: "lower", src: ["rule", ...G.src] };
      }
      return { target: `${lo}@${lbl}`, why: tx("{r} reps är under ditt intervall {lo}–{hi}. Sikta på {lo} med samma vikt.", { r: t.r, lo, hi }) + " " + effort, kind: "reps", src: ["plotkin2022", ...G.src] };
    }
    const add = easy ? 2 : 1;
    return {
      target: `${Math.min(t.r + add, hi)}@${lbl}`,
      why: (easy ? tx("Kändes lätt förra gången ({rir} kvar) – två reps till.", { rir }) : tx("En rep till än förra gången ({set}).", { set: `${t.r}@${lbl}` })) + " " + tx("Vid {hi} reps ökar du vikten.", { hi }) + " " + effort,
      kind: "reps", src: ["plotkin2022", ...G.src],
    };
  }
  if (last.sec) return { target: mmss(last.sec + 15), why: tx("Förra gången {t}. Sikta på 15 s längre.", { t: mmss(last.sec) }), kind: "time", src: ["rule"] };
  if (last.bw) return { target: `${last.bw + (rir !== null && rir >= 3 ? 2 : 1)}`, why: (rir !== null ? tx("Förra gången {r} reps ({rir} kvar).", { r: last.bw, rir }) : tx("Förra gången {r} reps.", { r: last.bw })) + " " + (rir !== null && rir >= 3 ? tx("Två till.") : tx("En till.")), kind: "reps", src: ["plotkin2022"] };
  return { target: "", why: "", kind: "none", src: [] };
}

// Times per week each muscle group was trained over the last `days` days.
export function groupFrequency(sessions, today, days = 28) {
  const cnt = Object.fromEntries(Object.keys(GROUP_NAMES).map((g) => [g, 0]));
  for (const s of sessions) {
    const d = daysBetween(s.date, today);
    if (d < 0 || d >= days) continue;
    const gs = new Set((s.ex || []).filter((e) => parseSets(e.s).length).map((e) => groupOf(e.n)).filter(Boolean));
    for (const g of gs) cnt[g]++;
  }
  return Object.entries(cnt).map(([g, n]) => ({ g, name: GROUP_NAMES[g], perWeek: (n * 7) / days }));
}

// Which session type is due, and why. Target: each region about twice a week.
export function nextType(sessions, today, goal = "muscle") {
  const done = [...sessions].filter((s) => s.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
  const src = ["schoenfeld2016", "schoenfeld2019", "pelland2024"];
  if (!done.length) return { tag: "HK", date: today, why: tx("Inga pass än. Börja med ett helkroppspass."), rest: false, src };
  const lastFor = (r) => done.find((s) => regions(effectiveTag(s)).includes(r))?.date;
  const lu = lastFor("upper"), ll = lastFor("lower");
  const gu = lu ? daysBetween(lu, today) : 99, gl = ll ? daysBetween(ll, today) : 99;
  const n7 = done.filter((s) => daysBetween(s.date, today) < 7).length;
  const doneToday = done[0].date === today;
  const in28 = done.filter((s) => daysBetween(s.date, today) < 28);
  const fu = in28.filter((s) => regions(effectiveTag(s)).includes("upper")).length / 4;
  const fl = in28.filter((s) => regions(effectiveTag(s)).includes("lower")).length / 4;
  const from8 = done.filter((s) => daysBetween(s.date, today) < 56);
  const hkShare = from8.length ? from8.filter((s) => effectiveTag(s) === "HK").length / from8.length : 0;
  const ru = gu / INTERVAL, rl = gl / INTERVAL;
  const dTxt = (g) => (g >= 99 ? tx("aldrig") : g === 0 ? tx("idag") : g === 1 ? tx("i går") : tx("för {n} dagar sedan", { n: g }));
  let tag;
  if (ru >= 1 && rl >= 1) {
    const ratio = Math.max(ru, rl) / Math.min(ru, rl);
    tag = ratio >= 2 ? (rl > ru ? "NK" : "ÖK") : hkShare >= 0.2 ? "HK" : rl >= ru ? "NK" : "ÖK";
  } else tag = rl >= ru ? "NK" : "ÖK";
  const why = tx("Benen tränades senast {dl} ({fl} gånger/vecka senaste 4 veckorna), överkroppen {du} ({fu}/vecka). Målet är minst {n} gånger per muskelgrupp och vecka.", { dl: dTxt(gl), fl: fmt1(fl), du: dTxt(gu), fu: fmt1(fu), n: FREQ_TARGET });
  const rest = doneToday || n7 >= 5 || (ru < 0.57 && rl < 0.57);
  const date = doneToday ? addDays(today, 1) : today;
  let restWhy = "";
  if (doneToday) restWhy = tx("Du har redan tränat idag. Förslaget gäller i morgon.");
  else if (n7 >= 5) restWhy = tx("{n} pass senaste 7 dagarna. En vilodag gör mer nytta än ett pass till.", { n: n7 });
  else if (rest) restWhy = tx("Allt är tränat de senaste två dagarna. Vila idag eller kör ett lätt pass.");
  return { tag, date, why, rest, restWhy, gu, gl, fu, fl, n7, src: rest ? [...src, "rule"] : src };
}

// How many working sets (warm-ups not counted) each exercise gets in one session.
// Each muscle group should get about band/2 hard sets per session (two sessions a
// week reach the weekly band), spread over that group's exercises: 2–4 sets each.
export function allocSets(names, goal = "muscle") {
  const G = goalOf(goal);
  const perSession = Math.ceil(G.band[0] / FREQ_TARGET);
  const lo = 2, hi = goal === "health" ? 3 : 4;
  const byGroup = new Map();
  for (const n of names) { const g = groupOf(n) || "?"; byGroup.set(g, (byGroup.get(g) || 0) + 1); }
  const sets = names.map((n) => {
    const g = groupOf(n) || "?";
    const want = g === "core" || g === "?" ? (goal === "health" ? 2 : 3) : Math.ceil(perSession / byGroup.get(g));
    return Math.max(lo, Math.min(hi, want));
  });
  // Keep the session a sensible length: trim the biggest counts first.
  while (sets.reduce((a, b) => a + b, 0) > MAX_SETS) {
    const i = sets.indexOf(Math.max(...sets));
    if (sets[i] <= lo) break;
    sets[i]--;
  }
  return sets;
}
// ---- session length ----
// Rough minutes of training: each working set incl. rest (compound 2,5 min,
// isolation 1,75 min, timed sets their duration + 1 min) and 1 min to change
// station. Warm-up is optional and not part of the session length.
// A rule of thumb, shown as such in the app.
const setMinutes = (name, one) => {
  const tm = String(one || "").match(/^(\d+):(\d\d)/);
  return tm ? (+tm[1] * 60 + +tm[2]) / 60 + 1 : isCompound(name) ? 2.5 : 1.75;
};
export const sessionMinutes = (items) => items.reduce((m, x) => m + x.sets * setMinutes(x.n, x.one ?? x.target) + 1, 0);

// Fit a proposal into the available time. items: priority order (most important
// first), each {n, sets, one}. Trims in this order until it fits:
// 1. sets above 2 (largest first);
// 2. a whole exercise, choosing (from the least important end) first core or
//    ungrouped, then one whose muscle group is still covered by another exercise,
//    then isolation, then anything, keeping at least 3 exercises;
// then adds sets back (most important first, up to what was asked) while it fits,
// and uses time left over: a dropped exercise back with 2 sets, then a 3rd set
// (up to `extra`) on the most important exercises.
export function fitToTime(items, minutes, extra = 3) {
  const want = new Map(items.map((x) => [x.n, x.sets]));
  const list = items.map((x) => ({ ...x }));
  const dropped = [];
  const fits = () => !minutes || sessionMinutes(list) <= minutes;
  while (!fits()) {
    const big = list.filter((x) => x.sets > 2);
    if (big.length) { big.sort((a, b) => b.sets - a.sets || +isCompound(a.n) - +isCompound(b.n))[0].sets--; continue; }
    if (list.length <= 3) break;
    const g = (x) => groupOf(x.n);
    const covered = (x) => g(x) && list.filter((y) => g(y) === g(x)).length > 1;
    const tests = [(x) => g(x) === "core" || !g(x), covered, (x) => !isCompound(x.n), () => true];
    let at = -1;
    for (const test of tests) {
      for (let i = list.length - 1; i >= 0 && at < 0; i--) if (test(list[i])) at = i;
      if (at >= 0) break;
    }
    dropped.push(list[at].n);
    list.splice(at, 1);
  }
  const grow = (cap) => {
    for (let grew = true; grew && minutes; ) {
      grew = false;
      for (const x of list) {
        if (x.sets >= cap(x)) continue;
        x.sets++;
        if (fits()) { grew = true; break; }
        x.sets--;
      }
    }
  };
  grow((x) => want.get(x.n));
  if (minutes) {
    for (const n of [...dropped]) {
      const x = { ...items.find((y) => y.n === n), sets: 2 };
      list.push(x);
      if (fits()) dropped.splice(dropped.indexOf(n), 1);
      else list.pop();
    }
    grow((x) => Math.max(want.get(x.n), extra));
  }
  return { items: list, dropped, minutes: Math.round(sessionMinutes(list)) };
}

// "9@25" + 3 sets → "9@25 x3" (Håkan's own notation for identical sets).
export const withSets = (target, n) => (target && n > 1 ? `${target} x${n}` : target);

// A concrete session of the given type: the exercises he usually does, with targets.
export function proposeSession(sessions, tag, date, goal = "muscle", minutes = 0) {
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
  const sets = allocSets(chosen.map((c) => c.n), goal);
  const items = chosen.map((c, i) => {
    const nt = nextTarget(hist.get(c.n), date, goal, c.n);
    return { n: c.n, ...nt, sets: sets[i], one: nt.target, last: hist.get(c.n)?.at(-1), prio: c.w };
  });
  // Fit by priority (how often it was done recently), then show in the usual order.
  const byPrio = [...items].sort((a, b) => b.prio - a.prio);
  const fit = fitToTime(byPrio, minutes, goal === "health" ? 2 : 3);
  const keep = new Map(fit.items.map((x) => [x.n, x.sets]));
  const plan = items.filter((x) => keep.has(x.n)).map((x) => ({ ...x, sets: keep.get(x.n), target: withSets(x.one, keep.get(x.n)) }));
  plan.dropped = fit.dropped;
  plan.minutes = fit.minutes;
  return plan;
}

// Weekly hard sets per muscle group over the last 4 weeks. Working sets are those
// at ≥80 % of the day's top weight (warm-ups excluded), plus bodyweight/timed sets.
// With "reps kvar" logged: 0–3 counts fully, 4 counts half, 5+ not at all.
export function weeklyVolume(sessions, today, weeks = 4) {
  const vol = Object.fromEntries(Object.keys(GROUP_NAMES).map((g) => [g, 0]));
  let withRir = 0, total = 0;
  for (const s of sessions) {
    const d = daysBetween(s.date, today);
    if (d < 0 || d >= weeks * 7) continue;
    for (const e of s.ex || []) {
      const g = groupOf(e.n);
      const sets = parseSets(e.s);
      if (!sets.length) continue;
      total++;
      if (e.r !== undefined && e.r !== null) withRir++;
      if (!g) continue;
      const top = Math.max(0, ...sets.filter((x) => x.w > 0).map((x) => x.w));
      const work = sets.filter((x) => (x.w > 0 ? x.w >= top * 0.8 : true)).length;
      const k = e.r === undefined || e.r === null ? 1 : e.r <= 3 ? 1 : e.r === 4 ? 0.5 : 0;
      vol[g] += work * k;
    }
  }
  return { groups: Object.entries(vol).map(([g, n]) => ({ g, name: GROUP_NAMES[g], perWeek: n / weeks })), rirShare: total ? withRir / total : 0, exercises: total };
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
export function coachReport(sessions, today, goal = "muscle", minutes = 0) {
  const G = goalOf(goal);
  const hist = history(sessions);
  const next = nextType(sessions, today, goal);
  const plan = proposeSession(sessions, next.tag, next.date, goal, minutes);
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
  const volume = weeklyVolume(sessions, today, 4);
  const freq = groupFrequency(sessions, today, 28);
  const hasData = sessions.some((s) => daysBetween(s.date, today) < 28 && daysBetween(s.date, today) >= 0);

  // Short list of the most useful observations, most important first.
  const notes = [];
  const lowF = freq.filter((f) => f.g !== "core" && f.perWeek < FREQ_TARGET - 0.25);
  if (hasData && lowF.length) notes.push({ k: "warn", t: tx("{groups} tränas under {n} gånger i veckan (snitt senaste 4 veckorna). Forskningen talar för minst två gånger per muskelgrupp och vecka – det är också det enklaste sättet att få in tillräcklig volym.", { groups: list(lowF.map((f) => gname(f.g))), n: FREQ_TARGET }), src: ["schoenfeld2016", "schoenfeld2019", "pelland2024"] });
  const lowV = volume.groups.filter((v) => v.g !== "core" && v.perWeek < G.band[0]);
  if (hasData && lowV.length) notes.push({ k: "warn", t: tx("Låg volym för {groups}: under {lo} tunga set i veckan. För målet {goal} ger {lo}–{hi} set per muskelgrupp och vecka mer utveckling.", { groups: list(lowV.map((v) => gname(v.g).toLowerCase())), lo: G.band[0], hi: G.band[1], goal: tx(G.label).toLowerCase() }), src: goal === "health" ? ["rule"] : ["ralston2017", "pelland2024"] });
  if (hasData && volume.exercises >= 5 && volume.rirShare < 0.3) notes.push({ k: "info", t: tx("Logga \"reps kvar\" (RIR) när du loggar pass. Då vet coachen vilka set som var tunga på riktigt och kan öka snabbare när det känns lätt. För {goal}: sikta på {rir} reps kvar.", { goal: tx(G.label).toLowerCase(), rir: G.rir }), src: ["robinson2024", "refalo2024"] });
  if (last4 < prev4 - 0.4) notes.push({ k: "warn", t: tx("Färre pass: {a} per vecka senaste 4 veckorna mot {b} veckorna innan.", { a: fmt1(last4), b: fmt1(prev4) }), src: [] });
  else if (last4 > prev4 + 0.4) notes.push({ k: "good", t: tx("Fler pass: {a} per vecka senaste 4 veckorna mot {b} innan.", { a: fmt1(last4), b: fmt1(prev4) }), src: [] });
  if (down.length) notes.push({ k: "warn", t: tx("Tappat i {list}. Kolla sömn och återhämtning, eller kör ett par pass lite lättare.", { list: list(down.slice(0, 3).map((d) => d.n)) }), src: ["rule"] });
  if (flat.length >= 3) notes.push({ k: "info", t: tx("{n} övningar står still. Variera reps (t.ex. fler reps på lägre vikt) eller byt variant under några veckor.", { n: flat.length }), src: ["plotkin2022", "rule"] });
  if (prs.length) notes.push({ k: "good", t: tx("Nya rekord senaste månaden: {list}.", { list: list(prs.slice(0, 3).map((p) => p.n)) }), src: [] });
  return { goal, G, minutes, next, plan, up, flat, down, prs, neglected, weeks, last4, prev4, vol: volume.groups, rirShare: volume.rirShare, freq, notes };
}
