/* 环境安装的下载 / 解压 / 目录替换原语（server/environment-download.js）。
 *
 * 全部离线：HTTP 用注入的 `request` 替身，文件都在 `os.tmpdir()`。
 * 这些原语是安装的安全边界，值得单独钉住：
 *   - 只允许 HTTPS + 白名单主机（重定向逐跳校验）
 *   - 只取官方校验文件里的同名条目
 *   - 解压脚本拒绝绝对路径 / `..` / 符号链接 / 超大条目
 *   - 目录替换失败能恢复旧目录
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-env-download-'));
let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL ' + name + '  → ' + (err && err.message ? err.message : err));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL ' + name + '  → ' + (err && err.message ? err.message : err));
  }
}
function section(title) { console.log('\n--- ' + title + ' ---'); }
function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/** 构造一个只发生一次响应的假 `https.get`。 */
function requestReturning(response) {
  return (_url, _options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    process.nextTick(() => onResponse(response));
    return req;
  };
}

function fakeResponse({ statusCode = 200, headers = {}, body = '' } = {}) {
  const res = Readable.from(body ? [Buffer.from(body)] : []);
  res.statusCode = statusCode;
  res.headers = headers;
  return res;
}

(async () => {
  const {
    EXTRACT_SCRIPT, isSha256, checksumFor, downloadFile, downloadText, createTempDir,
    writeExtractScript, swapDirectory, removeTree, cleanupStaleTemp,
  } = await import('../server/environment-download.js');

  section('校验与解析');

  check('isSha256 只接受 64 位十六进制', () => {
    assert.equal(isSha256('a'.repeat(64)), true);
    assert.equal(isSha256('A'.repeat(64)), true);
    assert.equal(isSha256('a'.repeat(63)), false);
    assert.equal(isSha256('g'.repeat(64)), false);
    assert.equal(isSha256(null), false);
  });

  check('checksumFor 按文件名匹配，支持 * 前缀，忽略其它条目', () => {
    const text = [
      'aaaa' + '0'.repeat(60) + '  node-v1.zip',
      'BBBB' + '0'.repeat(60) + ' *node-v24.22.3-win-x64.zip',
      'cccc' + '0'.repeat(60) + '  other.zip',
    ].join('\r\n');
    assert.equal(checksumFor('C:\\cache\\node-v24.22.3-win-x64.zip', text), 'bbbb' + '0'.repeat(60));
    assert.equal(checksumFor('node-v1.zip', text), 'aaaa' + '0'.repeat(60));
    assert.equal(checksumFor('missing.zip', text), null);
    assert.equal(checksumFor('node-v1.zip', null), null);
  });

  check('解压脚本包含路径穿越、绝对路径、符号链接与体积上限的保护', () => {
    for (const needle of ['absolute-entry', 'path-traversal', 'path-escape', 'symlink-entry', 'too-many-entries', '1073741824', 'GetFullPath']) {
      assert.equal(EXTRACT_SCRIPT.includes(needle), true, 'missing ' + needle);
    }
    /* 脚本以 -File 执行；一旦出现 -Command，参数就又变成一段可拼接的代码。 */
    assert.equal(EXTRACT_SCRIPT.includes('-Command'), false);
  });

  section('下载边界');

  await checkAsync('取消下载在写入流关闭后才结束，以便 Windows 能清理文件', async () => {
    const controller = new AbortController();
    let markWriting;
    const writing = new Promise(resolve => { markWriting = resolve; });
    const output = new Writable({
      write(_chunk, _encoding, callback) { markWriting(); callback(); },
      destroy(error, callback) { setImmediate(() => callback(error)); },
    });
    const request = (_url, options, onResponse) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      options.signal.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true });
      const response = new Readable({ read() {} });
      response.statusCode = 200;
      process.nextTick(() => { onResponse(response); response.push('partial'); });
      return req;
    };
    const pending = downloadFile({
      url: 'https://nodejs.org/file.zip', file: path.join(TMP, 'cancel.bin'),
      allowlist: ['nodejs.org'], signal: controller.signal, request,
      fsApi: { createWriteStream: () => output },
    });
    await writing;
    controller.abort();
    await assert.rejects(pending, error => error.code === 'cancelled');
    assert.equal(output.closed, true);
  });

  await checkAsync('非 HTTPS / 非法 URL 在发请求前就被拒绝', async () => {
    let requested = 0;
    const request = () => { requested++; throw new Error('should not request'); };
    for (const url of ['http://nodejs.org/x', 'file:///etc/passwd', 'not a url']) {
      await assert.rejects(
        downloadFile({ url, file: path.join(TMP, 'x.bin'), allowlist: ['nodejs.org'], request }),
        (err) => err.code === 'bad-url'
      );
    }
    assert.equal(requested, 0);
  });

  await checkAsync('白名单主机才放行；相似域名不能绕过', async () => {
    for (const url of ['https://evil.com/x', 'https://nodejs.org.evil.com/x', 'https://evilnodejs.org/x', 'https://cdn.nodejs.org/x']) {
      await assert.rejects(
        downloadFile({ url, file: path.join(TMP, 'x.bin'), allowlist: ['nodejs.org'], request: () => { throw new Error('no'); } }),
        (err) => err.code === 'host-not-allowed'
      );
    }
  });

  await checkAsync('重定向必须逐跳仍是 HTTPS 白名单主机', async () => {
    const req = requestReturning(fakeResponse({
      statusCode: 302,
      headers: { location: 'https://evil.example/x.zip' },
    }));
    await assert.rejects(
      downloadFile({ url: 'https://nodejs.org/x.zip', file: path.join(TMP, 'redirect.bin'), allowlist: ['nodejs.org', 'github.com'], request: req }),
      (err) => err.code === 'host-not-allowed'
    );
  });

  await checkAsync('校验文件下载传输中取消会立即结束，不会把任务挂在 cancelling', async () => {
    const controller = new AbortController();
    const request = (_url, options) => {
      const req = new EventEmitter();
      req.destroy = () => req.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options && options.signal) {
        options.signal.addEventListener('abort', () => req.destroy(), { once: true });
      }
      return req;
    };
    const pending = downloadText({
      url: 'https://nodejs.org/SHASUMS256.txt',
      allowlist: ['nodejs.org'],
      signal: controller.signal,
      request,
    });
    await new Promise((resolve) => process.nextTick(resolve));
    controller.abort();
    await assert.rejects(pending, (err) => err.code === 'cancelled');
  });

  await checkAsync('校验文件下载也限制重定向次数，循环重定向不会无限递归', async () => {
    let requests = 0;
    const req = (_url, _options, onResponse) => {
      requests++;
      const res = Readable.from([]);
      res.statusCode = 302;
      res.headers = { location: 'https://nodejs.org/loop' };
      process.nextTick(() => onResponse(res));
      return { destroy: () => {}, on: () => {} };
    };
    await assert.rejects(
      downloadText({ url: 'https://nodejs.org/SHASUMS256.txt', allowlist: ['nodejs.org'], request: req }),
      (err) => err.code === 'too-many-redirects'
    );
    assert.ok(requests <= 7, `unexpected redirect count: ${requests}`);
  });

  await checkAsync('非 200 与超大 Content-Length 被拒绝', async () => {
    await assert.rejects(
      downloadFile({ url: 'https://nodejs.org/x.zip', file: path.join(TMP, '404.bin'), allowlist: ['nodejs.org'], request: requestReturning(fakeResponse({ statusCode: 404 })) }),
      (err) => err.code === 'http-status'
    );
    await assert.rejects(
      downloadFile({
        url: 'https://nodejs.org/x.zip', file: path.join(TMP, 'big.bin'), allowlist: ['nodejs.org'],
        maxBytes: 10,
        request: requestReturning(fakeResponse({ headers: { 'content-length': '11' } })),
      }),
      (err) => err.code === 'too-large'
    );
  });

  await checkAsync('200 流式写入成功，进度回调带字节数', async () => {
    const file = path.join(TMP, 'ok.bin');
    const progress = [];
    await downloadFile({
      url: 'https://nodejs.org/x.zip', file, allowlist: ['nodejs.org'],
      request: requestReturning(fakeResponse({ headers: { 'content-length': '3' }, body: 'abc' })),
      onProgress: (p) => progress.push(p),
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
    assert.equal(progress[progress.length - 1].receivedBytes, 3);
    assert.equal(progress[progress.length - 1].totalBytes, 3);
  });

  await checkAsync('已取消的 signal 直接失败，不创建文件', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = path.join(TMP, 'aborted.bin');
    await assert.rejects(
      downloadFile({ url: 'https://nodejs.org/x.zip', file, allowlist: ['nodejs.org'], signal: controller.signal }),
      (err) => err.code === 'cancelled'
    );
    assert.equal(fs.existsSync(file), false);
  });

  section('临时目录与解压脚本');

  check('createTempDir 只接受 16–64 位十六进制 token，拒绝重复目录', () => {
    const root = path.join(TMP, 'runtime');
    assert.throws(() => createTempDir(root, '../escape'), (err) => err.code === 'bad-token');
    assert.throws(() => createTempDir(root, 'abc'), (err) => err.code === 'bad-token');
    const token = 'a'.repeat(32);
    const dir = createTempDir(root, token);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(path.dirname(dir), path.join(root, '.tmp'));
    assert.throws(() => createTempDir(root, token), (err) => err.code === 'temp-exists');
  });

  check('writeExtractScript 写到独立 scripts 目录，不跟随已有链接', () => {
    const root = path.join(TMP, 'scripts-root');
    const token = 'b'.repeat(32);
    const file = writeExtractScript(root, token);
    assert.equal(path.basename(path.dirname(file)), 'scripts');
    assert.equal(fs.readFileSync(file, 'utf8'), EXTRACT_SCRIPT);
    assert.ok(path.basename(file).includes(token));
  });

  section('目录替换');

  check('swapDirectory 把旧目录备份，commit 后删备份', () => {
    const base = path.join(TMP, 'swap-commit');
    write(path.join(base, 'staging', 'new.txt'), 'new');
    write(path.join(base, 'target', 'old.txt'), 'old');
    const swap = swapDirectory({ staging: path.join(base, 'staging'), target: path.join(base, 'target'), backup: path.join(base, 'backup') });
    assert.equal(fs.readFileSync(path.join(base, 'target', 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(base, 'backup', 'old.txt')), true);
    swap.commit();
    assert.equal(fs.existsSync(path.join(base, 'backup')), false);
  });

  check('swapDirectory 验证失败时 restore 恢复旧目录', () => {
    const base = path.join(TMP, 'swap-restore');
    write(path.join(base, 'staging', 'new.txt'), 'new');
    write(path.join(base, 'target', 'old.txt'), 'old');
    const swap = swapDirectory({ staging: path.join(base, 'staging'), target: path.join(base, 'target'), backup: path.join(base, 'backup') });
    swap.restore();
    assert.equal(fs.readFileSync(path.join(base, 'target', 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(base, 'target', 'new.txt')), false);
    assert.equal(fs.existsSync(path.join(base, 'backup')), false);
  });

  check('目标不是普通目录 / 暂存缺失时拒绝替换', () => {
    const base = path.join(TMP, 'swap-unsafe');
    const staging = path.join(base, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    const fileTarget = write(path.join(base, 'target-file'), 'not a dir');
    assert.throws(
      () => swapDirectory({ staging, target: fileTarget, backup: path.join(base, 'backup') }),
      (err) => err.code === 'unsafe-target'
    );
    assert.throws(
      () => swapDirectory({ staging: path.join(base, 'missing'), target: path.join(base, 'target'), backup: path.join(base, 'backup') }),
      (err) => err.code === 'staging-missing'
    );
  });

  section('清理');

  check('cleanupStaleTemp 只删超过时限的任务目录，保留 scripts', () => {
    const root = path.join(TMP, 'cleanup');
    const oldDir = write(path.join(root, '.tmp', 'old', 'x.txt'), 'x');
    const newDir = write(path.join(root, '.tmp', 'new', 'x.txt'), 'x');
    const scripts = write(path.join(root, '.tmp', 'scripts', 'extract.ps1'), 'x');
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.dirname(oldDir), oldTime, oldTime);
    const result = cleanupStaleTemp(root);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(path.dirname(oldDir)), false);
    assert.equal(fs.existsSync(path.dirname(newDir)), true);
    assert.equal(fs.existsSync(scripts), true);
  });

  check('removeTree 删掉整棵目录且不抛', () => {
    const dir = write(path.join(TMP, 'remove', 'a', 'b.txt'), 'x');
    removeTree(path.join(TMP, 'remove', 'a'));
    assert.equal(fs.existsSync(path.dirname(dir)), false);
    removeTree(path.join(TMP, 'does-not-exist'));
  });

  console.log(`\nEnvironment download: ${pass}/${pass + fail} passed; failed=${fail}; skipped=0`);
  if (fail) process.exitCode = 1;
})();
