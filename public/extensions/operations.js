/* 包操作在两个页签之间共用。确认前后都检查项目身份，结果只更新对应页面。 */
import { S, ownsWorkspace } from '../state.js';
import { extensionPackageAction } from '../api.js';
import { confirmModal, confirmSurfaceMeta, dismissConfirm } from '../ui/modal.js';
import { extensionOperationOutcome } from './market-model.js';

export function createExtensionOperations({ isLive, onChange }) {
  const owner = {};
  let pending = null;
  let receipt = null;

  const owns = (operation) => isLive() && pending === operation && ownsWorkspace(operation.generation);

  async function run({ action, id, name, confirmation }) {
    if (pending || !isLive() || S.switching) return;
    const operation = { action, id, name, generation: S.workspaceGeneration, phase: 'confirm' };
    pending = operation;
    const confirmed = await confirmModal({ ...confirmation, surface: 'extensions-package', meta: { owner } });
    if (!owns(operation) || S.switching || confirmed !== true) {
      if (pending === operation) pending = null;
      return;
    }
    operation.phase = 'running';
    receipt = null;
    onChange();
    const result = await extensionPackageAction(action, id);
    if (!owns(operation)) return;
    receipt = { ...operation, outcome: extensionOperationOutcome(action, result, { hasProject: S.hasProject }) };
    try {
      await onChange({ reload: true });
    } finally {
      if (owns(operation)) {
        pending = null;
        onChange();
      }
    }
  }

  return {
    run,
    rediscover: () => onChange({ reload: true }),
    busyFor(id, serverRunning = false) {
      if (pending?.phase === 'running') return { ...pending, own: pending.id === id };
      return serverRunning ? { own: false } : null;
    },
    receipt: () => receipt,
    dismiss() {
      receipt = null;
      onChange();
    },
    invalidate() {
      pending = null;
      receipt = null;
      if (confirmSurfaceMeta()?.owner === owner) dismissConfirm();
    },
  };
}
