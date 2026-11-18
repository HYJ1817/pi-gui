/* Non-appearance settings pages. Appearance is owned by appearance.js. */
import { openModal } from './ui/modal.js';
import { renderUpdateSection } from './update.js';
import { renderPiUpdateSection } from './pi-update.js';

export function openAppUpdates({ present = openModal } = {}) {
  present((card, close) => {
    card.classList.add('wide', 'app-updates-card');
    const heading = document.createElement('h3');
    heading.textContent = '应用与更新';
    card.appendChild(heading);
    renderUpdateSection(card);
    const runtime = document.createElement('details'); runtime.className = 'app-updates-runtime';
    const summary = document.createElement('summary'); summary.textContent = 'Pi 运行时更新';
    const runtimeBody = document.createElement('div');
    runtime.append(summary, runtimeBody); renderPiUpdateSection(runtimeBody); card.appendChild(runtime);
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn';
    done.textContent = '关闭'; done.onclick = close;
    actions.appendChild(done); card.appendChild(actions);
  });
}
