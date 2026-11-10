/* 把 GUI 自带的 gui_plan 扩展注入每一条 pi 启动命令。
 *
 * 和 tool-guard / process / revert 扩展一样，扩展目录由 materializeDir
 * 解析：开发时就是仓库里的 extensions/pi-gui-plan，打包后从 SEA assets
 * 解到临时目录。这里不持有任何会话状态 —— 计划状态由扩展自己按 session
 * 分支重建，rpc-bridge 只贡献启动参数。
 */
import path from 'node:path';
import { materializeDir } from '../lib/assets.js';

export function createPlanBridge() {
  return {
    available: () => true,
    prepare() {
      return {
        args: ['--extension', path.join(materializeDir('extensions/pi-gui-plan'), 'index.js')],
        env: {},
      };
    },
    /* 计划工具没有外部资源需要撤销；保留方法是为了与其它 launch provider 同形。 */
    invalidate() {},
  };
}
