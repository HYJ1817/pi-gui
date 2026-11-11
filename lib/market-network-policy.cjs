/* MCP 市场网络策略的**唯一实现** —— 后端市场请求、Electron 主进程代理桥、
 * 单元测试都从这里取同一套判定。
 *
 * 为什么单独一个 CJS 文件：后端是 ESM、Electron 主进程是 CJS、测试是 CJS。
 * 三处各写一份「什么算私网」「什么算 fake-IP」「代理线路怎么读」，
 * 迟早会出现两个真相，而分叉的那一份就是安全边界上最危险的那份。
 *
 * 这里只做**纯判定**：不联网、不读环境变量、不持有状态。
 */
'use strict';

const net = require('node:net');

/** URL 的 hostname，去掉 IPv6 方括号并小写。 */
function hostnameOf(u) {
  return String((u && u.hostname) || '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

/* IPv6 必须按 8 个 hextet 解析后再判定；字符串前缀判断会漏掉
 * `::ffff:7f00:1`（IPv4-mapped 十六进制）和 `::ffff:0:7f00:1`
 * （IPv4-translated），它们都能把请求带到 127.0.0.1。 */
function ipv6Hextets(ip) {
  let s = String(ip || '').toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  s = s.replace(/^\[|\]$/g, '');
  if (!net.isIPv6(s)) return null;
  /* Node 接受 `::ffff:93.184.216.34` 这种末尾带点分 IPv4 的写法；先把它
   * 折成两个 hextet，否则按 ':' 切分会得到一个带点的非法段，整条地址被
   * 误判成 invalid —— 而 invalid 在代理线路上同样是拒绝，方向安全但会
   * 把合法公网地址错杀。 */
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const tail = s.slice(cut + 1);
    if (!net.isIPv4(tail)) return null;
    const p = tail.split('.').map(Number);
    const hi = ((p[0] << 8) | p[1]).toString(16);
    const lo = ((p[2] << 8) | p[3]).toString(16);
    s = `${s.slice(0, cut + 1)}${hi}:${lo}`;
  }
  const parse = (part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return parseInt(part, 16);
  };
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    if (l.length + r.length > 7) return null;
    const values = [...l, ...new Array(8 - l.length - r.length).fill('0'), ...r].map(parse);
    return values.some((v) => v === null) ? null : values;
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  const values = parts.map(parse);
  return values.some((v) => v === null) ? null : values;
}

function embeddedIpv4(parts) {
  const hi = parts[6];
  const lo = parts[7];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function ipv4Class(a, b, c) {
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'documentation';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark';
  if (a === 198 && b === 51 && c === 100) return 'documentation';
  if (a === 203 && b === 0 && c === 113) return 'documentation';
  if (a >= 240) return 'reserved';
  if (a >= 224) return 'multicast';
  return 'public';
}

/**
 * 把一个 IP 字面量归到网络策略关心的类别。
 *
 * `benchmark` 是 RFC 2544 的 198.18.0.0/15 / 2001:2::/48 —— Clash、Mihomo、
 * Surge 等 TUN 代理常用它合成 fake-IP。它既不是公网地址，也不是「内网服务」，
 * 所以必须单独分类：只有能证明请求不会由应用直接拨到该地址时才可以放行。
 */
function classifyAddress(ip) {
  if (typeof ip !== 'string' || !ip) return 'invalid';
  const value = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(value)) {
    const p = value.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'invalid';
    return ipv4Class(p[0], p[1], p[2]);
  }
  if (net.isIPv6(value)) {
    const parts = ipv6Hextets(value);
    if (!parts) return 'invalid';
    if (parts.every((v) => v === 0)) return 'unspecified';
    if (parts.slice(0, 7).every((v) => v === 0) && parts[7] === 1) return 'loopback';
    /* fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local,
     * ff00::/8 multicast. */
    if ((parts[0] & 0xfe00) === 0xfc00) return 'ula';
    if ((parts[0] & 0xffc0) === 0xfe80) return 'link-local';
    if ((parts[0] & 0xffc0) === 0xfec0) return 'site-local';
    if ((parts[0] & 0xff00) === 0xff00) return 'multicast';
    /* 2001::/23 IETF 协议分配段（含 Teredo 2001::/32、benchmarking
     * 2001:2::/48、ORCHID 2001:10::/28），不是全局单播。 */
    if (parts[0] === 0x2001 && parts[1] === 0x0002 && parts[2] === 0) return 'benchmark';
    if (parts[0] === 0x2001 && parts[1] <= 0x01ff) return 'reserved';
    /* 2001:db8::/32 documentation. */
    if (parts[0] === 0x2001 && parts[1] === 0x0db8) return 'documentation';
    /* 3fff::/20 documentation. */
    if ((parts[0] & 0xfff0) === 0x3ff0) return 'documentation';
    /* 100::/64 discard-only. */
    if (parts[0] === 0x0100 && parts.slice(1, 4).every((v) => v === 0)) return 'reserved';
    /* ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d (IPv4-translated). */
    if (parts.slice(0, 5).every((v) => v === 0) && parts[5] === 0xffff) {
      return classifyAddress(embeddedIpv4(parts));
    }
    if (parts.slice(0, 4).every((v) => v === 0) && parts[4] === 0xffff && parts[5] === 0) {
      return classifyAddress(embeddedIpv4(parts));
    }
    /* IPv4-compatible ::a.b.c.d (deprecated but still parseable). */
    if (parts.slice(0, 6).every((v) => v === 0)) {
      return classifyAddress(embeddedIpv4(parts));
    }
    /* 64:ff9b::/96 NAT64 embeds IPv4 in the last 32 bits. Keep the embedded
     * address's verdict so a NAT64 spelling cannot hide 127.0.0.1. */
    if (parts[0] === 0x0064 && parts[1] === 0xff9b) {
      return classifyAddress(embeddedIpv4(parts));
    }
    /* 2002::/16 6to4 embeds IPv4 in hextets 1–2. */
    if (parts[0] === 0x2002) {
      const hi = parts[1];
      const lo = parts[2];
      return classifyAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return 'public';
  }
  return 'invalid';
}

function isFakeIpAddress(ip) {
  return classifyAddress(ip) === 'benchmark';
}

/**
 * 旧判据的兼容名：**除公网外一律为 true**（含 fake-IP）。
 * 直连 / 无法确认线路时仍用它；代理线路的判定用下面更细的
 * `isAcceptableResolvedAddress`。
 */
function isPrivateIp(ip) {
  return classifyAddress(ip) !== 'public';
}

/**
 * 一个已解析地址在某条线路上是否可以作为连接目标。
 *
 * - 公网地址：任何线路都可。
 * - fake-IP（benchmark）：只有代理线路，或显式允许 TUN fake-IP 的直连线路，
 *   才可作为连接目标。它必须**仍被固定**（直连时由 `lookup` 固定），
 *   不能把「允许」理解成「跳过地址校验」。
 * - 其它一切非公网类别：任何线路都拒绝。私网 / 回环 / 链路本地 / ULA /
 *   保留地址在代理线路上也拒绝 —— 本地解析器给出真实内网地址时，
 *   应用看不到代理会把它解析到哪里，不能放行。
 */
function isAcceptableResolvedAddress(kind, route, { allowFakeIp = false } = {}) {
  if (kind === 'public') return true;
  if (kind !== 'benchmark') return false;
  return route === 'proxied' || (route === 'direct' && allowFakeIp === true);
}

/** 本机 / 内网主机名。IP 字面量由 classifyAddress 单独判定。 */
function blockedHostname(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

/* Chromium `Session.resolveProxy` 的返回形如 `PROXY host:port` /
 * `SOCKS5 host:port; DIRECT`。只认这些类型。 */
const PROXY_LIST_TYPES = ['PROXY', 'HTTP', 'HTTPS', 'SOCKS', 'SOCKS4', 'SOCKS5'];
const PROXY_CHAIN_ENTRY = new RegExp(
  `^(?:${PROXY_LIST_TYPES.join('|')})\\s+\\S+(?:\\s*,\\s*(?:${PROXY_LIST_TYPES.join('|')})\\s+\\S+)*$`,
);

/**
 * 把 Chromium 的代理列表读成 `direct` / `proxied` / `unknown`。
 *
 * 只有「至少一条代理链、且没有任何 DIRECT 项」才算 `proxied`。
 * 列表里同时出现 DIRECT 时 Chromium 可能回退直连，应用无法证明请求一定
 * 走了代理 —— 此时是 `unknown`，**不是**更宽松的 `proxied`。
 * 空、不可解析、类型不认识一律 `unknown`。这个方向是 fail closed。
 */
function classifyProxyRoute(proxyList) {
  if (typeof proxyList !== 'string') return 'unknown';
  const entries = proxyList
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return 'unknown';
  let direct = false;
  let proxied = false;
  for (const entry of entries) {
    if (/^DIRECT$/i.test(entry)) {
      direct = true;
      continue;
    }
    if (!PROXY_CHAIN_ENTRY.test(entry)) return 'unknown';
    proxied = true;
  }
  if (proxied) return direct ? 'unknown' : 'proxied';
  return direct ? 'direct' : 'unknown';
}

module.exports = {
  blockedHostname,
  classifyAddress,
  classifyProxyRoute,
  hostnameOf,
  isAcceptableResolvedAddress,
  isFakeIpAddress,
  isPrivateIp,
};
