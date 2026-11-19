/* 启动贡献者：把 GUI 的“编辑并重新发送”导航扩展注入每条 Pi 进程。
 *
 * 只贡献 `--extension` 参数和一个随机命令名，不持有会话状态、不接触用户数据。
 * 命令名每次启动重新生成，后端在事务开始前用 `get_commands` 核对它确实被
 * 当前 Pi 加载；旧版 Pi 或扩展加载失败时，事务 fail-closed，不会退化成
 * 新会话 / fork。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { materializeDir } from '../lib/assets.js';

function extensionEntry() {
  return path.join(materializeDir('extensions/pi-gui-edit'), 'index.js');
}

export function createMessageEditLaunch() {
  let command = null;
  let entry = null;
  let available = null;
  const resolveEntry = () => {
    if (entry) return entry;
    try {
      const candidate = extensionEntry();
      if (fs.statSync(candidate).isFile()) entry = candidate;
    } catch {
      entry = null;
    }
    return entry;
  };
  return {
    available() {
      if (available === null) available = Boolean(resolveEntry());
      return available;
    },
    prepare() {
      const file = resolveEntry();
      if (!file) return null;
      command = 'pi-gui-edit-' + randomUUID().replace(/-/g, '').slice(0, 12);
      return {
        args: ['--extension', file],
        env: { PI_GUI_EDIT_COMMAND: command },
      };
    },
    command() {
      return command;
    },
    invalidate() {
      command = null;
    },
  };
}
