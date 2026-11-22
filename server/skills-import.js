/* 从本机导入技能：单个 .md 文件，或整个技能目录（连同附属资源）。
 *
 * 分两步，中间隔着用户的确认：
 *   stage   浏览器把选中的文件传上来 → 完整校验 → 暂存在内存里，返回一份「将要导入什么」的清单；
 *   commit  用户选好位置与名字后，凭暂存令牌落盘。
 * 这样落盘的字节一定就是用户看过清单的那一份，前端也没有机会在第二步换掉内容或带上路径。
 *
 * 暂存只在内存里，有数量、总大小与时间上限；不写任何临时文件。 */
import { Buffer } from 'node:buffer';
import { sanitizeSkillSlug } from './skills-document.js';
import { BUNDLE_LIMITS, createTokenStore, displayPath, validateBundle } from './skills-files.js';
import { fail } from './skills-manage.js';

const SKILL_FILE = 'SKILL.md';
const STAGE_TTL_MS = 15 * 60 * 1000;
const STAGE_MAX_ENTRIES = 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TOO_BIG = new Set(['too-large', 'file-too-large', 'too-many-files']);

/** 上传体的上限：包的总大小上限经 base64 膨胀 4/3，再留出路径与 JSON 结构的余量。 */
export const IMPORT_BODY_LIMIT = Math.ceil((BUNDLE_LIMITS.maxTotalBytes * 4) / 3) + 2 * 1024 * 1024;

/**
 * @param manager  skills-manage.js 的管理器（校验与落盘都交给它）
 * @param now      毫秒时钟，测试注入（暂存的过期按它算）
 */
export function createSkillsImport({ manager, now = Date.now }) {
  const stages = createTokenStore({
    ttlMs: STAGE_TTL_MS,
    maxEntries: STAGE_MAX_ENTRIES,
    maxBytes: STAGE_MAX_ENTRIES * BUNDLE_LIMITS.maxTotalBytes,
    now,
  });

  function decodeUpload(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return fail(400, 'empty', '没有可导入的文件');
    if (entries.length > BUNDLE_LIMITS.maxRawEntries) return fail(413, 'too-many-files', `文件太多（上限 ${BUNDLE_LIMITS.maxFiles} 个）`);
    const files = [];
    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.data !== 'string') return fail(400, 'bad-data', '上传的文件格式不对');
      if (entry.data.length % 4 !== 0 || !BASE64.test(entry.data)) return fail(400, 'bad-data', `文件内容不合法：${displayPath(entry.path)}`);
      files.push({ path: entry.path, bytes: Buffer.from(entry.data, 'base64') });
    }
    return { ok: true, files };
  }

  /**
   * @param payload { kind:'file'|'dir', dirName?, files:[{ path, data(base64) }] }
   *   file：只有一个 .md，存成 SKILL.md；
   *   dir ：path 是相对所选目录的路径（前端已去掉所选目录那一层），dirName 是所选目录的名字。
   */
  function stage(payload) {
    if (!payload || (payload.kind !== 'file' && payload.kind !== 'dir')) return fail(400, 'bad-request', 'kind 只能是 file 或 dir');
    const upload = decodeUpload(payload.files);
    if (!upload.ok) return upload;
    let bundle = upload.files;
    let nameHint = typeof payload.dirName === 'string' ? payload.dirName : '';
    if (payload.kind === 'file') {
      if (bundle.length !== 1) return fail(400, 'bad-request', '一次只能导入一个文件');
      const fileName = bundle[0].path.split(/[\\/]/).pop() || '';
      if (!/\.md$/i.test(fileName)) return fail(400, 'not-markdown', '请选择一个 .md 文件（通常是 SKILL.md）');
      const stem = fileName.replace(/\.md$/i, '');
      nameHint = /^skill$/i.test(stem) ? '' : stem;
      bundle = [{ path: SKILL_FILE, bytes: bundle[0].bytes }];
    }
    const checked = validateBundle(bundle);
    if (!checked.ok) return fail(TOO_BIG.has(checked.code) ? 413 : 400, checked.code, checked.error);
    const inspected = manager.inspectBundle(checked.files);
    if (!inspected.ok) return inspected;
    const stageId = stages.put({ files: checked.files }, checked.totalBytes);
    return {
      ok: true,
      stageId,
      plan: {
        kind: payload.kind,
        suggestedName: sanitizeSkillSlug(inspected.name) || sanitizeSkillSlug(nameHint),
        declaredName: inspected.name,
        description: inspected.description,
        fileCount: checked.files.length,
        totalBytes: checked.totalBytes,
        files: checked.files.map((file) => ({ path: file.path, size: file.bytes.length })),
        skipped: checked.skipped,
        problems: inspected.problems,
      },
    };
  }

  /** @param payload { stageId, target, name, onConflict } */
  async function commit(context, payload) {
    const staged = stages.get(payload && payload.stageId);
    if (!staged) return fail(410, 'stage-expired', '这次导入已经过期，请重新选择文件');
    const result = await manager.install(context, {
      targetKey: payload.target,
      name: payload.name,
      files: staged.files,
      onConflict: payload.onConflict || 'fail',
    });
    // 失败（比如同名冲突）时暂存要留着：用户选完「覆盖 / 保留两者」还要再提交一次
    if (result.ok) stages.delete(payload.stageId);
    return result;
  }

  return { stage, commit };
}
