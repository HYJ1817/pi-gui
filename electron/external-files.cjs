'use strict';

/* 工作区外文件授权：原生确认窗口 + 后端私有 IPC。
 *
 * 渲染进程只能说“我想打开这个绝对路径”。真正的授权动作发生在主进程：
 *   1. 先让后端 inspect 出规范化路径（渲染进程不能决定展示什么路径）；
 *   2. 用系统对话框取得用户明确选择；
 *   3. 经父子进程通道把 create 发给后端，拿到不可伪造的 grant id。
 * HTTP 侧没有创建授权的入口，模型输出或页面脚本无法自行授权。
 *
 * 没有直属后端子进程（开发模式复用后端）时明确降级，不假装可用。
 *
 * 长期授权不另建配置存储：主进程用系统设置已有的 createSystemPreferenceFile
 * 保存 `external-file-grants.json`，后端只持运行期账本。启动时主进程把保存
 * 的记录交给后端逐条重验；授权是否有效始终由后端决定。 */

const path = require('node:path');
const { createSystemPreferenceFile } = require('./system-settings-store.cjs');

const MAX_GRANTS = 64;
const MAX_PATH_CHARS = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONVERSATION_KEY = /^(?:conversation:[0-9a-f-]{36}|classic:.+)$/i;

function validGrant(grant) {
  return Boolean(grant) && typeof grant === 'object' && !Array.isArray(grant)
    && typeof grant.id === 'string' && /^[a-f0-9]{32}$/.test(grant.id)
    && typeof grant.conversationKey === 'string'
    && grant.conversationKey.length <= MAX_PATH_CHARS + 16
    && CONVERSATION_KEY.test(grant.conversationKey) && !CONTROL.test(grant.conversationKey)
    && grant.kind === 'directory' && grant.scope === 'persistent'
    && typeof grant.target === 'string' && /^(?:[a-z]:[\\/]|\/)/i.test(grant.target)
    && grant.target.length <= MAX_PATH_CHARS && !CONTROL.test(grant.target)
    && typeof grant.createdAt === 'string' && grant.createdAt.length <= 40;
}

function validGrantStore(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Array.isArray(value.grants) && value.grants.length <= MAX_GRANTS
    && value.grants.every(validGrant);
}

function normalizedGrant(grant) {
  return {
    id: grant.id,
    conversationKey: grant.conversationKey,
    kind: 'directory',
    scope: 'persistent',
    target: grant.target,
    createdAt: grant.createdAt,
  };
}

