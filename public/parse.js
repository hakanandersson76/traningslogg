// Parser for Håkan's set notation. Shared by the browser app and the Worker.
// "8@22,5kg, 6@25kg"  "10x65kg"  "33,5+2kg"  "x@72,5kg"  "10/8@16,25kg"
// "6@36,25kg x2"  bodyweight "10, 8"  time "2:30"  notes "(text)"

const num = (s) => parseFloat(String(s).replace(",", "."));

const SET_RE = /(\d+(?:[,.]\d+)?(?:\/\d+)?|x)\s*[@x]\s*(-?\d+(?:[,.]\d+)?(?:\+\d+(?:[,.]\d+)?)?)\s*(?:kg|k)?(?:\s+x(\d+)\b)?/g;
const TIME_RE = /\b(\d+):(\d\d)\b/g;
const BARE_RE = /(?<![\d@,.])\b(\d+)\b(?![@\d.:x]|,\d)/g;

// Returns [{r: reps|null, w: kg|null, wl?: "33,5+2", t?: seconds}]
export function parseSets(txt) {
  const sets = [];
  let body = String(txt || "").replace(/\([^)]*\)/g, " ");
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
