/* 把 public/ 下的原生 ES Module 图链接成一个脚本，供 jsdom 的 window.eval 执行。
 *
 * 为什么需要它：jsdom 不支持 ES Module，而 smoke.cjs 一直用 `window.eval(app.js)`
 * 跑前端 —— 这个方式顺带让顶层函数挂到了 window 上，几十条断言都直接调
 * `window.handleFiles(...)` 之类的内部函数。改成 Node 原生 ESM 会丢掉这套语义，
 * 于是选择在**测试侧**做一个极小的链接器。
 *
 * 转换规则写得很死，因为这套规则由我们自己约束（见下面的「允许的写法」）：
 *   允许：import { a, b as c } from './x.js';
 *        export function / async function / const / let / var / class
 *        export { a, b };
 *   不允许（遇到就抛错，绝不静默跳过）：default 导入/导出、命名空间导入、
 *        裸导入、动态 import()、re-export。
 * 这样一旦有人写出链接器认不出的写法，测试会立刻以明确信息失败，
 * 而不是产出一个「少了一个模块」的残缺脚本。
 *
 * 产物：
 *   code     可直接 window.eval 的脚本；执行后所有模块的具名导出都会挂到 window
 *   sources  所有模块的**原始**源码拼接（给静态检查用，见 smoke.cjs）
 *   files    参与链接的文件（绝对路径，按执行顺序）
 */

const fs = require('node:fs');
const path = require('node:path');

/* 多行 import 也要支持 —— app.js 里就有把 12 个名字折成多行的写法。 */
const IMPORT_RE = /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^[ \t]*export\s+(async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;

/* 认不出来的写法 —— 宁可报错也不要生成残缺脚本 */
const FORBIDDEN = [
  [/^[ \t]*import\s+[A-Za-z_$][\w$]*\s*(,|from)/m, '默认导入（import X from ...）'],
  [/^[ \t]*import\s*\*\s*as\s/m, '命名空间导入（import * as X）'],
  [/^[ \t]*import\s+['"]/m, '裸导入（import "./x.js"）'],
  [/^[ \t]*export\s+default/m, '默认导出（export default）'],
  [/^[ \t]*export\s+\*\s*from/m, 're-export（export * from ...）'],
  [/\bimport\s*\(/, '动态 import()'],
];

function readModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  for (const [re, what] of FORBIDDEN) {
    if (re.test(src)) throw new Error(`${file} 用了链接器不支持的写法：${what}`);
  }
  return src;
}

/** 解析一个模块：返回 { imports, exports, body }。 */
function parseModule(file) {
  let body = readModule(file);

  const imports = [];
  body = body.replace(IMPORT_RE, (_m, names, spec) => {
    const bindings = names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const parts = s.split(/\s+as\s+/).map((x) => x.trim());
        return { imported: parts[0], local: parts[1] || parts[0] };
      });
    imports.push({ spec, bindings });
    return '';
  });

  const exports = new Set();
  body = body.replace(EXPORT_DECL_RE, (_m, kind, name) => {
    exports.add(name);
    return `${kind} ${name}`;
  });
  body = body.replace(EXPORT_LIST_RE, (_m, names) => {
    for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) {
      exports.add(n.split(/\s+as\s+/).pop().trim());
    }
    return '';
  });

  return { imports, exports: [...exports], body };
}

/**
 * 从入口出发，按依赖优先的顺序把整张图摊平。
 * @param {string} entry 入口文件绝对路径
 * @returns {{code:string, sources:string, files:string[]}}
 */
function bundle(entry) {
  const order = [];
  const seen = new Map(); // file -> index

  (function visit(file) {
    if (seen.has(file)) return;
    if (!fs.existsSync(file)) throw new Error(`找不到模块：${file}`);
    const parsed = parseModule(file);
    // 先递归依赖，保证被依赖的模块先执行（ES Module 的语义）
    for (const imp of parsed.imports) visit(path.resolve(path.dirname(file), imp.spec));
    seen.set(file, order.length);
    order.push({ file, ...parsed });
  })(entry);

  const chunks = ['(function () {', 'var __mods = [];'];
  const sources = [];

  order.forEach((mod, i) => {
    sources.push(`/* ===== ${path.relative(path.dirname(entry), mod.file).replace(/\\/g, '/')} ===== */`);
    sources.push(fs.readFileSync(mod.file, 'utf8'));

    const binds = mod.imports
      .map((imp) => {
        const dep = path.resolve(path.dirname(mod.file), imp.spec);
        const idx = seen.get(dep);
        if (idx === undefined) throw new Error(`${mod.file} 引了未纳入链接的 ${imp.spec}`);
        const list = imp.bindings.map((b) => (b.imported === b.local ? b.imported : `${b.imported}: ${b.local}`)).join(', ');
        return `var { ${list} } = __mods[${idx}];`;
      })
      .join('\n    ');

    chunks.push(`__mods[${i}] = (function () {
    ${binds}
${mod.body}
    return { ${mod.exports.join(', ')} };
  })();`);
  });

  /* 把每个模块的导出都挂到 window 上。
   * 真实浏览器里 app.js 是 <script type="module">，顶层函数**不在** window 上；
   * 这里之所以能挂，是因为 window.eval 跑的是普通脚本 —— 测试要的正是这份可达性。
   * 逐个赋值并 try/catch：window 上有些属性是只读访问器（例如 stop），
   * 撞上了跳过就好，不该让整段脚本挂掉。 */
  chunks.push(`var __all = Object.assign.apply(Object, [{}].concat(__mods));
  for (var __k in __all) {
    if (!Object.prototype.hasOwnProperty.call(__all, __k)) continue;
    try { window[__k] = __all[__k]; } catch (e) { /* 只读的 window 属性，跳过 */ }
  }
  return __all;`);
  chunks.push('})();');

  return { code: chunks.join('\n'), sources: sources.join('\n'), files: order.map((m) => m.file) };
}

module.exports = { bundle };
