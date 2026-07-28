import { Capacitor, CapacitorHttp } from '@capacitor/core';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function isNative(): boolean {
  try { return Capacitor.isNativePlatform(); }
  catch { return false; }
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function nativeGet(url: string, extraHeaders?: Record<string, string>) {
  console.log('[BondMaster] nativeGet:', url);
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...extraHeaders,
  };
  return withTimeout(
    CapacitorHttp.request({ url, method: 'GET', headers }),
    20000,
  );
}

async function nativePost(
  url: string,
  body: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
) {
  console.log('[BondMaster] nativePost:', url);
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Content-Type': contentType,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Origin': 'https://www.jisilu.cn',
    'Referer': 'https://www.jisilu.cn/data/cbnew/',
    ...extraHeaders,
  };
  return withTimeout(
    CapacitorHttp.request({ url, method: 'POST', headers, data: body }),
    20000,
  );
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
 */
export async function jisiluLoginNative(username: string, password: string): Promise<JisiluSession> {
  try {
    // Step 1: pre-fetch homepage to get initial cookies
    console.log('[BondMaster] Step 1: pre-fetch jisilu.cn homepage...');
    const preResp = await nativeGet('https://www.jisilu.cn/');
    console.log('[BondMaster] Pre-fetch status:', preResp.status, 'headers:', JSON.stringify(preResp.headers));

    const preCookies = parseSetCookie(extractSetCookie(preResp.headers));
    console.log('[BondMaster] Pre-fetch cookies:', JSON.stringify(preCookies));

    // Step 2: login
    const body = new URLSearchParams({
      return_url: 'https://www.jisilu.cn/',
      user_name: username,
      password,
      aes: '1',
      auto_login: '1',
    }).toString();

    console.log('[BondMaster] Step 2: login...');
    const loginResp = await nativePost(
      'https://www.jisilu.cn/webapi/account/login_process/',
      body,
      'application/x-www-form-urlencoded; charset=UTF-8',
      { Cookie: cookiesToHeader(preCookies), Referer: 'https://www.jisilu.cn/' },
    );

    console.log('[BondMaster] Login status:', loginResp.status);

    // Check for login failure (CapacitorHttp auto-parses JSON)
    const loginData = loginResp.data;
    if (typeof loginData === 'object' && loginData !== null) {
      const json = loginData as Record<string, unknown>;
      console.log('[BondMaster] Login JSON:', JSON.stringify(json).slice(0, 300));
      if (json?.code === 413) {
        throw new Error((json.msg as string) || '手机号或密码不一致');
      }
      if (json?.code !== 200 && json?.code !== undefined) {
        throw new Error((json.msg as string) || `登录失败: code=${json.code}`);
      }
    } else {
      console.log('[BondMaster] Login response is not JSON (expected on success), type:', typeof loginData);
    }

    // Step 3: merge cookies
    const loginCookies = parseSetCookie(extractSetCookie(loginResp.headers));
    const merged = { ...preCookies, ...loginCookies };
    const cookie = cookiesToHeader(merged);

    if (!cookie) {
      if (cookiesToHeader(preCookies)) {
        console.log('[BondMaster] Using pre-fetch cookies only');
        return { cookie: cookiesToHeader(preCookies) };
      }
      throw new Error('登录可能成功，但未获得 Cookie');
    }

    console.log('[BondMaster] Login success, cookie length:', cookie.length);
    return { cookie };
  } catch (e: unknown) {
    console.error('[BondMaster] Login error:', e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/**
 * Fetch all bond data from jisilu.cn (paginated).
 */
export async function jisiluFetchBonds(cookie: string): Promise<RawBondItem[]> {
  const timestamp = Date.now();
  const baseUrl = `https://www.jisilu.cn/data/cbnew/cb_list_new/?___jsl=LST___t=${timestamp}`;

  // Warm up session
  try {
    await nativeGet('https://www.jisilu.cn/data/cbnew/', {
      Cookie: cookie,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    });
  } catch { /* not critical */ }

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

    let respData: unknown = resp.data;
    // CapacitorHttp may auto-parse JSON; if string, parse it
    if (typeof respData === 'string') {
      try { respData = JSON.parse(respData); } catch { /* keep as string */ }
    }

    if (typeof respData === 'string') {
      console.error('[BondMaster] Auth issue, string response:', (respData as string).slice(0, 500));
      throw new Error('Cookie 可能已过期，请重新登录');
    }

    const data = respData as Record<string, unknown>;

    const rows = (data.rows as unknown[]) || [];
    if (total === null && typeof data.total === 'number') {
      total = data.total;
    }

    console.log('[BondMaster] Page', page, '- rows:', rows.length, 'total:', total, 'keys:', Object.keys(data).join(','));

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
    'Accept': 'application/json, text/javascript, */*; q=0.01',
  });

  console.log('[BondMaster] Redeem status:', resp.status, 'data type:', typeof resp.data, 'length:', typeof resp.data === 'string' ? resp.data.length : JSON.stringify(resp.data).length);

  if (resp.status !== 200) return [];

  let rawText = '';
  if (typeof resp.data === 'string') {
    rawText = resp.data;
  } else if (typeof resp.data === 'object' && resp.data !== null) {
    // CapacitorHttp auto-parsed JSON; stringify to extract the embedded array
    rawText = JSON.stringify(resp.data);
  }

  // jisilu redeem endpoint returns text/JSON with embedded array: ...[{"bond_id":...}]...
  // Try direct JSON array first
  let rowsList: unknown[] = [];
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      rowsList = parsed;
      console.log('[BondMaster] Redeem: direct array,', rowsList.length, 'items');
    }
  } catch { /* not an array */ }

  // If not a direct array, find [{...}]} embedded pattern
  if (rowsList.length === 0) {
    const start = rawText.indexOf('[{');
    const end = rawText.lastIndexOf('}]}');
    if (start !== -1 && end !== -1) {
      try {
        rowsList = JSON.parse(rawText.slice(start, end + 2));
        console.log('[BondMaster] Redeem: extracted array,', rowsList.length, 'items');
      } catch {
        console.log('[BondMaster] Redeem: failed to parse extracted JSON');
      }
    }
  }

  // Try object with .rows or .data.rows
  if (rowsList.length === 0) {
    const d = resp.data as Record<string, unknown>;
    if (Array.isArray(d)) {
      rowsList = d;
    } else if (d?.rows && Array.isArray(d.rows)) {
      rowsList = d.rows as unknown[];
    } else if (d?.data) {
      const inner = d.data as Record<string, unknown>;
      if (Array.isArray(inner)) { rowsList = inner; }
      else if (inner?.rows && Array.isArray(inner.rows)) { rowsList = inner.rows as unknown[]; }
    }
    if (rowsList.length > 0) {
      console.log('[BondMaster] Redeem: found in object,', rowsList.length, 'items');
    }
  }

  if (rowsList.length === 0) {
    console.log('[BondMaster] Redeem: could not find data, keys:', typeof resp.data === 'object' && resp.data !== null ? Object.keys(resp.data as Record<string, unknown>).join(',') : 'n/a');
    return [];
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
