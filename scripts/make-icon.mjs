/* 生成应用图标 build/icon.ico。
 *
 * 两条来源，按优先级：
 *   1) assets/icon-src.png 存在 → 用它当母图（当前用的是一张插画）。
 *   2) 不存在 → 退回程序化绘制的 π（原先的默认图标）。
 *
 * 为什么要自己画 / 自己解码：Electron 打包不带图标时用的是 Electron 官方 logo，
 * 一眼就是「没做完」。装 canvas / sharp 这种依赖只为处理一个图标又不值当，
 * 所以这里手写光栅化 + PNG/ICO 编解码，零依赖。
 *
 * 程序化那条的画法：先在 4 倍尺寸上按硬边绘制（不做抗锯齿），再盒式降采样回
 * 目标尺寸，边缘自然就平滑了 —— 比逐像素算覆盖率简单得多。
 *
 * 源图那条：母图已经是光栅，没有可降采样的矢量信息，所以圆角遮罩要自己做
 * 子像素采样（见 applyRoundedMask）。母图尺寸由文件本身决定，不再固定 256。
 *
 * ICO 里小尺寸用 BMP(DIB) 条目、大尺寸用 PNG 条目：
 * rcedit（packager 用来写 exe 图标）对 PNG 条目的兼容性不如 BMP，混着来最稳。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'icon.ico');
const SRC = path.join(ROOT, 'assets', 'icon-src.png');

const AMBER = [0xe8, 0xa3, 0x3d]; // Codex 风格的琥珀色
const BG_TOP = [0x24, 0x24, 0x24];
const BG_BOT = [0x12, 0x12, 0x12];

/* 圆角方块的形状。用源图时按**满幅**切圆角（不内缩）：
 * 插画本身的底色就是深色，内缩一圈只会让画面变小、还多出一圈空边。
 * 半径 22% 接近 Windows 11 应用图标的观感。 */
const PAD_RATIO = 0;
const RADIUS_RATIO = 0.22;

/* ---------- 几何：圆角矩形命中测试 ---------- */
function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/* ---------- PNG 解码 ----------
 * 只用来读 assets/icon-src.png，所以刻意做得窄：8 位深、非隔行、不处理调色板。
 * 碰到不支持的形态**直接报错**，不要静默回退到 π —— 否则「换了图但图标没变」
 * 会变成一个查不出原因的现象。 */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG（文件签名不对）');
  }

  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') ihdr = buf.subarray(off + 8, off + 8 + len);
    else if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === 'IEND') break;
    off += 12 + len; // 4(长度) + 4(类型) + len(数据) + 4(CRC)
  }
  if (!ihdr) throw new Error('PNG 里没有 IHDR');
  if (!idat.length) throw new Error('PNG 里没有 IDAT');

  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const color = ihdr[9];
  const interlace = ihdr[12];
  if (depth !== 8) throw new Error(`只支持 8 位深的 PNG，这个是 ${depth} 位`);
  if (interlace !== 0) throw new Error('不支持隔行扫描（interlaced）的 PNG');
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (!CH) throw new Error(`不支持的 PNG 颜色类型 ${color}（调色板类型请先转成 RGB/RGBA）`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * CH;
  const out = Buffer.alloc(w * h * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    raw.copy(line, 0, p, p + stride);
    p += stride;
    /* 逐字节反滤波。a/b/c 取的都是**已重建**的值（line 就地覆盖），
     * 这正是 PNG 规范要求的顺序 —— 用原始字节算会得到一堆噪点。 */
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? line[i - CH] : 0;
      const b = prev[i];
      const c = i >= CH ? prev[i - CH] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * CH;
      const d = (y * w + x) * 4;
      if (CH === 1) {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = 255;
      } else if (CH === 2) {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = line[s + 1];
      } else if (CH === 3) {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = 255;
      } else {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = line[s + 3];
      }
    }
    line.copy(prev);
  }
  return { rgba: out, width: w, height: h };
}

