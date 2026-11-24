// Translations. Swedish is the source language: t("Logga pass") returns the text in
// the current language. Each other language is a dictionary from the Swedish text
// to its translation (locales/<code>.js). A missing translation falls back to
// English, then Swedish, so a new language can be added gradually.
//
// To add a language: create public/locales/<code>.js exporting a dictionary like
// locales/en.js, add it to LANGS and DICTS below, and fill in DATE_NAMES.
import en from "./locales/en.js";

export const LANGS = { sv: "Svenska", en: "English" };
const DICTS = { sv: {}, en };
const DATE_NAMES = {
  sv: { wd: ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"], mo: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"], decimal: "," },
  en: { wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], mo: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], decimal: "." },
};

let lang = "sv";
export const getLang = () => lang;
export function setLang(l) {
  lang = LANGS[l] ? l : "en";
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  return lang;
}

// Language from the iPhone/browser settings: first supported language in the
// preferred list ("sv-SE" → sv), otherwise English.
export function detectLang(list) {
  const prefs = list || (typeof navigator !== "undefined" ? navigator.languages || [navigator.language] : []);
  for (const p of prefs) {
    const code = String(p || "").toLowerCase().split(/[-_]/)[0];
    if (LANGS[code]) return code;
  }
  return "en";
}

// t("Hej {name}!", { name }) — placeholders in {braces}.
export function t(sv, vars) {
  let s = sv;
  if (lang !== "sv") s = DICTS[lang]?.[sv] ?? DICTS.en[sv] ?? sv;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}
// tn(n, "{n} pass", "{n} pass") — singular/plural.
export const tn = (n, one, many, vars = {}) => t(n === 1 ? one : many, { n: fmtNum(n), ...vars });

export const weekdays = () => DATE_NAMES[lang]?.wd || DATE_NAMES.en.wd;
export const months = () => DATE_NAMES[lang]?.mo || DATE_NAMES.en.mo;
// Numbers with the language's decimal separator: 22,5 (sv) / 22.5 (en).
export const fmtNum = (x) => String(Math.round(x * 100) / 100).replace(".", (DATE_NAMES[lang] || DATE_NAMES.en).decimal);

// Session types are stored as ÖK/NK/HK; shown with language-specific labels.
const TAG_LABELS = {
  sv: { ÖK: ["ÖK", "Överkropp"], NK: ["NK", "Nederkropp"], HK: ["HK", "Helkropp"], "": ["Pass", "Pass"] },
  en: { ÖK: ["UB", "Upper body"], NK: ["LB", "Lower body"], HK: ["FB", "Full body"], "": ["Session", "Session"] },
};
export const tagShort = (tag) => (TAG_LABELS[lang] || TAG_LABELS.en)[tag in TAG_LABELS.sv ? tag : ""][0];
export const tagName = (tag) => (TAG_LABELS[lang] || TAG_LABELS.en)[tag in TAG_LABELS.sv ? tag : ""][1];

// For tests: every Swedish text that has no translation in a language.
export const _dicts = DICTS;
