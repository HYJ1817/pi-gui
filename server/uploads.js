/* 附件上传。
 *
 * 上传走裸二进制（文件名放 query），省掉 multipart 解析 —— 见 http-utils.js
 * 的 readRawBody。
 *
 * 落盘位置由调用方传入（DATA_DIR 的唯一权威在 server.js），这里不自己算 ——
 * 否则打包形态一变（源码 / SEA / Electron），就有第二处需要跟着改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { extract, clampInline, maxBytes } from '../lib/extract.js';
import { json, readRawBody } from './http-utils.js';

// 去掉路径分隔符和控制字符，避免文件名穿越目录
export function safeName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'file';
}

/**
 * @param dataDir 数据目录（projects.json 与 .uploads 都在这里）
 */
export function createUploads({ dataDir }) {
  const UPLOAD_DIR = path.join(dataDir, '.uploads');

  function handle(req, res, url) {
    const rawName = url.searchParams.get('name') || 'file';
    const name = safeName(decodeURIComponent(rawName));

    readRawBody(req, maxBytes())
      .then(async (buf) => {
        if (!buf.length) return json(res, 400, { ok: false, error: '文件内容为空' });

        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const stored = `${stamp}_${name}`;
        const filePath = path.join(UPLOAD_DIR, stored);
        fs.writeFileSync(filePath, buf);

        let result;
        try {
          result = await extract(filePath, name);
        } catch (err) {
          return json(res, 200, {
            ok: true,
            id: stored,
            name,
            size: buf.length,
            path: filePath,
            kind: 'binary',
            error: err.message,
          });
        }

        const payload = {
          ok: true,
          id: stored,
          name,
          size: buf.length,
          path: filePath,
          kind: result.kind,
          pages: result.pages ?? null,
          note: result.note || '',
        };

        if (result.kind === 'text') {
          const { text, truncated } = clampInline(result.text);
          payload.chars = result.text.length;
          payload.truncated = truncated;
          payload.text = text;
          payload.preview = result.text.slice(0, 160).replace(/\s+/g, ' ');
        }

        return json(res, 200, payload);
      })
      .catch((err) => json(res, 400, { ok: false, error: String(err.message) }));
  }

  return { handle, uploadDir: UPLOAD_DIR, safeName };
}
