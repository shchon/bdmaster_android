const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Lazy Capacitor bridge import
interface CapacitorBridge {
  Capacitor: { isNativePlatform(): boolean };
  CapacitorHttp: {
    request(opts: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      data?: string;
    }): Promise<{ status: number; data: unknown; headers: Record<string, string> }>;
  };
}

let _bridge: CapacitorBridge | null = null;
let _bridgeLoaded = false;

async function loadBridge(): Promise<CapacitorBridge | null> {
  if (_bridgeLoaded) return _bridge;
  _bridgeLoaded = true;
  try {
    const mod = await import('@capacitor/core');
    _bridge = mod as unknown as CapacitorBridge;
  } catch {
    _bridge = null;
  }
  return _bridge;
}

export async function isNative(): Promise<boolean> {
  const bridge = await loadBridge();
  if (!bridge) return false;
  try { return bridge.Capacitor.isNativePlatform(); }
  catch { return false; }
}

async function nativeHttp(): Promise<CapacitorBridge['CapacitorHttp']> {
  const bridge = await loadBridge();
  if (!bridge) throw new Error('Capacitor bridge not available');
  return bridge.CapacitorHttp;
}

// --- Cookie helpers ---

function parseSetCookie(sc: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = sc.split(/,(?=[^;]+?=)/g);
  for (const part of parts) {
    const pair = part.split(';', 1)[0]?.trim();
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    result[pair.slice(0, idx).trim()] = pair.slice(idx + 1);
  }
  return result;
}

function cookiesToHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractSetCookie(headers: Record<string, string>): string {
  const sc = headers['set-cookie'];
  if (sc) return sc;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'set-cookie') return v;
  }
  return '';
}

// --- HTTP helpers ---

async function nativeGet(url: string, extraHeaders?: Record<string, string>) {
  const http = await nativeHttp();
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...extraHeaders,
  };
  return http.request({ url, method: 'GET', headers });
}

async function nativePost(
  url: string,
  body: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
) {
  const http = await nativeHttp();
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Content-Type': contentType,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Origin': 'https://www.jisilu.cn',
    'Referer': 'https://www.jisilu.cn/data/cbnew/',
    ...extraHeaders,
  };
  return http.request({ url, method: 'POST', headers, data: body });
}

// --- Public API ---

export interface JisiluSession {
  cookie: string;
}

export interface RawBondItem {
  cell: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RawRedeemItem {
  bond_id: string;
  redeem_remain_days?: number;
  redeem_status?: string;
  redeem_icon?: string;
}

/**
 * Login to jisilu.cn and return the session cookie string.
 * On web (dev mode), this is a no-op — use the backend proxy instead.
 */
export async function jisiluLoginNative(username: string, password: string): Promise<JisiluSession> {
  // Step 1: pre-fetch homepage to get initial cookies
  const preResp = await nativeGet('https://www.jisilu.cn/');
  const preCookies = parseSetCookie(extractSetCookie(preResp.headers));

  // Step 2: login
  const body = new URLSearchParams({
    return_url: 'https://www.jisilu.cn/',
    user_name: username,
    password,
    aes: '1',
    auto_login: '1',
  }).toString();

  const loginResp = await nativePost(
    'https://www.jisilu.cn/webapi/account/login_process/',
    body,
    'application/x-www-form-urlencoded; charset=UTF-8',
    { Cookie: cookiesToHeader(preCookies), Referer: 'https://www.jisilu.cn/' },
  );

  // Check for login failure
  try {
    const json = JSON.parse(loginResp.data as string);
    if (json?.code === 413) {
      throw new Error(json.msg || '手机号/用户名或密码不一致');
    }
  } catch (e: unknown) {
    if (e instanceof SyntaxError) { /* not JSON, which is expected on success */ }
    else if (e instanceof Error) throw e;
  }

  // Step 3: merge cookies
  const loginCookies = parseSetCookie(extractSetCookie(loginResp.headers));
  const merged = { ...preCookies, ...loginCookies };
  const cookie = cookiesToHeader(merged);

  if (!cookie) throw new Error('登录可能成功，但未获得 Cookie');

  return { cookie };
}

/**
 * Fetch all bond data from jisilu.cn (paginated).
 */
export async function jisiluFetchBonds(cookie: string): Promise<RawBondItem[]> {
  const timestamp = Date.now();
  const baseUrl = `https://www.jisilu.cn/data/cbnew/cb_list_new/?___jsl=LST___t=${timestamp}`;

  // Warm up session
  await nativeGet('https://www.jisilu.cn/data/cbnew/', {
    Cookie: cookie,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  });

  const allRows: RawBondItem[] = [];
  const seenIds = new Set<string>();
  const rp = 30;
  let page = 1;
  let total: number | null = null;

  while (page <= 200) {
    const url = `${baseUrl}&page=${page}&rp=${rp}`;
    const body = `page=${page}&rp=${rp}`;

    const resp = await nativePost(url, body, 'application/x-www-form-urlencoded; charset=UTF-8', {
      Cookie: cookie,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    });

    if (resp.status !== 200) {
      throw new Error(`网络错误: HTTP ${resp.status}`);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(resp.data as string);
    } catch {
      throw new Error('集思录返回数据格式异常');
    }

    const rows = (data.rows as unknown[]) || [];
    if (total === null && typeof data.total === 'number') {
      total = data.total;
    }

    if (rows.length === 0) break;

    for (const row of rows) {
      const item = (row as RawBondItem).cell || row;
      const id = String((item as Record<string, unknown>).bond_id || (item as Record<string, unknown>).id || '');
      if (!id) { allRows.push(row as RawBondItem); continue; }
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      allRows.push(row as RawBondItem);
    }

    if (total !== null && allRows.length >= total) break;
    page += 1;
  }

  return allRows;
}

/**
 * Fetch redeem info from jisilu.cn.
 */
export async function jisiluFetchRedeem(cookie: string): Promise<RawRedeemItem[]> {
  const url = `https://www.jisilu.cn/webapi/cb/redeem/?___t=${Date.now()}`;

  const resp = await nativeGet(url, {
    Cookie: cookie,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
  });

  if (resp.status !== 200) return [];

  const text = String(resp.data ?? '');
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }

  let rowsList: unknown[] = [];
  const d = data as Record<string, unknown>;
  if (d?.rows) {
    rowsList = d.rows as unknown[];
  } else if (d?.data) {
    const inner = d.data as Record<string, unknown>;
    if (inner?.rows && Array.isArray(inner.rows)) {
      rowsList = inner.rows as unknown[];
    }
  } else if (Array.isArray(data)) {
    rowsList = data;
  }

  return rowsList.map((row: unknown) => {
    const item = ((row as Record<string, unknown>).cell || row) as Record<string, unknown>;
    return {
      bond_id: String(item.bond_id || item.id || ''),
      redeem_remain_days: item.redeem_remain_days != null ? Number(item.redeem_remain_days) : undefined,
      redeem_status: item.redeem_status != null ? String(item.redeem_status) : undefined,
      redeem_icon: item.redeem_icon != null ? String(item.redeem_icon) : undefined,
    };
  }).filter((r: RawRedeemItem) => r.bond_id);
}
