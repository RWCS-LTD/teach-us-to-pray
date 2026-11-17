"""Checks to run before every release. Usage: python tools/verify.py [--zip path]

1. Bundled Scripture equals a fresh extraction from the source.
2. Every verse reference in every language file exists in its Scripture file.
3. The service worker lists exactly the files that are shipped.
4. The shipped files total less than 100 KB.
5. No shipped file contains the doxology, cookie code, or an outside address to load.
6. Every excerpt the app shows has balanced quotation marks once trimmed by the
   same rule as trimQuotes in js/app.js. The one exception is a speech that
   begins partway into an excerpt and runs on past it. Use --quotes to print every excerpt the
   rule changes, before and after.
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHIPPED_DIRS = ["css", "js", "lang", "scripture", "icons"]
SHIPPED_FILES = ["index.html", "manifest.webmanifest", "sw.js"]
BUDGET = 100 * 1024
problems = []
SHOW_QUOTES = "--quotes" in sys.argv
ARGS = [a for a in sys.argv[1:] if a != "--quotes"]


def strays(t):
    """Unmatched double and single quotation marks, by position."""
    letter = lambda c: c.isalpha()
    stray_d, stray_s, open_d, open_s = set(), set(), [], []
    for i, c in enumerate(t):
        if c == "“":
            open_d.append(i)
        elif c == "”":
            open_d.pop() if open_d else stray_d.add(i)
        elif c == "‘":
            open_s.append(i)
        elif c == "’" and not (i > 0 and letter(t[i - 1]) and i + 1 < len(t) and letter(t[i + 1])):
            open_s.pop() if open_s else stray_s.add(i)
    stray_d.update(open_d)
    stray_s.update(open_s)
    return stray_d, stray_s


def trim_quotes(t):
    """Same rule as trimQuotes in js/app.js: drop an unmatched mark at the very start or end of the excerpt."""
    stray_d, stray_s = strays(t)
    drop = {i for i in stray_d if i in (0, len(t) - 1)}
    for i in list(drop):
        if t[i] == "“" and i + 1 in stray_s:
            drop.add(i + 1)
        if t[i] == "”" and i - 1 in stray_s:
            drop.add(i - 1)
    return "".join(c for i, c in enumerate(t) if i not in drop)


def balanced(t):
    """After trimming, the only unmatched mark allowed is an opening one after the start of
    the excerpt (a speech that begins here and runs on), with a single mark directly after it."""
    stray_d, stray_s = strays(t)
    allowed_d = {i for i in stray_d if t[i] == "“" and i > 0}
    allowed_s = {i + 1 for i in allowed_d if t[i + 1:i + 2] == "‘"}
    return stray_d <= allowed_d and stray_s <= allowed_s


def excerpts(L):
    """Every group of verses the app shows as one excerpt."""
    yield from ([r] for r in L["welcome"]["verses"])
    yield from (s["verses"] for s in L["why"]["sections"])
    yield L["guide"]["introVerses"]
    for st in L["steps"]:
        yield from st["verses"]
        yield from st["related"]
        yield from (q["example"] for q in st["guided"] if q.get("example"))

# 1
r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_scripture.py"), "--check", *ARGS],
                   capture_output=True, text=True)
print("scripture:", (r.stdout or r.stderr).strip())
if r.returncode:
    problems.append("scripture does not match source")

# 2
for lang_file in sorted((ROOT / "lang").glob("*.json")):
    text = lang_file.read_text(encoding="utf-8")
    L = json.loads(text)
    V = json.loads((ROOT / L["meta"]["scriptureFile"]).read_text(encoding="utf-8"))["verses"]
    refs = set(re.findall(r'"([A-Z0-9]{3} \d+:\d+[ab]?)"', text))
    missing = sorted(refs - set(V))
    unknown_books = sorted({ref.split()[0] for ref in refs} - set(L["books"]))
    print(f"{lang_file.name}: {len(refs)} references, {len(missing)} missing")
    if missing or unknown_books:
        problems.append(f"{lang_file.name}: missing {missing}, books without a name {unknown_books}")
        continue

    # 6
    changed = 0
    for group in excerpts(L):
        before = " ".join(V[r] for r in group)
        after = trim_quotes(before)
        label = f"{group[0]}" + (f"-{group[-1].split(':')[1]}" if len(group) > 1 else "")
        if after != before:
            changed += 1
            if SHOW_QUOTES:
                sys.stdout.reconfigure(encoding="utf-8")
                print(f"\n{label}\n  before: {before}\n  after:  {after}")
        if not balanced(after):
            problems.append(f"{lang_file.name}: unbalanced quotation marks in {label}: {after}")
    print(f"{lang_file.name}: quotation marks trimmed in {changed} excerpts")

# 3 and 4
shipped = [ROOT / f for f in SHIPPED_FILES] + [p for d in SHIPPED_DIRS for p in (ROOT / d).rglob("*") if p.is_file()]
names = {p.relative_to(ROOT).as_posix() for p in shipped}
listed = set(re.findall(r"'([^']+\.[a-z]+)'", (ROOT / "sw.js").read_text(encoding="utf-8")))
if names - {"sw.js"} != listed:
    problems.append(f"sw.js file list differs: {sorted((names - {'sw.js'}) ^ listed)}")
total = sum(p.stat().st_size for p in shipped)
print(f"size: {total / 1024:.1f} KB of {BUDGET // 1024} KB in {len(shipped)} files")
if total > BUDGET:
    problems.append("over the size budget")

# 5
for p in shipped:
    if p.suffix == ".png":
        continue
    text = p.read_text(encoding="utf-8")
    if "For yours is the Kingdom" in text:
        problems.append(f"doxology found in {p.name}")
    if p.suffix in (".js", ".html", ".css"):
        if "document.cookie" in text:
            problems.append(f"cookie code in {p.name}")
        if re.search(r"https?://", text):
            problems.append(f"outside address in {p.name}")

print("FAILED:\n- " + "\n- ".join(problems) if problems else "ALL CHECKS PASSED")
sys.exit(1 if problems else 0)
