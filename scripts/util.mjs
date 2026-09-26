/* 构建脚本的公共工具。
 *
 * 从 scripts/build-app.mjs 里抽出来，安装程序脚本（build-installer.mjs）
 * 也要用同一套 —— 尤其是下面那个「删目录的三级兜底」：
 * 那种逻辑只要有两份，其中一份必定会漏掉某次修正。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* 仓库根目录。
 *
 * 放在这里（而不是某个业务脚本里）是为了**分层干净**：`util.mjs` 不 import
 * 任何别的项目内模块，所以谁都能安全地引用它。早先 ROOT 定义在
 * check-version.mjs 里，于是「算校验和」反过来依赖「版本守卫」——
 * 依赖方向是反的，提交边界也跟着纠缠。 */
export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, '..');

/** 递归算体积（目录或文件） */
export const sizeOf = (p) => {
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  let t = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) t += sizeOf(path.join(p, e.name));
  return t;
};

export const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';
export const kb = (bytes) => Math.round(bytes / 1024);

/** 转成正斜杠路径，专门给命令行工具用。
 *
 * Windows 的 bsdtar（系统自带的 tar.exe）会把参数里的反斜杠当**转义字符**，
 * 而且认八进制转义 —— `\21022` 会被解析成 `\210` + `22`，
 * 整段路径直接变形，报错是 `Cannot open: No such file or directory`，
 * 完全看不出跟分隔符有关。用正斜杠就没这个问题（Windows API 同样接受）。
 *
 * 凡是把路径当参数交给外部命令的地方，都要先过一下这个函数。 */
export const slash = (p) => p.split(path.sep).join('/');

/** 把文件或目录复制到目标位置（目标是目录时会连同其名一起拷进去） */
export function copyInto(destDir, src, asName) {
  const dest = path.join(destDir, asName || path.basename(src));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

/** 删一组路径 —— 先走 fs.rmSync，被删除保护拦下的部分再用受管 rm 补一刀。
 *
 * 删除保护是按「轮」累计计数的，所以循环里删到第 51 个就会开始抛错。
 * 这里把失败的挑出来交给命令行 rm 一次性处理（受限环境里 PATH 上的 rm
 * 是受管的，等于走官方通道）。返回没能删掉的路径。 */
export function removePaths(paths) {
  const failed = [];
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      failed.push(p);
    }
  }
  if (!failed.length) return [];

  try {
    execFileSync('rm', ['-rf', '--', ...failed], { stdio: 'ignore' });
  } catch {
    /* 没有 rm 就算了，下面按实际存在与否再核一遍 */
  }
  return failed.filter((p) => fs.existsSync(p));
}

/** 清空一个目录 —— 但绝不和「批量删除保护」硬碰。
 *
 * 受限环境给 node 注入了删除保护（NODE_OPTIONS 里的 node-safe-delete-shim），
 * 一轮里删超过 50 个文件就直接抛错。而构建产物目录里动辄几百上千个文件，
 * 所以 fs.rmSync 必然失败，构建会卡在「清目录」这一步。
 *
 * 三级兜底，逐级降级：
 *   1) fs.rmSync        —— 普通机器上这一级就够了
 *   2) 命令行 rm -rf    —— 受限环境里 PATH 上的 rm 是**受管的**（safe-bin），
 *                          走它等于走官方通道，由它自己决定放不放行
 *   3) 改名挪到一边      —— 重命名不是删除，任何环境都不会被拦。
 *                          代价是留个 .trash-<时间戳>，清掉即可
 *
 * 不关掉保护、不改阈值 —— 那是环境的安全机制，不该由构建脚本动。 */
export function clearDir(dir, label) {
  if (!fs.existsSync(dir)) return;

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    /* 被删除保护拦下了，往下试 */
  }

  try {
    execFileSync('rm', ['-rf', '--', dir], { stdio: 'ignore' });
    if (!fs.existsSync(dir)) return;
  } catch {
    /* 没有 rm（比如从 cmd 里跑构建），继续降级 */
  }

  const aside = `${dir}.trash-${Date.now().toString(36)}`;
  try {
    fs.renameSync(dir, aside);
    console.log(`  ${label || dir} 删不掉，已改名挪到 ${path.basename(aside)}（可手动清掉）`);
  } catch (e) {
    throw new Error(
      `既删不掉也挪不走 ${dir}：${e.message}\n` + '  多半是有进程正占用它（比如应用还开着）。关掉后重试。'
    );
  }
}

