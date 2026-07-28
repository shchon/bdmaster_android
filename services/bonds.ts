import { BondData, ScreenRequest, ScreenResult } from '../types';
import { apiPost } from './http';
import { isNative, jisiluFetchRedeem } from './jisiluDirect';
import { runLocalPipeline } from './pipeline';
import { clearKlineCache } from './kline';
import { getJisiluCookie } from './jisiluService';
import { DEFAULT_SCORE_CONFIG, type ScoreConfig } from '../lib/scoreConfig';

export interface ScreenBondsResponse {
  bonds: BondData[];
  summary: ScreenResult['summary'];
  raw: ScreenResult;
}

export const screenBonds = async (
  payload: ScreenRequest,
  allBonds?: BondData[],
  scoreConfig?: ScoreConfig,
): Promise<ScreenBondsResponse> => {
  if (await isNative() && allBonds) {
    // Local pipeline on mobile
    const cookie = getJisiluCookie();

    // Refresh redeem info if we have a cookie
    let redeemMap = new Map<string, { bond_id: string; redeem_remain_days?: number; redeem_status?: string; redeem_icon?: string }>();
    if (cookie) {
      try {
        const items = await jisiluFetchRedeem(cookie);
        redeemMap = new Map(items.map((r) => [r.bond_id, r]));
      } catch { /* best effort */ }
    }

    const result = await runLocalPipeline(
      allBonds,
      redeemMap,
      {
        max_price: payload.max_price,
        max_premium_rt: payload.max_premium_rt,
        min_turnover_rt: payload.min_turnover_rt,
        year_left: payload.year_left,
        rating_pattern: payload.rating_pattern,
        top_n: payload.top_n,
        min_redeem_days: payload.min_redeem_days,
        max_increase_rt: payload.max_increase_rt,
        exclude_bond_ids: payload.exclude_bond_ids,
        factor_weights: payload.factor_weights as Record<string, number> | undefined,
      },
      payload.hold_ids || [],
      scoreConfig || DEFAULT_SCORE_CONFIG,
    );

    const raw: ScreenResult = {
      summary: {
        total_bonds: result.summary.total_bonds,
        selected_count: result.summary.selected_count,
        config_used: result.summary.config_used,
        kline_fetch_mode: result.summary.kline_fetch_mode,
      },
      result: result.result.map((b) => ({
        bond_id: b.id,
        bond_nm: b.name,
        price: b.price,
        increase_rt: b.priceChange,
        bond_value: b.bondValue || 0,
        premium_rt: b.premiumRate,
        ytm_rt: b.ytmRt ?? null,
        stock_last_px: b.stockPrice,
        total_score: b.totalScore || 0,
        year_left: b.remainingYear,
        turnover_rt: b.turnoverRate,
        rating_cd: b.rating,
        curr_iss_amt: b.currIssAmt,
        redeem_icon: b.redeemIcon,
        '满足强赎': (b as BondData & { satisfyRedeem?: number }).satisfyRedeem ?? null,
        redeem_status: b.redeemStatus,
        redeem_ongoing_days: b.redeemOngoingDays ?? null,
        force_redeem_price: b.forceRedeemPrice,
      })),
      sell: result.sell.map((t) => ({ bond_id: t.bond_id, bond_nm: t.bond_nm, price: t.price, increase_rt: t.increase_rt, action: t.action })),
      buy: result.buy.map((t) => ({ bond_id: t.bond_id, bond_nm: t.bond_nm, price: t.price, increase_rt: t.increase_rt, action: t.action })),
    };

    return { bonds: result.result, summary: result.summary, raw };
  }

  // Web: use backend proxy
  const resp = await apiPost('/bonds/screen', payload ?? {});

  let json: any = null;
  try { json = await resp.json(); } catch { /* ignore */ }

  if (!resp.ok) {
    const message = (json && typeof json === 'object' && typeof json.message === 'string')
      ? json.message : '选股接口调用失败';
    throw new Error(message);
  }

  const data = json as ScreenResult;
  const bonds: BondData[] = data.result.map((item) => {
    const bondId = String(item.bond_id);
    const price = typeof item.price === 'number' ? item.price : 0;
    const premium = typeof item.premium_rt === 'number' ? item.premium_rt : 0;
    const bondValue = typeof item.bond_value === 'number' ? item.bond_value : undefined;
    const ytmRt = typeof item.ytm_rt === 'number' ? item.ytm_rt : undefined;
    const stockLastPx = typeof item.stock_last_px === 'number' ? item.stock_last_px : Number.NaN;
    const yearLeft = typeof item.year_left === 'number' ? item.year_left : 0;
    const turnover = typeof item.turnover_rt === 'number' ? item.turnover_rt : undefined;
    const currIssAmt = typeof item.curr_iss_amt === 'number' ? item.curr_iss_amt : undefined;
    const rating = (item.rating_cd ?? '') as string;

    const pureBondPremiumRate = typeof item.price === 'number' && typeof item.bond_value === 'number' && item.bond_value > 0
      ? (item.price / item.bond_value - 1) * 100 : undefined;

    return {
      id: bondId, code: bondId, name: item.bond_nm, price,
      priceChange: typeof item.increase_rt === 'number' ? item.increase_rt : 0,
      premiumRate: premium, stockPrice: stockLastPx, stockChange: 0,
      listDate: undefined, bondValue, pureBondPremiumRate,
      redeemStatus: (item.redeem_status ?? undefined) as string | undefined,
      redeemIcon: (item.redeem_icon ?? undefined) as string | undefined,
      redeemOngoingDays: typeof item.redeem_ongoing_days === 'number' ? item.redeem_ongoing_days : undefined as number | null | undefined,
      satisfyRedeem: (item['满足强赎'] ?? undefined) as string | number | undefined,
      rating, forceRedeemPrice: typeof item.force_redeem_price === 'number' ? item.force_redeem_price : undefined,
      maturityDate: undefined, remainingYear: yearLeft, currIssAmt, volume: 0,
      turnoverRate: turnover, ytmRt, sYtm: undefined, sPrem: undefined, sAmt: undefined, sPureOr: undefined,
      totalScore: typeof item.total_score === 'number' ? item.total_score : undefined,
      doubleLow: price + premium,
    };
  });

  return { bonds, summary: data.summary, raw: data };
};

export const saveSnapshot = async (jisiluCookie?: string): Promise<{ filepath: string; bond_count: number }> => {
  if (await isNative()) {
    throw new Error('快照功能需要后端服务支持');
  }

  const resp = await apiPost('/bonds/snapshot/save', { jisilu_cookie: jisiluCookie || undefined });
  if (!resp.ok) {
    const data = await resp.json().catch(() => null);
    throw new Error(data?.detail?.message || data?.message || '保存快照失败');
  }
  return resp.json();
};

export const clearCache = async (): Promise<{ status: string; message: string }> => {
  if (await isNative()) {
    clearKlineCache();
    return { status: 'ok', message: '本地缓存已清除' };
  }

  const resp = await apiPost('/bonds/cache/clear');
  if (!resp.ok) throw new Error('清除缓存失败');
  return resp.json();
};
