/* 浮层。
 *
 * 模型选择、思考等级、上下文提示都用同一套：锚在触发元素上方，
 * 右边缘对齐，越界时自动收回视口内。
 *
 * 浮层元素在这里创建并常驻（不是每次新建），所以调用方通过 openPop /
 * closePop 操作，并可以用 pop / currentAnchor() 读它的状态。 */

export const pop = document.createElement('div');
pop.className = 'pop';
pop.hidden = true;
document.body.appendChild(pop);

let anchor = null;

export const currentAnchor = () => anchor;
export const popVisible = () => !pop.hidden;

export function closePop() {
  pop.hidden = true;
  pop.innerHTML = '';
  pop.classList.remove('tip-mode');
  anchor = null;
}

export function openPop(target, { tip = false, align = 'right' } = {}) {
  pop.classList.toggle('tip-mode', tip);
  pop.hidden = false;

  const a = target.getBoundingClientRect();
  const r = pop.getBoundingClientRect();

  let left = align === 'left' ? a.left : a.right - r.width;
  left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));

  let top = a.top - r.height - 8;
  if (top < 8) top = Math.max(8, Math.min(a.bottom + 8, window.innerHeight - r.height - 8));

  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
  anchor = target;
}

document.addEventListener('mousedown', (e) => {
  if (pop.hidden) return;
  if (pop.contains(e.target)) return;
  if (anchor && (anchor === e.target || anchor.contains(e.target))) return;
  closePop();
});

window.addEventListener('resize', closePop);
window.addEventListener('blur', closePop);

/* ---------- 内容构造 ---------- */

export function popTitle(text) {
  const d = document.createElement('div');
  d.className = 'pop-title';
  d.textContent = text;
  return d;
}

export function popLabel(text) {
  const d = document.createElement('div');
  d.className = 'pop-label';
  d.textContent = text;
  return d;
}

export function popSep() {
  const d = document.createElement('div');
  d.className = 'pop-sep';
  return d;
}

export function popItem({ label, sub, on, onClick }) {
  const d = document.createElement('div');
  d.className = 'pop-item' + (on ? ' on' : '');

  const t = document.createElement('span');
  t.className = 'pi-text';
  t.textContent = label;
  d.appendChild(t);

  if (sub) {
    const s = document.createElement('span');
    s.className = 'pi-sub';
    s.textContent = sub;
    d.appendChild(s);
  }

  const c = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  c.setAttribute('viewBox', '0 0 24 24');
  c.setAttribute('class', 'pi-check');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7');
  c.appendChild(p);
  d.appendChild(c);

  d.onclick = onClick;
  return d;
}
