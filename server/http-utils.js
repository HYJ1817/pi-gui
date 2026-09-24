/* 通用 HTTP 小工具。
 *
 * 这两个原本在 server.js 里，被上传、命令、供应商、项目、Git 五条链路共用。
 * 拆模块时**不能各复制一份** —— 否则「请求体怎么读」会有五个答案，
 * 改一处漏四处。所以单独放这里，谁需要谁 import。
 */

/** 统一的 JSON 响应。 */
export function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// 读取小型 JSON 请求体。同样按 Buffer 累积，避免多字节字符被 chunk 边界切开。
export function readBody(req, limit = 2 * 1024 * 1024) {
  return readRawBody(req, limit).then((buf) => buf.toString('utf8'));
}

// 上传走裸二进制（文件名放 query），省掉 multipart 解析。
// 超限时不 destroy 请求，而是停止缓冲并让连接自然读完 —— 否则响应写不回去，
// 前端只能看到连接被重置，拿不到「文件过大」这个明确原因。
export function readRawBody(req, limit) {
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
      if (tooBig) reject(new Error(`文件超过上限 ${Math.round(limit / 1024 / 1024)} MB`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}
