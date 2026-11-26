/* 「信息」设置页。
 *
 * 这一页只做**编排**，不拥有任何更新 / 重启 / 日志状态：
 *   - pi-GUI 自己的更新：update.js（状态机 + Electron 桥 + Release Notes 安全渲染）
 *   - Pi 运行时更新：pi-update.js（与上面完全独立的一份状态机）
 *   - 重启：providers.js 的 restartPi()（唯一入口 + 确认框）
 *   - 日志 / 导出：logs.js 的 openLogs()（用 initialTab 落到既有标签）
 *
 * 更新区块只在信息页挂载。系统环境由系统页展示，技术诊断由日志与诊断承接；
 * 这里不复制它们的状态、不额外订阅后台服务。
 */
import { fetchDiagnostics } from './api.js';
import { appUpdateSnapshot } from './app-update.js';
import { getPiUpdateState, renderPiUpdateSection } from './pi-update.js';
import { getUpdateState, openExternal, renderUpdateSection } from './update.js';
import { restartPi } from './providers.js';
import { createIcon } from './ui/icons.js';
import { openModal } from './ui/modal.js';
import { createSettingsCard, createSettingsRow } from './ui/primitives.js';
import { toast } from './ui/toast.js';

const ISSUES_URL = 'https://github.com/HYJ1817/pi-gui/issues';

function node(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== '') n.textContent = String(text);
  return n;
}

