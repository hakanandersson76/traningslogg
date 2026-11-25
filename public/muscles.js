// Which muscles an exercise trains, read from the free-text name.
// A rule list (Swedish and English words, the way people write in their notes)
// gives primary muscles (count as a full set) and secondary muscles (count as
// half a set, the "fractional" counting in Pelland 2024). The user can override
// any exercise in the app; overrides win over the rules.

// Muscles, with the coarse group used for session types and frequency.
export const MUSCLES = {
  bröst: { name: "Bröst", group: "bröst" },
  rygg: { name: "Rygg", group: "rygg" },
  trapets: { name: "Trapets", group: "rygg" },
  axlar: { name: "Axlar", group: "axlar" },
  bakaxlar: { name: "Bakre axlar", group: "axlar" },
  biceps: { name: "Biceps", group: "armar" },
  triceps: { name: "Triceps", group: "armar" },
  underarmar: { name: "Underarmar", group: "armar" },
  framlår: { name: "Framsida lår", group: "ben" },
  baklår: { name: "Baksida lår", group: "ben" },
  säte: { name: "Säte", group: "ben" },
  höft: { name: "Höft (in/ut)", group: "ben" },
  vader: { name: "Vader", group: "ben" },
  bål: { name: "Bål", group: "core" },
};
// Muscles the weekly volume target applies to (the big ones).
export const MAIN = ["bröst", "rygg", "axlar", "biceps", "triceps", "framlår", "baklår", "säte"];

// Ordered: the first matching rule wins (legs before "curl", triceps before "bänk").
// c = compound (multi-joint) lift.
const R = (re, p, s = [], c = false) => ({ re, p, s, c });
const RULES = [
  R(/underarm|wrist|handled/, ["underarmar"]),
  R(/jefferson/, ["baklår"], ["säte", "rygg"], true),
  R(/hamstring|leg ?curl|lårcurl|nordic|baklår/, ["baklår"]),
  R(/rdl|rumänsk|stiff|good ?morning/, ["baklår", "säte"], ["rygg"], true),
  R(/marklyft|deadlift/, ["säte", "baklår"], ["framlår", "rygg", "trapets"], true),
  R(/hip ?ab\w*.*\(in\)|adduct|adduktor|inåt/, ["höft"]),
  R(/hip ?ab|abduct|abduktor|clam/, ["höft"], ["säte"]),
  R(/glute|hip ?thrust|höftlyft|säte|kickback|hip ?ext/, ["säte"], ["baklår"], true),
  R(/leg ?ext|benspark|knästräck/, ["framlår"]),
  R(/squat|knäböj|benpress|leg ?press|hack|utfall|lunge|split|step ?up|bulgar|goblet/, ["framlår", "säte"], ["höft", "baklår"], true),
  R(/vad|calf/, ["vader"]),
  R(/mage|plank|maghjul|crunch|sit-?up|\babs?\b|dead ?bug|pallof|bål|ab ?wheel|rygglyft|back ?ext|hollow/, ["bål"]),
  R(/face ?pull|rear ?delt|bakre axel|reverse fly|omvänd fly/, ["bakaxlar"], ["trapets"]),
  R(/rotat|rotator|external rot/, ["bakaxlar"]),
  R(/shrug|axelryck/, ["trapets"]),
  R(/landmine press/, ["axlar", "bröst"], ["triceps"], true),
  R(/axelpress|shoulder press|military|overhead press|\bohp\b|arnold|militärpress/, ["axlar"], ["triceps"], true),
  R(/lateral|sidolyft|side raise|front ?raise|framlyft|axellyft/, ["axlar"]),
  R(/tricep|skull|pushdown|french|nedpress/, ["triceps"]),
  R(/bicep|preacher|hammer|\bcurl/, ["biceps"], ["underarmar"]),
  R(/\bdips/, ["bröst", "triceps"], ["axlar"], true),
  R(/fly|flyes|pec ?deck|crossover|cable cross/, ["bröst"], ["axlar"]),
  R(/bänk|bench|bröstpress|chest ?press|incline|push-?up|armhävning|bröst/, ["bröst"], ["triceps", "axlar"], true),
  R(/pulldown|latsdrag|chin|pull-?up|\blats?\b|pullover/, ["rygg"], ["biceps"], true),
  R(/rodd|\brow\b|rowing/, ["rygg"], ["biceps", "bakaxlar"], true),
  R(/scapular|skulderblad/, ["rygg"], ["trapets"]),
];

let OVERRIDES = {}; // name (lower case) -> { p: [...], s: [...] }
export function setMuscleOverrides(map) {
  OVERRIDES = {};
  for (const [n, v] of Object.entries(map || {})) OVERRIDES[n.toLowerCase().trim()] = v;
}

// { p: primary muscles, s: secondary, c: compound, known: from rules/override }
export function musclesOf(name) {
  const n = String(name || "").toLowerCase().trim();
  const o = OVERRIDES[n];
  const rule = RULES.find((r) => r.re.test(n));
  if (o && o.p?.length) return { p: [...o.p], s: [...(o.s || [])], c: o.c ?? rule?.c ?? false, known: true, own: true };
  if (rule) return { p: [...rule.p], s: [...rule.s], c: rule.c, known: true, own: false };
  return { p: [], s: [], c: false, known: false, own: false };
}

// Suggestions to vary with when the user hasn't done an alternative before.
// Named the way they could appear in a gym log.
export const CATALOG = [
  "Bänkpress", "Bänkpress (incline hantel)", "Bröstpress (maskin)", "Dips", "Flyes (kabel)",
  "Kabelrodd", "Hantelrodd", "Pulldown (bred stång)", "Chins",
  "Axelpress (hantel sittande)", "Lateral raises (hantel)", "Lateral raises (kabelmaskin)",
  "Face pulls", "Rear deltoid", "Omvänd flyes (hantel)",
  "Bicepscurl (hantel)", "Preacher curl", "Hammercurl (hantel)",
  "Tricepspress (kabelmaskin)", "Tricepspress (rep över huvud)", "Skull crushers",
  "Squats", "Benpress", "Leg extensions", "Utfall (bulgariska)",
  "RDLs (fri stång)", "Hamstring curl", "Leg curl (liggande)",
  "Glute drive", "Hip thrust",
  "Vadpress (maskin)", "Calf raises (smith)",
  "Hip abductor (ut)", "Hip abductor (in)",
  "Plankan", "Maghjul", "Mage (maskin)", "Pallof press",
];
