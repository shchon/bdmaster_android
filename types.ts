export interface BondData {
  id: string;
  code: string;
  name: string;
  price: number;
  priceChange: number; // Percentage
  premiumRate: number; // Percentage
  stockId?: string;
  stockName?: string;
  stockPrice: number;
  stockChange: number;
  listDate?: string;
  bondValue?: number;
  pureBondPremiumRate?: number;
  redeemStatus?: string;
  redeemIcon?: string;
  redeemOngoingDays?: number | null;
  rating: string;
  forceRedeemPrice?: number;
  maturityDate?: string;
  remainingYear: number;
  currIssAmt?: number;
  volume: number; // in 10k
  turnoverRate?: number;
  ytmRt?: number;
  sYtm?: number;
  sPrem?: number;
  sAmt?: number;
  sPureOr?: number;
  totalScore?: number;
  doubleLow: number; // Price + Premium Rate * 100
  satisfyRedeem?: string | number; // 满足强赎
}

export enum SignalType {
  BUY = 'BUY',
  SELL = 'SELL',
  HOLD = 'HOLD'
}

export interface AnalysisResult {
  bondId: string;
  content: string;
  loading: boolean;
}

export interface FilterConfig {
  maxPrice: number;
  maxPremium: number;
  minRating: string; // 'AAA', 'AA+', 'AA', 'A+'
}

export interface ScreenFactorWeights {
  ytm_rt?: number;
  premium_rt?: number;
  bond_ytm?: number;
  curr_iss_amt?: number;
  stock_mom?: number;
  turnover_rt?: number;
  price?: number;
}

export interface ScreenRequest {
  max_price?: number;
  max_premium_rt?: number;
  min_turnover_rt?: number;
  year_left?: number;
  rating_pattern?: string;
  top_n?: number;
  min_redeem_days?: number;
  max_increase_rt?: number;
  exclude_bond_ids?: string[];
  factor_weights?: ScreenFactorWeights;
  hold_ids?: string[];
  jisilu_cookie?: string;
}

export interface ScreenSummary {
  total_bonds: number;
  selected_count: number;
  config_used: Record<string, unknown>;
  kline_fetch_mode?: string;
}

export interface ScreenResult {
  summary: ScreenSummary;
  result: Array<{
    bond_id: string;
    bond_nm: string;
    price: number;
    increase_rt: number;
    bond_value: number;
    premium_rt: number;
    bond_ytm?: number | null;
    ytm_rt?: number | null;
    stock_last_px?: number | null;
    total_score: number;
    满足强赎?: string | number | null;
    redeem_status?: string | null;
    redeem_icon?: string | null;
    redeem_ongoing_days?: number | null;
    rating_cd?: string | null;
    year_left?: number | null;
    turnover_rt?: number | null;
    curr_iss_amt?: number | null;
    force_redeem_price?: number | null;
  }>;
  sell: Array<{
    bond_id: string;
    bond_nm: string;
    price: number;
    increase_rt: number;
    action: string;
  }>;
  buy: Array<{
    bond_id: string;
    bond_nm: string;
    price: number;
    increase_rt: number;
    action: string;
  }>;
}
