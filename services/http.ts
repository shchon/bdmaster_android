import { Capacitor, CapacitorHttp } from '@capacitor/core';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8000';

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  if (!isNative()) {
    return fetch(url, options);
  }

  const resp = await CapacitorHttp.request({
    url,
    method: (options?.method ?? 'GET') as string,
    headers: (options?.headers ?? {}) as Record<string, string>,
    data: (options?.body ?? undefined) as string | undefined,
  });

  // 204, 304, and 1xx statuses cannot have a body
  const nullBodyStatus = resp.status === 204 || resp.status === 304 || (resp.status >= 100 && resp.status < 200);
  const body = nullBodyStatus
    ? null
    : typeof resp.data === 'string'
      ? resp.data
      : resp.data != null
        ? JSON.stringify(resp.data)
        : null;

  return new Response(body, {
    status: resp.status,
    statusText: '',
    headers: new Headers(resp.headers ?? {}),
  });
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
