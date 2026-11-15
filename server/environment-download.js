/* 环境安装的下载、校验、解压与目录替换。
 *
 * 这一层刻意**不认识** Node / Pi / Git —— 它只知道「一个 HTTPS 文件、一个
 * 固定摘要、一个目标目录」。业务顺序与状态机在 environment-install.js。
 *
 * ---------- 硬边界 ----------
 *
 * - URL 只允许 https + 白名单主机；**每一次重定向都重新校验**。
 * - 下载写盘用 `wx`（不覆盖、不跟随已存在的链接），文件落在本次任务独有的
 *   随机临时目录里。
 * - 解压只认固定参数调用系统 PowerShell，脚本是本仓库内嵌的固定文本，路径
 *   经参数传入；脚本自己拒绝绝对路径、`..`、盘符和符号链接条目。
 * - 目录替换只 rename，不跨卷复制；目标已存在时先备份，失败可恢复。
 * - 任何错误都映射成固定 code，不把远端响应体、原始 stderr 或绝对路径带出去。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import https from 'node:https';

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
/* 连接/传输空闲上限。大文件持续有数据时会不断重置；这里防的是
 * 服务器接受连接后再也不响应，让任务永远停在 downloading。 */
const SOCKET_TIMEOUT_MS = 30_000;
const USER_AGENT = 'pi-gui-environment/1';

