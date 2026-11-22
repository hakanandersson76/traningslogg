import re, json, sys

src = open(sys.argv[1], encoding="utf-8").read().splitlines()

NAME_MAP = {
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
}
TAGS = {"ÖK": "Överkropp", "NK": "Nederkropp", "UK": "Underkropp", "HK": "Helkropp", "FK": "FK"}

def num(s):
    return float(s.replace(",", "."))

def split_name(line):
    depth = 0
    for i, ch in enumerate(line):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0:
            prev = line[i - 1] if i else " "
            if ch.isdigit() and not (prev.isalnum()):
                return line[:i].strip(), line[i:].strip()
            if ch == "x" and line[i + 1:i + 2] == "@" and prev == " ":
                return line[:i].strip(), line[i:].strip()
    return line.strip(), ""

SET_RE = re.compile(
    r"(?P<reps>\d+(?:[,.]\d+)?(?:/\d+)?|x)\s*[@x]\s*"
    r"(?P<w>-?\d+(?:,\d+)?(?:\+\d+(?:,\d+)?)?)\s*(?:kg|k)?"
    r"(?:\s+x(?P<mult>\d+)\b)?"
)
TIME_RE = re.compile(r"\b(\d+):(\d\d)\b")
BARE_RE = re.compile(r"(?<![\d@,.])\b(\d+)\b(?![@\d.:x]|,\d)")

sessions = []
cur = None
for raw in src:
    line = raw.strip()
    if not line or line.startswith("Träning gym"):
        continue
    m = re.match(r"^(\d{2})(\d{2})(\d{2})\s*(.*)$", line)
    if m:
        yy, mm, dd, rest = m.groups()
        fixed = yy != "26"
        tag, note = "", ""
        t = re.match(r"^(ÖK|NK|UK|HK|FK)\b\s*(.*)$", rest)
        if t:
            tag, note = t.group(1), t.group(2).strip("() ")
        cur = {"date": f"2026-{mm}-{dd}", "tag": tag, "note": note,
               "exercises": [], "dateFixed": fixed}
        sessions.append(cur)
        continue
    name, rest = split_name(line)
    name = NAME_MAP.get(name, name)
    notes = re.findall(r"\(([^)]*)\)", rest)
    body = re.sub(r"\([^)]*\)", " ", rest)
    sets = []
    for sm in SET_RE.finditer(body):
        reps = sm.group("reps")
        wraw = sm.group("w")
        parts = wraw.split("+")
        w = sum(num(p) for p in parts)
        if wraw == "31,52":
            w = 31.25
        s = {"reps": None if reps == "x" else (num(reps.split("/")[0])),
             "w": round(w, 2)}
        if "/" in reps:
            s["repsLabel"] = reps
        if "+" in wraw:
            s["wLabel"] = wraw.replace(",", ".")
        for _ in range(int(sm.group("mult") or 1)):
            sets.append(dict(s))
    body2 = SET_RE.sub(" ", body)
    for tm in TIME_RE.finditer(body2):
        sets.append({"time": int(tm.group(1)) * 60 + int(tm.group(2))})
    body3 = TIME_RE.sub(" ", body2)
    if not any("w" in s for s in sets):
        for bm in BARE_RE.finditer(body3):
            sets.append({"reps": int(bm.group(1)), "w": None})
    cur["exercises"].append({"name": name, "sets": sets,
                             "note": "; ".join(n for n in notes if n),
                             "raw": line})

for s in sessions:
    s["exercises"] = [e for e in s["exercises"] if e["name"]]
sessions.sort(key=lambda s: s["date"])
json.dump(sessions, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)

# report
names = {}
for s in sessions:
    for e in s["exercises"]:
        names[e["name"]] = names.get(e["name"], 0) + 1
        if not e["sets"]:
            print("NO SETS:", s["date"], e["raw"])
print(len(sessions), "sessions,", len(names), "exercises")
print("fixed dates:", [s["date"] for s in sessions if s["dateFixed"]])
for n, c in sorted(names.items()):
    print(f"{c:3} {n}")
