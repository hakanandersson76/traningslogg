// Numbers for the Home page, chosen to keep people training (behavioural science):
// - goal gradient: show how close this week's goal is (Kivetz et al. 2006)
// - habit / streaks: weeks in a row with training; a week, not a day, so one missed
//   day never breaks it (Lally et al. 2010: habits form over weeks to months)
// - fresh start: Mondays and new months are natural moments to restart (Dai et al. 2014)
// - progress made visible: strength gained, records, kilos lifted, next milestone
// - planning: a concrete next session (implementation intentions, Gollwitzer & Sheeran 2006;
//   planning prompts and coming back after a miss, Milkman et al. 2021)
// Pure functions over the session history, like coach.js.
import { parseSets } from "./parse.js";
import { history, daysBetween, isCompound } from "./coach.js";

export const WEEK_TARGET = 2;
export const HOME_SOURCES = {
  kivetz2006: { s: "Kivetz 2006", t: "Kivetz m.fl. 2006 (J Marketing Research): ju närmare ett mål man är, desto mer anstränger man sig – målgradienten.", u: "https://doi.org/10.1509/jmkr.43.1.39" },
  lally2010: { s: "Lally 2010", t: "Lally m.fl. 2010 (Eur J Soc Psychol): en vana tog i snitt runt två månader att bygga, och en enstaka missad gång gjorde ingen skillnad.", u: "https://doi.org/10.1002/ejsp.674" },
  dai2014: { s: "Dai 2014", t: "Dai, Milkman & Riis 2014 (Management Science): nystarter som en ny vecka eller månad ökar viljan att ta tag i sina mål, till exempel gymbesök.", u: "https://doi.org/10.1287/mnsc.2014.1901" },
  gollwitzer2006: { s: "Gollwitzer 2006", t: "Gollwitzer & Sheeran 2006 (metaanalys): en konkret plan för när och vad man ska göra ökar chansen att det blir av.", u: "https://doi.org/10.1016/S0065-2601(06)38002-1" },
  milkman2021: { s: "Milkman 2021", t: "Milkman m.fl. 2021 (Nature): stor studie med 61 000 gymmedlemmar – påminnelser, planering och att uppmuntra comeback efter en miss ökade antalet besök.", u: "https://doi.org/10.1038/s41586-021-04128-4" },
};

const pd = (s) => { const [a, b, c] = s.split("-").map(Number); return Date.UTC(a, b - 1, c); };
const addDays = (s, n) => new Date(pd(s) + n * 864e5).toISOString().slice(0, 10);
export const mondayOf = (s) => addDays(s, -((new Date(pd(s)).getUTCDay() + 6) % 7));
const MILESTONES = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

// Kilos lifted in a session: weight × reps over weighted sets.
const tonnage = (s) => (s.ex || []).reduce((a, e) => a + parseSets(e.s).reduce((b, x) => b + (x.w > 0 && x.r ? x.w * x.r : 0), 0), 0);

