// Parser for Håkan's set notation. Shared by the browser app and the Worker.
// "8@22,5kg, 6@25kg"  "10x65kg"  "33,5+2kg"  "x@72,5kg"  "10/8@16,25kg"
// "6@36,25kg x2"  bodyweight "10, 8"  time "2:30"  notes "(text)"

const num = (s) => parseFloat(String(s).replace(",", "."));

// "kg" after the weight is optional and case-insensitive: 22,5 = 22,5kg = 22,5 kg = 22,5KG
const SET_RE = /(\d+(?:[,.]\d+)?(?:\/\d+)?|x)\s*[@x]\s*(-?\d+(?:[,.]\d+)?(?:\+\d+(?:[,.]\d+)?)?)\s*(?:kg|k)?(?:\s+x(\d+)\b)?/gi;
const TIME_RE = /\b(\d+):(\d\d)\b/g;
const BARE_RE = /(?<![\d@,.])\b(\d+)\b(?![@\d.:x]|,\d)/g;

// Effort marker in text: "RIR 2", "rir2", "2 kvar" (reps left in the tank).
const RIR_RE = /\b(?:rir\s*(\d)|(\d)\s*kvar)\b/gi;
export function rirFromText(txt) {
  const m = [...String(txt || "").matchAll(RIR_RE)].at(-1);
  return m ? Math.min(5, +(m[1] ?? m[2])) : null;
}

// Returns [{r: reps|null, w: kg|null, wl?: "33,5+2", t?: seconds}]
export function parseSets(txt) {
  const sets = [];
  let body = String(txt || "").replace(/\([^)]*\)/g, " ").replace(RIR_RE, " ");
  body = body.replace(SET_RE, (m, r, w, mult) => {
    const wv = w.split("+").reduce((a, p) => a + num(p), 0);
    const s = { r: r === "x" ? null : num(r.split("/")[0]), w: Math.round(wv * 100) / 100 };
    if (w.includes("+")) s.wl = w;
    for (let i = 0; i < (+mult || 1); i++) sets.push({ ...s });
    return " ";
  });
  body = body.replace(TIME_RE, (m, a, b) => {
    sets.push({ t: +a * 60 + +b });
    return " ";
  });
  if (!sets.some((s) => s.w != null)) {
    for (const m of body.matchAll(BARE_RE)) sets.push({ r: +m[1], w: null });
  }
  return sets;
}

// ---- Pasting sessions from Notes ------------------------------------------

// Spelling variants seen in the Notes log → canonical exercise names.
export const NAME_MAP = {
  "Preachercurl (hantel)": "Preacher curl (hantel)",
  "Preachercurl": "Preacher curl",
  "Pulldowns (rak stång)": "Pulldown (rak stång)",
  "Facepulls": "Face pulls",
  "Facepulls (kabelmaskin)": "Face pulls",
  "Tricepspress över huvud (rep)": "Tricepspress (rep över huvud)",
  "Bicepscurl hantel (sittande)": "Bicepscurl (hantel sittande)",
  "Bicepscurl hantel (sittande bänk)": "Bicepscurl (hantel sittande)",
  "Hantelcurl sittande": "Bicepscurl (hantel sittande)",
  "Bicepscurl (sittande)": "Bicepscurl (hantel sittande)",
  "Tricepspress (stång kabelmaskin)": "Tricepspress stång (kabelmaskin)",
  "Chest press": "Chest press (maskin)",
  "Pulldown (v-handtag)": "Pulldown (v-shape)",
  "Bänkpress incline (hantel)": "Bänkpress (incline hantel)",
};
const TAG_MAP = { "ÖK": "ÖK", "NK": "NK", "HK": "HK", "UK": "NK", "FK": "HK" };

// Split "Kabelrodd (smal) 8@33,5kg, 6@35kg" into name and sets text: the sets
// start at the first digit outside parentheses that does not follow a letter
// (so "Hip abductor x2 10@30kg" keeps "x2" in the name), or at "x@".
export function splitLine(line) {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const prev = i ? line[i - 1] : " ";
      if (/\d/.test(ch) && !/[\p{L}\p{N}]/u.test(prev)) return [line.slice(0, i).trim(), line.slice(i).trim()];
      if ((ch === "x" || ch === "X") && line[i + 1] === "@" && /\s/.test(prev)) return [line.slice(0, i).trim(), line.slice(i).trim()];
    }
  }
  return [line.trim(), ""];
}

// Header line: "261122 ÖK", "261122ÖK (Kyrkbyn)", "2026-11-22 nk", "22/11 HK", "22/11/2026"
function parseHeader(line, today) {
  let m = line.match(/^(\d{2})(\d{2})(\d{2})\b\s*(.*)$/) || line.match(/^(\d{4})-(\d{2})-(\d{2})\b\s*(.*)$/);
  let date = null, rest = "";
  if (m) {
    const y = m[1].length === 2 ? 2000 + +m[1] : +m[1];
    date = `${y}-${m[2]}-${m[3]}`;
    rest = m[4];
  } else if ((m = line.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b\s*(.*)$/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +String(today || new Date().toISOString()).slice(0, 4);
    date = `${y}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
    rest = m[4];
  } else return null;
  const d = new Date(date + "T00:00:00Z");
  if (isNaN(d) || d.toISOString().slice(0, 10) !== date) return null;
  // A header has at most a session type and a note after the date, never sets.
  if (/\d@|\dx\d/i.test(rest)) return null;
  let tag = "";
  const t = rest.match(/^(ök|nk|hk|uk|fk)(?![\p{L}])\s*(.*)$/iu);
  if (t) { tag = TAG_MAP[t[1].toUpperCase()] || ""; rest = t[2]; }
  return { date, tag, note: rest.replace(/^\(|\)$/g, "").trim() };
}

// Parse pasted text into sessions: [{date|null, tag, note, ex: [{n, s}]}].
// Lines before the first date header form one session without a date.
export function parseSessionText(text, today) {
  const sessions = [];
  let cur = null;
  for (let raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/[   ]/g, " ").replace(/^\s*(?:[-*•–·]|\d+[.)]|\[[ x]\])\s+/, "").replace(/\s+/g, " ").trim();
    if (!line || /^träning gym\b/i.test(line)) continue;
    const h = parseHeader(line, today);
    if (h) { cur = { ...h, ex: [] }; sessions.push(cur); continue; }
    const [n0, s] = splitLine(line);
    if (!n0) continue;
    if (!cur) { cur = { date: null, tag: "", note: "", ex: [] }; sessions.push(cur); }
    const r = rirFromText(s);
    const clean = s.replace(RIR_RE, "").replace(/,\s*\)/g, ")").replace(/\(\s*\)/g, "").replace(/\s*,\s*$/, "").replace(/\s{2,}/g, " ").trim();
    cur.ex.push(r === null ? { n: NAME_MAP[n0] || n0, s } : { n: NAME_MAP[n0] || n0, s: clean, r });
  }
  return sessions.filter((x) => x.ex.length);
}
