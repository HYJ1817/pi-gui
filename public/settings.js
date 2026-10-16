/* Settings organizes existing actions. Update state still belongs to its owners. */
import { openModal } from './ui/modal.js';
import { renderUpdateSection } from './update.js';
import { renderPiUpdateSection } from './pi-update.js';
import { themePreference, setThemePreference, onThemeChange } from './theme.js';

export function openAppearance() {
  let unsubscribe = null;
  openModal((card, close) => {
    const heading = document.createElement('h3'); heading.textContent = '外观与主题';
    const body = document.createElement('fieldset'); body.className = 'appearance-body';
    const legend = document.createElement('legend'); legend.textContent = '主题'; body.append(legend);
    const status = document.createElement('p'); status.className = 'modal-desc'; status.setAttribute('role', 'status');
    status.textContent = '仅改变界面外观；System 随系统主题变化。';
    const select = document.createElement('select'); select.setAttribute('aria-label', '界面主题');
    for (const [value, text] of [['dark', 'Claude Dark'], ['light', 'Claude Light'], ['system', 'System（跟随系统）']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
    }
    select.value = themePreference(); body.append(select);
    select.onchange = async () => { if (!await setThemePreference(select.value)) { select.value = themePreference(); status.textContent = '主题未能切换，请重试。'; } };
    unsubscribe = onThemeChange(snapshot => {
      select.value = snapshot.preference;
      status.textContent = snapshot.persisted ? '主题偏好已保存。' : '主题已应用，本次无法保存偏好。';
    });
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn'; done.textContent = '关闭'; done.onclick = close;
    actions.append(done); card.append(heading, body, status, actions);
  }, () => unsubscribe?.());
}

export function openAppUpdates() {
  openModal((card, close) => {
    card.classList.add('wide');
    const heading = document.createElement('h3');
    heading.textContent = '应用与更新';
    card.appendChild(heading);
    renderUpdateSection(card);
    renderPiUpdateSection(card);
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn';
    done.textContent = '关闭'; done.onclick = close;
    actions.appendChild(done); card.appendChild(actions);
  });
}