function button(label, cls = 'btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

function actionGroup(actions) {
  const wrap = node('div', 'about-row-actions');
  for (const action of actions) {
    const b = button(action.label, action.primary ? 'btn primary' : 'btn');
    if (action.testId) b.dataset.aboutAction = action.testId;
    b.onclick = action.run;
    wrap.appendChild(b);
  }
  return wrap;
}

function updatePanel({ id, key, icon, title, description }) {
  const panel = node('section', 'about-update-panel');
  panel.dataset.aboutUpdate = key;
  panel.setAttribute('aria-labelledby', id);
  const head = node('div', 'about-update-head');
  const iconBox = node('span', 'about-update-icon');
  iconBox.setAttribute('aria-hidden', 'true');
  iconBox.appendChild(createIcon(icon));
  const copy = node('div', 'about-update-copy');
  const heading = node('h3', 'about-update-title', title);
  heading.id = id;
  copy.append(heading, node('p', 'about-update-desc', description));
  head.append(iconBox, copy);
  const body = node('div', 'about-update-body');
  panel.append(head, body);
  return { panel, body };
}

function buildHero(card) {
  const hero = node('section', 'about-hero');
  hero.setAttribute('aria-label', '应用信息');
  /* 重试成功后错误行连同按钮一起消失；把焦点收回 hero，避免键盘用户
   * 掉回 body。平时不进 Tab 序，只在程序化聚焦时可达。 */
  hero.tabIndex = -1;
  const mark = node('div', 'about-hero-mark', 'π');
  mark.setAttribute('aria-hidden', 'true');
  const version = node('div', 'about-hero-version', '版本 读取中…');
  version.setAttribute('role', 'status');
  const meta = node('div', 'about-hero-meta', '正在读取应用信息…');
  const error = node('div', 'about-hero-error');
  error.setAttribute('role', 'status');
  error.hidden = true;
  hero.append(mark, node('div', 'about-hero-name', 'pi-GUI'), version, meta, error);
  card.appendChild(hero);
  return { version, meta, error, focus: (options) => hero.focus(options) };
}

function paintHero(hero, diagnostics) {
  hero.version.textContent = `版本 ${diagnostics.app?.version || '未知'}`;
  const pi = diagnostics.pi || {};
  hero.meta.textContent = 'Pi ' + (pi.available === false ? '不可用' : pi.version || '未知');
  hero.error.hidden = true;
  hero.error.replaceChildren();
}

function paintHeroError(hero, message, retry) {
  hero.version.textContent = '版本 未知';
  hero.meta.textContent = 'Pi 未知';
  hero.error.replaceChildren(
    node('span', '', message || '无法读取应用信息'),
    (() => {
      const again = button('重试');
      again.dataset.aboutAction = 'retry-info';
      again.onclick = retry;
      return again;
    })(),
  );
  hero.error.hidden = false;
}

function restartRow() {
  const restart = button('重启 Pi');
  restart.dataset.aboutAction = 'restart-pi';
  let pending = false;
  /* 直接调用 providers.js 的唯一重启入口：确认框、流式回答警告、取消即不发请求、
   * 失败文案与重连后的会话恢复都由它自己保证。这里只防连点并给出忙碌态。 */
  restart.onclick = async () => {
    if (pending) return;
    pending = true;
    restart.disabled = true;
    restart.setAttribute('aria-busy', 'true');
    try {
      await restartPi();
    } catch {
      toast('重启没有完成，请重试。', 'error', { important: true });
    } finally {
      pending = false;
      if (restart.isConnected) {
        restart.disabled = false;
        restart.removeAttribute('aria-busy');
      }
    }
  };
  return createSettingsRow({
    label: '重启 Pi',
    detail: '重新加载 Pi 配置并重新连接运行时。',
    control: restart,
    extraClass: 'about-restart-row',
    id: 'aboutRestartRow',
  });
}

/**
 * 打开「信息」页。
 *
 * `present` 与其它设置页同形（settingsSurface.presentDetail 或 openModal）。
 * `openLogs(initialTab)` 由组合根注入：只声明目的地，不自己创建第二层页面。
 */
export function openAboutSettings({
  present = openModal,
  openLogs = () => { const b = document.getElementById('navLogs'); if (b) b.click(); },
} = {}) {
  present((card) => {
    card.classList.add('about-settings-card');
    card.appendChild(node('h3', '', '信息'));
    card.appendChild(node('p', 'settings-page-desc', '版本、更新与应用支持。'));

    const hero = buildHero(card);
    let heroSeq = 0;

    const loadHero = async () => {
      const seq = ++heroSeq;
      const retryHadFocus = hero.error.contains(document.activeElement);
      hero.version.textContent = '版本 读取中…';
      hero.meta.textContent = '正在读取应用信息…';
      hero.error.hidden = true;
      const payload = await fetchDiagnostics().catch(() => ({ ok: false }));
      if (!card.isConnected || seq !== heroSeq) return;
      const diagnostics = payload && payload.ok !== false ? payload.diagnostics : null;
      if (!diagnostics) {
        paintHeroError(hero, '无法读取应用信息，请重试。', loadHero);
      } else {
        paintHero(hero, diagnostics);
      }
      /* 旧的「重试」按钮已经随错误行一起被替换；焦点回到 hero。 */
      if (retryHadFocus) hero.focus({ preventScroll: true });
    };

    /* 软件更新：复用 update.js 的状态机与 Electron 下载 / 校验 / 安装路径。
     * 不在卡片里再加第二个检查按钮 —— 更新区块自己那一份就是唯一动作入口。 */
    const appUpdate = updatePanel({
      id: 'aboutAppUpdateTitle',
      key: 'app',
      icon: 'update',
      title: '软件更新',
      description: '检查并安装 pi-GUI 自身的新版本。',
    });
    renderUpdateSection(
      appUpdate.body,
      appUpdateSnapshot()?.currentVersion || getUpdateState().currentVersion || '',
      { heading: false },
    );
    card.appendChild(appUpdate.panel);

    /* Pi 运行时更新：独立卡片、独立状态、独立确认；与上面的 pi-GUI 更新
     * 永远不是一个操作。 */
    const piUpdate = updatePanel({
      id: 'aboutPiUpdateTitle',
      key: 'pi',
      icon: 'refresh',
      title: 'Pi 运行时',
      description: '更新 Pi GUI 驱动的外部 Pi 程序；与 pi-GUI 自身更新相互独立。',
    });
    renderPiUpdateSection(piUpdate.body, getPiUpdateState().currentVersion || '', { heading: false });
    card.appendChild(piUpdate.panel);

    card.appendChild(createSettingsCard({
      title: '运行时',
      description: '重启会重新加载 Pi 配置；磁盘上的会话与文件不受影响。',
      children: [restartRow()],
    }));

    card.appendChild(createSettingsCard({
      title: '日志与反馈',
      description: '日志只保存在本机；打开 GitHub 不会自动上传日志、会话内容或密钥。',
      children: [
        createSettingsRow({
          label: '日志与诊断',
          detail: '查看本机日志、诊断摘要，或导出脱敏故障报告。',
          control: actionGroup([
            { label: '打开日志与诊断', testId: 'open-logs', run: () => openLogs('overview') },
            { label: '导出故障报告', testId: 'export-report', run: () => openLogs('export') },
          ]),
          extraClass: 'about-support-row',
          id: 'aboutLogsRow',
        }),
        createSettingsRow({
          label: '问题反馈',
          detail: '在 GitHub Issues 中反馈问题；不会自动上传日志、会话内容或 API Key。',
          control: actionGroup([
            {
              label: '打开 GitHub',
              testId: 'open-github',
              run: () => { openExternal(ISSUES_URL).catch(() => {}); },
            },
          ]),
          extraClass: 'about-support-row',
          id: 'aboutFeedbackRow',
        }),
      ],
    }));

    loadHero();
  });
}
