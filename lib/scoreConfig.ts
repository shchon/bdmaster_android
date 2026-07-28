export type ScoreFactorKey =
  | 'ytmRt'
  | 'premiumRate'
  | 'currIssAmt'
  | 'pureBondPremiumRate'
  | 'turnoverRt'
  | 'price'
  | 'stockMom';

export type ScoreFactorConfig = {
  enabled: boolean;
  weight: number;
  largerBetter: boolean;
};

export type ScoreConfig = {
  version: 1;
  factors: Record<ScoreFactorKey, ScoreFactorConfig>;
};

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  version: 1,
  factors: {
    ytmRt: { enabled: true, weight: 1, largerBetter: true },
    premiumRate: { enabled: true, weight: 1, largerBetter: false },
    currIssAmt: { enabled: true, weight: 1, largerBetter: false },
    pureBondPremiumRate: { enabled: true, weight: 1, largerBetter: false },
    turnoverRt: { enabled: true, weight: 1, largerBetter: true },
    price: { enabled: true, weight: 1, largerBetter: false },
    stockMom: { enabled: true, weight: 1, largerBetter: true },
  },
};

const SCORE_CONFIG_COOKIE = 'bm_score_config';

export const getScoreConfigCookieName = () => SCORE_CONFIG_COOKIE;

export const normalizeScoreConfig = (input: unknown): ScoreConfig => {
  const out: ScoreConfig = JSON.parse(JSON.stringify(DEFAULT_SCORE_CONFIG));

  if (!input || typeof input !== 'object') return out;

  const anyInput = input as any;
  const factors = anyInput.factors;
  if (!factors || typeof factors !== 'object') return out;

  (Object.keys(out.factors) as ScoreFactorKey[]).forEach((k) => {
    const f = factors[k];
    if (!f || typeof f !== 'object') return;

    if (typeof f.enabled === 'boolean') out.factors[k].enabled = f.enabled;

    const w = Number(f.weight);
    if (Number.isFinite(w)) out.factors[k].weight = w;

    if (typeof f.largerBetter === 'boolean') out.factors[k].largerBetter = f.largerBetter;
  });

  return out;
};

export const encodeScoreConfigToCookieValue = (config: ScoreConfig) => {
  return encodeURIComponent(JSON.stringify(config));
};

export const decodeScoreConfigFromCookieValue = (val: string | undefined | null): ScoreConfig | null => {
  if (!val) return null;
  try {
    const decoded = decodeURIComponent(val);
    const parsed = JSON.parse(decoded);
    return normalizeScoreConfig(parsed);
  } catch {
    return null;
  }
};
