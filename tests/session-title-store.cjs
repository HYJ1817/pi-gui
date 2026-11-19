'use strict';
/* 会话标题存储（server/session-title-store.js）的离线测试。
 *
 * 这一套只碰**临时目录**：标题与设置都是 Pi GUI 自己的元数据文件，
 * 不读、不写任何真实项目或 Pi 会话。覆盖优先级、持久化、原生改名失效、
 * 只生成一次的标记、坏文件降级与容量上限。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  let ok = cond;
  try { ok = typeof cond === 'function' ? cond() : cond; }
  catch (err) { ok = 'threw: ' + err.message; }
  if (ok === true) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : '')); }
}
const section = (title) => console.log('\n--- ' + title + ' ---');

(async () => {
  const { createSessionTitleStore } = await import('../server/session-title-store.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-title-store-'));

  /* 可控时钟：条目的 updatedAt 排序依赖时间，真实时钟可能同毫秒。 */
  let clock = Date.parse('2030-01-01T00:00:00.000Z');
  const now = () => new Date(clock += 1000);
  const make = (dir, opts = {}) => createSessionTitleStore({ dataDir: dir, now, ...opts });

  try {
    /* ================= 1. 设置 ================= */
    section('1. 设置默认值与持久化');
    const d1 = path.join(root, 'd1');
    const s1 = make(d1);
    check('1a. 默认开启自动标题', () => s1.settings().autoEnabled === true);
    check('1b. 默认门槛 enabledAt 是合法 ISO 时间', () => Number.isFinite(Date.parse(s1.settings().enabledAt)));
    check('1c. 设置文件已落盘', () => fs.existsSync(s1.paths.settings));
    const off = s1.updateSettings({ autoEnabled: false });
    check('1d. 关闭后 revision 递增', () => off.revision > 1);
    check('1e. 重新加载仍保持关闭', () => make(d1).settings().autoEnabled === false);
    check('1f. 非法值不改变设置', () => s1.updateSettings({ autoEnabled: 'no' }).autoEnabled === false);
    const on = s1.updateSettings({ autoEnabled: true });
    check('1g. 重新开启会重置门槛（只对新会话生效）', () =>
      on.autoEnabled === true && Date.parse(on.enabledAt) >= Date.parse(off.enabledAt));
    check('1h. 再开启一次 revision 继续递增', () => on.revision > off.revision);

    /* ================= 2. 优先级 ================= */
    section('2. 标题来源优先级');
    const s2 = make(path.join(root, 'd2'));
    const key = 'classic:11111111-1111-4111-8111-111111111111';
    check('2a. 什么都没有 → 默认标题', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111' });
      return r.source === 'default' && r.title === '（还没有消息）';
    });
    check('2b. 只有首条消息 → fallback', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111', fallback: '帮我写登录' });
      return r.source === 'fallback' && r.title === '帮我写登录';
    });
    check('2c. 原生手动名压过首条消息', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111', nativeName: '用户起的名字', fallback: '帮我写登录' });
      return r.source === 'manual' && r.title === '用户起的名字';
    });
    s2.setAuto(key, { title: 'AI 自动标题', providerId: 'p', modelId: 'm' });
    check('2d. 自动标题压过首条消息', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111', fallback: '帮我写登录' });
      return r.source === 'auto' && r.title === 'AI 自动标题';
    });
    check('2e. 原生手动名仍然压过自动标题', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111', nativeName: '用户起的名字' });
      return r.source === 'manual' && r.title === '用户起的名字';
    });
    s2.setManual(key, { title: '用户采纳的 AI 标题', nativeNameAt: '用户起的名字' });
    check('2f. 采纳的覆盖压过同名原生名', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111', nativeName: '用户起的名字' });
      return r.source === 'manual' && r.title === '用户采纳的 AI 标题' && r.manualOverride === true;
    });
    check('2g. 原生名在 Pi 里被改掉 → 覆盖失效、原生名获胜', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111', nativeName: '后来改的名字' });
      return r.source === 'manual' && r.title === '后来改的名字' && r.manualOverride === false;
    });
    check('2h. 覆盖失效后自动标题仍在（不丢失）', () => {
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111' });
      return r.source === 'auto' && r.title === 'AI 自动标题';
    });
    check('2i. clearManual 后回到自动标题', () => {
      s2.clearManual(key);
      const r = s2.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111' });
      return r.source === 'auto' && r.title === 'AI 自动标题';
    });

    /* ================= 3. 只生成一次 ================= */
    section('3. attempt 标记');
    const s3 = make(path.join(root, 'd3'));
    const k3 = 'runtime:22222222-2222-4222-8222-222222222222';
    check('3a. 第一次 attempt 成功', () => Boolean(s3.recordAttempt(k3, 1)));
    check('3b. 第二次 attempt 被拒（自动标题只跑一次）', () => s3.recordAttempt(k3, 1) === null);
    check('3c. 有 auto 后不再记 attempt', () => {
      s3.setAuto(k3, { title: '标题' });
      return s3.recordAttempt('runtime:33333333-3333-4333-8333-333333333333', 1) !== null
        && s3.recordAttempt(k3, 1) === null;
    });
    check('3d. 有 manual 后不再记 attempt', () => {
      const k = 'classic:44444444-4444-4444-8444-444444444444';
      s3.setManual(k, { title: '手动' });
      return s3.recordAttempt(k, 1) === null;
    });

    /* ================= 4. 键与清理 ================= */
    section('4. 键校验与删除清理');
    const s4 = make(path.join(root, 'd4'));
    check('4a. 非法 scope / 空 id → key 为 null', () => s4.keyFor('classic', '') === null && s4.keyFor('other', 'x') === null);
    check('4b. 带路径分隔符的 id 不能写进存储', () => s4.recordAttempt('classic:../../etc/passwd', 1) === null);
    s4.setAuto('classic:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { title: '会被删的标题' });
    check('4c. forgetClassic 按原生会话 id 删除', () => s4.forgetClassic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') === true);
    check('4d. 删除后回落到默认', () => s4.resolve({ scope: 'classic', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).source === 'default');
    check('4e. 未知键 forget 返回 false', () => s4.forget('classic:not-there') === false);

    /* ================= 5. 容量与文本清洗 ================= */
    section('5. 上限与清洗');
    const s5 = make(path.join(root, 'd5'), { maxEntries: 2 });
    s5.setAuto('classic:00000000-0000-4000-8000-000000000001', { title: '一' });
    s5.setAuto('classic:00000000-0000-4000-8000-000000000002', { title: '二' });
    s5.setAuto('classic:00000000-0000-4000-8000-000000000003', { title: '三' });
    check('5a. 有效标题（auto / manual）不因条数超限被删除', () => {
      const reloaded = make(path.join(root, 'd5'), { maxEntries: 2 });
      return Boolean(reloaded.entry('classic:00000000-0000-4000-8000-000000000001'))
        && Boolean(reloaded.entry('classic:00000000-0000-4000-8000-000000000002'))
        && Boolean(reloaded.entry('classic:00000000-0000-4000-8000-000000000003'));
    });
    check('5a2. 只有失败 attempt 会按上限清理', () => {
      const d = path.join(root, 'd5b');
      const s = make(d, { maxEntries: 2 });
      for (const n of ['1', '2', '3']) {
        s.recordAttempt(`classic:00000000-0000-4000-8000-00000000010${n}`, 1);
      }
      const reloaded = make(d, { maxEntries: 2 });
      const attempts = ['1', '2', '3']
        .filter((n) => reloaded.entry(`classic:00000000-0000-4000-8000-00000000010${n}`));
      return attempts.length === 2 && !reloaded.entry('classic:00000000-0000-4000-8000-000000000101');
    });
    check('5b. 标题里的换行与控制字符被折成单行', () => {
      const k = 'classic:00000000-0000-4000-8000-00000000000f';
      s5.setAuto(k, { title: '第一行\n第二行\u0007' });
      return s5.entry(k).auto.title === '第一行 第二行';
    });
    check('5c. 空标题不写入', () => {
      const k = 'classic:00000000-0000-4000-8000-00000000000e';
      return s5.setAuto(k, { title: '   ' }) === null && s5.entry(k) === null;
    });

    /* ================= 6. 坏文件降级 ================= */
    section('6. 坏文件不拖垮启动');
    const d6 = path.join(root, 'd6');
    fs.mkdirSync(d6, { recursive: true });
    fs.writeFileSync(path.join(d6, 'session-titles.json'), '{ this is not json', 'utf8');
    fs.writeFileSync(path.join(d6, 'session-title-settings.json'), 'broken', 'utf8');
    const s6 = make(d6);
    check('6a. 坏标题文件仍能创建 store', () => s6.settings().autoEnabled === true);
    check('6b. 坏设置文件被备份并写好默认值', () =>
      fs.readdirSync(d6).some((f) => f.startsWith('session-title-settings.json.corrupt-')));
    s6.setAuto('classic:55555555-5555-4555-8555-555555555555', { title: '恢复后的标题' });
    check('6c. 坏标题文件被备份，新标题可以保存', () =>
      fs.readdirSync(d6).some((f) => f.startsWith('session-titles.json.corrupt-'))
      && s6.resolve({ scope: 'classic', sessionId: '55555555-5555-4555-8555-555555555555' }).source === 'auto');

    /* 能解析但形状不对，同样是坏文件：不能静默覆盖、也不能丢备份。 */
    const d6b = path.join(root, 'd6b');
    fs.mkdirSync(d6b, { recursive: true });
    fs.writeFileSync(path.join(d6b, 'session-titles.json'), JSON.stringify({ version: 1, items: 'nope' }), 'utf8');
    fs.writeFileSync(path.join(d6b, 'session-title-settings.json'), JSON.stringify(['not', 'an', 'object']), 'utf8');
    const s6b = make(d6b);
    check('6d. 形状错误的设置文件也被备份，并回到默认开启', () =>
      s6b.settings().autoEnabled === true
      && fs.readdirSync(d6b).some((f) => f.startsWith('session-title-settings.json.corrupt-')));
    s6b.setAuto('classic:55555555-5555-4555-8555-555555555556', { title: '形状修复后的标题' });
    check('6e. 形状错误的标题文件被备份后才覆盖', () =>
      fs.readdirSync(d6b).some((f) => f.startsWith('session-titles.json.corrupt-'))
      && s6b.resolve({ scope: 'classic', sessionId: '55555555-5555-4555-8555-555555555556' }).source === 'auto');

    /* 旧版本数据没有 revision / nativeName：迁移时补 0，不能丢标题。 */
    const d6c = path.join(root, 'd6c');
    fs.mkdirSync(d6c, { recursive: true });
    const item = (id, at, title) => ({ key: 'classic:' + id, auto: { title, at }, updatedAt: at });
    fs.writeFileSync(path.join(d6c, 'session-titles.json'), JSON.stringify({ version: 1, items: [
      item('11111111-1111-4111-8111-111111111111', '2030-01-01T00:00:00.000Z', '旧标题'),
      item('22222222-2222-4222-8222-222222222222', '2030-02-01T00:00:00.000Z', '中间标题'),
      item('33333333-3333-4333-8333-333333333333', '2030-03-01T00:00:00.000Z', '新标题'),
    ] }), 'utf8');
    const s6c = make(d6c, { maxEntries: 2 });
    check('6f. 旧数据（无 revision）迁移后保留全部有效标题，修订从 0 开始', () =>
      s6c.entry('classic:33333333-3333-4333-8333-333333333333')?.auto.title === '新标题'
      && s6c.entry('classic:22222222-2222-4222-8222-222222222222')?.auto.title === '中间标题'
      && s6c.entry('classic:11111111-1111-4111-8111-111111111111')?.auto.title === '旧标题'
      && s6c.resolve({ scope: 'classic', sessionId: '11111111-1111-4111-8111-111111111111' }).revision === 0);

    /* ================= 7. 跨重启持久化 ================= */
    section('7. 重启后恢复');
    const d7 = path.join(root, 'd7');
    const s7a = make(d7);
    s7a.setAuto('classic:66666666-6666-4666-8666-666666666666', { title: '重启也要在', providerId: 'anthropic', modelId: 'claude-sonnet-5-5' });
    s7a.setManual('runtime:77777777-7777-4777-8777-777777777777', { title: '手动采纳的标题', nativeNameAt: '' });
    s7a.updateSettings({ autoEnabled: false });
    const s7b = make(d7);
    check('7a. 自动标题跨重启保留', () => s7b.resolve({ scope: 'classic', sessionId: '66666666-6666-4666-8666-666666666666' }).title === '重启也要在');
    check('7b. provider / model 元数据保留（用于诊断）', () => {
      const e = s7b.entry('classic:66666666-6666-4666-8666-666666666666');
      return e.auto.providerId === 'anthropic' && e.auto.modelId === 'claude-sonnet-5-5';
    });
    check('7c. 覆盖标题与其原生名快照保留', () => {
      const r = s7b.resolve({ scope: 'runtime', conversationId: '77777777-7777-4777-8777-777777777777' });
      return r.source === 'manual' && r.manualOverride === true && r.title === '手动采纳的标题';
    });
    check('7d. 关闭状态跨重启保留', () => s7b.settings().autoEnabled === false);

    /* ================= 8. 修订号与并发裁决 ================= */
    section('8. 修订号与并发裁决');
    const d8 = path.join(root, 'd8');
    const s8 = make(d8);
    const k8 = 'classic:88888888-8888-4888-8888-888888888888';
    const resolve8 = (extra = {}) => s8.resolve({ scope: 'classic', sessionId: '88888888-8888-4888-8888-888888888888', ...extra });
    const manual8 = s8.setManual(k8, { title: '手动一', nativeNameAt: '' });
    check('8a. setManual 递增 revision，并可从 resolve 读到', () =>
      manual8 && manual8.revision === 1 && resolve8().revision === 1 && resolve8().title === '手动一');
    const staleAuto = s8.setAuto(k8, { title: '迟到的自动标题', nativeName: '', expectedRevision: 0 });
    check('8b. 旧修订的自动结果被拒，原标题不变', () =>
      staleAuto && staleAuto.ok === false && staleAuto.code === 'revision_conflict'
      && staleAuto.revision === 1 && resolve8().title === '手动一');
    const manual8b = s8.setManual(k8, { title: '手动二', nativeNameAt: '', expectedRevision: 1 });
    check('8c. 修订匹配的手动改名成功并继续递增', () =>
      manual8b && manual8b.revision === 2 && resolve8().title === '手动二');
    check('8d. 原生名变化使旧的 manual 覆盖失效并递增 revision', () => {
      const r = resolve8({ nativeName: 'Pi 里改的名字' });
      return r.title === 'Pi 里改的名字' && r.manualOverride === false && r.revision === 3
        && !s8.entry(k8).manual;
    });
    const k8b = 'classic:99999999-9999-4999-8999-999999999999';
    s8.setManual(k8b, { title: '手动覆盖', nativeNameAt: '原名字' });
    const unresolved = s8.resolve({
      scope: 'classic', sessionId: '99999999-9999-4999-8999-999999999999',
      nativeName: '读取不完整时看到的旧名字', nativeConfirmed: false,
    });
    check('8e. 原生名未确认（截断读取）时不误删 manual 覆盖', () =>
      unresolved.manualOverride === true && unresolved.title === '手动覆盖'
      && s8.entry(k8b)?.manual?.title === '手动覆盖');
    check('8f. revision 跨重启保留', () =>
      make(d8).resolve({ scope: 'classic', sessionId: '88888888-8888-4888-8888-888888888888', nativeName: 'Pi 里改的名字' }).revision === 3);
    const k8c = 'classic:aaaaaaaa-0000-4000-8000-000000000001';
    s8.setManual(k8c, { title: '要被清除', nativeNameAt: '' });
    const beforeClear = s8.resolve({ scope: 'classic', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }).revision;
    s8.clearManual(k8c);
    check('8g. clearManual 也递增 revision', () =>
      s8.resolve({ scope: 'classic', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }).revision === beforeClear + 1);
    const k8d = 'classic:bbbbbbbb-0000-4000-8000-000000000001';
    s8.setManual(k8d, { title: 'A', nativeNameAt: '' });
    s8.setManual(k8d, { title: 'B', nativeNameAt: '', expectedRevision: 1 });
    const oldTask = s8.setAuto(k8d, { title: '旧任务结果', nativeName: '', expectedRevision: 0 });
    check('8h. A→B→A 场景：拿旧修订的任务仍然被拒', () =>
      oldTask && oldTask.ok === false
      && s8.resolve({ scope: 'classic', sessionId: 'bbbbbbbb-0000-4000-8000-000000000001' }).title === 'B');
    check('8i. 没有条目的会话 resolve 返回 revision 0（不臆造修订）', () => {
      const r = s8.resolve({ scope: 'classic', sessionId: 'cccccccc-0000-4000-8000-000000000001', fallback: '首条消息' });
      return r.source === 'fallback' && r.revision === 0;
    });
    const k8e = 'classic:dddddddd-0000-4000-8000-000000000001';
    const nativeFirst = s8.resolve({ scope: 'classic', sessionId: 'dddddddd-0000-4000-8000-000000000001', nativeName: '原生 A' });
    check('8j. 没有标题记录的原生名也建立修订锚点（rev 1）', () =>
      nativeFirst.source === 'manual' && nativeFirst.title === '原生 A' && nativeFirst.revision === 1);
    const nativeSecond = s8.resolve({ scope: 'classic', sessionId: 'dddddddd-0000-4000-8000-000000000001', nativeName: '原生 B' });
    check('8k. 原生名再变时 revision 递增（同修订的旧响应不能顶回）', () =>
      nativeSecond.title === '原生 B' && nativeSecond.revision === 2 && s8.entry(k8e)?.nativeName === '原生 B');
    check('8l. 未确认的读取不会建立原生名锚点', () =>
      s8.resolve({ scope: 'classic', sessionId: 'eeeeeeee-0000-4000-8000-000000000001', nativeName: '未确认', nativeConfirmed: false }).revision === 0);
    const k8f = 'classic:ffffffff-0000-4000-8000-000000000001';
    s8.setManual(k8f, { title: '截断时改的名', nativeNameAt: '', nativeName: '', nativeNameConfirmed: false });
    const confirmedLater = s8.resolve({ scope: 'classic', sessionId: 'ffffffff-0000-4000-8000-000000000001', nativeName: '旧的原生名' });
    check('8m. 写入时原生名未知的 manual，后续确认不误删（补快照并保留）', () =>
      confirmedLater.title === '截断时改的名' && confirmedLater.manualOverride === true
      && s8.entry(k8f)?.manual?.nativeNameAt === '旧的原生名'
      && s8.entry(k8f)?.manual?.nativeNameConfirmed === true);
    const changedLater = s8.resolve({ scope: 'classic', sessionId: 'ffffffff-0000-4000-8000-000000000001', nativeName: 'Pi 新改的名' });
    check('8n. 快照补齐后再改名，manual 正常失效', () =>
      changedLater.title === 'Pi 新改的名' && changedLater.manualOverride === false && !s8.entry(k8f)?.manual);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch((err) => {
  console.error('session-title-store 测试失败：', err);
  process.exit(1);
});
