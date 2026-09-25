// CLI 启动时端口已被占用，只信任同一 app/protocol 的健康检查。
export function classifyOccupiedPort(body) {
  return body?.app === 'pi-gui' && body?.protocol === 1 ? 'pi-gui' : 'foreign-service';
}

export async function probeOccupiedPort(port, fetchFn = fetch) {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
      headers: { 'Cache-Control': 'no-store' },
    });
    if (!response.ok) return 'foreign-service';
    return classifyOccupiedPort(await response.json());
  } catch {
    return 'foreign-service';
  }
}
