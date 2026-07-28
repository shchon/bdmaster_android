/**
 * Pure TypeScript bond screening pipeline.
 * Mirrors the Python backend/core/logic.py scoring and filtering logic.
 */

import { BondData } from '../types';
import type { ScoreConfig } from '../lib/scoreConfig';
import { fetchKlineData, computeMomentum, type KLineRow, type StockMomentum } from './kline';
import { type RawBondItem, type RawRedeemItem } from './jisiluDirect';

// --- Helpers ---

export function safeFloat(val: unknown): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const parsed = parseFloat(val.replace('%', ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Percentile-rank scoring. Returns array of scores (0..1) with same length as values.
 * tied values get average rank. `largerBetter` controls direction.
 */
export function percentileRank(values: (number | null)[], largerBetter: boolean): number[] {
  const n = values.length;
  const result = new Array(n).fill(0);
  const indexed: { idx: number; v: number }[] = [];

  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) indexed.push({ idx: i, v });
  }

  if (indexed.length === 0) return result;

  indexed.sort((a, b) => a.v - b.v);

  const m = indexed.length;
  let i = 0;
  while (i < m) {
    let j = i + 1;
    while (j < m && indexed[j].v === indexed[i].v) j++;
    const rankAvg = (i + 1 + j) / 2;
    const pct = rankAvg / m;
    const s = largerBetter ? pct : 1 - pct;
    for (let k = i; k < j; k++) result[indexed[k].idx] = s;
    i = j;
  }

  return result;
}

// --- Data parsers ---

export function parseRawBondItem(item: Record<string, unknown>): Partial<BondData> {
  const bondValue = safeFloat(item.bond_value);
  const price = safeFloat(item.price);
  const pureBondPremiumRate = bondValue > 0 ? ((price - bondValue) / bondValue) * 100 : 0;

  return {
    id: String(item.bond_id ?? ''),
    code: String(item.bond_id ?? ''),
    name: String(item.bond_nm ?? ''),
    price,
    priceChange: safeFloat(item.increase_rt),
    premiumRate: safeFloat(item.premium_rt),
    stockId: String(item.stock_id ?? ''),
    stockName: String(item.stock_nm ?? ''),
    stockPrice: safeFloat(item.sprice),
    stockChange: safeFloat(item.sincrease_rt),
    listDate: String(item.list_dt ?? ''),
    bondValue,
    pureBondPremiumRate,
    rating: String(item.rating_cd ?? ''),
    forceRedeemPrice: safeFloat(item.force_redeem_price),
    maturityDate: String(item.maturity_dt ?? ''),
    remainingYear: safeFloat(item.year_left),
    currIssAmt: safeFloat(item.curr_iss_amt),
    volume: safeFloat(item.volume ?? item.vol_in_2),
    turnoverRate: safeFloat(item.turnover_rt),
    ytmRt: safeFloat(item.ytm_rt),
    doubleLow: safeFloat(item.dblow),
  };
}

export function parseRawBonds(rawList: RawBondItem[]): BondData[] {
  return rawList.map((row) => {
    const item = (row.cell || row) as Record<string, unknown>;
    return parseRawBondItem(item) as BondData;
  }).filter((b) => b.id);
}

// --- Filtering ---

export interface ScreenConfig {
  max_price: number;
  max_premium_rt: number;
  min_turnover_rt: number;
  year_left: number;
  rating_pattern: string;
  top_n: number;
  min_redeem_days: number;
  max_increase_rt: number;
  exclude_bond_ids: string[];
  factor_weights: Record<string, number>;
}

export function filterBonds(
  bonds: BondData[],
  config: ScreenConfig,
): BondData[] {
  return bonds.filter((b) => {
    if (b.remainingYear <= config.year_left) return false;
    if ((b.turnoverRate ?? 0) <= config.min_turnover_rt) return false;
    if (b.price > config.max_price) return false;
    if (b.premiumRate > config.max_premium_rt) return false;
    if (!(b.rating || '').includes(config.rating_pattern)) return false;
    if ((b.stockName || '').toLowerCase().includes('st')) return false;

    // Redeem filter
    const days = b.redeemOngoingDays;
    if (days != null && config.min_redeem_days > 0) {
      if (days > config.min_redeem_days) return false;
      if (
        days === config.min_redeem_days &&
        b.forceRedeemPrice &&
        b.forceRedeemPrice > 0 &&
        b.stockPrice > b.forceRedeemPrice
      ) return false;
    }

    // Increase rate filter
    if (config.max_increase_rt > 0 && b.priceChange > config.max_increase_rt) return false;

    // Exclusions
    if (config.exclude_bond_ids.includes(b.id)) return false;

    return true;
  });
}