export const EXTRACT_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveFull = [System.IO.Path]::GetFullPath($Archive)
$destFull = [System.IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath $archiveFull -PathType Leaf)) { throw 'archive-missing' }
if (Test-Path -LiteralPath $destFull) { throw 'destination-exists' }
[System.IO.Directory]::CreateDirectory($destFull) | Out-Null
$zip = [System.IO.Compression.ZipFile]::OpenRead($archiveFull)
try {
  $count = 0
  [long]$total = 0
  foreach ($entry in $zip.Entries) {
    $count++
    if ($count -gt 20000) { throw 'too-many-entries' }
    $name = $entry.FullName
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ($name.StartsWith('/') -or $name.StartsWith('\') -or $name -match '^[A-Za-z]:') { throw 'absolute-entry' }
    $parts = $name -split '[\\/]'
    if ($parts -contains '..') { throw 'path-traversal' }
    if ((([int64]$entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'symlink-entry' }
    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destFull, $name))
    $prefix = $destFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'path-escape' }
    $total += $entry.Length
    if ($total -gt 1073741824) { throw 'uncompressed-too-large' }
  }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ($name.EndsWith('/') -or $name.EndsWith('\')) { continue }
    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destFull, $name))
    $dir = [System.IO.Path]::GetDirectoryName($target)
    if ($dir) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
} finally {
  $zip.Dispose()
}
Write-Output 'ok'
`;

function isFile(fsApi, file) {
  try {
    return fsApi.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(fsApi, dir) {
  try {
    const st = fsApi.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function errorWith(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

export function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

/** 解析 SHASUMS256.txt，取指定文件名的摘要。 */
export function checksumFor(archive, text) {
  if (typeof text !== 'string') return null;
  const wanted = path.basename(String(archive || ''));
  if (!wanted) return null;
  for (const line of text.split(/\r?\n/).slice(0, 5000)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && path.basename(m[2]) === wanted) return m[1].toLowerCase();
  }
  return null;
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw errorWith('bad-url');
  }
  if (url.protocol !== 'https:') throw errorWith('bad-url');
  return url;
}

/** 给请求加空闲超时；测试里的假请求没有 setTimeout 时直接跳过。 */
function armSocketTimeout(req, timeoutMs = SOCKET_TIMEOUT_MS) {
  if (!req || typeof req.setTimeout !== 'function') return;
  req.setTimeout(timeoutMs, () => {
    try { req.destroy(); } catch { /* 已关闭 */ }
  });
}

function hostAllowed(url, allowlist) {
  const host = url.hostname.toLowerCase();
  /* 只认清单里的**完整主机名**，不接受任意子域：白名单越宽，
   * 「某个受信任域下的用户内容」就越容易变成下载源。重定向也一样。 */
  return allowlist.some((item) => typeof item === 'string' && host === item.toLowerCase());
}

/** 下载到文件；重定向逐跳校验协议、主机与次数。 */
export function downloadFile({
  url,
  file,
  allowlist,
  fsApi = fs,
  maxBytes = MAX_DOWNLOAD_BYTES,
  signal = null,
  onProgress = null,
  redirects = MAX_REDIRECTS,
  request = https.get,
} = {}) {
  return new Promise((resolve, reject) => {
    let current;
    try {
      current = validateUrl(url);
      if (!Array.isArray(allowlist) || !hostAllowed(current, allowlist)) throw errorWith('host-not-allowed');
    } catch (err) {
      reject(err);
      return;
    }
    if (signal && signal.aborted) {
      reject(errorWith('cancelled', '已取消'));
      return;
    }

    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let req;
    let out = null;
    try {
      req = request(current, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
        signal: signal || undefined,
      }, (res) => {
        const status = Number(res.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (redirects <= 0) {
            done(reject, errorWith('too-many-redirects'));
            return;
          }
          const location = res.headers && res.headers.location;
          if (!location) {
            done(reject, errorWith('bad-redirect'));
            return;
          }
          let next;
          try {
            next = new URL(location, current);
            if (next.protocol !== 'https:' || !hostAllowed(next, allowlist)) throw errorWith('host-not-allowed');
          } catch (err) {
            done(reject, err);
            return;
          }
          downloadFile({ url: next.href, file, allowlist, fsApi, maxBytes, signal, onProgress, redirects: redirects - 1, request })
            .then((value) => done(resolve, value), (err) => done(reject, err));
          return;
        }
        if (status !== 200) {
          res.resume();
          done(reject, errorWith('http-status'));
          return;
        }
        const totalBytes = Number(res.headers && res.headers['content-length']) || null;
        if (totalBytes && totalBytes > maxBytes) {
          res.resume();
          done(reject, errorWith('too-large'));
          return;
        }
        let received = 0;
        try {
          out = fsApi.createWriteStream(file, { flags: 'wx', mode: 0o600 });
        } catch {
          res.resume();
          done(reject, errorWith('write-failed'));
          return;
        }
        const fail = (code) => {
          try { req.destroy(); } catch { /* noop */ }
          try { out.destroy(); } catch { /* noop */ }
          /* 取消期间任何传输错误都归为 cancelled：否则用户点了取消，
           * 任务却可能以 write-failed / network-error 结束。 */
          done(reject, errorWith(signal && signal.aborted ? 'cancelled' : code));
        };
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            fail('too-large');
            return;
          }
          if (onProgress) {
            try { onProgress({ receivedBytes: received, totalBytes }); } catch { /* noop */ }
          }
        });
        res.on('error', () => fail('network-error'));
        out.on('error', () => fail('write-failed'));
        out.on('finish', () => done(resolve, { bytes: received, totalBytes }));
        res.pipe(out);
      });
      armSocketTimeout(req);
    } catch {
      reject(errorWith('network-error'));
      return;
    }
    req.on('error', (err) => {
      /* 取消 / 网络错误时关掉写流，让调用方能立刻清理临时目录；
       * 否则 Windows 上残留的文件句柄会让删除失败。 */
      try { if (out) out.destroy(); } catch { /* noop */ }
      done(reject, errorWith(signal && signal.aborted ? 'cancelled' : 'network-error', err && err.message));
    });
  });
}

/** 下载一个小文本（校验文件），超过 1 MiB 直接失败。 */
export function downloadText({
  url,
  allowlist,
  signal = null,
  request = https.get,
  maxBytes = MAX_CHECKSUM_BYTES,
  redirects = MAX_REDIRECTS,
} = {}) {
  return new Promise((resolve, reject) => {
    let current;
    try {
      current = validateUrl(url);
      if (!Array.isArray(allowlist) || !hostAllowed(current, allowlist)) throw errorWith('host-not-allowed');
    } catch (err) {
      reject(err);
      return;
    }
    if (signal && signal.aborted) {
      reject(errorWith('cancelled', '已取消'));
      return;
    }
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    let req;
    try {
      req = request(current, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
        signal: signal || undefined,
      }, (res) => {
        const status = Number(res.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (redirects <= 0) return done(reject, errorWith('too-many-redirects'));
          const location = res.headers && res.headers.location;
          if (!location) return done(reject, errorWith('bad-redirect'));
          let next;
          try {
            next = new URL(location, current);
            if (next.protocol !== 'https:' || !hostAllowed(next, allowlist)) throw errorWith('host-not-allowed');
          } catch (err) {
            return done(reject, err);
          }
          downloadText({ url: next.href, allowlist, signal, request, maxBytes, redirects: redirects - 1 })
            .then((v) => done(resolve, v), (e) => done(reject, e));
          return;
        }
        if (status !== 200) {
          res.resume();
          return done(reject, errorWith('http-status'));
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > maxBytes) {
            try { req.destroy(); } catch { /* noop */ }
            done(reject, errorWith('too-large'));
          }
        });
        res.on('error', () => done(reject, errorWith('network-error')));
        res.on('end', () => done(resolve, text));
      });
      armSocketTimeout(req);
    } catch {
      reject(errorWith('network-error'));
      return;
    }
    req.on('error', () => done(reject, errorWith(signal && signal.aborted ? 'cancelled' : 'network-error')));
  });
}

export function sha256File(file, fsApi = fs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let stream;
    try {
      stream = fsApi.createReadStream(file);
    } catch {
      reject(errorWith('read-failed'));
      return;
    }
    stream.on('error', () => reject(errorWith('read-failed')));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 建本次任务的临时目录；只建一层随机名，拒绝跟随已存在的链接。 */
export function createTempDir(root, token, fsApi = fs) {
  if (typeof token !== 'string' || !/^[a-f0-9]{16,64}$/.test(token)) throw errorWith('bad-token');
  const base = path.join(root, '.tmp');
  fsApi.mkdirSync(base, { recursive: true, mode: 0o700 });
  if (!isDir(fsApi, base)) throw errorWith('unsafe-temp');
  const dir = path.join(base, token);
  if (fsApi.existsSync(dir)) throw errorWith('temp-exists');
  fsApi.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** 固定脚本文本写到独立目录，绝不与下载文件同目录执行。 */
export function writeExtractScript(root, token, fsApi = fs) {
  const dir = path.join(root, '.tmp', 'scripts');
  fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isDir(fsApi, dir)) throw errorWith('unsafe-temp');
  const file = path.join(dir, `extract-${token}.ps1`);
  fsApi.writeFileSync(file, EXTRACT_SCRIPT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return file;
}

export function windowsPowerShellPath(env = process.env, fsApi = fs) {
  const root = typeof env.SystemRoot === 'string' && path.isAbsolute(env.SystemRoot)
    ? env.SystemRoot
    : (typeof env.windir === 'string' && path.isAbsolute(env.windir) ? env.windir : 'C:\\Windows');
  const file = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return isFile(fsApi, file) ? file : null;
}

/**
 * 受控解压。`runCli` 由 server.js 注入（`shell:false` + args 数组 + 树 kill）。
 * 脚本路径、压缩包、目标目录都以参数传入，cwd 固定为脚本目录。
 */
export async function extractZipSafe({
  zipFile,
  destDir,
  scriptFile,
  powershell,
  runCli,
  signal = null,
  timeoutMs = 180_000,
  fsApi = fs,
} = {}) {
  if (process.platform !== 'win32') throw errorWith('unsupported-platform');
  if (!isFile(fsApi, zipFile) || !isFile(fsApi, scriptFile) || !isFile(fsApi, powershell)) {
    throw errorWith('extract-input-missing');
  }
  if (fsApi.existsSync(destDir)) throw errorWith('destination-exists');
  const res = await runCli({
    entry: { ok: true, cmd: powershell, baseArgs: [] },
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-Archive', zipFile, '-Destination', destDir],
    cwd: path.dirname(scriptFile),
    timeoutMs,
    maxStdoutBytes: 4096,
    signal,
  });
  if (!res || !res.ok) throw errorWith(signal && signal.aborted ? 'cancelled' : 'extract-failed');
  if (!isDir(fsApi, destDir)) throw errorWith('extract-failed');
  return destDir;
}

/** 目录替换：目标先备份，rename 失败立即恢复。 */
export function swapDirectory({ staging, target, backup, fsApi = fs } = {}) {
  if (!isDir(fsApi, staging)) throw errorWith('staging-missing');
  if (fsApi.existsSync(target)) {
    const st = fsApi.lstatSync(target);
    if (!st.isDirectory() || st.isSymbolicLink()) throw errorWith('unsafe-target');
    if (fsApi.existsSync(backup)) fsApi.rmSync(backup, { recursive: true, force: true });
    fsApi.renameSync(target, backup);
  }
  try {
    fsApi.renameSync(staging, target);
  } catch (err) {
    if (fsApi.existsSync(backup) && !fsApi.existsSync(target)) {
      try { fsApi.renameSync(backup, target); } catch { /* 恢复失败只能如实上报 */ }
    }
    throw errorWith('swap-failed', err && err.message);
  }
  return {
    commit() {
      try { if (fsApi.existsSync(backup)) fsApi.rmSync(backup, { recursive: true, force: true }); } catch { /* 备份清不掉不影响已完成的安装 */ }
    },
    restore() {
      try {
        if (fsApi.existsSync(target)) fsApi.rmSync(target, { recursive: true, force: true });
        if (fsApi.existsSync(backup)) fsApi.renameSync(backup, target);
      } catch { /* 恢复失败由调用方标成失败，不假装成功 */ }
    },
  };
}

/** 只删本次任务目录；符号链接只删链接本身。 */
export function removeTree(target, fsApi = fs) {
  try {
    const st = fsApi.lstatSync(target);
    if (st.isSymbolicLink()) fsApi.unlinkSync(target);
    else fsApi.rmSync(target, { recursive: true, force: true });
  } catch {
    /* 清理失败不是安装结论 */
  }
}

/** 启动时清掉 24 小时前的临时目录（上次进程退出留下的）。 */
export function cleanupStaleTemp(root, { fsApi = fs, now = () => Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const base = path.join(root, '.tmp');
  let names;
  try {
    names = fsApi.readdirSync(base);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const name of names) {
    const target = path.join(base, name);
    try {
      const st = fsApi.lstatSync(target);
      const age = now() - st.mtimeMs;
      if (age >= maxAgeMs) {
        removeTree(target, fsApi);
        removed++;
      }
    } catch {
      /* 单个条目失败继续 */
    }
  }
  return { removed };
}
