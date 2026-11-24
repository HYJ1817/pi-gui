/* 会话内文件引用的真实文件夹具。
 *
 * 全部写在 os.tmpdir() 里；两个工作区故意拥有同名文件（src/app.ts），
 * 用来证明链接只会打开消息所属会话的文件。内容覆盖常见语言与图片/PDF/
 * Office/ZIP，供真实 Chromium 验收使用。product 代码不引用本文件。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------- 真实 PNG（不引入图像库） ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

function makePng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * stride + 1 + x * 3;
      const block = (Math.floor(x / 48) + Math.floor(y / 48)) % 2;
      raw[at] = block ? 38 : 89;
      raw[at + 1] = block ? 132 : 169;
      raw[at + 2] = block ? 255 : 236;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 文本夹具 ---------- */

const A_APP = `import { readFile } from 'node:fs/promises';

export interface DocumentView {
  path: string;
  content: string;
}

// A 工作区：会话内文件引用打开的是这里。
export class EditorSession {
  private current: DocumentView | null = null;

  constructor(private readonly root: string) {}

  async open(filePath: string): Promise<DocumentView> {
    const content = await readFile(this.root + '/' + filePath, 'utf8');
    this.current = { path: filePath, content };
    return this.current;
  }

  get lineCount(): number {
    return this.current ? this.current.content.split('\\n').length : 0;
  }

  get title(): string {
    return this.current?.path ?? '未打开文件';
  }
}

export function describe(session: EditorSession): string {
  return \`当前文件 \${session.lineCount} 行\`;
}
`;

const B_APP = `// B 工作区：同名文件，内容不同。
export const project = 'project-b';

export function workspaceLabel(): string {
  return 'B 工作区';
}
`;

const A_CSS = `:root {
  --card: #ffffff;
  --ink: #1a1c1f;
}

.editor-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--card);
  color: var(--ink);
}

.editor-card h2 {
  margin: 0;
  font-size: 16px;
}
`;

const A_VUE = `<template>
  <section class="editor-card">
    <h2>{{ title }}</h2>
    <p>中文与空格路径的示例文件。</p>
  </section>
</template>

<script setup lang="ts">
const title = '文件引用验收';
</script>

<style scoped>
.editor-card { max-inline-size: 420px; }
</style>
`;

const A_MD = `# 中文与空格路径

这个文件用来验证 \`docs/说明 文档.md\` 这类路径能被识别、悬停和打开。

- 文件引用绑定消息自己的工作区
- 不把普通技术术语当成文件
`;

const PLACEHOLDER_PDF = Buffer.from('%PDF-1.4\n% Pi-GUI fixture, not a real document\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PLACEHOLDER_XLSX = Buffer.from('PK\u0003\u0004 Pi-GUI xlsx fixture');
const PLACEHOLDER_ZIP = Buffer.from('PK\u0003\u0004 Pi-GUI zip fixture');

const write = (root, rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function createFileLinksWorld() {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-links-world-'));
  const rootA = path.join(world, 'project-a');
  const rootB = path.join(world, 'project-b');
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });

  write(rootA, 'README.md', '# Pi-GUI 文件引用验收\n\nA 工作区的说明文件。\n');
  write(rootA, 'src/app.ts', A_APP);
  write(rootA, 'src/styles.css', A_CSS);
  write(rootA, 'src/App.vue', A_VUE);
  write(rootA, 'src/components/Sidebar.tsx', "export function Sidebar() {\n  return null;\n}\n");
  write(rootA, 'docs/说明 文档.md', A_MD);
  write(rootA, 'config/settings.json', '{\n  "theme": "dark",\n  "fontSize": 13,\n  "features": ["files", "terminal"]\n}\n');
  write(rootA, 'scripts/build.py', "import sys\n\n# A 工作区的构建脚本\ndef main(path: str) -> int:\n    print(f'building {path}')\n    return 0\n\nif __name__ == '__main__':\n    sys.exit(main('.'))\n");
  write(rootA, 'notes.txt', '普通文本，不是代码。\n');
  write(rootA, 'run.log', '2026-11-24 10:00:01 INFO 启动\n2026-11-24 10:00:02 WARN 文件引用验收\n');
  write(rootA, 'Makefile', 'test:\n\tnode --test\n');
  write(rootA, 'assets/architecture.png', makePng(240, 140));
  write(rootA, 'docs/design.pdf', PLACEHOLDER_PDF);
  write(rootA, 'data/report.xlsx', PLACEHOLDER_XLSX);
  write(rootA, 'archive.zip', PLACEHOLDER_ZIP);

  write(rootB, 'README.md', '# B 工作区\n\n同名文件不应该打开 A 的版本。\n');
  write(rootB, 'src/app.ts', B_APP);

  return { rootA, rootB, world };
}

module.exports = { createFileLinksWorld, makePng };
