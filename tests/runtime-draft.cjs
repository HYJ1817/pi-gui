/* tests/runtime-draft.cjs
 * Z5-1: Runtime 草稿适配器单元测试
 */

const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;

  const {
    RUNTIME_DRAFT_PREFIX,
    DRAFT_MAX_CHARS,
    DRAFT_SAVE_DEBOUNCE_MS,
    extractStableLocator,
    runtimeDraftKey,
    sameStableLocator,
    saveRuntimeDraft,
    restoreRuntimeDraft,
    clearRuntimeDraft,
    createRuntimeDraftCoordinator,
  } = await import('../public/runtime-draft.js');

  /* ---- 1. extractStableLocator 身份提取 ---- */
  const validOwner = {
    backendInstance: 'backend-1',
    projectId: 'proj-1',
    repoId: 'repo-1',
    workspaceId: 'ws-1',
    workspaceEpoch: 'epoch-1',
    conversationId: 'conv-1',
    runtimeId: 'rt-1',
    runtimeGeneration: 'g-1',
    sessionId: 'native-1',
  };
  const validItem = {
    conversationId: 'conv-1',
    nativeSessionId: 'native-1',
    workspace: { projectId: 'proj-1', workspaceId: 'ws-1', workspaceEpoch: 'epoch-1' },
    owner: validOwner,
  };

  const loc = extractStableLocator(validItem, validOwner);
  ok('提取完整稳定 locator', loc && loc.projectId === 'proj-1' && loc.workspaceId === 'ws-1'
    && loc.workspaceEpoch === 'epoch-1' && loc.conversationId === 'conv-1' && loc.nativeSessionId === 'native-1');

  // 身份冲突：item.nativeSessionId !== owner.sessionId
  const conflictItem = { ...validItem, nativeSessionId: 'native-conflict' };
  ok('nativeSessionId 冲突时返回 null', extractStableLocator(conflictItem, validOwner) === null);
  ok('workspace 字段与 owner 冲突时返回 null', extractStableLocator({ ...validItem, workspace: { ...validItem.workspace, projectId: 'proj-diff' } }, validOwner) === null);

  // 缺少字段
  ok('缺少 projectId 返回 null', extractStableLocator({ ...validItem, workspace: { ...validItem.workspace, projectId: '' } }, { ...validOwner, projectId: '' }) === null);
  ok('缺少 workspaceId 返回 null', extractStableLocator({ ...validItem, workspace: { ...validItem.workspace, workspaceId: null } }, { ...validOwner, workspaceId: null }) === null);
  ok('缺少 workspaceEpoch 返回 null', extractStableLocator({ ...validItem, workspace: { ...validItem.workspace, workspaceEpoch: '   ' } }, { ...validOwner, workspaceEpoch: '' }) === null);
  ok('缺少 conversationId 返回 null', extractStableLocator({ ...validItem, conversationId: '' }, { ...validOwner, conversationId: '' }) === null);
  ok('缺少 nativeSessionId 返回 null', extractStableLocator({ ...validItem, nativeSessionId: null }, { ...validOwner, sessionId: null }) === null);

  // 只有 item.nativeSessionId（如 dormant 会话）
  const dormantItem = { ...validItem, owner: null };
  const dormantLoc = extractStableLocator(dormantItem, null);
  ok('dormant 会话提取 nativeSessionId', dormantLoc && dormantLoc.nativeSessionId === 'native-1');

  // 超长非法字段（防注入）
  const hugeField = 'x'.repeat(513);
  ok('超过 512 字符的非法身份返回 null', extractStableLocator({ ...validItem, conversationId: hugeField }, null) === null);

  /* ---- 2. runtimeDraftKey 生成 ---- */
  const key1 = runtimeDraftKey(loc);
  ok('生成合规 key 前缀与结构', key1 === 'pi-gui.draft.v1:runtime:proj-1:ws-1:epoch-1:conv-1:native-1');
  ok('无效 locator 返回 null', runtimeDraftKey(null) === null);
  ok('部分空字段 locator 返回 null', runtimeDraftKey({ ...loc, nativeSessionId: '' }) === null);

  // 编码特殊字符
  const specialLoc = {
    projectId: 'p/1:special',
    workspaceId: 'w 1',
    workspaceEpoch: 'e#1',
    conversationId: 'c?1',
    nativeSessionId: 's&1',
  };
  const keySpecial = runtimeDraftKey(specialLoc);
  ok('特殊字符安全 encodeURIComponent 编码', keySpecial === 'pi-gui.draft.v1:runtime:p%2F1%3Aspecial:w%201:e%231:c%3F1:s%261');

  /* ---- 3. sameStableLocator 比较 ---- */
  ok('相同 locator 判定一致', sameStableLocator(loc, { ...loc }));
  ok('nativeSessionId 不同判定不一致', !sameStableLocator(loc, { ...loc, nativeSessionId: 'native-2' }));
  ok('workspaceEpoch 不同判定不一致', !sameStableLocator(loc, { ...loc, workspaceEpoch: 'epoch-2' }));
  ok('conversationId 不同判定不一致', !sameStableLocator(loc, { ...loc, conversationId: 'conv-2' }));

  /* ---- 4. 保存与恢复 ---- */
  localStorage.clear();
  const testKey = runtimeDraftKey(loc);

  // 4.1 正常纯文本
  const res1 = saveRuntimeDraft(testKey, 'hello runtime draft');
  ok('正常保存返回 saved', res1.status === 'saved' && res1.text === 'hello runtime draft');
  const restored1 = restoreRuntimeDraft(testKey);
  ok('正常恢复纯文本', restored1 === 'hello runtime draft');

  // 4.2 空文本清除持久副本
  const resEmpty = saveRuntimeDraft(testKey, '   ');
  ok('空文本返回 empty', resEmpty.status === 'empty');
  ok('空文本后持久副本已清除', restoreRuntimeDraft(testKey) === '');

  // 4.3 边界测试：恰好 20000 字符
  const text20000 = 'A'.repeat(DRAFT_MAX_CHARS);
  const res20000 = saveRuntimeDraft(testKey, text20000);
  ok('20000 字符正常保存', res20000.status === 'saved');
  ok('20000 字符正常恢复', restoreRuntimeDraft(testKey) === text20000);

  // 4.4 超限测试：20001 字符
  const text20001 = 'B'.repeat(DRAFT_MAX_CHARS + 1);
  const res20001 = saveRuntimeDraft(testKey, text20001);
  ok('超限返回 exceeded', res20001.status === 'exceeded' && res20001.notice.includes('超过本地恢复上限'));
  ok('超限保留内存完整文本', res20001.text.length === 20001);
  ok('超限清除了持久副本防止旧稿残留', restoreRuntimeDraft(testKey) === '');

  // 4.5 缩短文本后重新保存
  const resShortened = saveRuntimeDraft(testKey, 'recovered short text');
  ok('超限后缩短可重新保存', resShortened.status === 'saved');
  ok('缩短后恢复正常', restoreRuntimeDraft(testKey) === 'recovered short text');

  // 4.6 无 key 保存（unbound）
  const resUnbound = saveRuntimeDraft(null, 'unbound draft');
  ok('无 key 保存返回 unbound', resUnbound.status === 'unbound' && resUnbound.text === 'unbound draft');

  /* ---- 5. clearRuntimeDraft 条件清理 ---- */
  const resCond = clearRuntimeDraft(testKey, 'mismatch text');
  ok('文本不匹配时拒绝清除', resCond === false);
  ok('拒绝清除后草稿仍在', restoreRuntimeDraft(testKey) === 'recovered short text');

  const resCondOk = clearRuntimeDraft(testKey, 'recovered short text');
  ok('文本匹配时成功清除', resCondOk === true);
  ok('清除后草稿为空', restoreRuntimeDraft(testKey) === '');

  /* ---- 6. 异常与降级 ---- */
  // 6.1 损坏的 JSON 格式
  localStorage.setItem(testKey, '{ invalid json');
  ok('损坏 JSON 恢复为空字符串且不抛错', restoreRuntimeDraft(testKey) === '');

  // 6.2 异常的超大文本存储在 localStorage（外部篡改）
  localStorage.setItem(testKey, JSON.stringify({ v: 1, text: 'X'.repeat(30000), at: Date.now() }));
  ok('恢复时若发现超长文本拒绝恢复并清除', restoreRuntimeDraft(testKey) === '');

  /* ---- 7. createRuntimeDraftCoordinator 防抖与生命周期 ---- */
  const statusEvents = [];
  const coord = createRuntimeDraftCoordinator({
    onStatus: (k, s) => { statusEvents.push({ k, s }); },
  });

  coord.schedule(testKey, 'scheduled text');
  ok('调度后尚未触发 flush', statusEvents.length === 0);
  await new Promise(r => setTimeout(r, DRAFT_SAVE_DEBOUNCE_MS + 50));
  ok('防抖时间到达后触发保存', statusEvents.length === 1 && statusEvents[0].s.status === 'saved');
  ok('恢复防抖保存文本', restoreRuntimeDraft(testKey) === 'scheduled text');

  statusEvents.length = 0;
  coord.schedule(testKey, 'flush text');
  const flushed = coord.flush();
  ok('flush 立即同步保存', flushed && flushed.status === 'saved');
  ok('恢复 flush 文本', restoreRuntimeDraft(testKey) === 'flush text');
  ok('flush 后 pending 已清空', coord.flush() === null);

  coord.dispose();

  console.log(`Runtime draft tests: ${checks}/${checks}`);
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
