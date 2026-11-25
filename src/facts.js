// The data the weekly AI insight is based on: the coach's own analysis (same code
// as in the app) plus the latest sessions, kept compact to keep the cost down.
import { coachReport, GOALS, sessionFeedback } from "../public/coach.js";
import { homeStats } from "../public/home.js";
import { setMuscleOverrides, MUSCLES } from "../public/muscles.js";

const r1 = (x) => Math.round(x * 10) / 10;

export function insightFacts(data, user, today) {
  // The muscle overrides are module state; set them right before the (synchronous) analysis.
  setMuscleOverrides(data.muscles || {});
  const goal = user.goal || "muscle";
  const r = coachReport(data.sessions, today, goal, user.session_min || 40);
  setMuscleOverrides({});
  const G = GOALS[goal] || GOALS.muscle;
  const recent = [...data.sessions].filter((s) => s.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  return {
    today,
    goal: { id: goal, reps_compound: G.comp.join("–"), reps_isolation: G.iso.join("–"), reps_in_reserve: G.rir, weekly_hard_sets_target: G.band.join("–") },
    session_length_min: user.session_min || 40,
    sessions_per_week: { last_4_weeks: r1(r.last4), previous_4_weeks: r1(r.prev4) },
    times_per_week_per_group_last_4_weeks: Object.fromEntries(r.freq.map((f) => [f.g, r1(f.perWeek)])),
    hard_sets_per_week_per_muscle_last_4_weeks: Object.fromEntries(r.vol.map((v) => [v.g, r1(v.perWeek)])),
    change_vs_previous_4_weeks: Object.fromEntries(r.vol.map((v) => [v.g, r1(v.delta)])),
    personal_weekly_hard_set_target_per_big_muscle: { target: r.volTarget.target, from: `${r.volTarget.freq} workouts × ${r.volTarget.minutes} min`, near_max_growth_band: r.volTarget.band.join("–"), note: "Judge volume against the personal target; the band needs much more time." },
    big_muscles: Object.keys(MUSCLES).filter((m) => r.vol.find((v) => v.g === m)?.main),
    share_of_exercises_with_reps_in_reserve_logged: r1(r.rirShare),
    trends_e1rm: {
      improving: r.up.slice(0, 5).map((t) => ({ n: t.n, change_pct: Math.round(t.delta * 100) })),
      stalled: r.flat.slice(0, 5).map((t) => t.n),
      dropping: r.down.slice(0, 5).map((t) => ({ n: t.n, change_pct: Math.round(t.delta * 100) })),
    },
    new_records_30_days: r.prs.slice(0, 5).map((p) => ({ n: p.n, date: p.date })),
    not_done_for_45_days: r.neglected.slice(0, 5).map((x) => ({ n: x.n, days: x.since })),
    coach_next_session: { type: r.next.tag, date: r.next.date, rest_suggested: r.next.rest },
    coach_rule_notes: r.notes.map((n) => n.t),
    recent_sessions: recent.map((s) => ({ date: s.date, type: s.tag || "", note: s.note || "", ex: (s.ex || []).map((e) => `${e.n}: ${String(e.s).slice(0, 80)}${e.r !== undefined && e.r !== null ? ` (RIR ${e.r})` : ""}`) })),
  };
}

// The rule-based feedback on one saved session, and the data the AI comment gets.
export function sessionFacts(data, user, sessionId, focus = []) {
  setMuscleOverrides(data.muscles || {});
  const goal = user.goal || "muscle";
  const rules = sessionFeedback(data.sessions, sessionId, goal);
  const s = data.sessions.find((x) => x.id === sessionId);
  const hs = rules ? homeStats(data.sessions.filter((x) => x.date <= s.date), s.date) : null;
  setMuscleOverrides({});
  if (!rules) return { rules: null, facts: null };
  const G = GOALS[goal] || GOALS.muscle;
  const recent = data.sessions.filter((x) => x.id !== sessionId && x.date <= s.date).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 4);
  return {
    rules,
    facts: {
      workout: { date: s.date, type: rules.tag, note: s.note || "", exercises: (s.ex || []).map((e) => ({ n: e.n, sets: e.s, r: e.r ?? null })) },
      comparison: rules.items.map((i) => ({ n: i.n, status: i.status, result: i.got, target: i.want, next_target: i.next })),
      total_sets: rules.totalSets, estimated_minutes: rules.minutes, planned_session_length_min: user.session_min || 40,
      hard_sets_per_muscle: Object.fromEntries(rules.muscles.map((m) => [m.m, m.v])),
      goal: { id: goal, reps_compound: G.comp.join("–"), reps_isolation: G.iso.join("–"), reps_in_reserve: G.rir },
      week: { workouts_done: hs.week.done, weekly_goal: hs.week.target, streak_weeks: hs.streak.current },
      focus_muscles_this_week: focus,
      recent_workouts: recent.map((x) => ({ date: x.date, type: x.tag || "", ex: (x.ex || []).map((e) => `${e.n}: ${String(e.s).slice(0, 60)}`) })),
    },
  };
}
