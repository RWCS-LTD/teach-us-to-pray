"""Checks to run before every release. Usage: python tools/verify.py [--zip path]

1. Bundled Scripture equals a fresh extraction from the source.
2. Every verse reference in every language file exists in its Scripture file.
3. The service worker lists exactly the files that are shipped.
4. The shipped files total less than 100 KB.
5. No shipped file contains the doxology, cookie code, or an outside address to load.
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

# 1
r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_scripture.py"), "--check", *sys.argv[1:]],
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
