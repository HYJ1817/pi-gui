/* “用系统默认程序打开”的保守文件策略。
 *
 * 这条通用入口会把文件交给 OS 的默认关联——那可能执行它。因此策略是
 * **白名单优先**：明确属于文档、文本、图片、音视频、压缩包等“只读查看”的
 * 扩展名才放行；未知类型、无扩展名、双扩展名、以及任何可能直接执行代码的
 * 形状都默认拒绝。文件真实内容（扩展名伪装）用**有界文件头**复核：
 * 只要头部像可执行格式（MZ/PE、ELF、Mach-O、shebang、脚本解释器指令），
 * 即使扩展名在允许列表里也拒绝。
 *
 * 不依赖“用户机器装了什么”：判断只看路径形状与文件头，不看注册表关联。
 * 危险文件仍可在应用内部查看器读字节，或交给**明确配置的外部编辑器**——
 * 编辑器只是读文本；这里的策略只管“会不会执行”，不管“能不能看”。 */
import fs from 'node:fs';
import path from 'node:path';

/* 明确“只读查看”的扩展名。保守取舍：没列出来的一律按不可打开处理，
 * 让规则可读、可审。仍允许看源码/配置/数据文件。 */
const SAFE_OPEN_EXTENSIONS = new Set([
  /* 文本 / 文档 */
  '.txt', '.md', '.markdown', '.mdown', '.mkd', '.rst', '.adoc', '.org', '.log',
  '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.xml', '.xsd', '.xsl',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env',
  '.diff', '.patch', '.puml', '.plantuml', '.mermaid', '.sql', '.graphql', '.gql',
  /* 办公 / 报告 */
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.rtf', '.pages', '.numbers', '.key', '.epub',
  /* 图片 */
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg',
  '.tif', '.tiff', '.heic', '.heif', '.psd', '.ai', '.eps',
  /* 音视频 */
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.opus', '.m4a', '.wma',
  '.mp4', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv', '.m4v', '.3gp',
  /* 压缩包（打开的是归档管理器，不是运行包内程序） */
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
  /* 数据 / 设计 */
  '.db', '.sqlite', '.sqlite3', '.parquet', '.arrow', '.feather',
  '.dwg', '.dxf', '.stl', '.obj', '.fbx', '.blend', '.step', '.stp', '.iges', '.igs',
  /* 字体与排版 */
  '.ttf', '.otf', '.woff', '.woff2',
  /* 配置/元数据（打开后是查看器/编辑器，不是执行） */
  '.lock', '.snapshot', '.pem', '.crt', '.cer', '.der', '.p12', '.pfx',
]);

/* 路径形状判断：
 *   - 无扩展名：未知类型，默认拒绝；
 *   - 双扩展名/伪装名（a.txt.exe）：以**最后一个**扩展名为准，白名单外拒绝；
 *   - 扩展名在允许列表里也可能伪装 —— 用文件头复核（见下）。 */
function extensionOf(basename) {
  const name = String(basename || '');
  const ext = path.extname(name);
  if (!ext || ext === name) return '';
  return ext.toLowerCase();
}

/* 有界文件头识别。只要前 4KB 看起来像可执行/脚本格式就拒绝：
 *   MZ（PE）、ELF、Mach-O、#!/usr/bin/env 脚本、Java class、
 *   Windows 快捷方式（Lnk）、以及 polyglot 的 ZIP-EXE 不强行深挖。 */
const EXECUTABLE_MAGIC = [
  { bytes: Buffer.from('MZ'), label: '可执行文件' },
  { bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), label: 'ELF 可执行文件' },
  { bytes: Buffer.from([0xfe, 0xed, 0xfa, 0xce]), label: 'Mach-O 可执行文件' },
  { bytes: Buffer.from([0xce, 0xfa, 0xed, 0xfe]), label: 'Mach-O 可执行文件' },
  { bytes: Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), label: 'Mach-O 可执行文件' },
  { bytes: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), label: 'Mach-O 可执行文件' },
  { bytes: Buffer.from([0xca, 0xfe, 0xba, 0xbe]), label: 'Java class / FAT binary' },
  { bytes: Buffer.from('#!'), label: '脚本解释器指令' },
  { bytes: Buffer.from([0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00]), label: 'Windows 快捷方式' },
];

const HEADER_BYTES = 4096;

function readHeader(abs, max = HEADER_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buffer = Buffer.allocUnsafe(max);
    const bytes = fs.readSync(fd, buffer, 0, max, 0);
    return buffer.subarray(0, bytes);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* noop */ }
  }
}

function looksExecutableHeader(header) {
  for (const magic of EXECUTABLE_MAGIC) {
    if (header.length >= magic.bytes.length && header.subarray(0, magic.bytes.length).equals(magic.bytes)) {
      return magic.label;
    }
  }
  return '';
}

/** 保守打开策略：只放行白名单扩展名 + 文件头不像可执行格式。
 *  返回 `{ ok, ext, reason }`；`reason` 为空表示允许。 */
export function evaluateSystemOpen(abs, { basename } = {}) {
  const name = basename ?? path.basename(String(abs || ''));
  const ext = extensionOf(name);
  if (!ext) return { ok: false, ext, reason: 'unknown_type' };
  if (!SAFE_OPEN_EXTENSIONS.has(ext)) {
    /* 双扩展名伪装：真实扩展名（最后一个）不在白名单就拒绝；
     * 不再单独拒 “.txt.exe” 的中间名 —— 那只能靠真实类型判断。 */
    return { ok: false, ext, reason: 'unsafe_type' };
  }
  const header = readHeader(abs);
  const magic = looksExecutableHeader(header);
  if (magic) return { ok: false, ext, reason: `executable_header:${magic}` };
  return { ok: true, ext, reason: '' };
}

/** 测试可读：白名单不导出供拼接；只读检查器单独看头部。 */
export function unsafeHeaderReason(abs) {
  const header = readHeader(abs);
  const label = looksExecutableHeader(header);
  return label || '';
}

export { SAFE_OPEN_EXTENSIONS, EXECUTABLE_MAGIC };
