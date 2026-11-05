/* Presentation only: the existing tool buttons retain capability and action ownership. */
export function mountWorkPanelLauncher(host, tools) {
  const root = document.createElement('section');
  root.className = 'work-panel-empty';
  const title = document.createElement('h2');
  title.textContent = '新建';
  const list = document.createElement('div');
  list.className = 'work-panel-launcher-list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', '工作面板工具');
  const bindings = tools.filter(Boolean).map(source => {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'work-panel-launcher-row';
    row.dataset.tool = source.id;
    const icon = document.createElement('span');
    icon.className = 'work-panel-launcher-icon'; icon.setAttribute('aria-hidden', 'true');
    const svg = source.querySelector('svg');
    if (svg) icon.append(svg.cloneNode(true));
    const label = document.createElement('span');
    const sync = () => {
      row.hidden = source.hidden;
      row.disabled = source.disabled;
      label.textContent = source.getAttribute('aria-label') || source.title;
    };
    row.onclick = () => {
      if (source.hidden || source.disabled) return;
      source.focus(); source.click();
    };
    row.append(icon, label); list.append(row); sync();
    return { source, row, sync };
  });
  const observer = new MutationObserver(() => bindings.forEach(binding => binding.sync()));
  for (const { source } of bindings) observer.observe(source, { attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-label'] });
  root.append(title, list); host.append(root);
  return () => {
    observer.disconnect();
    for (const { row } of bindings) { row.disabled = true; row.onclick = null; }
  };
}
