"""Summarize an already completed canonical run; never executes or changes tests.
Usage: python docs/claude-ui-redesign/evidence/summarize-baseline.py --exit-code <observed code>
The supplied exit code must come from the actual command completion, not log inference.
"""
import argparse
import datetime as dt
import json
import pathlib
import re

parser = argparse.ArgumentParser()
parser.add_argument('--exit-code', type=int, required=True)
args = parser.parse_args()
out = pathlib.Path(__file__).resolve().parent
root = out.parents[2]
log = out / 'npm-test.log'
lines = log.read_text(encoding='utf-8').splitlines()
pkg = json.loads((root / 'package.json').read_text(encoding='utf-8'))
summaries, skips, failures, json_results = [], [], [], []
for n, text in enumerate(lines, 1):
    clean = text.strip()
    if re.search(r'\b\d+/\d+\b', clean) and not re.match(r'^(ok|PASS|>)\b', clean):
        summaries.append({'line': n, 'text': text})
    if clean.startswith('SKIP ') or re.match(r'^--\s+跳过', clean) or re.search(r'skipped=[1-9]\d*', clean):
        skips.append({'line': n, 'text': text})
    if re.match(r'^(FAIL\b|not ok\b|AssertionError\b)', clean):
        failures.append({'line': n, 'text': text})
    if clean.startswith('{'):
        try:
            value = json.loads(clean)
            if isinstance(value, dict) and 'passed' in value and 'failed' in value:
                json_results.append({'line': n, 'passed': value['passed'], 'failed': value['failed'], 'skipped': value.get('skipped'), 'layer': value.get('layer'), 'tool': value.get('tool')})
        except json.JSONDecodeError:
            pass
stat = log.stat()
created = getattr(stat, 'st_birthtime', stat.st_ctime)
tz = dt.timezone(dt.timedelta(hours=8))
report = {
    'command': 'npm test (PowerShell; UI-1 theme suite prepended; existing chain retained)',
    'observedExitCode': args.exit_code,
    'topLevelChainCommands': len(pkg['scripts']['test'].split(' && ')),
    'logCreatedAtShanghai': dt.datetime.fromtimestamp(created, tz).isoformat(),
    'logLastWriteAtShanghai': dt.datetime.fromtimestamp(stat.st_mtime, tz).isoformat(),
    'outputWindowSeconds': round(stat.st_mtime - created, 3),
    'durationNote': 'log creation to final write; excludes any silent command startup/teardown; approximate runtime only',
    'logBytes': stat.st_size,
    'numericSummaries': summaries,
    'jsonResultSummaries': json_results,
    'skipLines': skips,
    'failureMarkers': failures,
    'noCountPassedMarkers': [s for s in lines if re.fullmatch(r'(reliability|interactions|port-owner): passed', s.strip())],
    'countNote': 'Do not sum nested/JSON/printed results into a claimed canonical assertion total. Skip counts are outside printed passed/total denominators. Line references preserve the source evidence.'
}
(out / 'test-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
md = ['# Canonical npm test 实际结果', '',
      f'观察到的命令退出码：{args.exit_code}；入口命令链：{report["topLevelChainCommands"]} 条（含npm子入口）。', '',
      f'输出时窗：{report["logCreatedAtShanghai"]} 至 {report["logLastWriteAtShanghai"]}，约 {report["outputWindowSeconds"]} 秒。无声启动/清理不在此时窗内。', '',
      '以下保留每个打印的数字签名，不把嵌套或JSON结果再相加成一个虚构总断言数。未编号的reliability/interactions/port-owner通过另列。原始证据为同目录npm-test.log。', '',
      '| log行 | 原始数字摘要 |', '|---:|---|']
md.extend(f'| {r["line"]} | {r["text"].replace("|", " / ")} |' for r in summaries)
md += ['', '## JSON结果（避免与上表重复计数）', '', '```json', json.dumps(json_results, ensure_ascii=False, indent=2), '```', '', '## 明确跳过', '']
md.extend(f'- log:{r["line"]} {r["text"]}' for r in skips)
md += ['', '## 未打印断言数量的通过入口', ''] + [f'- {s}' for s in report['noCountPassedMarkers']]
md += ['', '## 失败标记', '', f'匹配FAIL/not ok/AssertionError起始行：{len(failures)}。实际退出码才是整条命令结果；负向fixture中的“失败”文字不自动判为失败。', '']
(out / 'test-summary.md').write_text('\n'.join(md), encoding='utf-8')
print(json.dumps({'exitCode': args.exit_code, 'resultSignatures': len(summaries), 'skipLines': len(skips), 'failureMarkers': len(failures), 'outputWindowSeconds': report['outputWindowSeconds']}))
