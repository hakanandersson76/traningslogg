// Collects every Swedish source text that the UI can show, so the test can check
// that each locale has a translation. Swedish is the key (see public/i18n.js).
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// Read a JS string literal starting at src[i] (" ' or `). Returns [value, end] or
// null when it is a template with ${…} (dynamic, cannot be a key).
function literal(src, i) {
  const q = src[i];
  let s = "", j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") { const c = src[j + 1]; s += c === "n" ? "\n" : c; j += 2; continue; }
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") return null;
    s += src[j++];
  }
  return [s, j + 1];
}

// Split the argument list of a call starting right after "(" into top-level args.
function args(src, i) {
  const out = [];
  let depth = 0, start = i, j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      // skip any string, templates included (with nested ${})
      if (c === "`") {
        j++;
        let d = 0;
        while (j < src.length && !(src[j] === "`" && d === 0)) {
          if (src[j] === "\\") j++;
          else if (src[j] === "$" && src[j + 1] === "{") { d++; j++; }
          else if (src[j] === "}" && d > 0) d--;
          j++;
        }
        j++;
      } else j = literal(src, j)[1];
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) { out.push(src.slice(start, j).trim()); return out; }
      depth--;
    } else if (c === "," && depth === 0) { out.push(src.slice(start, j).trim()); start = j + 1; }
    j++;
  }
  return out;
}

const pure = (a) => {
  if (!a || !`"'\``.includes(a[0])) return null;
  const r = literal(a, 0);
  return r && r[1] === a.length ? r[0] : null;
};

// Calls of the translate functions: name -> which args are keys.
function fromCalls(src, names) {
  const keys = [];
  const re = new RegExp(`(?<![\\w$.])(${names.join("|")})\\(`, "g");
  let m;
  while ((m = re.exec(src))) {
    const a = args(src, m.index + m[0].length);
    const idx = m[1] === "_n" ? [1, 2] : [0];
    for (const k of idx) { const v = pure(a[k]); if (v) keys.push(v); }
  }
  return keys;
}

// String literals after a given pattern, e.g. `t:"…"` or `bad("…")`.
function after(src, re) {
  const keys = [];
  let m;
  while ((m = re.exec(src))) {
    const r = /["'`]/.test(src[m.index + m[0].length]) && literal(src, m.index + m[0].length);
    if (r) keys.push(r[0]);
  }
  return keys;
}

export function collectKeys() {
  const html = read("public/index.html");
  const script = html.slice(html.indexOf('<script type="module">'));
  const coach = read("public/coach.js");
  const server = read("src/worker.js") + read("src/auth.js") + read("src/ai.js");
  const keys = new Set();
  const add = (a) => a.forEach((k) => k && /\p{L}/u.test(k) && keys.add(k));

  add([...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]));
  add(fromCalls(script, ["_", "_n"]));
  add(fromCalls(coach, ["tx"]));
  // Texts stored first and translated where they are shown.
  add(after(script, /\bt:/g)); // flash / authMsg / notes
  add(after(script, /(?:setSync|setA\("\w+",)\(?/g));
  add(after(script, /(?:STATUS|PW_RULES)=[^;]*?\["?/g));
  add([...script.matchAll(/const STATUS=\{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/\["([^"]+)"/g)].map((x) => x[1])));
  add([...script.matchAll(/const PW_RULES=\[(.*?)\];/g)].flatMap((m) => [...m[1].matchAll(/\["([^"]+)"/g)].map((x) => x[1])));
  add([...script.matchAll(/btn\("[^"]+",x,([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((s) => !/^(pri|dan)$/.test(s))));
  add([...script.matchAll(/\|\|"([^"]+)"/g)].map((m) => m[1])); // e.message||"…"
  add(after(coach, /\bt: /g)); // SOURCES
  add(after(coach, /\blabel: /g)); // GOALS
  add(["Tumregel"]);
  add([...read("public/muscles.js").matchAll(/name: "([^"]+)"/g)].map((m) => m[1])); // muscle names // short source label; the others are author names + year
  add([...coach.matchAll(/GROUP_NAMES = \{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/: "([^"]+)"/g)].map((x) => x[1])));
  // Server messages shown to the user.
  add(after(server, /\bbad\(/g));
  add(after(server, /\bmessage: /g));
  add(after(server, /\berror: /g));
  add(after(server, /\breturn (?=["'`])/g).filter((s) => /\s/.test(s))); // passwordProblem
  // Any sentence-like literal (capital first, ends with . ! ?) in UI or server code.
  const sentences = (src) => [...src.matchAll(/"([A-ZÅÄÖ][^"<>{}=\n]*[.!?])"/g)].map((m) => m[1]);
  add(sentences(script));
  add(sentences(server));
  return [...keys].filter((k) => !/^(#|\d{6} )/.test(k) && !/^(application\/json|same-origin|content-type|SHA-256|admin|muscle|null)$/.test(k)).sort();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const en = (await import("../public/locales/en.js").catch(() => ({ default: {} }))).default;
  const keys = collectKeys();
  const missing = keys.filter((k) => !(k in en));
  console.log(process.argv.includes("--all") ? keys.join("\n") : missing.join("\n"));
  console.error(`${keys.length} keys, ${missing.length} missing in en`);
}
