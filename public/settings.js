/* Settings organizes existing actions. Update state still belongs to its owners. */
import { openModal } from './ui/modal.js';
import { renderUpdateSection } from './update.js';
import { renderPiUpdateSection } from './pi-update.js';

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
