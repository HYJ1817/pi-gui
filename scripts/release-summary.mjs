/* Release 摘要：一份短的人类可读版本说明，不做长期 CHANGELOG。
 *
 * .github/release-summary.md 只描述“当前准备发布的版本”。正式 Release 发布后，
 * 历史说明保存在 GitHub Release 页面；下一次发版时覆写这一个文件即可。
 *
 * 文件首行带版本标记，版本一致性校验会检查它，避免把上一版摘要原样带进下一版。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.mjs';

export const RELEASE_SUMMARY_REL = '.github/release-summary.md';
const MARKER_RE = /^<!--\s*pi-gui-release-summary:\s*([^\s]+)\s*-->\s*/;

/** 解析摘要文本。 */
export function parseReleaseSummary(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Release 摘要是空的');

  const match = raw.match(MARKER_RE);
  if (!match) {
    throw new Error(
      'Release 摘要首行缺少版本标记：<!-- pi-gui-release-summary: <版本> -->'
    );
  }

  const body = raw.slice(match[0].length).trim();
  if (!body) throw new Error('Release 摘要只有版本标记，没有正文');

  return { version: match[1], body };
}

/** 读取并要求摘要版本与当前版本完全一致。 */
export function readReleaseSummary({ expectedVersion, root = ROOT, filePath = null } = {}) {
  if (!expectedVersion) throw new Error('读取 Release 摘要时必须给 expectedVersion');
  const target = filePath || path.join(root, RELEASE_SUMMARY_REL);

  if (!fs.existsSync(target)) {
    throw new Error(
      `缺少 Release 摘要：${path.relative(root, target) || target}（发版前写 3–6 条用户能看懂的变化）`
    );
  }

  const parsed = parseReleaseSummary(fs.readFileSync(target, 'utf8'));
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `Release 摘要版本与 package.json 不一致：${JSON.stringify(parsed.version)} ≠ ${JSON.stringify(expectedVersion)}`
    );
  }
  return { ...parsed, path: target };
}
