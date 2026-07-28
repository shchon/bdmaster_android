const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8000';

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

// --- Lazy Capacitor bridge: import only after deviceready / on native ---

let _bridge: { Capacitor: unknown; CapacitorHttp: unknown } | null = null;
let _bridgeLoaded = false;

async function loadBridge() {
  if (_bridgeLoaded) return _bridge;
  _bridgeLoaded = true;
  try {
    const mod = await import('@capacitor/core');
    _bridge = { Capacitor: mod.Capacitor, CapacitorHttp: mod.CapacitorHttp };
  } catch {
    _bridge = null;
  }
  return _bridge;
}

export async function isNative(): Promise<boolean> {
  const bridge = await loadBridge();
  if (!bridge) return false;
  try {
    return (bridge.Capacitor as { isNativePlatform(): boolean }).isNativePlatform();
  } catch {
    return false;
  }
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const native = await isNative();

  if (!native) {
    return fetch(url, options);
  }

  const bridge = await loadBridge();
  const CapacitorHttp = (bridge! as { CapacitorHttp: { request(opts: Record<string, unknown>): Promise<{ status: number; data: unknown; headers: Record<string, string> }> } }).CapacitorHttp;

  const resp = await CapacitorHttp.request({
    url,
    method: (options?.method ?? 'GET') as string,
    headers: options?.headers ? (options.headers as Record<string, string>) : {},
    data: (options?.body ?? undefined) as string | undefined,
  });

  const responseHeaders = new Headers(resp.headers || {});
  return new Response(
    typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
    { status: resp.status, statusText: '', headers: responseHeaders },
  );
}

export async function apiPost<T = never>(
  path: string,
  body?: unknown,
  options?: RequestInit,
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  return apiFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> | undefined),
    },
    body: body ? JSON.stringify(body) : undefined,
    ...options,
  });
}

export async function apiGet<T = never>(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  return apiFetch(url, { method: 'GET', ...options });
}