/* ---------- 圆角遮罩 ----------
 * 母图是光栅，不能像程序化那条靠「超采样绘制再降采样」拿到平滑边缘，
 * 所以这里对每个像素做 samples×samples 子像素采样，把覆盖率乘进 alpha。
 * 4×4 在这个尺寸上已经看不出锯齿，再高只是白费时间。 */
function applyRoundedMask(rgba, size, padRatio = PAD_RATIO, radiusRatio = RADIUS_RATIO, samples = 4) {
  const out = Buffer.from(rgba);
  const pad = size * padRatio;
  const x0 = pad;
  const y0 = pad;
  const w = size - pad * 2;
  const h = size - pad * 2;
  const r = size * radiusRatio;
  const inv = 1 / (samples * samples);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (inRoundRect(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples, x0, y0, w, h, r)) cov++;
        }
      }
      const o = (y * size + x) * 4;
      out[o + 3] = Math.round(out[o + 3] * cov * inv);
    }
  }
  return out;
}

/* ---------- 母图来源一：assets/icon-src.png ---------- */
function loadImageMaster() {
  if (!fs.existsSync(SRC)) return null;
  const png = decodePng(fs.readFileSync(SRC));
  if (png.width !== png.height) {
    throw new Error(`assets/icon-src.png 必须是正方形，现在是 ${png.width}x${png.height}`);
  }
  return { rgba: applyRoundedMask(png.rgba, png.width), size: png.width };
}

/* ---------- 母图来源二：程序化绘制 π ---------- */
function renderMaster(size) {
  const SS = 4;
  const N = size * SS;
  const px = new Float32Array(N * N * 4); // 预乘前：r,g,b,a(0..1)

  const S = (v) => v * SS; // 逻辑坐标 → 超采样坐标

  // 背景圆角方块：留 6% 内边距，Windows 图标惯例
  const pad = size * 0.055;
  const bx = S(pad);
  const by = S(pad);
  const bw = S(size - pad * 2);
  const bh = S(size - pad * 2);
  const br = S(size * 0.235);

  // π 的三笔。坐标基于 256 设计稿，先按 size/256 缩放到目标尺寸，
  // 再经 S() 进超采样空间 —— 少乘 SS 会让 π 缩到左上角 1/4 大小。
  const K = (v) => S(v * (size / 256));
  const barX = K(60), barY = K(82), barW = K(136), barH = K(23), barR = K(11.5);
  const legW = K(23), legR = K(11.5);
  const legTop = K(82), legBot = K(185);
  const legLX = K(82), legRX = K(151);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;

      // 背景
      if (inRoundRect(x, y, bx, by, bw, bh, br)) {
        const t = (y - by) / bh; // 0 顶 → 1 底
        for (let c = 0; c < 3; c++) px[i + c] = BG_TOP[c] + (BG_BOT[c] - BG_TOP[c]) * t;
        px[i + 3] = 1;
      }

      // 顶部内高光：一条极淡的横向亮线，让方块看起来有厚度
      const hiY = by + S(1);
      if (px[i + 3] === 1 && y >= hiY && y < hiY + S(1.2)) {
        const inset = S(size * 0.10);
        if (x > bx + inset && x < bx + bw - inset) {
          for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, px[i + c] + 26);
        }
      }

      // π：横杠
      const onBar = inRoundRect(x, y, barX, barY, barW, barH, barR);
      // π：两条竖腿（底部圆角）
      const onLegL = inRoundRect(x, y, legLX, legTop, legW, legBot - legTop, legR);
      const onLegR = inRoundRect(x, y, legRX, legTop, legW, legBot - legTop, legR);

      if (onBar || onLegL || onLegR) {
        for (let c = 0; c < 3; c++) px[i + c] = AMBER[c];
        px[i + 3] = 1;
      }
    }
  }

  // 盒式降采样 SS×SS → 目标尺寸
  const out = Buffer.alloc(size * size * 4);
  const area = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          const al = px[i + 3];
          r += px[i] * al; // 按 alpha 加权，避免透明边缘混进黑
          g += px[i + 1] * al;
          b += px[i + 2] * al;
          a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return out;
}

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, w, h = w) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- BMP(DIB) 编码，用于 ICO 里的小尺寸 ---------- */
function toDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 两张位图，高度翻倍
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // BMP 自下而上
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  const maskRow = Math.ceil(size / 32) * 4; // 1bpp，行按 4 字节对齐
  const and = Buffer.alloc(maskRow * size); // 全 0：交给 alpha 通道决定透明度
  return Buffer.concat([header, xor, and]);
}

