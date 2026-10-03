/* Session HTML is created outside the workspace, downloaded, then removed. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { json } from './http-utils.js';

export function createSessionExport({ rpc, runtime, resolvePackageDir }) {
  async function supportsOutputPath() {
    try {
      const dir = resolvePackageDir();
      if (!dir) return false;
      const file = path.join(dir, 'dist', 'modes', 'rpc', 'rpc-types.d.ts');
      if ((await fs.stat(file)).size > 512 * 1024) return false;
      const text = await fs.readFile(file, 'utf8');
      return /type:\s*["']export_html["']\s*;\s*outputPath\?\s*:\s*string/.test(text);
    } catch { return false; }
  }

  async function handle(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
    const cwd = runtime.getCurrentCwd();
    const run = rpc.getState().bridgeRun;
    if (!cwd) return json(res, 409, { ok: false, error: '请先选择项目' });
    const relativeTemp = path.relative(cwd, os.tmpdir());
    if (!relativeTemp || (!relativeTemp.startsWith('..' + path.sep) && relativeTemp !== '..' && !path.isAbsolute(relativeTemp))) {
      return json(res, 409, { ok: false, error: '系统临时目录位于当前项目内，无法安全导出。请选择项目外的工作目录。' });
    }
    if (!await supportsOutputPath()) return json(res, 409, { ok: false, error: '当前 Pi 未确认支持项目外导出（outputPath），请使用支持此能力的 Pi。' });
    let dir;
    try {
      // Never accept an output path from the Web renderer.
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-gui-export-'));
      const outputPath = path.join(dir, 'session.html');
      if (runtime.getCurrentCwd() !== cwd || rpc.getState().bridgeRun !== run) throw new Error('stale');
      const result = await rpc.request({ type: 'export_html', outputPath, __bridgeRun: run }, { timeoutMs: 30_000 });
      if (!result || result.__error || typeof result.path !== 'string' || path.resolve(result.path) !== outputPath) throw new Error('export-failed');
      if (runtime.getCurrentCwd() !== cwd || rpc.getState().bridgeRun !== run) throw new Error('stale');
      const stat = await fs.lstat(outputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('invalid-file');
      const html = await fs.readFile(outputPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="pi-session.html"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': html.length,
      });
      res.end(html);
    } catch {
      return json(res, 502, { ok: false, error: '会话导出失败或项目已切换；未在项目目录创建导出文件。' });
    } finally {
      if (dir) {
        try { await fs.rm(dir, { recursive: true, force: true }); }
        catch {
          // The response may already be sent. Do not terminate the server or log session paths.
          console.warn('会话导出临时文件清理失败，请检查系统临时目录权限。');
        }
      }
    }
  }
  return { handle };
}
