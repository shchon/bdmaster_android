import { BondData } from '../types';
import type { ScoreConfig } from '../lib/scoreConfig';
import { apiPost } from './http';
import { jisiluLoginNative, jisiluFetchBonds, jisiluFetchRedeem, isNative } from './jisiluDirect';
import { parseRawBonds, computeScores } from './pipeline';

interface LoginParams {
  user_name: string;
  password: string;
}

let currentCookie: string | null = null;

const COOKIE_STORAGE_KEY = 'jisilu_cookie';

export const restoreJisiluCookie = () => {
  if (typeof window === 'undefined') return;
  const saved = localStorage.getItem(COOKIE_STORAGE_KEY);
  if (saved) currentCookie = saved;
};

export const loginJisilu = async ({ user_name, password }: LoginParams): Promise<boolean> => {
  if (isNative()) {
    const session = await jisiluLoginNative(user_name, password);
    currentCookie = session.cookie;
    if (typeof window !== 'undefined') {
      localStorage.setItem(COOKIE_STORAGE_KEY, currentCookie);
    }
    return true;
  }

  const resp = await apiPost('/jisilu/login', { user_name, password });
  const data = await resp.json();

  if (!resp.ok || !data?.success) {
    throw new Error(data?.message || '集思录登录失败');
  }

  currentCookie = data.cookie as string;
  if (typeof window !== 'undefined') {
    localStorage.setItem(COOKIE_STORAGE_KEY, currentCookie);
  }
  return true;
};

export const logoutJisilu = () => {
  currentCookie = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem(COOKIE_STORAGE_KEY);
  }
};

export const getJisiluCookie = (): string | null => {
  return currentCookie;
};

export const fetchJisiluData = async (scoreConfig?: ScoreConfig): Promise<BondData[]> => {
  if (!currentCookie) {
    throw new Error('尚未登录集思录');
  }

  if (isNative()) {
    // Direct to jisilu.cn
    const rawBonds = await jisiluFetchBonds(currentCookie);
    const bonds = parseRawBonds(rawBonds);

    // Merge redeem info
    try {
      const redeemItems = await jisiluFetchRedeem(currentCookie);
      const redeemMap = new Map(redeemItems.map((r) => [r.bond_id, r]));
      for (const b of bonds) {
        const r = redeemMap.get(b.id);
        if (r) {
          b.redeemStatus = r.redeem_status;
          b.redeemIcon = r.redeem_icon;
          if (r.redeem_remain_days != null) {
            const normalized = r.redeem_remain_days === -1 ? 15 : r.redeem_remain_days;
            b.redeemOngoingDays = 15 - normalized;
          }
        }
      }
    } catch { /* redeem info is best-effort */ }

    // Apply scoring if config provided
    if (scoreConfig) {
      const fw = scoreConfig.factors;
      computeScores(bonds, {
        ytm_rt: fw.ytmRt.enabled ? fw.ytmRt.weight : 0,
        premium_rt: fw.premiumRate.enabled ? fw.premiumRate.weight : 0,
        bond_ytm: fw.pureBondPremiumRate.enabled ? fw.pureBondPremiumRate.weight : 0,
        curr_iss_amt: fw.currIssAmt.enabled ? fw.currIssAmt.weight : 0,
        stock_mom: 0,
        turnover_rt: fw.turnoverRt.enabled ? fw.turnoverRt.weight : 0,
        price: fw.price.enabled ? fw.price.weight : 0,
      });
    }

    console.log('[BondMaster] fetchJisiluData: parsed', bonds.length, 'bonds');
    bonds.sort((a, b) => a.doubleLow - b.doubleLow);
    return bonds;
  }

  // Web: use backend proxy
  const resp = await apiPost('/jisilu/bonds', { cookie: currentCookie, scoreConfig });
  const data = await resp.json();

  if (!resp.ok || !data?.success) {
    throw new Error(data?.message || '获取集思录数据失败');
  }

  return data.bonds as BondData[];
};