// --- Scoring ---

export function computeScores(bonds: BondData[], factorWeights: Record<string, number>, momentumMap?: Map<string, StockMomentum>): void {
  const n = bonds.length;

  // Bond-side factors
  const pureBondOrValues = bonds.map((b) => {
    if (b.bondValue && b.bondValue > 0) return b.price / b.bondValue - 1;
    return null;
  });

  const w_ytm = factorWeights.ytm_rt ?? 1;
  const w_premium = factorWeights.premium_rt ?? 1;
  const w_bond_ytm = factorWeights.bond_ytm ?? 1;
  const w_curr_amt = factorWeights.curr_iss_amt ?? 1;
  const w_mom = factorWeights.stock_mom ?? 1;
  const w_turnover = factorWeights.turnover_rt ?? 1;
  const w_price = factorWeights.price ?? 1;

  const sYtm = percentileRank(bonds.map((b) => b.ytmRt ?? null), true);
  const sPrem = percentileRank(bonds.map((b) => b.premiumRate), false);
  const sTurnover = percentileRank(bonds.map((b) => b.turnoverRate ?? null), true);
  const sBondYtm = percentileRank(pureBondOrValues, false);
  const sAmt = percentileRank(bonds.map((b) => b.currIssAmt ?? null), false);
  const sPrice = percentileRank(bonds.map((b) => b.price), false);

  // Stock momentum scores (require K-line data)
  let sMomScores: number[] = new Array(n).fill(0.5);
  if (momentumMap && momentumMap.size > 0) {
    const mom10s = bonds.map((b) => {
      const m = momentumMap.get(b.stockId || '');
      return m?.mom10 ?? null;
    });
    const mom60s = bonds.map((b) => {
      const m = momentumMap.get(b.stockId || '');
      return m?.mom60 ?? null;
    });
    const sMom10 = percentileRank(mom10s, true);
    const sMom60 = percentileRank(mom60s, true);
    sMomScores = sMom10.map((v, i) => v * 0.5 + sMom60[i] * 0.5);
  }

  for (let i = 0; i < n; i++) {
    bonds[i].sYtm = sYtm[i];
    bonds[i].sPrem = sPrem[i];
    bonds[i].sAmt = sAmt[i];
    bonds[i].sPureOr = sBondYtm[i];

    bonds[i].totalScore =
      sYtm[i] * w_ytm +
      sPrem[i] * w_premium +
      sBondYtm[i] * w_bond_ytm +
      sAmt[i] * w_curr_amt +
      sMomScores[i] * w_mom +
      sTurnover[i] * w_turnover +
      sPrice[i] * w_price;
  }
}

// --- Trade suggestions ---

export interface TradeTable {
  bond_id: string;
  bond_nm: string;
  price: number;
  increase_rt: number;
  action: string;
}

export function computeTradeSuggestions(
  allBonds: BondData[],
  selectedBonds: BondData[],
  holdIds: string[],
): { sell: TradeTable[]; buy: TradeTable[] } {
  const holdSet = new Set(holdIds);
  const top20 = selectedBonds.slice(0, 20);
  const top20Ids = new Set(top20.map((b) => b.id));

  const toSellIds = new Set([...holdSet].filter((id) => !top20Ids.has(id)));
  const toBuyIds = new Set([...top20Ids].filter((id) => !holdSet.has(id)));

  const bondMap = new Map(allBonds.map((b) => [b.id, b]));

  const sell: TradeTable[] = [];
  for (const id of toSellIds) {
    const b = bondMap.get(id);
    if (b) sell.push({ bond_id: b.id, bond_nm: b.name, price: b.price, increase_rt: b.priceChange, action: '卖出' });
  }

  const buy: TradeTable[] = [];
  for (const id of toBuyIds) {
    const b = bondMap.get(id);
    if (b) buy.push({ bond_id: b.id, bond_nm: b.name, price: b.price, increase_rt: b.priceChange, action: '买入' });
  }

  return { sell, buy };
}

// --- Full pipeline ---

