from pathlib import Path
import re, json, unicodedata
from urllib.parse import unquote

root = Path(__file__).resolve().parents[3]
files = ['docs/T4-B-design.md', 'docs/T4-B-acceptance.md', 'docs/README.md', 'docs/git-changes.md', 'docs/security.md', 'docs/testing.md']
count = 0
errors = []
for rel in files:
    doc = root / rel
    for match in re.finditer(r'(?<!!)\[[^\]\n]*\]\(([^)\n]+)\)', doc.read_text(encoding='utf-8-sig')):
        link = match.group(1).split(' "', 1)[0].strip('<>')
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', link):
            continue
        pathpart, _, anchor = link.partition('#')
        target = (doc.parent / unquote(pathpart)).resolve() if pathpart else doc
        count += 1
        if not target.exists():
            errors.append({'doc': rel, 'link': link, 'reason': 'missing file'})
        elif anchor and target.suffix == '.md':
            headings = []
            for h in re.findall(r'^#{1,6}\s+(.+)$', target.read_text(encoding='utf-8-sig'), re.M):
                h = h.strip().lower().replace('`', '')
                h = ''.join(c for c in h if c.isalnum() or c in ['_', '-', ' '])
                headings.append(h.replace(' ', '-'))
            if unquote(anchor) not in headings:
                errors.append({'doc': rel, 'link': link, 'reason': 'missing heading'})
result = {'relativeLinksAndAnchors': count, 'passed': count-len(errors), 'failed': len(errors), 'errors': errors}
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(1 if errors else 0)
