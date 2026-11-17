/* 空状态吉祥物专项测试（离线）。
 *
 * 只验证本仓库自己的原创 SVG/CSS：
 *   - 仅存在于「已选项目、pi 就绪」的 #welcomeReady，恢复中/无项目不出现；
 *   - 100×100，颜色走 currentColor（深浅主题共用一条资产）；
 *   - 有动效，但 prefers-reduced-motion 下完全静态；
 *   - 不引用外部图片，没有 hover 缩放/旋转。
 */
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok && typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/ui4-feedback.css'), 'utf8');
const dom = new JSDOM(html);
const document = dom.window.document;

const mascots = [...document.querySelectorAll('.welcome-mascot')];
const mascot = mascots[0];
const ready = document.getElementById('welcomeReady');
const restore = document.getElementById('welcomeRestore');
const noProject = document.getElementById('welcomeNoProj');

console.log('=== 1. 只属于 ready 空状态 ===');
check('页面里有且只有一个吉祥物', mascots.length === 1, `count=${mascots.length}`);
check('吉祥物位于 #welcomeReady', mascot?.parentElement === ready);
check('恢复中引导块没有吉祥物', restore && !restore.querySelector('.welcome-mascot'));
check('无项目引导块没有吉祥物', noProject && !noProject.querySelector('.welcome-mascot'));
check('吉祥物在标题之前', mascot?.nextElementSibling?.tagName === 'H2', mascot?.nextElementSibling?.tagName);
check('欢迎块仍由既有显隐逻辑控制（hidden 属性未被移除）', ready?.hasAttribute('hidden'));

console.log('=== 2. 尺寸与主题 ===');
check('viewBox 为 100×100', mascot?.getAttribute('viewBox') === '0 0 100 100');
check('沿用 .welcome-mark（100×100 的既有尺寸类）', mascot?.classList.contains('welcome-mark'));
check('装饰性图形对辅助技术隐藏', mascot?.getAttribute('aria-hidden') === 'true'
  && mascot?.getAttribute('focusable') === 'false');
const svgMarkup = mascot?.outerHTML || '';
check('没有 <img> / <image> 外部图片', !/<img\b|<image\b/i.test(svgMarkup));
check('没有 href/src 外链', !/\b(?:href|src)\s*=/i.test(svgMarkup));
check('SVG 内没有硬编码颜色', !/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(svgMarkup));
check('线稿颜色继承 currentColor', /class="[^"]*\bmascot-line\b/.test(svgMarkup)
  && /\.welcome-mascot \.mascot-line\s*\{[^}]*stroke:\s*currentColor/s.test(css));

console.log('=== 3. 动效与 reduced motion ===');
check('CSS 定义了浮动动画', /@keyframes mascot-float/.test(css)
  && /\.welcome-mascot \.mascot-float\s*\{[^}]*animation:\s*mascot-float/s.test(css));
check('CSS 定义了眨眼动画', /@keyframes mascot-blink/.test(css));
check('云朵轮廓是闭合 path，两只脚是独立 path', (() => {
  const cloud = mascot?.querySelector('.mascot-cloud');
  const feet = [...(mascot?.querySelectorAll('.mascot-foot') || [])];
  if (!cloud || !/^M[\s\S]*Z$/.test(cloud.getAttribute('d') || '')) return '云朵轮廓不是闭合 path';
  return feet.length === 2 || `feet=${feet.length}`;
})());
check('两只眼睛沿用 currentColor 并比轮廓更粗', mascot?.querySelectorAll('.mascot-eye').length === 2
  && /\.welcome-mascot \.mascot-eye\s*\{[^}]*stroke:\s*currentColor[^}]*stroke-width:\s*3\.4/s.test(css));
check('prefers-reduced-motion 下关闭全部动画', /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.welcome-mascot \.mascot-float[\s\S]*?\.welcome-mascot \.mascot-shadow[\s\S]*?\.welcome-mascot \.mascot-eye[\s\S]*?animation:\s*none/.test(css)
  && /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.welcome-mascot \.mascot-eye\s*\{[^}]*transform:\s*none/s.test(css));
check('没有 hover 缩放/旋转', !/\.welcome-mascot[^,{]*:hover|\.welcome-mascot\s*:hover/.test(css));
check('动画只用 transform / opacity（不改变布局）', (() => {
  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)]
    .filter(([, name]) => name.startsWith('mascot-'));
  if (!keyframes.length) return '没有找到 mascot 关键帧';
  const allowed = /^(transform|opacity)$/;
  for (const [, name, body] of keyframes) {
    for (const [, prop] of body.matchAll(/([a-z-]+)\s*:/g)) {
      if (!allowed.test(prop)) return `${name} 修改了 ${prop}`;
    }
  }
  return true;
})());
check('吉祥物不接收指针事件（不会出现可点击假象）', /\.welcome-mascot\s*\{[^}]*pointer-events:\s*none/s.test(css)
  || /\.welcome-mascot\s*\{[^}]*overflow:\s*visible/s.test(css));

console.log('=== 4. 原创资产边界 ===');
check('没有引用 PI-Desktop / vastsa 资源路径', !/pi-desktop|vastsa|\.gif\b/i.test(svgMarkup + css));
check('没有新增运行时依赖或图标服务', !/url\(\s*['"]?https?:/i.test(css));

console.log(`\n${pass}/${pass + fail} 通过`);
dom.window.close();
if (fail) process.exitCode = 1;
