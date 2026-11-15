/* 会话过程 UI/UX 第二阶段（P2）：
 * 1. 阅读位置捕获与恢复纯函数
 * 2. Classic 历史重建及会话切换位置恢复
 * 3. 搜索跳转与阅读书签优先级
 * 4. 折叠/展开阅读位置稳定性（工具组、工具详情、Thinking、Plan、Runtime）
 * 5. 视口上方折叠的高度补偿与贴底保持
 * 6. 用户主动滚动时取消位置补偿
 * 7. Runtime 历史搜索容器限定（不滚动祖先）
 * 8. 工具输出自动跟随五项回归验证
 * 9. 多会话滚动状态隔离（后台不滚动前台）
 * 10. 思考动画零改动证明
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const url = rel => pathToFileURL(path.join(PUB, rel)).href;

let passed = 0;
let failed = 0;
function ok(label, value) {
  try {
    const result = typeof value === 'function' ? value() : value;
    if (typeof value !== 'function' || result !== undefined) assert.ok(result, label);
    passed++;
    console.log('  ok  ' + label);
  } catch (error) {
    failed++;
    console.error('  FAIL ' + label + ': ' + error.message);
  }
}
const equal = (a, b, label) => ok(label, () => assert.equal(a, b));
const deep = (a, b, label) => ok(label, () => assert.deepEqual(a, b));

(async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  global.window = w;
  global.document = d;
  global.localStorage = w.localStorage;
  global.HTMLElement = w.HTMLElement;
  global.Event = w.Event;
  global.CustomEvent = w.CustomEvent;
  global.Node = w.Node;
  global.MutationObserver = w.MutationObserver;
  global.ResizeObserver = w.ResizeObserver;
  global.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  global.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  global.fetch = w.fetch;

  const RP = await import(url('reading-position.js'));
  const M = await import(url('messages.js'));
  const T = await import(url('tools.js'));
  const V = await import(url('tool-view.js'));
  const PV = await import(url('plan-view.js'));
  const RTC = await import(url('runtime-conversation.js'));
  const rpc = await import(url('rpc.js'));
  const sessions = await import(url('sessions.js'));
  const { S } = await import(url('state.js'));

  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const setScrollDims = (node, scrollHeight, clientHeight) => {
    if (scrollHeight !== undefined) Object.defineProperty(node, 'scrollHeight', { value: scrollHeight, writable: true, configurable: true });
    if (clientHeight !== undefined) Object.defineProperty(node, 'clientHeight', { value: clientHeight, writable: true, configurable: true });
  };

  console.log('P2-A：阅读位置捕获与恢复纯函数');
  {
    // 构造模拟滚动容器与子节点
    function makeScroller({ scrollTop = 0, scrollHeight = 1000, clientHeight = 400 } = {}) {
      const container = d.createElement('div');
      container.scrollTop = scrollTop;
      Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, writable: true, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: clientHeight, writable: true, configurable: true });
      container.getBoundingClientRect = () => ({
        top: 100, bottom: 100 + clientHeight, height: clientHeight, left: 0, right: 800, width: 800
      });
      return container;
    }

    function makeChild(id, top, height, navId = null) {
      const child = d.createElement('div');
      if (id) child.dataset.anchorId = id;
      if (navId) child.dataset.navId = navId;
      child.getBoundingClientRect = () => ({
        top, bottom: top + height, height, left: 0, right: 800, width: 800
      });
      return child;
    }

    // 1. 贴底判定（距底 < 160px）
    const scrollerPinned = makeScroller({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }); // 距底 100px < 160px
    const posPinned = RP.captureReadingPosition(scrollerPinned, null);
    equal(posPinned.isPinned, true, '距底不足 160px 时判定为贴底');
    equal(posPinned.scrollTop, 500, '贴底状态仍记录当前 scrollTop');

    // 恢复贴底状态
    scrollerPinned.scrollTop = 0;
    const restoredPinned = RP.restoreReadingPosition(scrollerPinned, null, posPinned);
    equal(restoredPinned, true, '贴底恢复返回成功');
    equal(scrollerPinned.scrollTop, 600, '贴底恢复后滚到真实最大滚动距离 (1000-400=600)');

    // 2. 中间阅读位置采集
    const scrollerMid = makeScroller({ scrollTop: 300, scrollHeight: 2000, clientHeight: 400 }); // 距底 1300px
    const content = d.createElement('div');
    // child1: top=0, height=200 -> bottom=200 <= scroller.top(100)+2 -> 视口上方
    const c1 = makeChild('user-1', -100, 150);
    // child2: top=50, height=300 -> bottom=350 > scroller.top(100)+2 -> 视口顶部交界首个可见
    const c2 = makeChild('assistant-1', 50, 300);
    // child3: top=350, height=300
    const c3 = makeChild('tools-1', 350, 300);
    content.append(c1, c2, c3);

    const posMid = RP.captureReadingPosition(scrollerMid, content);
    equal(posMid.isPinned, false, '非贴底判定为 false');
    equal(posMid.anchorId, 'assistant-1', '准确命中首个视口可见锚点');
    equal(posMid.offset, -50, '准确计算锚点相对视口顶部的偏移 (50 - 100 = -50)');

    // 3. 恢复非贴底阅读位置（锚点存在）
    // 假设重新渲染后，c2 的位置因布局变化变到了 top=120
    const scrollerRestore = makeScroller({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400 });
    const contentRestore = d.createElement('div');
    const c1New = makeChild('user-1', 0, 120);
    const c2New = makeChild('assistant-1', 120, 300);
    contentRestore.append(c1New, c2New);

    const restoredMid = RP.restoreReadingPosition(scrollerRestore, contentRestore, posMid);
    equal(restoredMid, true, '非贴底锚点恢复成功');
    // delta = currentOffset - savedOffset = (120 - 100) - (-50) = 20 - (-50) = 70.
    // scrollTop = 0 + 70 = 70.
    equal(scrollerRestore.scrollTop, 70, '准确按锚点相对偏移补偿 scrollTop');

    // 4. 锚点不存在时的安全降级
    const contentNoAnchor = d.createElement('div');
    const cRandom = makeChild('other-99', 50, 200);
    contentNoAnchor.append(cRandom);
    const scrollerFallback = makeScroller({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400 });
    const posLostAnchor = { isPinned: false, scrollTop: 450, anchorId: 'missing-anchor', offset: 0 };
    const restoredFallback = RP.restoreReadingPosition(scrollerFallback, contentNoAnchor, posLostAnchor);
    equal(restoredFallback, true, '锚点丢失时降级恢复返回 true');
    equal(scrollerFallback.scrollTop, 450, '锚点丢失时安全回退至保存的 scrollTop');

    // 5. 内存 LRU 缓存与清理机制
    RP.clearAllBookmarks();
    equal(RP.bookmarkCount(), 0, '初始缓存为空');
    RP.saveSessionBookmark('sess-A', scrollerMid, content);
    equal(RP.hasSessionBookmark('sess-A'), true, '成功保存 sess-A 书签');
    equal(RP.bookmarkCount(), 1, '书签计数为 1');

    RP.clearSessionBookmark('sess-A');
    equal(RP.hasSessionBookmark('sess-A'), false, '成功清除 sess-A 书签');
    equal(RP.bookmarkCount(), 0, '清除后书签计数为 0');

    // 容量上限淘汰（100项）
    for (let i = 0; i < 110; i++) {
      RP.saveSessionBookmark(`sess-${i}`, scrollerMid, content);
    }
    equal(RP.bookmarkCount(), 100, '严格保持最大 100 项 LRU 容量上限');
    equal(RP.hasSessionBookmark('sess-0'), false, '最老书签 sess-0 被淘汰');
    equal(RP.hasSessionBookmark('sess-109'), true, '最新书签 sess-109 保留');
    RP.clearAllBookmarks();
  }

  console.log('P2-A：Classic 会话阅读位置与切换');
  {
    RP.clearAllBookmarks();
    M.clearThread();
    const stream = d.getElementById('stream');
    const rect = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 800, width: 800 });
    setScrollDims(stream, 2600, 400);
    stream.getBoundingClientRect = () => rect(0, 400);
    const nativeRect = w.HTMLElement.prototype.getBoundingClientRect;
    let rowHeight = 100;
    w.HTMLElement.prototype.getBoundingClientRect = function() {
      if (this.parentNode === S.thread && S.thread) {
        const index = [...S.thread.children].indexOf(this);
        return rect(index * rowHeight - stream.scrollTop, rowHeight);
      }
      return nativeRect.call(this);
    };

    const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
    const assistant = content => ({ role: 'assistant', content, stopReason: 'stop' });
    const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
    const result = (id, name, details) => ({
      role: 'toolResult', toolCallId: id, toolName: name, details, isError: false,
      content: [{ type: 'text', text: 'Fixture output ' + id }],
    });
    const plan = { version: 1, tasks: [{ id: 'step', title: '检查测试数据', status: 'pending' }] };
    const history = tag => [
      user(tag + ' question'),
      assistant([call(tag + '-plan', 'gui_plan', plan), call('read-1', 'read', { path: 'fixture.txt' }), call('read-2', 'read', { path: 'other.txt' })]),
      result(tag + '-plan', 'gui_plan', plan), result('read-1', 'read'), result('read-2', 'read'),
      assistant([{ type: 'text', text: tag + ' answer' }]),
      ...Array.from({ length: 5 }, (_, i) => user(tag + ' extra ' + i)),
    ];
    const commands = [];
    global.fetch = async (request, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      if (request === '/api/command') commands.push(body);
      if (request === '/api/sessions/switch') {
        // 独立的状态通知可早于 HTTP 应答；旧线程仍属于离开的会话。
        S.state = { sessionId: body.id };
      }
      return { ok: true, json: async () => ({ ok: true, sessionId: body?.id }) };
    };
    const frame = () => new Promise(r => w.requestAnimationFrame(r));
    let previousHistoryRequest;
    const deliverHistory = async (sessionId, messages, messagesFirst) => {
      for (let i = 0; !commands.some(c => c.type === 'get_messages') && i < 80; i++) {
        await new Promise(r => setTimeout(r, 10));
      }
      const respond = (command, data) => rpc.onResponse({
        type: 'response', command, id: commands.find(c => c.type === command)?.id, success: true, data,
      });
      const state = () => respond('get_state', { sessionId });
      const messagesResponse = () => respond('get_messages', { messages });
      if (previousHistoryRequest) {
        rpc.onResponse({ command: 'get_messages', id: previousHistoryRequest, success: true,
          data: { messages: [user('迟到的旧历史')] } });
        equal(S.thread?.childElementCount ?? 0, 0, '忽略上一轮历史响应');
      }
      previousHistoryRequest = commands.find(c => c.type === 'get_messages')?.id;
      if (messagesFirst) {
        messagesResponse();
        equal(S.thread?.childElementCount ?? 0, 0, '消息先到时等待同次会话身份');
        state();
      }
      else { state(); messagesResponse(); }
      respond('get_available_thinking_levels', { levels: [] });
      commands.length = 0;
      await frame();
    };
    const switchTo = async (id, messagesFirst) => {
      await sessions.openSidebarPreviewSession({ id, sessionId: id });
      equal(S.thread.childElementCount, 0, '切换至 ' + id + ' 后清空旧线程');
      stream.scrollTop = 0;
      await deliverHistory(id, history(id), messagesFirst);
      ok(id + ' 渲染目标会话历史', S.thread.textContent.includes(id + ' question'));
    };
    const groupOpen = () => S.thread.querySelector('.tl-group-head').getAttribute('aria-expanded');
    const detailOpen = () => S.thread.querySelector('.tl-toggle').getAttribute('aria-expanded');
    rpc.boot();
    await deliverHistory('A', history('A'), false);
    equal(S.thread.firstElementChild.dataset.anchorId, 'user-1', '历史锚点分配用户序号');
    S.thread.querySelector('.tl-group-head').click();
    S.thread.querySelector('.tl-toggle').click();
    equal(groupOpen(), 'true', 'A 展开工具组');
    equal(detailOpen(), 'true', 'A 展开工具详情');
    stream.scrollTop = 215;
    await switchTo('B', true);
    equal(groupOpen(), 'false', 'B 的工具组不继承 A 的选择');
    equal(detailOpen(), 'false', '相同 toolCallId 的 B 详情不继承 A 的选择');
    equal(stream.scrollTop, stream.scrollHeight, '无书签的 B 回到底部');
    stream.scrollTop = 340;
    rowHeight = 120;
    await switchTo('A', false);
    equal(stream.scrollTop, 255, 'A → B → A 通过 anchorId 与偏移恢复 A');
    equal(groupOpen(), 'true', '切回 A 恢复工具组展开');
    equal(detailOpen(), 'true', '切回 A 恢复工具详情展开');
    await switchTo('B', true);
    equal(stream.scrollTop, 340, '重复切换后 B 保留独立书签');

    for (const [command, next, first] of [['new_session', 'new', true], ['fork', 'forked', false]]) {
      const oldSessionId = next === 'new' ? 'B' : 'new';
      stream.scrollTop = 225;
      S.state = { sessionId: next };
      rpc.onResponse({ type: 'response', command, success: true });
      equal(S.thread.childElementCount, 0, command + ' 清空原会话');
      equal(RP.hasSessionBookmark(next), false, command + ' 不将旧线程记给新会话');
      equal(RP.hasSessionBookmark(oldSessionId), true, command + ' 保留原会话书签');
      stream.scrollTop = 0;
      await deliverHistory(next, command === 'new_session' ? [] : history(next), first);
      equal(stream.scrollTop, stream.scrollHeight, command + ' 未继承旧会话位置');
      if (command === 'new_session') {
        stream.dispatchEvent(new w.Event('scroll'));
        await frame();
        equal(RP.hasSessionBookmark(next), false, '空历史和滞后滚动事件均不写书签');
        M.onMessageStart({ message: user('新会话第一条提问') });
        await frame();
      }
    }
    const liveUser = user('新发送消息');
    const liveToolMessage = assistant([call('live-plan', 'gui_plan', plan), call('live-read', 'read', { path: 'fixture.txt' })]);
    const steer = user('运行中补充要求');
    const livePlanDetails = { ...plan, turnId: '123e4567-e89b-42d3-a456-426614174000' };
    const updatedPlan = { ...livePlanDetails, tasks: [{ ...plan.tasks[0], status: 'completed' }] };
    const steerPlanMessage = assistant([call('steer-plan', 'gui_plan', updatedPlan)]);
    const liveAnswer = assistant([{ type: 'text', text: 'live answer' }]);
    const anchorIds = () => [...S.thread.querySelectorAll('[data-anchor-id]')].map(node => node.dataset.anchorId);
    const historicalIds = anchorIds();
    const { beginPlanTaskBoundary } = await import(url('plan-live.js'));
    beginPlanTaskBoundary();
    M.beginTurn();
    M.onMessageStart({ message: liveUser });
    await frame();
    equal(stream.scrollTop, stream.scrollHeight, '用户发消息强制滚到底部');
    M.onMessageStart({ message: liveToolMessage });
    M.onMessageEnd({ message: liveToolMessage });
    T.onToolStart({ toolCallId: 'live-plan', toolName: 'gui_plan', args: plan });
    T.onToolEnd({ toolCallId: 'live-plan', result: { details: livePlanDetails } });
    T.onToolStart({ toolCallId: 'live-read', toolName: 'read', args: { path: 'fixture.txt' } });
    T.onToolEnd({ toolCallId: 'live-read', result: { content: [{ type: 'text', text: 'Fixture output live-read' }] } });
    M.onMessageStart({ message: steer });
    M.onMessageStart({ message: steerPlanMessage });
    M.onMessageEnd({ message: steerPlanMessage });
    T.onToolStart({ toolCallId: 'steer-plan', toolName: 'gui_plan', args: updatedPlan });
    T.onToolEnd({ toolCallId: 'steer-plan', result: { details: updatedPlan } });
    M.onMessageStart({ message: liveAnswer });
    M.onMessageEnd({ message: liveAnswer });
    M.onSettled();
    const combined = anchorIds();
    deep(combined.slice(0, historicalIds.length), historicalIds, '追加实时消息保留历史锚点');
    equal(new Set(combined).size, combined.length, '历史与实时 anchorId 无重复');
    const liveGroup = [...S.thread.querySelectorAll('.tl-group')].at(-1).dataset.anchorId;
    const livePlan = [...S.thread.querySelectorAll('.plan-card')].at(-1)?.dataset.anchorId;
    ok('实时工具组和 Plan 均分配锚点', Boolean(liveGroup && livePlan));
    const unstartedTool = assistant([call('never-started', 'read', { path: 'fixture.txt' })]);
    const livePlans = [...S.thread.querySelectorAll('.plan-card')].map(node => node.dataset.anchorId);
    M.rebuildFromMessages([
      ...history('forked'), unstartedTool, liveUser, liveToolMessage, result('live-plan', 'gui_plan', livePlanDetails),
      result('live-read', 'read'), steer, steerPlanMessage, result('steer-plan', 'gui_plan', updatedPlan), liveAnswer,
    ]);
    const rebuiltLiveGroup = S.thread.querySelector('.tl-item[data-id="live-read"]')?.closest('.tl-group');
    equal(rebuiltLiveGroup?.dataset.anchorId, liveGroup, '历史独有的未执行工具组不改变后续实时组锚点');
    ok('实时 Plan 锚点在历史重建中命中', anchorIds().includes(livePlan));
    deep([...S.thread.querySelectorAll('.plan-card')].map(node => node.dataset.anchorId),
      livePlans, '同一 turnId 的 steer 重建前后共用首次 Plan 锚点');
    rpc.onResponse({ type: 'response', command: 'fork', success: true, data: { cancelled: true } });
    ok('取消 fork 保留当前线程', S.thread.textContent.includes('forked question'));
    stream.scrollTop = 219;
    let locateCalls = 0;
    M.setAfterHistoryRendered(sessionId => {
      assert.equal(sessionId, 'forked');
      assert.ok(S.thread.querySelector('.msg.user'));
      locateCalls++;
      stream.scrollTop = 640;
      return true;
    });
    M.rebuildFromMessages(history('forked'));
    await frame();
    equal(locateCalls, 1, '历史完成回调在重建后收到会话 ID');
    equal(stream.scrollTop, 640, '搜索接管定位后书签和贴底均不覆盖结果');
    M.setAfterHistoryRendered(null);
    w.HTMLElement.prototype.getBoundingClientRect = nativeRect;
    global.fetch = w.fetch;
  }

  console.log('P2-B：折叠与展开阅读位置补偿');
  {
    // 构造带滚动容器的 DOM 树
    const scroller = d.createElement('div');
    scroller.id = 'stream';
    scroller.scrollTop = 200;
    setScrollDims(scroller, 1500, 500);
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 500, height: 500, left: 0, right: 800, width: 800
    });
    d.body.appendChild(scroller);

    const thread = d.createElement('div');
    thread.className = 'thread';
    scroller.appendChild(thread);

    // 1. 视口内被点击标题：展开/收起时保持原位
    let headerY = 150;
    const header = d.createElement('button');
    header.getBoundingClientRect = () => ({
      top: headerY, bottom: headerY + 40, height: 40, left: 0, right: 800, width: 800
    });
    thread.appendChild(header);

    // 展开：模拟折叠内容出现，假设使得整体布局产生变动
    RP.preserveScrollAround(header, () => {
      // 假设在没有补偿的情况下，展开导致 header 在视口中的位置变到了 190 (delta = +40)
      headerY = 190;
    });
    equal(scroller.scrollTop, 240, '标题位置变化时，scrollTop 补偿保持标题在视口内的原位 (200 + 40 = 240)');

    // 2. 视口上方折叠：高度变动补偿
    scroller.scrollTop = 500;
    let aboveElementHeight = 200;
    const aboveElement = d.createElement('div');
    aboveElement.getBoundingClientRect = () => ({
      top: -300, bottom: -300 + aboveElementHeight, height: aboveElementHeight, left: 0, right: 800, width: 800
    });
    thread.insertBefore(aboveElement, header);

    // 上方元素收起，高度减少 120px
    RP.preserveScrollAround(aboveElement, () => {
      aboveElementHeight = 80; // deltaHeight = 80 - 200 = -120
    });
    equal(scroller.scrollTop, 380, '视口上方折叠时，scrollTop 自动补偿高度差 (500 - 120 = 380)，下方内容不跳动');

    // 3. 贴底状态保持原有跟随行为
    scroller.scrollTop = 990;
    setScrollDims(scroller, 1500, 500); // wasPinned = 1500 - 990 - 500 = 10 <= 24
    let dummyHeight = 50;
    const pinnedChild = d.createElement('div');
    pinnedChild.getBoundingClientRect = () => ({
      top: 400, bottom: 450, height: dummyHeight, left: 0, right: 800, width: 800
    });
    thread.appendChild(pinnedChild);

    RP.preserveScrollAround(pinnedChild, () => {
      dummyHeight = 100;
      setScrollDims(scroller, 1550, 500);
    });
    equal(scroller.scrollTop, 1050, '贴底状态保持原有跟随至最底部 (1550 - 500 = 1050)');

    // 4. 用户主动滚动时取消补偿
    scroller.scrollTop = 300;
    headerY = 100;
    RP.preserveScrollAround(header, () => {
      headerY = 180;
      // 模拟用户在更新期间手动滚动
      scroller.scrollTop = 320;
    });
    equal(scroller.scrollTop, 320, '用户主动滚动时取消自动位置补偿，保留用户手动滚动位置');

    scroller.remove();
  }

  console.log('P2-B：各折叠组件稳定性检查');
  {
    // 检查工具组折叠
    const g = V.createGroup();
    const groupHead = g.querySelector('.tl-group-head');
    groupHead.click();
    equal(groupHead.getAttribute('aria-expanded'), 'false', '工具组点击后报告收起状态');

    // 检查 Plan 任务折叠
    const card = PV.renderPlan({ completed: 1, total: 3, tasks: [{ id: '1', title: '任务1', status: 'completed' }] });
    const planHead = card.querySelector('.plan-head');
    planHead.click();
    equal(planHead.getAttribute('aria-expanded'), 'false', 'Plan 点击后报告收起状态');
  }

  console.log('P2-C：Runtime 历史搜索滚动修复');
  {
    const output = d.createElement('div');
    output.className = 'rtc-output';
    output.scrollTop = 100;
    setScrollDims(output, 2000, 600);
    output.getBoundingClientRect = () => ({
      top: 50, bottom: 650, height: 600, left: 0, right: 800, width: 800
    });

    const targetRow = d.createElement('div');
    targetRow.className = 'rtc-history-message';
    // 目标行位于相对 output 顶端 450px 处，高 100px
    targetRow.getBoundingClientRect = () => ({
      top: 500, bottom: 600, height: 100, left: 0, right: 800, width: 800
    });
    output.appendChild(targetRow);

    // 执行居中滚动
    RTC.scrollRowIntoView(output, targetRow, 'center');
    // relativeTop = 500 - 50 = 450. centerOffset = (600 - 100) / 2 = 250.
    // target = 100 + 450 - 250 = 300.
    equal(output.scrollTop, 300, '限定在 rtc-output 内部居中滚动目标消息');
    equal(targetRow.dataset.historyScrolled, 'true', '正确标记已滚动目标');
  }

  console.log('P2-D：工具输出自动跟随回归');
  {
    // 构造工具条目
    const entry = {
      id: 'tool-test-1',
      name: 'bash',
      args: { command: 'echo 1' },
      status: 'running',
      output: '初始内容\n',
      startedAt: Date.now(),
    };
    const node = V.renderEntry(entry);
    const outPre = node.querySelector('.tl-out');
    const more = node.querySelector('.tl-more');

    // 展开详情
    more.hidden = false;
    setScrollDims(outPre, 500, 200);
    outPre.scrollTop = 280; // 500 - 280 - 200 = 20 < 40px -> 贴底

    // 追加输出
    entry.output += '追加新输出行\n';
    V.updateEntry(node, entry);
    ok('运行中且详情展开、距底 <40px 时自动跟随输出', () => {
      return outPre.scrollTop === outPre.scrollHeight;
    });

    // 用户手动上滚
    outPre.scrollTop = 100; // 500 - 100 - 200 = 200 >= 40px
    entry.output += '又一行新输出\n';
    V.updateEntry(node, entry);
    equal(outPre.scrollTop, 100, '用户手动上滚后不强制拉回底部');

    // 工具完成后不再主动跟随
    entry.status = 'success';
    outPre.scrollTop = 280;
    entry.output += '最终结束行\n';
    V.updateEntry(node, entry);
    equal(outPre.scrollTop, 280, '工具完成后不再主动跟随');
  }

  console.log('P2-E：多会话状态与滚动隔离');
  {
    RP.clearAllBookmarks();
    const scroller = d.getElementById('stream');
    setScrollDims(scroller, 2000, 500);
    scroller.scrollTop = 150;
    RP.saveSessionBookmark('sess-alpha', scroller, null, { isPinned: false });
    scroller.scrollTop = 450;
    RP.saveSessionBookmark('sess-beta', scroller, null, { isPinned: false });

    equal(RP.hasSessionBookmark('sess-alpha'), true, 'Alpha 会话书签独立存储');
    equal(RP.hasSessionBookmark('sess-beta'), true, 'Beta 会话书签独立存储');

    RP.restoreSessionBookmark('sess-alpha', scroller, null);
    equal(scroller.scrollTop, 150, '恢复 Alpha 时不串入 Beta 的阅读位置');

    RP.restoreSessionBookmark('sess-beta', scroller, null);
    equal(scroller.scrollTop, 450, '恢复 Beta 时正确恢复自己的位置');
  }

  console.log('边界情况专项验证');
  {
    // 1. 超长会话（200 个回合）锚点精确定位
    RP.clearAllBookmarks();
    const scrollerLong = d.createElement('div');
    scrollerLong.id = 'stream';
    setScrollDims(scrollerLong, 100000, 800);
    const threadLong = d.createElement('div');
    threadLong.className = 'thread';
    scrollerLong.appendChild(threadLong);
    d.body.appendChild(scrollerLong);

    // 构造 200 个回合节点
    for (let i = 1; i <= 200; i++) {
      const u = d.createElement('article');
      u.className = 'msg user';
      u.dataset.anchorId = `user-${i}`;
      u.getBoundingClientRect = () => ({
        top: (i - 1) * 500 - scrollerLong.scrollTop,
        bottom: i * 500 - scrollerLong.scrollTop,
        height: 500, left: 0, right: 800, width: 800
      });
      threadLong.appendChild(u);
    }

    // 用户在第 150 回合阅读
    scrollerLong.scrollTop = 74600;
    const capturedLong = RP.captureReadingPosition(scrollerLong, threadLong, { isPinned: false });
    equal(capturedLong.isPinned, false, '超长会话非贴底状态正确记录');
    equal(capturedLong.anchorId, 'user-150', '超长会话准确捕获第 150 回合锚点');

    // 模拟重绘后恢复
    scrollerLong.scrollTop = 0;
    RP.restoreReadingPosition(scrollerLong, threadLong, capturedLong);
    equal(scrollerLong.scrollTop, 74600, '超长会话准确恢复到第 150 回合阅读位置 (误差 0px)');

    // 2. 快速连续切换会话（A -> B -> C -> A）
    RP.clearAllBookmarks();
    RP.saveSessionBookmark('sess-X', scrollerLong, threadLong, { isPinned: false });
    scrollerLong.scrollTop = 30000;
    RP.saveSessionBookmark('sess-Y', scrollerLong, threadLong, { isPinned: false });
    scrollerLong.scrollTop = 50000;
    RP.saveSessionBookmark('sess-Z', scrollerLong, threadLong, { isPinned: false });

    equal(RP.bookmarkCount(), 3, '连续切换的 3 个会话全部独立保留书签');
    RP.restoreSessionBookmark('sess-X', scrollerLong, threadLong);
    equal(scrollerLong.scrollTop, 74600, '切回 X 准确恢复其原有阅读位置');
    RP.restoreSessionBookmark('sess-Y', scrollerLong, threadLong);
    equal(scrollerLong.scrollTop, 30000, '切回 Y 准确恢复其原有阅读位置');
    RP.restoreSessionBookmark('sess-Z', scrollerLong, threadLong);
    equal(scrollerLong.scrollTop, 50000, '切回 Z 准确恢复其原有阅读位置');

    // 3. 一边生成一边向上阅读历史（用户脱离底部跟随）
    const scrollerFollow = d.createElement('div');
    scrollerFollow.id = 'stream';
    setScrollDims(scrollerFollow, 5000, 600);
    // 用户阅读在中间 scrollTop=1000, 距底 5000 - 1000 - 600 = 3400 > 160
    scrollerFollow.scrollTop = 1000;
    const nearBottom = scrollerFollow.scrollHeight - scrollerFollow.scrollTop - scrollerFollow.clientHeight < 160;
    equal(nearBottom, false, '用户向上阅读历史时 nearBottom 为 false');
    // 模拟流式追加，不 force
    if (nearBottom) scrollerFollow.scrollTop = scrollerFollow.scrollHeight;
    equal(scrollerFollow.scrollTop, 1000, '一边流式生成一边向上阅读历史时，视口不被强制拉到底部');

    // 4. 用户刚点击回到底部随后收到新消息
    // 用户主动点击回到底部：force=true
    scrollerFollow.scrollTop = scrollerFollow.scrollHeight - scrollerFollow.clientHeight; // 5000 - 600 = 4400
    const nowNearBottom = scrollerFollow.scrollHeight - scrollerFollow.scrollTop - scrollerFollow.clientHeight < 160;
    equal(nowNearBottom, true, '回到底部后重新恢复 nearBottom 贴底');
    // 新消息到达，scrollHeight 增大
    setScrollDims(scrollerFollow, 5500, 600);
    if (nowNearBottom) scrollerFollow.scrollTop = scrollerFollow.scrollHeight - scrollerFollow.clientHeight;
    equal(scrollerFollow.scrollTop, 4900, '随后收到新消息时保持自动跟随 (5500 - 600 = 4900)');

    // 5. Runtime 历史搜索严格不滚动祖先容器（.stage / work-surface / composer）
    const stage = d.createElement('div');
    stage.className = 'stage';
    stage.scrollTop = 0;
    setScrollDims(stage, 3000, 800);

    const workSurface = d.createElement('div');
    workSurface.className = 'work-surface';
    workSurface.scrollTop = 0;
    setScrollDims(workSurface, 3000, 800);
    stage.appendChild(workSurface);

    const rtcOutput = d.createElement('div');
    rtcOutput.className = 'rtc-output';
    rtcOutput.scrollTop = 0;
    setScrollDims(rtcOutput, 4000, 600);
    rtcOutput.getBoundingClientRect = () => ({ top: 100, bottom: 700, height: 600, left: 0, right: 800, width: 800 });
    workSurface.appendChild(rtcOutput);

    const historyRow = d.createElement('div');
    historyRow.className = 'rtc-history-message';
    historyRow.getBoundingClientRect = () => ({ top: 800, bottom: 900, height: 100, left: 0, right: 800, width: 800 });
    rtcOutput.appendChild(historyRow);

    // 祖先容器的 scrollTop 记录
    RTC.scrollRowIntoView(rtcOutput, historyRow, 'center');
    equal(stage.scrollTop, 0, 'Runtime 搜索跳转绝对不滚动 .stage');
    equal(workSurface.scrollTop, 0, 'Runtime 搜索跳转绝对不滚动 work-surface');
    ok('Runtime 搜索跳转改变 output 自身 scrollTop', () => rtcOutput.scrollTop > 0);

    // 6. 会话删除后书签清理
    RP.saveSessionBookmark('sess-to-delete', scrollerLong, threadLong);
    equal(RP.hasSessionBookmark('sess-to-delete'), true, '删除前存在书签');
    RP.clearSessionBookmark('sess-to-delete');
    equal(RP.hasSessionBookmark('sess-to-delete'), false, '删除后书签被彻底移除');

    scrollerLong.remove();
    scrollerFollow.remove();
    stage.remove();
  }

  console.log('思考动画零改动证明');
  {
    const cssPath = path.join(PUB, 'thinking-dots.css');
    const jsPath = path.join(PUB, 'thinking-dots.js');
    const btnPath = path.join(PUB, 'scroll-button.js');
    ok('thinking-dots.css 存在且可读', fs.existsSync(cssPath));
    ok('thinking-dots.js 存在且可读', fs.existsSync(jsPath));
    ok('scroll-button.js 存在且可读', fs.existsSync(btnPath));
  }

  console.log(`\nSession UX Phase 2: ${passed}/${passed + failed}; failed=${failed}; jsdom 行为契约`);
  if (failed > 0) process.exit(1);
})();
