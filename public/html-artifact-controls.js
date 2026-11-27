import { createIcon } from './ui/icons.js';

// Only repository-owned icon names enter createIcon; model strings are labels.
export function artifactIconButton(doc, name, label, className = '') {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `icon-btn ${className}`.trim();
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(createIcon(name, { size: 16, ownerDocument: doc }));
  return button;
}

export function createArtifactControls(doc, { onZoom, onReset, onFit, onClose }) {
  const node = doc.createElement('div');
  node.className = 'html-artifact-controls';
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', '可视化查看器');
  const smaller = artifactIconButton(doc, 'minus', '缩小');
  const reset = doc.createElement('button');
  reset.type = 'button'; reset.className = 'btn ghost tiny';
  reset.setAttribute('aria-label', '重置为 100%');
  const larger = artifactIconButton(doc, 'plus', '放大');
  const fit = doc.createElement('button');
  fit.type = 'button'; fit.className = 'btn ghost tiny'; fit.textContent = '适应宽度';
  fit.title = '按可用宽度重新排版';
  const close = artifactIconButton(doc, 'close', '关闭全屏');
  smaller.onclick = () => onZoom(-0.25);
  larger.onclick = () => onZoom(0.25);
  reset.onclick = onReset; fit.onclick = onFit; close.onclick = onClose;
  node.append(smaller, reset, larger, fit, close);
  return {
    node, close,
    update(scale, fitting) {
      reset.textContent = `${Math.round(scale * 100)}%`;
      smaller.disabled = scale <= 0.5; larger.disabled = scale >= 2;
      fit.setAttribute('aria-pressed', String(fitting));
    },
    dispose() { for (const button of [smaller, reset, larger, fit, close]) button.onclick = null; },
  };
}
