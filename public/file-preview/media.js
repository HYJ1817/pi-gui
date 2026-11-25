import { node, button, formatBytes } from './common.js';

const AUDIO = new Set(['mp3', 'wav', 'wave', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'aif', 'aiff', 'wma', 'weba']);
const VIDEO = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi', 'wmv', 'flv', 'mpeg', 'mpg']);

export function mediaKind(name = '') {
  const extension = name.toLowerCase().split('.').pop();
  return AUDIO.has(extension) ? 'audio' : VIDEO.has(extension) ? 'video' : null;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const rest = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export async function mount(ctx) {
  let disposed = false;
  let media;
  let timer;
  let fullscreen;
  let metadataKnown = false;
  let failed = false;
  const listeners = [];
  const current = () => !disposed && !failed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    listeners.splice(0).forEach(remove => remove());
    if (media) {
      media.pause();
      media.removeAttribute('src');
      media.querySelectorAll('source,track').forEach(source => source.remove());
      // load() after clearing src releases the decoder and any pending Range read.
      media.load();
      if (media.ownerDocument.fullscreenElement === media) {
        media.ownerDocument.exitFullscreen?.().catch(() => {}); // best-effort native cleanup
      }
    }
  };
  const getState = () => ({
    currentTime: metadataKnown && Number.isFinite(media?.currentTime) ? media.currentTime : 0,
    volume: Number.isFinite(media?.volume) ? media.volume : 1,
    muted: media?.muted === true,
    // Deliberately no playing/autoplay flag: restoring a tab never starts playback.
  });
  const handle = { dispose, getState };
  ctx.resources.own(dispose);
  const kind = mediaKind(ctx.meta.name || ctx.request.name || ctx.request.path);
  if (!kind) { ctx.error('此媒体类型暂不支持。'); return handle; }
  try {
    const url = await ctx.access.url();
    if (!current()) return handle;
    if (typeof url !== 'string' || !url) throw new Error('missing_url');
    const wrapper = node('div', `fp-media fp-media-${kind}`);
    media = node(kind, 'fp-media-player');
    media.controls = true;
    media.autoplay = false;
    media.preload = 'metadata';
    media.loop = false;
    media.setAttribute('aria-label', ctx.meta.name || ctx.request.name || '媒体预览');
    if (kind === 'video') media.playsInline = true;
    media.volume = Number.isFinite(ctx.state?.volume) ? Math.min(1, Math.max(0, ctx.state.volume)) : 1;
    media.muted = ctx.state?.muted === true;
    const metadata = node('div', 'fp-media-meta');
    const time = node('span', 'fp-media-time', '— / —');
    const size = Number.isFinite(ctx.meta.bytes) ? formatBytes(ctx.meta.bytes) : '';
    const info = node('span', 'fp-media-info', size);
    const status = node('p', 'fp-media-status', '正在读取媒体信息…');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    metadata.append(time, info);
    wrapper.append(media, metadata, status);
    ctx.host.append(wrapper);
    function refreshTime() {
      if (current()) time.textContent = `${formatTime(media.currentTime)} / ${formatTime(media.duration)}`;
    }
    function unavailable() {
      if (!current()) return;
      failed = true;
      clearTimeout(timer);
      metadataKnown = false;
      status.textContent = '当前环境无法播放此媒体，可使用文件菜单选择其他打开方式。';
      status.dataset.state = 'error';
      if (fullscreen) fullscreen.disabled = true;
      // Keep a concise, persistent local failure, never raw decoder/network text.
      media.pause();
      media.removeAttribute('src');
      media.load();
    }
    listen(media, 'loadedmetadata', () => {
      if (!current()) return;
      clearTimeout(timer);
      metadataKnown = true;
      const savedTime = Number(ctx.state?.currentTime);
      if (Number.isFinite(savedTime) && savedTime > 0 && Number.isFinite(media.duration) && media.duration > 0) {
        media.currentTime = Math.min(savedTime, Math.max(0, media.duration - 0.01));
      }
      const frame = kind === 'video' && media.videoWidth > 0 && media.videoHeight > 0
        ? `${media.videoWidth} × ${media.videoHeight}` : '';
      info.textContent = [frame, size].filter(Boolean).join(' · ');
      status.textContent = '媒体信息已读取，点击播放。';
      if (fullscreen) fullscreen.disabled = false;
      refreshTime();
    });
    listen(media, 'canplay', () => { if (current()) status.textContent = '可以播放。'; });
    listen(media, 'playing', () => { if (current()) status.textContent = '正在播放。'; });
    listen(media, 'pause', () => { if (current() && metadataKnown) status.textContent = '已暂停。'; });
    listen(media, 'ended', () => { if (current()) status.textContent = '播放结束。'; });
    listen(media, 'waiting', () => { if (current() && metadataKnown) status.textContent = '正在缓冲…'; });
    listen(media, 'timeupdate', refreshTime);
    listen(media, 'durationchange', refreshTime);
    listen(media, 'error', unavailable);
    if (kind === 'video' && typeof media.requestFullscreen === 'function') {
      fullscreen = button('全屏', () => {
        if (!current() || !metadataKnown) return;
        const result = media.requestFullscreen();
        result?.catch(() => { if (current()) status.textContent = '无法进入全屏，可继续使用播放器。'; });
      });
      fullscreen.disabled = true;
      ctx.toolbar.append(fullscreen);
    }
    // Only access owns URL creation/authentication/Range. No fetch, data URI,
    // extension-derived MIME assertion or canPlayType-as-success shortcut here.
    media.src = url;
    media.load();
    timer = setTimeout(() => {
      if (current() && !metadataKnown) {
        status.textContent = '尚未读到媒体信息，可重开文件或选择其他打开方式。';
      }
    }, 15000);
  } catch {
    if (current()) ctx.error('媒体读取失败。');
  }
  return handle;
}
