/* 请求体读取的完整性回归测试。
 *
 * 背景：原来用 `body += chunk` 累积请求体。chunk 是 Buffer，`+=` 会对每个 chunk
 * 单独做一次 UTF-8 解码；一旦 chunk 边界落在多字节字符中间（中文 3 字节，
 * 64KB 的 socket 分片几乎必然切开），解码就会产出 U+FFFD，正文直接变乱码。
 * 这对「把 PDF 正文拼进消息」这个功能是致命的。
 *
 * 做法：起一个本地服务收一次请求体，保留原始 chunk 列表，
 * 再用「逐块解码」和「先 concat 再解码」两种方式还原，对比结果。
 */
const http = require('node:http');

const SIZE = 400 * 1024;

// 全由 3 字节汉字组成，chunk 边界必然落在某个字符中间
const PAYLOAD = '发酵罐空气分布器设计参数核算与通气量校核'.repeat(Math.ceil(SIZE / 57)).slice(0, SIZE / 3);

// 真实 server.js 里的做法：按 Buffer 累积，最后一次性解码
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('超过上限'));
      else resolve(chunks);
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const chunks = await readRawBody(req, 64 * 1024 * 1024);

  // 旧实现：body += chunk
  const broken = chunks.map((c) => c.toString('utf8')).join('');
  // 修复后：Buffer.concat 再解码
  const fixed = Buffer.concat(chunks).toString('utf8');

  // 统计有多少个 chunk 边界切在了多字节字符中间
  let splitCount = 0;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const last = prev[prev.length - 1];
    const first = chunks[i][0];
    // 前一字节是 UTF-8 起始字节（非续字节 10xxxxxx），后一字节是续字节 → 切开了
    if ((last & 0xc0) !== 0x80 && (first & 0xc0) === 0x80) splitCount++;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ chunkCount: chunks.length, splitCount, broken, fixed }));
});

const badCount = (s) => (s.match(/\uFFFD/g) || []).length;

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const bytes = Buffer.from(PAYLOAD, 'utf8');

  let j;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: bytes });
    j = await r.json();
  } catch (e) {
    console.log('请求失败: ' + e.message);
    server.close();
    process.exit(1);
  }

  const results = [
    ['测试数据本身无替换字符', () => badCount(PAYLOAD) === 0 || '构造的数据就有问题'],
    ['确实产生了多字节切分（测试有意义）', () => j.splitCount > 0 || `共 ${j.chunkCount} 块，未切分`],
    ['旧实现会损坏正文（证明这是真 bug）', () => badCount(j.broken) > 0 || '旧实现居然没坏'],
    ['修复后正文完整无损', () => j.fixed === PAYLOAD || `长度 ${j.fixed.length} vs ${PAYLOAD.length}`],
    ['修复后无替换字符', () => badCount(j.fixed) === 0 || `${badCount(j.fixed)} 个`],
  ];

  let pass = 0;
  for (const [name, fn] of results) {
    const v = fn();
    const ok = v === true;
    if (ok) pass++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : '  → ' + v}`);
  }

  console.log(`\n分片数 ${j.chunkCount}，其中切开多字节字符 ${j.splitCount} 处`);
  console.log(`替换字符数：旧实现 ${badCount(j.broken)}，修复后 ${badCount(j.fixed)}`);
  console.log(`${pass}/${results.length} 通过`);

  server.close();
  process.exit(pass === results.length ? 0 : 1);
});