/* ---------- ICO 封装 ---------- */
function buildIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // 1 = icon
  dir.writeUInt16LE(entries.length, 4);

  const heads = [];
  let offset = 6 + entries.length * 16;
  for (const e of entries) {
    const h = Buffer.alloc(16);
    h[0] = e.size >= 256 ? 0 : e.size; // 256 用 0 表示
    h[1] = e.size >= 256 ? 0 : e.size;
    h[2] = 0;
    h[3] = 0;
    h.writeUInt16LE(1, 4); // planes
    h.writeUInt16LE(32, 6); // bpp
    h.writeUInt32LE(e.data.length, 8);
    h.writeUInt32LE(offset, 12);
    heads.push(h);
    offset += e.data.length;
  }
  return Buffer.concat([dir, ...heads, ...entries.map((e) => e.data)]);
}

/* ---------- 主流程 ---------- */
const fromImage = loadImageMaster();
const master = fromImage ? fromImage.rgba : renderMaster(256);
const masterSize = fromImage ? fromImage.size : 256;

// 大尺寸：从母图直接盒式降到目标尺寸，保证质量
function downscale(rgba, from, to) {
  if (from === to) return rgba;
  const f = from / to;
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * f); sy < Math.floor((y + 1) * f); sy++) {
        for (let sx = Math.floor(x * f); sx < Math.floor((x + 1) * f); sx++) {
          const i = (sy * from + sx) * 4;
          const al = rgba[i + 3] / 255;
          r += rgba[i] * al;
          g += rgba[i + 1] * al;
          b += rgba[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * to + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const entries = [];
for (const size of [16, 24, 32, 48, 64]) {
  const small = downscale(master, masterSize, size);
  entries.push({ size, data: toDib(small, size) });
}
for (const size of [128, 256]) {
  const big = downscale(master, masterSize, size);
  entries.push({ size, data: toPng(big, size) });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const ico = buildIco(entries);
fs.writeFileSync(OUT, ico);

// 顺手导一张 256 PNG，方便在别处复用（比如网页 favicon）
fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), toPng(downscale(master, masterSize, 256), 256));

// --preview：把小尺寸放大 6 倍拼一张对照图，人眼确认 16px 下还认不认得出
if (process.argv.includes('--preview')) {
  const sizes = [16, 24, 32, 48];
  const Z = 6;
  const gap = 8;
  const W = sizes.reduce((a, s) => a + s * Z + gap, gap);
  const H = 48 * Z + gap * 2;
  const sheet = Buffer.alloc(W * H * 4);
  let ox = gap;
  for (const s of sizes) {
    const small = downscale(master, masterSize, s);
    for (let y = 0; y < s * Z; y++) {
      for (let x = 0; x < s * Z; x++) {
        const src = Math.floor(y / Z) * s + Math.floor(x / Z);
        const dst = ((y + gap) * W + x + ox) * 4;
        sheet[dst] = small[src * 4];
        sheet[dst + 1] = small[src * 4 + 1];
        sheet[dst + 2] = small[src * 4 + 2];
        sheet[dst + 3] = small[src * 4 + 3];
      }
    }
    ox += s * Z + gap;
  }
  fs.writeFileSync(path.join(ROOT, 'build', 'icon-preview.png'), toPng(sheet, W, H));
}

console.log(`母图  ${fromImage ? `assets/icon-src.png（${masterSize}px）` : '程序化绘制（256px）'}`);
console.log(`icon.ico  ${(ico.length / 1024).toFixed(1)} KB`);
for (const e of entries) console.log(`  ${String(e.size).padStart(3)}px  ${e.data.length} B`);
