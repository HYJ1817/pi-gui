/* 历史消息编辑：真实安装的 Pi + 确定性回环模型夹具。
 *
 * 这是**可选**验收，默认跳过（CI 不依赖真 Pi）：
 *   PI_GUI_MESSAGE_EDIT_FIXTURE=1 node tests/message-edit-real-pi.cjs
 *
 * 它证明的是 jsdom / 假 RPC 证明不了的部分：扩展命令在真实 Pi 1.5.2 里
 * navigateTree 到目标用户消息的父节点，修改后的 prompt 落在**同一个**
 * sessionId / session 文件里；旧回复仍留在 append-only 文件里但离开 active
 * path；模型请求体里只剩新历史；重启后仍走新路径。
 *
 * 所有写操作都在 os.tmpdir() 的临时项目里；不读不写用户真实项目或会话。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

if (process.env.PI_GUI_MESSAGE_EDIT_FIXTURE !== '1') {
  console.log('SKIP message edit real Pi: set PI_GUI_MESSAGE_EDIT_FIXTURE=1 to run');
  process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = content => typeof content === 'string'
  ? content
  : Array.isArray(content)
    ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('')
    : '';

function sessionFiles(dir) {
  const found = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function createRpcClient(entryPath, args, { cwd, env }) {
  const child = spawn(process.execPath, [entryPath, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const events = [];
  const stderr = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.type === 'response' && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: message.success === true, data: message.data, error: message.error, command: message.command });
        continue;
      }
      events.push(message);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr.push(String(text)); });
  child.on('exit', () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error('pi_exited'), { code: 'pi_exited' }));
    }
    pending.clear();
  });

  const request = (command, { timeoutMs = 30000 } = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(Object.assign(new Error('pi_exited'), { code: 'pi_exited' })); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('pi_timeout'), { code: 'pi_timeout' }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  const stop = async () => {
    if (closed) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already closed */ }
    const deadline = Date.now() + 5000;
    while (!closed && Date.now() < deadline) await sleep(20);
  };

  return { request, stop, events, stderr, pid: () => child.pid, isClosed: () => closed };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-message-edit-'));
  const project = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(project); fs.mkdirSync(agentDir); fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(project, 'README.md'), '# temp fixture\n');

  const { createPiLaunch } = await import('../server/pi-launch.js');
  const launch = createPiLaunch({ getCwd: () => project });
  const entry = launch.cliEntry();
  if (!entry.ok) {
    console.log('SKIP message edit real Pi: installed Pi entry unavailable');
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }

  const http = require('node:http');
  const modelRequests = [];
  const modelServer = http.createServer(async (req, res) => {
    let raw = '';
    try { for await (const chunk of req) raw += chunk; } catch { /* aborted */ }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userTexts = messages.filter(message => message.role === 'user').map(message => textOf(message.content));
    modelRequests.push({ userTexts });
    const last = userTexts.length ? userTexts[userTexts.length - 1] : '';
    if (last.includes('SLOW')) await sleep(1500);
    const reply = 'reply to ' + last;
    try {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({
        id: 'fixture-' + modelRequests.length, object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) + '\n\n';
      res.write(chunk({ role: 'assistant' }));
      res.write(chunk({ content: reply }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    } catch { /* aborted by Pi */ }
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));

  const provider = 'message-edit-fixture';
  const modelId = 'fixture';
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      [provider]: {
        baseUrl: 'http://127.0.0.1:' + modelServer.address().port + '/v1',
        api: 'openai-completions',
        apiKey: 'fixture-unused',
        models: [{
          id: modelId, name: 'Message edit fixture', api: 'openai-completions', reasoning: false,
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096,
          compat: { supportsDeveloperRole: false, supportsStore: false },
        }],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId, retry: { enabled: false, maxRetries: 0 } }));

  const command = 'pi-gui-edit-' + Math.random().toString(36).slice(2, 12);
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_PROVIDER: provider,
    PI_MODEL: modelId,
    PI_THINKING: 'off',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    PI_GUI_EDIT_COMMAND: command,
  };
  const extensionPath = path.join(__dirname, '..', 'extensions', 'pi-gui-edit', 'index.js');
  const baseArgs = [
    '--mode', 'rpc',
    '--provider', provider, '--model', modelId, '--thinking', 'off',
    '--session-dir', sessionDir,
    '--extension', extensionPath,
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-context-files', '--no-mcp', '--no-tools',
  ];

  let checks = 0;
  const pass = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
  const report = { platform: process.platform, piVersion: entry.version, root, sessionIds: [], files: [], modelRequests: 0 };
  let rpc = createRpcClient(entry.entryPath, baseArgs, { cwd: project, env });
  const cleanup = async () => {
    await rpc.stop().catch(() => {});
    await new Promise(resolve => modelServer.close(resolve));
    if (!report.keep) fs.rmSync(root, { recursive: true, force: true });
  };

  try {
    const stateRead = await rpc.request({ type: 'get_state' });
    assert.equal(stateRead.ok, true, 'get_state');
    const initial = stateRead.data;
    assert.ok(initial.sessionId, 'session id');
    assert.ok(initial.sessionFile, 'session file');
    report.sessionIds.push(initial.sessionId);
    report.sessionFile = initial.sessionFile;
    report.initialFile = fs.existsSync(initial.sessionFile) ? fs.statSync(initial.sessionFile).size : null;

    const sendPrompt = async text => {
      const eventIndex = rpc.events.length;
      const response = await rpc.request({ type: 'prompt', message: text });
      assert.equal(response.ok, true, 'prompt accepted');
      assert.equal(response.data?.disposition, 'started', 'prompt disposition');
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (rpc.events.slice(eventIndex).some(event => event.type === 'agent_settled')) return;
        await sleep(20);
      }
      throw new Error('settled_timeout');
    };

    await sendPrompt('first question');
    await sendPrompt('second question');

    const before = (await rpc.request({ type: 'get_state' })).data;
    const beforeEntries = (await rpc.request({ type: 'get_entries' })).data;
    const beforeMessages = (await rpc.request({ type: 'get_messages' })).data.messages;
    pass('two real prompts created a native session with two user turns', () => {
      assert.equal(before.sessionId, initial.sessionId);
      assert.equal(before.sessionFile, initial.sessionFile);
      assert.equal(beforeMessages.filter(message => message.role === 'user').length, 2);
      assert.equal(sessionFiles(sessionDir).length, 1);
    });

    const { createMessageEditService } = await import('../server/message-edit.js');
    const service = createMessageEditService({ pollTimeoutMs: 5000, pollIntervalMs: 25 });
    const io = {
      scope: 'classic',
      sessionId: initial.sessionId,
      commandName: () => command,
      busyReason: () => null,
      validate() { if (rpc.isClosed()) throw Object.assign(new Error('stale_runtime'), { code: 'stale_runtime' }); },
      async request(cmd) {
        const { __messageEditNav, ...wire } = cmd;
        const result = await rpc.request(wire);
        return { ok: result.ok, data: result.data, code: result.error };
      },
    };

    const preflight = await service.preflight(io, { userIndex: 0, kind: 'edit' });
    pass('real Pi preflight exposes the native entry id and active leaf', () => {
      assert.equal(preflight.ok, true);
      assert.equal(preflight.canEdit, true);
      assert.equal(preflight.commandReady, true);
      assert.equal(preflight.text, 'first question');
      assert.equal(preflight.userIndex, 0);
      assert.equal(typeof preflight.entryId, 'string');
      assert.equal(typeof preflight.leafId, 'string');
    });

    const beforeFileBytes = fs.statSync(initial.sessionFile).size;
    const beforeEntriesCount = beforeEntries.entries.length;
    const edit = await service.resend(io, {
      userIndex: 0, kind: 'edit', text: 'edited first question',
      expectedEntryId: preflight.entryId, expectedLeafId: preflight.leafId,
      requestId: 'fixture-edit-request-1',
    });
    pass('edit is accepted inside the original native session', () => {
      assert.equal(edit.ok, true);
      assert.equal(edit.accepted, true);
      assert.equal(edit.sessionId, initial.sessionId);
      assert.equal(edit.targetEntryId, preflight.entryId);
      assert.equal(typeof edit.newEntryId, 'string');
      assert.equal(edit.text, 'edited first question');
    });

    const eventIndex = rpc.events.length;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !rpc.events.slice(eventIndex).some(event => event.type === 'agent_settled')) await sleep(20);

    const after = (await rpc.request({ type: 'get_state' })).data;
    const afterEntries = (await rpc.request({ type: 'get_entries' })).data;
    const afterMessages = (await rpc.request({ type: 'get_messages' })).data.messages;
    const afterUserTexts = afterMessages.filter(message => message.role === 'user').map(message => textOf(message.content));
    const afterAssistantTexts = afterMessages.filter(message => message.role === 'assistant').map(message => textOf(message.content));
    const rawFile = fs.readFileSync(initial.sessionFile, 'utf8');
    const header = JSON.parse(rawFile.split('\n')[0]);

    pass('identity is unchanged: same session id, same file, no new session file', () => {
      assert.equal(after.sessionId, initial.sessionId);
      assert.equal(after.sessionFile, initial.sessionFile);
      assert.equal(sessionFiles(sessionDir).length, 1);
      assert.equal(header.type, 'session');
      assert.equal(header.id || header.sessionId, initial.sessionId);
      assert.ok(fs.statSync(initial.sessionFile).size > beforeFileBytes, 'append-only file grew');
      assert.ok(rawFile.includes('first question'), 'old text remains in the append-only file');
    });

    pass('the active path and model context contain only the edited turn', () => {
      assert.deepEqual(afterUserTexts, ['edited first question']);
      assert.equal(afterAssistantTexts.length, 1);
      assert.match(afterAssistantTexts[0], /edited first question/);
      assert.equal(afterEntries.entries.length > beforeEntriesCount, true, 'old entries remain in the tree');
      assert.ok(afterEntries.leafId);
      assert.equal(afterEntries.entries.some(entry => entry.id === preflight.entryId), true, 'old user entry is still stored');
    });

    const editRequest = modelRequests.filter(request => request.userTexts.includes('edited first question')).at(-1);
    pass('the real model request carried only the new history', () => {
      assert.ok(editRequest);
      assert.deepEqual(editRequest.userTexts, ['edited first question']);
      report.modelRequests = modelRequests.length;
      report.afterEditUserTexts = editRequest.userTexts;
    });

    const regenPreflight = await service.preflight(io, { userIndex: 0, kind: 'regenerate' });
    const regenerate = await service.resend(io, {
      userIndex: 0, kind: 'regenerate',
      expectedEntryId: regenPreflight.entryId, expectedLeafId: regenPreflight.leafId,
      requestId: 'fixture-regenerate-request-1',
    });
    pass('regenerate reuses the original user text in the same session', () => {
      assert.equal(regenerate.ok, true);
      assert.equal(regenerate.kind, 'regenerate');
      assert.equal(regenerate.sessionId, initial.sessionId);
      assert.equal(regenerate.text, 'edited first question');
    });

    const regenIndex = rpc.events.length;
    const regenDeadline = Date.now() + 60000;
    while (Date.now() < regenDeadline && !rpc.events.slice(regenIndex).some(event => event.type === 'agent_settled')) await sleep(20);
    const regenMessages = (await rpc.request({ type: 'get_messages' })).data.messages;
    const regenUsers = regenMessages.filter(message => message.role === 'user').map(message => textOf(message.content));
    const regenAssistants = regenMessages.filter(message => message.role === 'assistant').map(message => textOf(message.content));

    pass('regenerate leaves one user message and one fresh reply on the active path', () => {
      assert.deepEqual(regenUsers, ['edited first question']);
      assert.equal(regenAssistants.length, 1);
      assert.match(regenAssistants[0], /edited first question/);
      assert.equal(sessionFiles(sessionDir).length, 1);
    });

    const regenRequest = modelRequests.filter(request => request.userTexts.includes('edited first question')).at(-1);
    pass('the regenerate model request also carried only the new history', () => {
      assert.ok(regenRequest);
      assert.deepEqual(regenRequest.userTexts, ['edited first question']);
    });

    const finalUsersBeforeRestart = regenUsers;
    report.fileCount = sessionFiles(sessionDir).length;
    report.finalBytes = fs.statSync(initial.sessionFile).size;

    await rpc.stop();
    rpc = createRpcClient(entry.entryPath, [...baseArgs, '--session', initial.sessionFile], { cwd: project, env });
    const restarted = (await rpc.request({ type: 'get_state' })).data;
    const restartedMessages = (await rpc.request({ type: 'get_messages' })).data.messages;
    const restartedUsers = restartedMessages.filter(message => message.role === 'user').map(message => textOf(message.content));

    pass('restarting Pi from the same session file restores the edited active path', () => {
      assert.equal(restarted.sessionId, initial.sessionId);
      assert.equal(restarted.sessionFile, initial.sessionFile);
      assert.equal(sessionFiles(sessionDir).length, 1);
      assert.deepEqual(restartedUsers, finalUsersBeforeRestart);
      assert.deepEqual(restartedUsers, ['edited first question']);
    });

    report.restartedUsers = restartedUsers;

    /* 旧 leaf 是用户消息时，扩展必须先追加 guard 才能精确回滚。真实 Pi 里
     * 这种状态出现在「用户消息已落盘、assistant 还没开始」时进程被结束。
     * 这里用慢模型 + 直接结束进程造出该状态，再从同一文件重启后编辑更早的
     * 消息，验证 guard 真实写入且新路径生效。 */
    const slowIndex = rpc.events.length;
    const slowPrompt = await rpc.request({ type: 'prompt', message: 'SLOW leaf question' });
    assert.equal(slowPrompt.data?.disposition, 'started');
    const userEventDeadline = Date.now() + 10000;
    while (Date.now() < userEventDeadline && !rpc.events.slice(slowIndex).some(event => event.type === 'message_start' && event.message?.role === 'user')) await sleep(20);
    await rpc.stop();
    rpc = createRpcClient(entry.entryPath, [...baseArgs, '--session', initial.sessionFile], { cwd: project, env });
    const interrupted = (await rpc.request({ type: 'get_entries' })).data;
    const interruptedLeaf = interrupted.entries.find(entry => entry.id === interrupted.leafId);
    const leafIsUser = interruptedLeaf?.type === 'message' && interruptedLeaf.message?.role === 'user';
    report.interruptedLeaf = interruptedLeaf ? { type: interruptedLeaf.type, role: interruptedLeaf.message?.role || null } : null;

    if (leafIsUser) {
      const guardPreflight = await service.preflight(io, { userIndex: 0, kind: 'edit' });
      const guarded = await service.resend(io, {
        userIndex: 0, kind: 'edit', text: 'edited after interruption',
        expectedEntryId: guardPreflight.entryId, expectedLeafId: guardPreflight.leafId,
        requestId: 'fixture-guard-request-1',
      });
      const guardedEntries = (await rpc.request({ type: 'get_entries' })).data;
      const guard = guardedEntries.entries.find(entry => entry.type === 'custom'
        && entry.customType === 'pi-gui-edit-guard'
        && entry.data?.requestId === 'fixture-guard-request-1');
      pass('a user-message leaf is guarded before navigating, and the edit still succeeds', () => {
        assert.equal(guarded.ok, true);
        assert.ok(guard, 'guard entry exists');
        assert.equal(guard.parentId, interruptedLeaf.id);
      });
      const guardSettledIndex = rpc.events.length;
      const guardDeadline = Date.now() + 60000;
      while (Date.now() < guardDeadline && !rpc.events.slice(guardSettledIndex).some(event => event.type === 'agent_settled')) await sleep(20);
      const guardedMessages = (await rpc.request({ type: 'get_messages' })).data.messages;
      const guardedUsers = guardedMessages.filter(message => message.role === 'user').map(message => textOf(message.content));
      pass('the guarded edit leaves only the new user turn on the active path', () => {
        assert.deepEqual(guardedUsers, ['edited after interruption']);
        assert.equal(sessionFiles(sessionDir).length, 1);
      });
      report.guardedUsers = guardedUsers;
    } else {
      console.log('SKIP guard case: interrupted leaf was ' + (interruptedLeaf?.type || 'unknown') + '/' + (interruptedLeaf?.message?.role || ''));
    }

    const finalState = (await rpc.request({ type: 'get_state' })).data;
    const finalMessages = (await rpc.request({ type: 'get_messages' })).data.messages;
    const finalUsers = finalMessages.filter(message => message.role === 'user').map(message => textOf(message.content));
    report.finalUsers = finalUsers;
    report.fileCount = sessionFiles(sessionDir).length;
    report.finalBytes = fs.statSync(initial.sessionFile).size;
    report.lineCount = fs.readFileSync(initial.sessionFile, 'utf8').split('\n').filter(Boolean).length;
    report.finalSessionId = finalState.sessionId;

    report.checks = checks;
    report.ok = true;
    console.log('EVIDENCE ' + JSON.stringify({
      piVersion: report.piVersion,
      sessionId: report.sessionIds[0],
      sessionFileCount: report.fileCount,
      sessionBytes: report.finalBytes,
      sessionLines: report.lineCount,
      modelRequests: modelRequests.length,
      restartedUsers: report.restartedUsers,
      interruptedLeaf: report.interruptedLeaf,
      guardedUsers: report.guardedUsers || null,
      finalUsers: report.finalUsers,
    }));
    console.log(`Message edit real Pi: ${checks}/${checks}`);
  } catch (error) {
    report.ok = false;
    report.error = error.message;
    report.checks = checks;
    console.error('FAIL ' + error.message);
    console.error('stderr bytes: ' + rpc.stderr.join('').length);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