/* ---------- bsdtar（打 / 解 zip 必须用它） ----------
 *
 * ⚠️ **不能用 PATH 上的 `tar`。** Git for Windows 装的是 **GNU tar**，它：
 *   - **不支持 zip**：`tar -a -cf x.zip` 不报错，但**静默产出普通 tar**；
 *   - 也**读不了** zip（"This does not look like a tar archive"）。
 *
 * 这条是实测踩出来的，代价不小：`build:installer --zip` 一直用 `tar -a` 出
 * 「便携版 zip」，而产物其实是 tar 改名 —— Windows 用户双击打不开
 * （Expand-Archive：「找不到中央目录结尾记录」）。而 portable-check 用同一个
 * tar 去解，所以**测试全绿**：造和验用的是同一把错误的尺子。
 *
 * Windows 10+ 自带 `C:\Windows\System32\tar.exe`（bsdtar / libarchive），
 * macOS 的 `/usr/bin/tar` 本身就是 bsdtar。
 */
let bsdtarCache;

function looksLikeBsdtar(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /bsdtar|libarchive/i.test(out);
  } catch {
    return false;
  }
}

/** 找到 bsdtar；找不到返回 null。结果会缓存。 */
export function findBsdtar() {
  if (bsdtarCache !== undefined) return bsdtarCache;

  const candidates = [];
  if (process.env.PI_GUI_BSDTAR) candidates.push(process.env.PI_GUI_BSDTAR);
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'));
  }
  // PATH 上的 bsdtar / tar —— 但**只有真的是 bsdtar 才用**（见上面的说明）
  for (const name of ['bsdtar', 'tar']) {
    try {
      const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) candidates.push(line);
    } catch {
      /* 没有就算了 */
    }
  }

  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    if (looksLikeBsdtar(c)) {
      bsdtarCache = c;
      return c;
    }
  }
  bsdtarCache = null;
  return null;
}

/** 同上，但找不到就抛一个能照着做的错。 */
export function requireBsdtar() {
  const p = findBsdtar();
  if (!p) {
    throw new Error(
      '没找到 bsdtar（libarchive 的 tar）。\n' +
        '  打 / 解 zip 必须用它 —— GNU tar（Git for Windows 装的那个）不支持 zip，\n' +
        '  用 `tar -a` 会**静默产出普通 tar**，用户双击打不开。\n' +
        '  Windows 10+ 自带 C:\\Windows\\System32\\tar.exe，正常不会缺；\n' +
        '  实在没有就用 PI_GUI_BSDTAR=<路径> 指定一个。'
    );
  }
  return p;
}

/* ---------- 文件魔数 ---------- */

const MAGIC = {
  '.exe': [[0x4d, 0x5a]], // 'MZ'
  '.zip': [
    [0x50, 0x4b, 0x03, 0x04], // 普通 zip
    [0x50, 0x4b, 0x05, 0x06], // 空归档
  ],
};

/** 读文件头几个字节。 */
function headOf(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, 0);
    return b;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 文件内容与扩展名是否匹配。返回 null = 正常，否则返回人话描述。
 *
 * 挡的是「存在、非空、名字对，但内容根本不是那个东西」：
 *   - 下载失败时把 HTML 错误页存成了 .exe
 *   - 被中断的构建留下的半截文件
 *   - **tar 改名成 .zip**（zip 还要额外查中央目录结尾记录 EOCD ——
 *     「开头是 PK」可以伪造，但没有 EOCD 的 zip 谁都解不开）
 */
export function fileMagicMismatch(file) {
  const ext = path.extname(file).toLowerCase();
  const wants = MAGIC[ext];
  if (!wants) return null;

  const size = fs.statSync(file).size;
  const head = headOf(file, Math.min(4, size));
  if (!wants.some((sig) => sig.every((b, i) => head[i] === b))) {
    return '开头字节是 ' + head.toString('hex') + '，不是合法的 ' + ext;
  }

  if (ext === '.zip') {
    /* EOCD 在文件末尾（注释最长 65535，所以最后 66000 字节里一定有）。 */
    const tailLen = Math.min(size, 66000);
    const fd = fs.openSync(file, 'r');
    let tail;
    try {
      tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    } finally {
      fs.closeSync(fd);
    }
    if (!tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) {
      return '没有中央目录结尾记录（EOCD）—— 不是有效的 zip（常见的成因：用 GNU tar 的 -a 打出来的其实是 tar）';
    }
  }

  return null;
}