export interface ScreenPipelineResult {
  summary: {
    total_bonds: number;
    selected_count: number;
    config_used: Record<string, unknown>;
    kline_fetch_mode: string;
  };
  result: BondData[];
  sell: TradeTable[];
  buy: TradeTable[];
  allBonds: BondData[];
}

export async function runLocalPipeline(
  rawBonds: BondData[],
  redeemMap: Map<string, RawRedeemItem>,
  overrides: Partial<ScreenConfig>,
  holdIds: string[],
  scoreConfig: ScoreConfig,
  klineMode: 'full' | 'cache' | 'skip' = 'cache',
): Promise<ScreenPipelineResult> {
  // 1. Merge redeem info into bonds
  for (const b of rawBonds) {
    const r = redeemMap.get(b.id);
    if (r) {
      b.redeemStatus = r.redeem_status;
      b.redeemIcon = r.redeem_icon;
      if (r.redeem_remain_days != null) {
        b.redeemOngoingDays = 15 - (r.redeem_remain_days === -1 ? 15 : r.redeem_remain_days);
      }
    }
  }

  // 2. Build config
  const config: ScreenConfig = {
    max_price: overrides.max_price ?? 500,
    max_premium_rt: overrides.max_premium_rt ?? 25,
    min_turnover_rt: overrides.min_turnover_rt ?? 1,
    year_left: overrides.year_left ?? 0.5,
    rating_pattern: overrides.rating_pattern ?? 'A',
    top_n: overrides.top_n ?? 70,
    min_redeem_days: overrides.min_redeem_days ?? 0,
    max_increase_rt: overrides.max_increase_rt ?? 96,
    exclude_bond_ids: overrides.exclude_bond_ids ?? [],
    factor_weights: {
      ytm_rt: scoreConfig.factors.ytmRt.enabled ? scoreConfig.factors.ytmRt.weight : 0,
      premium_rt: scoreConfig.factors.premiumRate.enabled ? scoreConfig.factors.premiumRate.weight : 0,
      bond_ytm: scoreConfig.factors.pureBondPremiumRate.enabled ? scoreConfig.factors.pureBondPremiumRate.weight : 0,
      curr_iss_amt: scoreConfig.factors.currIssAmt.enabled ? scoreConfig.factors.currIssAmt.weight : 0,
      stock_mom: scoreConfig.factors.stockMom.enabled ? scoreConfig.factors.stockMom.weight : 0,
      turnover_rt: scoreConfig.factors.turnoverRt.enabled ? scoreConfig.factors.turnoverRt.weight : 0,
      price: scoreConfig.factors.price.enabled ? scoreConfig.factors.price.weight : 0,
    },
  };

  // 3. Filter
  const filtered = filterBonds(rawBonds, config);

  // 4. Fetch K-line for momentum (if factor is enabled)
  let momentumMap: Map<string, StockMomentum> | undefined;
  let klineFetchMode = 'cache_only';
  if (config.factor_weights.stock_mom > 0) {
    const stockIds = filtered.map((b) => b.stockId).filter(Boolean) as string[];
    if (stockIds.length > 0 && klineMode !== 'skip') {
      try {
        const klineData = await fetchKlineData(stockIds);
        klineFetchMode = 'fetched';
        momentumMap = computeMomentum(stockIds, klineData);
      } catch {
        klineFetchMode = 'failed';
      }
    }
  }

  // 5. Score
  computeScores(filtered, config.factor_weights, momentumMap);

  // 6. Sort and top-N
  filtered.sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0));
  const selected = filtered.slice(0, config.top_n);

  // 7. Set satisfy_redeem
  for (const b of selected) {
    if (b.forceRedeemPrice && b.forceRedeemPrice > 0) {
      const ratio = b.stockPrice / b.forceRedeemPrice;
      (b as BondData & { satisfyRedeem?: number }).satisfyRedeem = ratio >= 1 ? ratio : undefined;
    }
  }

  // 8. Exclusions
  const excluded = selected.filter((b) => !config.exclude_bond_ids.includes(b.id));

  // 9. Trade suggestions
  const { sell, buy } = computeTradeSuggestions(rawBonds, excluded, holdIds);

  return {
    summary: {
      total_bonds: rawBonds.length,
      selected_count: excluded.length,
      config_used: { ...config },
      kline_fetch_mode: klineFetchMode,
    },
    result: excluded,
    sell,
    buy,
    allBonds: rawBonds,
  };
}
