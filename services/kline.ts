// Lazy Capacitor bridge
interface CapacitorBridge {
  Capacitor: { isNativePlatform(): boolean };
  CapacitorHttp: {
    request(opts: { url: string; method: string }): Promise<{ status: number; data: unknown }>;
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

export interface KLineRow {
  date: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  code: string;
  stock_id: string;
}

export interface StockMomentum {
  stock_id: string;
  mom10: number | null;
  mom60: number | null;
}

export interface KLineCache {
  date: string;
  data: KLineRow[];
}

let _klineCache: KLineCache | null = null;

export function clearKlineCache(): void {
  _klineCache = null;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch 60-day K-line for stock symbols.
 */
export async function fetchKlineData(stockIds: string[]): Promise<KLineRow[]> {
  const uniqueIds = [...new Set(stockIds.map((s) => String(s).padStart(6, '0')))].filter(Boolean);
  if (uniqueIds.length === 0) return [];

  const cache = _klineCache;
  const today = todayStr();

  if (cache && cache.date === today && cache.data.length > 0) {
    // Use cached data, only fetch missing stocks
    const cachedIds = new Set(cache.data.map((r) => r.stock_id));
    const missingIds = uniqueIds.filter((id) => !cachedIds.has(id));

    if (missingIds.length === 0) {
      return cache.data.filter((r) => uniqueIds.includes(r.stock_id));
    }

    const newData = await _fetchKlineBatch(missingIds);
    const merged = [...cache.data, ...newData];
    _klineCache = { date: today, data: merged };
    return merged.filter((r) => uniqueIds.includes(r.stock_id));
  }

  // Full fetch
  const data = await _fetchKlineBatch(uniqueIds);
  _klineCache = { date: today, data };
  return data;
}

async function _fetchKlineBatch(symbols: string[]): Promise<KLineRow[]> {
  const results: KLineRow[] = [];
  const url = 'https://quotedata.cnfin.com/quote/v1/kline';

  for (const sym of symbols) {
    try {
      const code = String(sym).padStart(6, '0');
      const prodCode = code.startsWith('6') ? `${code}.XSHG` : `${code}.XSHE`;

      const params = new URLSearchParams({
        localDate: String(Date.now()),
        get_type: 'offset',
        prod_code: prodCode,
        candle_period: '6',
        candle_mode: '1',
        data_count: '60',
      });

      const native = await isNative();
      if (native) {
        const bridge = await loadBridge();
        const http = bridge!.CapacitorHttp;
        const resp = await http.request({
          url: `${url}?${params.toString()}`,
          method: 'GET',
        });
        if (resp.status !== 200) continue;
        const js = JSON.parse(resp.data as string);

        const candle = js?.data?.candle;
        if (!candle) continue;

        const fields: string[] = candle.fields;
        const rows: unknown[][] = candle[prodCode];
        if (!rows || !Array.isArray(rows)) continue;

        for (const row of rows) {
          const obj: Record<string, unknown> = {};
          fields.forEach((f: string, i: number) => { obj[f] = row[i]; });
          results.push({
            date: String(obj.min_time || ''),
            close: Number(obj.close_px ?? 0),
            open: Number(obj.open_px ?? 0),
            high: Number(obj.high_px ?? 0),
            low: Number(obj.low_px ?? 0),
            volume: Number(obj.business_amount ?? 0),
            code: prodCode,
            stock_id: code,
          });
        }
      } else {
        const resp = await fetch(`${url}?${params.toString()}`);
        if (!resp.ok) continue;
        const js = await resp.json();

        const candle = js?.data?.candle;
        if (!candle) continue;

        const fields: string[] = candle.fields;
        const rows: unknown[][] = candle[prodCode];
        if (!rows || !Array.isArray(rows)) continue;

        for (const row of rows) {
          const obj: Record<string, unknown> = {};
          fields.forEach((f: string, i: number) => { obj[f] = row[i]; });
          results.push({
            date: String(obj.min_time || ''),
            close: Number(obj.close_px ?? 0),
            open: Number(obj.open_px ?? 0),
            high: Number(obj.high_px ?? 0),
            low: Number(obj.low_px ?? 0),
            volume: Number(obj.business_amount ?? 0),
            code: prodCode,
            stock_id: code,
          });
        }
      }
    } catch {
      // skip failed symbols
    }
  }

  return results;
}

/**
 * Compute 10-day and 60-day momentum for each stock.
 * Mirrors Python compute_stock_momentum_scores.
 */
export function computeMomentum(
  stockIds: string[],
  klineData: KLineRow[],
): Map<string, StockMomentum> {
  const result = new Map<string, StockMomentum>();
  const byStock = new Map<string, KLineRow[]>();

  for (const row of klineData) {
    const list = byStock.get(row.stock_id) || [];
    list.push(row);
    byStock.set(row.stock_id, list);
  }

  for (const sid of stockIds) {
    const rows = byStock.get(String(sid).padStart(6, '0'));
    if (!rows || rows.length === 0) {
      result.set(sid, { stock_id: sid, mom10: null, mom60: null });
      continue;
    }

    rows.sort((a, b) => a.date.localeCompare(b.date));
    const closes = rows.map((r) => r.close).filter((c) => c > 0);

    if (closes.length === 0) {
      result.set(sid, { stock_id: sid, mom10: null, mom60: null });
      continue;
    }

    const c0 = closes[closes.length - 1];
    const c10 = closes.length >= 10 ? closes[closes.length - 10] : closes[0];
    const c60 = closes.length >= 60 ? closes[closes.length - 60] : closes[0];

    result.set(sid, {
      stock_id: sid,
      mom10: c10 !== 0 ? c0 / c10 - 1 : null,
      mom60: c60 !== 0 ? c0 / c60 - 1 : null,
    });
  }

  return result;
}