function sameGrants(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function installExternalFiles({ ipcMain, dialog, getWindow, getServer, origin, directory }) {
  let pending = false;
  let sequence = 0;
  let store = null;
  let mirror = [];

  try {
    if (directory) {
      store = await createSystemPreferenceFile({
        directory,
        fileName: 'external-file-grants.json',
        defaults: { grants: [] },
        validate: validGrantStore,
        maxBytes: 16384,
      });
    }
  } catch {
    store = null;
  }
  if (store) {
    const state = store.snapshot();
    if (state.status !== 'unavailable') {
      mirror = state.settings.grants.map(normalizedGrant);
    }
  }

  function persistenceError() {
    if (!store) return 'external_grants_unavailable';
    const status = store.snapshot().status;
    if (status === 'unavailable') return 'external_grants_unavailable';
    if (status === 'corrupt') return 'external_grants_corrupt';
    return '';
  }

  async function persist(grants) {
    if (!store) return { ok: false, code: 'external_grants_unavailable', error: '长期授权存储不可用。' };
    const result = await store.save({ grants: grants.map(normalizedGrant) });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code || 'external_grants_save_failed',
        error: result.error || '长期授权保存失败。',
      };
    }
    return { ok: true };
  }

  /* 授权创建/撤销与持久化必须串行：否则先发起的 create 晚落盘，会把刚完成的
   * revoke 又写回来。对话框等待不在队列内，只有真正的后端变更与落盘串行。 */
  let mutations = Promise.resolve();
  function serialized(action) {
    const run = mutations.then(action, action);
    mutations = run.catch(() => {});
    return run;
  }

  const unavailable = {
    ok: false,
    code: 'native-unavailable',
    error: '外部文件授权只在桌面应用中可用。',
  };

  /* 原生对话框是唯一的用户确认入口，必须串行：包括文件夹选择窗口在内，
   * 第二个请求在第一个窗口关闭前直接返回 busy，不能排队后在后台弹出。 */
  async function exclusive(action) {
    if (pending) return { ok: false, code: 'busy', error: '已有授权确认正在进行。' };
    pending = true;
    try {
      return await action();
    } finally {
      pending = false;
    }
  }

  function trusted(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false;
    try {
      const url = new URL(event.senderFrame.url);
      return url.protocol === 'http:' && url.origin === origin;
    } catch { return false; }
  }

  function call(child, frame) {
    if (!child?.connected || child !== getServer()) return Promise.resolve(unavailable);
    const id = ++sequence;
    return new Promise(resolve => {
      let timer = null;
      function finish(result) {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('disconnect', onDisconnect);
        resolve(result);
      }
      function onMessage(message) {
        if (message?.type === 'files-grant-result' && message.id === id) finish(message.result);
      }
      function onDisconnect() { finish(unavailable); }
      timer = setTimeout(onDisconnect, 20_000);
      child.on('message', onMessage);
      child.once('disconnect', onDisconnect);
      try {
        child.send({ type: 'files-grant', id, ...frame }, error => { if (error) onDisconnect(); });
      } catch { onDisconnect(); }
    });
  }

  function validConversation(value) {
    return value === null || value === undefined || value === ''
      || (typeof value === 'string' && /^[\da-f-]{36}$/.test(value));
  }

  function validPath(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024
      && !/[\u0000-\u001f\u007f]/.test(value);
  }

  async function authorizePath(event, { rawPath, conversationId: rawConversation, scopeKind: rawKind }) {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    const child = getServer();
    if (!child?.connected) return unavailable;
    const conversationId = rawConversation;
    const scopeKind = rawKind === 'directory' ? 'directory' : 'file';
    if (!validPath(rawPath) || !validConversation(conversationId)) {
      return { ok: false, code: 'invalid_request', error: '路径或会话身份不合法。' };
    }
    try {
      const inspected = await call(child, {
        action: 'inspect',
        path: rawPath,
        scopeKind,
        conversationId: conversationId || null,
      });
      if (!inspected?.ok) {
        return {
          ok: false,
          code: inspected?.code || 'inspect_failed',
          error: inspected?.error || '无法确认这个路径。',
        };
      }
      /* 普通文件点击已有任何覆盖授权时不再打扰用户；但显式请求目录授权
       * （右键“授权所在文件夹…”或文件夹选择器）若是会话级，应允许用户
       * 通过同一个确认窗口升级为长期授权，而不是静默返回旧范围。 */
      const wantsFolder = scopeKind === 'directory';
      if (inspected.existing && !(wantsFolder && inspected.existing.scope !== 'persistent')) {
        return { ok: true, existing: true, grant: inspected.existing };
      }

      const target = inspected.target;
      const isFile = inspected.kind === 'file';
      const folder = typeof inspected.folder === 'string' ? inspected.folder : (isFile ? path.dirname(target) : target);
      const canPersist = Boolean(store) && store.snapshot().status !== 'unavailable';
      const buttons = isFile
        ? [...(canPersist ? ['仅此文件', '此文件夹（本次运行）', '记住此文件夹'] : ['仅此文件', '此文件夹（本次运行）']), '取消']
        : [...(canPersist ? ['此文件夹（本次运行）', '记住此文件夹'] : ['此文件夹（本次运行）']), '取消'];
      const cancelId = buttons.length - 1;
      const detail = [
        isFile ? `文件：${target}` : `文件夹：${target}`,
        isFile ? `文件夹：${folder}` : '',
        '',
        '仅本次运行：退出应用后失效。',
        ...(canPersist ? ['记住此文件夹：保存到系统设置，重启后仍对当前会话有效。'] : []),
        '授权只允许读取；不授予写入、删除或执行权限。',
      ].filter(line => line !== '').join('\n');
      const result = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        title: '访问工作区外文件',
        message: '允许 Pi GUI 读取工作区之外的这个位置？',
        detail,
        buttons,
        defaultId: cancelId,
        cancelId,
        noLink: true,
      });
      if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
      if (result.response === cancelId || result.response < 0) {
        return { ok: false, cancelled: true };
      }
      const persistent = canPersist && (isFile ? result.response === 2 : result.response === 1);
      const asDirectory = isFile ? result.response >= 1 : true;
      const created = await serialized(async () => {
        const reply = await call(child, {
          action: 'create',
          approval: inspected.approval,
          scopeKind: asDirectory ? 'directory' : 'file',
          persistent: asDirectory && persistent,
          conversationId: conversationId || null,
        });
        if (!reply?.ok) return reply;
        if (reply.grant?.scope !== 'persistent') return reply;
        if (!Array.isArray(reply.persistent)) {
          return { ok: false, code: 'external_grants_save_failed', error: '长期授权没有返回可保存的记录。' };
        }
        const next = reply.persistent.map(normalizedGrant);
        const saved = await persist(next);
        if (!saved.ok) {
          /* 用户选的是“记住”，落盘失败就不能把它当成长期授权继续。
           * 撤回刚创建的运行期授权，按失败返回，不留下“重启即失效”的假象。 */
          await call(child, { action: 'revoke', grantId: reply.grant.id, conversationId: conversationId || null });
          return {
            ok: false,
            code: saved.code || 'external_grants_save_failed',
            error: '长期授权没有保存成功，未开启访问。',
          };
        }
        mirror = next;
        return reply;
      });
      if (!created?.ok) {
        return {
          ok: false,
          code: created?.code || 'grant_failed',
          error: created?.error || '授权没有创建成功。',
        };
      }
      return { ok: true, grant: created.grant };
    } catch {
      return { ok: false, code: 'grant_failed', error: '授权确认窗口无法完成。' };
    }
  }

  ipcMain.handle('pi-gui:external-file-authorize', (event, request) => exclusive(() => authorizePath(event, {
    rawPath: request?.path,
    conversationId: request?.conversationId,
    scopeKind: request?.kind,
  })));

  ipcMain.handle('pi-gui:external-file-choose-directory', (event, request) => exclusive(async () => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    let result;
    try {
      result = await dialog.showOpenDialog(getWindow(), {
        title: '选择要授权访问的文件夹',
        properties: ['openDirectory'],
      });
    } catch {
      return { ok: false, code: 'dialog_failed', error: '无法打开文件夹选择窗口。' };
    }
    if (result.canceled || result.filePaths.length !== 1) return { ok: false, cancelled: true };
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    return authorizePath(event, {
      rawPath: result.filePaths[0],
      conversationId: request?.conversationId,
      scopeKind: 'directory',
    });
  }));

  ipcMain.handle('pi-gui:external-file-list', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    const child = getServer();
    if (!child?.connected) return unavailable;
    const conversationId = request?.conversationId;
    if (!validConversation(conversationId)) return { ok: false, code: 'invalid_request' };
    const result = await call(child, { action: 'list', conversationId: conversationId || null });
    if (!result?.ok) return result;
    const error = persistenceError();
    return error ? { ...result, storeError: error } : result;
  });

  ipcMain.handle('pi-gui:external-file-revoke', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    const child = getServer();
    if (!child?.connected) return unavailable;
    const conversationId = request?.conversationId;
    const grantId = request?.grantId;
    if (!validConversation(conversationId)
      || typeof grantId !== 'string' || !/^[a-f0-9]{32}$/.test(grantId)) {
      return { ok: false, code: 'invalid_request', error: '授权标识不合法。' };
    }
    return serialized(async () => {
      const result = await call(child, { action: 'revoke', grantId, conversationId: conversationId || null });
      if (!result?.ok || !Array.isArray(result.persistent)) return result;
      const next = result.persistent.map(normalizedGrant);
      if (sameGrants(next, mirror)) return result;
      const saved = await persist(next);
      if (saved.ok) {
        mirror = next;
        return result;
      }
      /* 撤销没有写进长期存储时不能告诉用户“已撤销”：重启会把它恢复。
       * 把刚移除的持久授权重新交给后端，保持内存与磁盘一致，并返回失败。 */
      if (result.removed && validGrant(result.removed)) {
        await call(child, { action: 'restore', grants: [result.removed] });
      }
      return {
        ok: false,
        code: 'revoke_not_saved',
        error: '撤销没有保存成功，访问仍然有效，请重试。',
        storeError: saved.code || 'external_grants_save_failed',
      };
    });
  });

  /* 启动时调用一次：把主进程保存的长期目录授权交给后端逐条重验。
   * 后端会丢掉已删除、已变成符号链接、进入敏感目录或格式不合法的记录；
   * 清理后的权威集合再回写存储，避免坏记录每次启动都被重新投喂。 */
  async function restore() {
    const child = getServer();
    if (!child?.connected) return unavailable;
    if (!store) {
      return { ok: false, code: 'external_grants_unavailable', error: '长期授权存储不可用。' };
    }
    return serialized(async () => {
      if (!mirror.length) return { ok: true, restored: 0, persistent: [] };
      const result = await call(child, { action: 'restore', grants: mirror });
      if (!result?.ok) return result;
      const next = Array.isArray(result.persistent) ? result.persistent.map(normalizedGrant) : [];
      if (!sameGrants(next, mirror)) {
        const saved = await persist(next);
        if (!saved.ok) {
          return { ...result, storeError: saved.code || 'external_grants_save_failed' };
        }
      }
      mirror = next;
      return result;
    });
  }

  return { restore };
}

module.exports = { installExternalFiles };
