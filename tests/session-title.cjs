'use strict';
/* 顶部会话标题的投影规则（纯函数，无 DOM / 无 Pi）。
 *
 * 这些用例只钉「选哪一条、显示什么」，不代替 smoke 里的真实切换链路：
 * 那里还会验证 switch 应答、侧栏异步刷新、重命名与 new_session 的接线。
 */
const assert = require('node:assert/strict');

(async () => {
  const { isNewSessionEntry, projectSessionTitle, sessionDisplayTitle } = await import('../public/session-title.js');

  const sessions = [
    { id: 'current', title: '你好', current: true, pending: false },
    { id: 'history', title: '帮我写个登录功能', current: false, pending: false },
    { id: 'pending', title: '新会话（还没有消息）', current: false, pending: true },
    { id: 'blank', title: '（还没有消息）', current: false, pending: false },
    { id: 'untitled', title: '', current: false, pending: false },
  ];

  // 1. Pi 的实时名字**不再**直接投影：有列表时用列表里后端裁决过的标题，
  //    没有列表时返回 null（调用方保留已有标题），原生名不能覆盖确认标题。
  assert.deepEqual(
    projectSessionTitle({ sessions, liveName: '我命名的会话' }),
    { key: 'current', title: '你好' }
  );
  assert.equal(projectSessionTitle({ liveName: '我命名的会话' }), null);
  assert.equal(projectSessionTitle({ sessions, liveName: '   ' }).title, '你好');

  // 2. 用当前会话的列表标题（历史会话恢复）
  assert.deepEqual(
    projectSessionTitle({ sessions, currentId: 'current' }),
    { key: 'current', title: '你好' }
  );

  // 3. 刚切过去的那条优先于列表里可能过期的 current 标记
  assert.deepEqual(
    projectSessionTitle({ sessions, currentId: 'current', expectedKey: 'history' }),
    { key: 'history', title: '帮我写个登录功能' }
  );

  // 4. 连续切换：同一份列表、不同的 expectedKey，各取各的，不缓存上一条
  const first = projectSessionTitle({ sessions, expectedKey: 'history' });
  const second = projectSessionTitle({ sessions, expectedKey: 'current' });
  assert.equal(first.title, '帮我写个登录功能');
  assert.equal(second.title, '你好');
  assert.notEqual(first.key, second.key);

  // 5. 目标还没出现在列表里 → 保持切换应答里的标题，绝不画另一条
  assert.equal(projectSessionTitle({ sessions, expectedKey: 'not-loaded-yet' }), null);

  // 6. 新建 / 空会话统一显示「新会话」
  assert.equal(projectSessionTitle({ sessions, expectedKey: 'pending' }).title, '新会话');
  assert.equal(projectSessionTitle({ sessions, expectedKey: 'blank' }).title, '新会话');
  assert.equal(projectSessionTitle({ sessions, expectedKey: 'untitled' }).title, '新会话');

  // 7. currentId 兜底（旧接口没有 current 标记时）
  assert.equal(
    projectSessionTitle({ sessions: [{ id: 'only', title: '只有这一条' }], currentId: 'only' }).title,
    '只有这一条'
  );

  // 8. 没有可用的当前项 → null（调用方保留已有标题）
  assert.equal(projectSessionTitle({ sessions: [{ id: 'x', title: 'x' }] }), null);
  assert.equal(projectSessionTitle({ sessions: [] }), null);
  assert.equal(projectSessionTitle({}), null);

  // 9. 同名不同 ID：必须认 ID，不能按标题猜
  const sameNames = [
    { id: 'a', title: '同一个标题', current: true },
    { id: 'b', title: '同一个标题', current: false },
  ];
  assert.equal(projectSessionTitle({ sessions: sameNames, expectedKey: 'b' }).key, 'b');

  // 10. 条目展示规则本身（pending / 空标题 / 空会话占位）
  assert.equal(sessionDisplayTitle({ title: '真实标题' }), '真实标题');
  assert.equal(sessionDisplayTitle({ title: '真实标题', pending: true }), '新会话');
  assert.equal(sessionDisplayTitle({ title: '（还没有消息）' }), '新会话');
  assert.equal(sessionDisplayTitle({ title: '新会话（还没有消息）' }), '新会话');
  assert.equal(sessionDisplayTitle({ title: '   ' }), '新会话');
  assert.equal(sessionDisplayTitle(null), '新会话');
  assert.equal(sessionDisplayTitle({ title: '真实标题' }, '未命名'), '真实标题');
  assert.equal(sessionDisplayTitle(null, '未命名'), '未命名');

  // 11. 新建会话：只认 pending 或「之前没见过的 ID」，旧列表的 current 不算
  const known = new Set(['old-a', 'old-b']);
  assert.equal(isNewSessionEntry({ id: 'old-a', current: true }, 'old-b', known), false, '旧列表 current 不能冒充新会话');
  assert.equal(isNewSessionEntry({ id: 'old-b', current: true }, 'old-b', known), false, '切换前那条不能冒充新会话');
  assert.equal(isNewSessionEntry({ id: 'brand-new', current: true }, 'old-b', known), true);
  assert.equal(isNewSessionEntry({ id: 'pending-new', pending: true }, 'old-b', known), true);
  assert.equal(isNewSessionEntry(null, 'old-b', known), false);
  assert.equal(isNewSessionEntry({ id: '' }, 'old-b', known), false);

  console.log('session-title: 11 组投影用例全部通过');
})().catch((err) => {
  console.error('session-title 测试失败：', err);
  process.exit(1);
});