export function homeStats(sessions, today, target = WEEK_TARGET) {
  const done = sessions.filter((s) => s.date <= today);
  const dates = [...new Set(done.map((s) => s.date))].sort();
  const mon = mondayOf(today);
  const perWeek = new Map();
  for (const d of dates) { const m = mondayOf(d); perWeek.set(m, (perWeek.get(m) || 0) + 1); }

  // This week: goal gradient.
  const thisWeek = perWeek.get(mon) || 0;
  const daysLeft = 7 - daysBetween(mon, today); // today included
  const week = { done: thisWeek, target, left: Math.max(0, target - thisWeek), daysLeft, met: thisWeek >= target };

  // Streak: weeks in a row with at least one workout. The current week only
  // breaks it once it's over, so it counts if trained, otherwise it's "still open".
  let streak = 0;
  let w = thisWeek ? mon : addDays(mon, -7);
  while (perWeek.get(w)) { streak++; w = addDays(w, -7); }
  let best = 0, run = 0, prev = null;
  for (const m of [...perWeek.keys()].sort()) {
    run = prev && daysBetween(prev, m) === 7 ? run + 1 : 1;
    best = Math.max(best, run); prev = m;
  }
  const atRisk = !thisWeek && streak > 0; // trained last week, not yet this week

  // Last 12 weeks, oldest first, for the strip.
  const weeks = Array.from({ length: 12 }, (_, i) => { const m = addDays(mon, -7 * (11 - i)); return { start: m, n: perWeek.get(m) || 0 }; });
  const goalWeeks12 = weeks.slice(0, 11).filter((x) => x.n >= target).length; // completed weeks only
  const activeWeeks12 = weeks.filter((x) => x.n > 0).length;

  // Year and month, compared at the same point in time (fair comparison).
  const y = today.slice(0, 4), lastY = String(+y - 1);
  const year = { n: dates.filter((d) => d.startsWith(y)).length, lastYearSoFar: dates.filter((d) => d.startsWith(lastY) && d.slice(5) <= today.slice(5)).length, hasLastYear: dates.some((d) => d.startsWith(lastY)) };
  const monthStart = today.slice(0, 8) + "01";
  const prevMonthStart = new Date(Date.UTC(+y, +today.slice(5, 7) - 2, 1)).toISOString().slice(0, 10);
  const prevMonthSame = addDays(prevMonthStart, daysBetween(monthStart, today));
  const inRange = (a, b) => done.filter((s) => s.date >= a && s.date <= b);
  const month = {
    n: new Set(inRange(monthStart, today).map((s) => s.date)).size,
    prevSoFar: new Set(inRange(prevMonthStart, prevMonthSame < monthStart ? prevMonthSame : addDays(monthStart, -1)).map((s) => s.date)).size,
    kg: Math.round(inRange(monthStart, today).reduce((a, s) => a + tonnage(s), 0)),
    prevKg: Math.round(inRange(prevMonthStart, prevMonthSame < monthStart ? prevMonthSame : addDays(monthStart, -1)).reduce((a, s) => a + tonnage(s), 0)),
  };
  const yearKg = Math.round(done.filter((s) => s.date.startsWith(y)).reduce((a, s) => a + tonnage(s), 0));

  // Strength: the compound lifts done most in the last 90 days, best estimated
  // 1RM of the last 3 times against the first 3 times in the last 12 months.
  const hist = history(done);
  const strength = [];
  for (const [n, entries] of hist) {
    if (!isCompound(n)) continue;
    const e = entries.filter((x) => x.e1 && daysBetween(x.date, today) <= 365);
    const recent = e.filter((x) => daysBetween(x.date, today) <= 90);
    if (e.length < 6 || recent.length < 2) continue;
    const first = Math.max(...e.slice(0, 3).map((x) => x.e1)), last = Math.max(...e.slice(-3).map((x) => x.e1));
    strength.push({ n, pct: last / first - 1, since: e[0].date, count: recent.length });
  }
  // Show gains only (the Coach tab has the full picture, declines included);
  // without gains, show the year's best lifts instead – always true and positive.
  const gains = strength.filter((x) => x.pct >= 0.02).sort((a, b) => b.pct - a.pct);
  const bestLifts = [];
  for (const [n, entries] of hist) {
    const e = entries.filter((x) => x.top && x.top.w > 0 && x.date.startsWith(today.slice(0, 4)));
    if (!isCompound(n) || e.length < 3) continue;
    const b = e.reduce((p, x) => (x.e1 > p.e1 ? x : p));
    bestLifts.push({ n, top: b.top, date: b.date, count: e.length });
  }
  bestLifts.sort((a, b) => b.count - a.count);

  // Records: sessions where an exercise beat its earlier best estimated 1RM
  // (needs some history first, so the first few times don't count as records).
  const records = [];
  for (const [n, entries] of hist) {
    let bestE = 0, k = 0;
    for (const x of entries) {
      if (!x.e1) continue;
      if (k >= 3 && x.e1 > bestE * 1.005) records.push({ n, date: x.date, top: x.top });
      bestE = Math.max(bestE, x.e1); k++;
    }
  }
  records.sort((a, b) => (a.date < b.date ? 1 : -1));
  const recordsYear = records.filter((r) => r.date.startsWith(y)).length;

  const total = dates.length;
  const next = MILESTONES.find((m) => m > total) ?? Math.ceil((total + 1) / 100) * 100;
  const lastDate = dates.at(-1) || null;
  const gap = lastDate ? daysBetween(lastDate, today) : null;
  const dow = (new Date(pd(today)).getUTCDay() + 6) % 7; // 0 = Monday
  const fresh = today.endsWith("-01") ? "month" : dow === 0 ? "week" : null;

  return {
    week, streak: { current: streak, best, atRisk }, weeks, goalWeeks12, activeWeeks12, year, month, yearKg,
    gains: gains.slice(0, 3), bestLifts: bestLifts.slice(0, 3), recentRecords: records.filter((r) => daysBetween(r.date, today) <= 30).slice(0, 3), recordsYear,
    total, milestone: { next, left: next - total }, gap, lastDate, fresh,
  };
}
