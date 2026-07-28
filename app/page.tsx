"use client";
import { useState, useEffect, useMemo } from 'react';
import { Activity, RefreshCw, LogOut, Briefcase, ListFilter, Sparkles, ArrowDownCircle, ArrowUpCircle, FileText, SlidersHorizontal } from 'lucide-react';
import { BondData, type ScreenRequest, type ScreenSummary } from '../types';
import { fetchJisiluData, getJisiluCookie, loginJisilu, logoutJisilu, restoreJisiluCookie } from '../services/jisiluService';
import { clearCache, saveSnapshot, screenBonds } from '../services/bonds';
import { apiPost } from '../services/http';
import BondTable from '../components/BondTable';
import LoginModal from '../components/LoginModal';
import ScoreConfigModal from '../components/ScoreConfigModal';
import { DEFAULT_SCORE_CONFIG, normalizeScoreConfig, type ScoreConfig } from '../lib/scoreConfig';

type TradeLogItem = {
  ts: string;
  targetCount: number;
  buy: Array<{ id: string; code: string; name: string }>;
  sell: Array<{ id: string; code: string; name: string }>;
};

const App: React.FC = () => {
  const [bonds, setBonds] = useState<BondData[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [marketTopN, setMarketTopN] = useState<10 | 20 | 30 | 'ALL'>(30);

  const [holdingTargetCount, setHoldingTargetCount] = useState<number>(10);

  const [tradeLogs, setTradeLogs] = useState<TradeLogItem[]>([]);

  const [isTradeLogOpen, setIsTradeLogOpen] = useState(false);
  const [isScoreConfigOpen, setIsScoreConfigOpen] = useState(false);
  const [isWebdavOpen, setIsWebdavOpen] = useState(false);
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);

  // 全量行情快照，供“持仓监控”三块使用，不受后端 TopN 影响
  const [allBonds, setAllBonds] = useState<BondData[]>([]);

  // 最近一次后端选股返回的 summary（包含 config_used）
  const [backendSummary, setBackendSummary] = useState<ScreenSummary | null>(null);

  const [scoreConfig, setScoreConfig] = useState<ScoreConfig>(DEFAULT_SCORE_CONFIG);

  const [marketFilters, setMarketFilters] = useState<{
    keyword: string;
    maxPrice: number | null;
    maxPremium: number | null;
    minRemainingYear: number | null;
    minTurnoverRate: number | null;
    minIncreaseRate: number | null;
    minRedeemDays: number | null;
    excludeBRating: boolean;
    excludeNewBond: boolean;
  }>({
    keyword: '',
    maxPrice: null,
    maxPremium: null,
    minRemainingYear: null,
    minTurnoverRate: null,
    minIncreaseRate: null,
    minRedeemDays: null,
    excludeBRating: false,
    excludeNewBond: false,
  });
  
  // Holdings State (Persisted in localStorage)
  const [holdingIds, setHoldingIds] = useState<Set<string>>(new Set());

  const [buyIds, setBuyIds] = useState<Set<string>>(new Set());

  const [sellIds, setSellIds] = useState<Set<string>>(new Set());

  const [blacklistIds, setBlacklistIds] = useState<Set<string>>(new Set());
  const [isBlacklistOpen, setIsBlacklistOpen] = useState(false);

  const BLACKLIST_KEY = 'bond_blacklist';

  const loadData = async (overrideScoreConfig?: ScoreConfig) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const effectiveScoreConfig = overrideScoreConfig ?? scoreConfig;
      const data = await fetchJisiluData(effectiveScoreConfig);
      // 更新全量行情快照和当前候选池
      setAllBonds(data);
      setBonds(data);
      setLastUpdated(new Date());
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem('last_bonds', JSON.stringify(data));
        } catch {
          // ignore
        }
      }
    } catch (error: any) {
      console.error("Failed to load market data", error);
      const msg = error?.message || "数据加载失败";
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleAddToBlacklist = (id: string) => {
    setBlacklistIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const handleRemoveFromBlacklist = (id: string) => {
    setBlacklistIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleBackendScreen = async () => {
    setLoading(true);
    setErrorMsg(null);

    try {
      const req: ScreenRequest = {};

      req.factor_weights = {
        ytm_rt: scoreConfig.factors.ytmRt.enabled ? scoreConfig.factors.ytmRt.weight : 0,
        premium_rt: scoreConfig.factors.premiumRate.enabled ? scoreConfig.factors.premiumRate.weight : 0,
        curr_iss_amt: scoreConfig.factors.currIssAmt.enabled ? scoreConfig.factors.currIssAmt.weight : 0,
        bond_ytm: scoreConfig.factors.pureBondPremiumRate.enabled
          ? scoreConfig.factors.pureBondPremiumRate.weight
          : 0,
        stock_mom: scoreConfig.factors.stockMom.enabled ? scoreConfig.factors.stockMom.weight : 0,
        turnover_rt: scoreConfig.factors.turnoverRt.enabled ? scoreConfig.factors.turnoverRt.weight : 0,
        price: scoreConfig.factors.price.enabled ? scoreConfig.factors.price.weight : 0,
      };

      if (marketFilters.maxPrice !== null) {
        req.max_price = marketFilters.maxPrice;
      }
      if (marketFilters.maxPremium !== null) {
        req.max_premium_rt = marketFilters.maxPremium;
      }
      if (marketFilters.minTurnoverRate !== null) {
        req.min_turnover_rt = marketFilters.minTurnoverRate;
      }
      if (marketFilters.minRemainingYear !== null) {
        req.year_left = marketFilters.minRemainingYear;
      }
      if (marketFilters.minRedeemDays !== null) {
        req.min_redeem_days = marketFilters.minRedeemDays;
      }
      if (marketFilters.minIncreaseRate !== null) {
        req.max_increase_rt = marketFilters.minIncreaseRate;
      }

      // if (marketTopN !== 'ALL') {
      //   req.top_n = marketTopN;
      // }

      if (marketFilters.excludeBRating) {
        req.rating_pattern = 'A';
      }

      if (holdingIds.size > 0) {
        req.hold_ids = Array.from(holdingIds);
      }

      const cookie = getJisiluCookie();
      if (cookie) {
        req.jisilu_cookie = cookie;
      }

      const { bonds: screenedBonds, summary } = await screenBonds(req, allBonds, scoreConfig);

      setBonds(screenedBonds);
      setBackendSummary(summary);
      setLastUpdated(new Date());
    } catch (error: any) {
      console.error('Backend screening failed', error);
      const msg = error?.message || '后端选股失败';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSnapshot = async () => {
    setSavingSnapshot(true);
    setSnapshotMsg(null);
    try {
      const cookie = getJisiluCookie();
      const result = await saveSnapshot(cookie ?? undefined);
      setSnapshotMsg(`快照已保存: ${result.bond_count} 只可转债`);
    } catch (error: any) {
      console.error('Save snapshot failed', error);
      setSnapshotMsg(`保存失败: ${error?.message || '未知错误'}`);
    } finally {
      setSavingSnapshot(false);
    }
  };

  const handleClearCache = async () => {
    try {
      await clearCache();
      setErrorMsg(null);
      // Optionally re-run screening immediately to show fresh data
      await handleBackendScreen();
    } catch (error: any) {
      console.error('Clear cache failed', error);
      setErrorMsg(error?.message || '清除缓存失败');
    }
  };

  useEffect(() => {
    restoreJisiluCookie();
    const savedUser = localStorage.getItem('jisilu_user');
    if (savedUser) {
      setUser(savedUser);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const safeParse = (s: string | null) => {
      if (!s) return null;
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };

    const savedTopN = localStorage.getItem('market_top_n');
    if (savedTopN === 'ALL') {
      setMarketTopN('ALL');
    } else {
      const n = savedTopN ? Number(savedTopN) : NaN;
      if (n === 10 || n === 20 || n === 30) setMarketTopN(n);
    }

    const savedHoldingTarget = localStorage.getItem('holding_target_count');
    const ht = savedHoldingTarget ? Number(savedHoldingTarget) : NaN;
    if (Number.isFinite(ht) && ht > 0) setHoldingTargetCount(Math.floor(ht));

    const savedFilters = safeParse(localStorage.getItem('market_filters'));
    if (savedFilters && typeof savedFilters === 'object') {
      setMarketFilters((p) => ({ ...p, ...savedFilters }));
    }

    const savedHoldings = safeParse(localStorage.getItem('my_bond_holdings'));
    if (Array.isArray(savedHoldings)) setHoldingIds(new Set(savedHoldings));

    const savedBuy = safeParse(localStorage.getItem('my_bond_buy'));
    if (Array.isArray(savedBuy)) setBuyIds(new Set(savedBuy));

    const savedSell = safeParse(localStorage.getItem('my_bond_sell'));
    if (Array.isArray(savedSell)) setSellIds(new Set(savedSell));

    const savedBlacklist = safeParse(localStorage.getItem(BLACKLIST_KEY));
    if (Array.isArray(savedBlacklist)) setBlacklistIds(new Set(savedBlacklist));

    const savedLogs = safeParse(localStorage.getItem('trade_logs'));
    if (Array.isArray(savedLogs)) setTradeLogs(savedLogs);

    const savedScoreConfig = safeParse(localStorage.getItem('score_config'));
    if (savedScoreConfig && typeof savedScoreConfig === 'object') {
      setScoreConfig(normalizeScoreConfig(savedScoreConfig));
    }

    const savedBonds = safeParse(localStorage.getItem('last_bonds'));
    if (Array.isArray(savedBonds)) {
      setBonds(savedBonds as BondData[]);
    }

    setStorageLoaded(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    loadData();
    // Manual refresh only
  }, [user]);

  useEffect(() => {
    if (!user) setIsScoreConfigOpen(false);
  }, [user]);

  // Save holdings when changed
  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('my_bond_holdings', JSON.stringify(Array.from(holdingIds)));
  }, [holdingIds]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('my_bond_buy', JSON.stringify(Array.from(buyIds)));
  }, [buyIds]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('my_bond_sell', JSON.stringify(Array.from(sellIds)));
  }, [sellIds]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem(BLACKLIST_KEY, JSON.stringify(Array.from(blacklistIds)));
  }, [blacklistIds]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('market_filters', JSON.stringify(marketFilters));
  }, [marketFilters]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('market_top_n', String(marketTopN));
  }, [marketTopN]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('holding_target_count', String(holdingTargetCount));
  }, [holdingTargetCount]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('trade_logs', JSON.stringify(tradeLogs));
  }, [tradeLogs]);

  useEffect(() => {
    if (!storageLoaded) return;
    localStorage.setItem('score_config', JSON.stringify(scoreConfig));
  }, [scoreConfig]);

  const handleSaveScoreConfig = async (cfg: ScoreConfig) => {
    setScoreConfig(cfg);
    setIsScoreConfigOpen(false);
  };

  const handleLogin = async (user_name: string, password: string) => {
    await loginJisilu({ user_name, password });
    setUser(user_name);
    if (typeof window !== 'undefined') {
      localStorage.setItem('jisilu_user', user_name);
    }
    setIsLoginOpen(false);
    setTimeout(loadData, 100);
  };

  const handleLogout = () => {
    logoutJisilu();
    setUser(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('jisilu_user');
    }
  };

  const handleToggleHolding = (id: string) => {
    setHoldingIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

    setBuyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

    setSellIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleToggleBuy = (id: string) => {
    setBuyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

    setSellIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleToggleSell = (id: string) => {
    setSellIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

    setHoldingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    setBuyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const sortByTotalScoreDesc = (list: BondData[]) => {
    return [...list].sort((a, b) => {
      const at = a.totalScore;
      const bt = b.totalScore;
      const aHas = typeof at === 'number' && Number.isFinite(at);
      const bHas = typeof bt === 'number' && Number.isFinite(bt);
      if (aHas && bHas) return bt - at;
      if (aHas) return -1;
      if (bHas) return 1;
      return a.doubleLow - b.doubleLow;
    });
  };

  const myHoldingsData = useMemo(() => {
    return allBonds.filter((b) => holdingIds.has(b.id));
  }, [allBonds, holdingIds]);

  const myToBuyData = useMemo(() => {
    return allBonds.filter((b) => buyIds.has(b.id));
  }, [allBonds, buyIds]);

  const myToSellData = useMemo(() => {
    return allBonds.filter((b) => sellIds.has(b.id));
  }, [allBonds, sellIds]);

  const holdingsOverallChange = useMemo(() => {
    if (myHoldingsData.length === 0) return null;
    const sum = myHoldingsData.reduce((acc, b) => acc + (typeof b.priceChange === 'number' ? b.priceChange : 0), 0);
    return sum / myHoldingsData.length;
  }, [myHoldingsData]);

  const myToSellSorted = useMemo(() => sortByTotalScoreDesc(myToSellData), [myToSellData]);
  const myToBuySorted = useMemo(() => sortByTotalScoreDesc(myToBuyData), [myToBuyData]);

  const marketRankedData = useMemo(() => {
    const keyword = marketFilters.keyword.trim();

    const getRedeemDays = (b: { redeemOngoingDays?: number | null }) => {
      if (b.redeemOngoingDays == null) return null;
      return b.redeemOngoingDays;
    };

    const filtered = bonds.filter((b) => {
      if (keyword) {
        const name = b.name || '';
        const code = b.code || '';
        if (!name.includes(keyword) && !code.includes(keyword)) return false;
      }

      if (marketFilters.maxPrice !== null && b.price > marketFilters.maxPrice) return false;
      if (marketFilters.maxPremium !== null && b.premiumRate > marketFilters.maxPremium) return false;
      if (
        marketFilters.minRemainingYear !== null &&
        b.remainingYear < marketFilters.minRemainingYear
      ) {
        return false;
      }
      if (
        marketFilters.minTurnoverRate !== null &&
        (typeof b.turnoverRate !== 'number' || b.turnoverRate <= marketFilters.minTurnoverRate)
      ) {
        return false;
      }

      // 排除涨幅超过 29% 的可转债（复选框控制）
      if (marketFilters.excludeNewBond) {
        const inc = typeof b.priceChange === 'number' ? b.priceChange : null;
        if (inc !== null && inc > 29) return false;
      }

      // 按涨幅上限过滤：仅保留涨幅小于等于指定阈值的可转债
      if (marketFilters.minIncreaseRate !== null) {
        const inc = typeof b.priceChange === 'number' ? b.priceChange : null;
        if (inc === null || inc > marketFilters.minIncreaseRate) return false;
      }

      if (marketFilters.minRedeemDays !== null) {
        const days = getRedeemDays(b);
        // 强赎天数大于上限 → 排除
        if (days !== null && days > marketFilters.minRedeemDays) return false;
        // 强赎天数等于上限 且 正股价已突破强赎触发价 → 也排除
        if (
          days === marketFilters.minRedeemDays &&
          typeof b.forceRedeemPrice === 'number' &&
          b.forceRedeemPrice > 0 &&
          Number.isFinite(b.stockPrice) &&
          b.stockPrice > b.forceRedeemPrice
        ) {
          return false;
        }
      }

      return true;
    });

    return [...filtered]
      .sort((a, b) => {
        const at = a.totalScore;
        const bt = b.totalScore;
        const aHas = typeof at === 'number' && Number.isFinite(at);
        const bHas = typeof bt === 'number' && Number.isFinite(bt);
        if (aHas && bHas) return bt - at;
        if (aHas) return -1;
        if (bHas) return 1;
        return a.doubleLow - b.doubleLow;
      });
  }, [bonds, marketFilters]);

  const marketTop20Data = useMemo(() => {
    return marketRankedData.slice(0, marketTopN === 'ALL' ? marketRankedData.length : marketTopN);
  }, [marketRankedData, marketTopN]);

  // 从 backendSummary.config_used 中提取关键配置，供 UI 展示
  const backendConfigDisplay = useMemo(() => {
    if (!backendSummary) return null;
    const cfg = backendSummary.config_used as any;
    if (!cfg || typeof cfg !== 'object') return null;

    const factor = (cfg.factor_weights ?? {}) as Record<string, number | undefined>;

    return {
      maxPrice: cfg.max_price as number | undefined,
      maxPremium: cfg.max_premium_rt as number | undefined,
      topN: cfg.top_n as number | undefined,
      yearLeft: cfg.year_left as number | undefined,
      klineFetchMode: backendSummary.kline_fetch_mode as string | undefined,
      factorWeights: {
        ytm_rt: factor.ytm_rt,
        premium_rt: factor.premium_rt,
        bond_ytm: factor.bond_ytm,
        curr_iss_amt: factor.curr_iss_amt,
        stock_mom: factor.stock_mom,
        turnover_rt: factor.turnover_rt,
        price: factor.price,
      },
    };
  }, [backendSummary]);

  const handlePickBonds = () => {
    const n = Math.max(1, Math.floor(holdingTargetCount || 0));
    const selected = marketRankedData.filter((b) => !blacklistIds.has(b.id)).slice(0, n);
    const selectedIds = new Set(selected.map((b) => b.id));

    setBuyIds(new Set(selected.filter((b) => !holdingIds.has(b.id)).map((b) => b.id)));
    setSellIds(new Set(Array.from(holdingIds).filter((id) => !selectedIds.has(id))));
  };

  const handleRestorePick = () => {
    setBuyIds(new Set());
    setSellIds(new Set());
  };

  const handleConfirmTrade = () => {
    const buyList = Array.from(buyIds).filter((id) => !holdingIds.has(id));
    const sellList = Array.from(sellIds).filter((id) => holdingIds.has(id));

    if (buyList.length === 0 && sellList.length === 0) {
      alert('没有需要买入/卖出的标的');
      return;
    }

    if (!confirm(`确认执行买卖？\n买入：${buyList.length} 支\n卖出：${sellList.length} 支`)) return;
    if (!confirm('再次确认：执行后将直接修改持仓列表，是否继续？')) return;

    // 交易日志里的代码与名称尽量从全量行情里取，保证持仓中所有债券都能找到
    const bondMap = new Map(allBonds.map((b) => [b.id, b] as const));
    const toBrief = (id: string) => {
      const b = bondMap.get(id);
      return {
        id,
        code: b?.code || id,
        name: b?.name || '-',
      };
    };

    setHoldingIds((prev) => {
      const next = new Set(prev);
      for (const id of sellList) next.delete(id);
      for (const id of buyList) next.add(id);
      return next;
    });
    setBuyIds(new Set());
    setSellIds(new Set());

    setTradeLogs((prev) => {
      const entry: TradeLogItem = {
        ts: new Date().toISOString(),
        targetCount: Math.max(1, Math.floor(holdingTargetCount || 0)),
        buy: buyList.map(toBrief),
        sell: sellList.map(toBrief),
      };
      return [entry, ...prev].slice(0, 200);
    });
  };

  type WebdavConfig = {
    endpoint: string;
    username: string;
    password: string;
    path: string;
  };

  const [webdavForm, setWebdavForm] = useState<WebdavConfig>({
    endpoint: '',
    username: '',
    password: '',
    path: '/bondmaster/data.json',
  });

  const [webdavUrl, setWebdavUrl] = useState<string>('');

  const WEBDAV_CONFIG_KEY = 'webdav_config';

  const loadWebdavConfig = (): WebdavConfig | null => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(WEBDAV_CONFIG_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as WebdavConfig;
      if (!parsed.endpoint || !parsed.path) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const saveWebdavConfig = (cfg: WebdavConfig) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(cfg));
  };

  const handleOpenWebdavSync = () => {
    if (typeof window === 'undefined') return;
    const existing = loadWebdavConfig();
    if (existing) {
      setWebdavForm(existing);
      const base = existing.endpoint.replace(/\/$/, '');
      const combined = base + (existing.path || '');
      setWebdavUrl(combined);
    } else {
      setWebdavForm({
        endpoint: '',
        username: '',
        password: '',
        path: '/bondmaster/data.json',
      });
      setWebdavUrl('');
    }
    setIsWebdavOpen(true);
  };

  const buildSyncPayload = () => {
    const holdings = Array.from(holdingIds);
    const buys = Array.from(buyIds);
    const sells = Array.from(sellIds);
    const blacklist_ids = Array.from(blacklistIds);
    return {
      version: 3,
      ts: new Date().toISOString(),
      holdings,
      buys,
      sells,
      blacklist_ids,
      scoreConfig,
      tradeLogs,
    };
  };

  const applySyncPayload = (data: any) => {
    if (!data || typeof data !== 'object') return;
    const holdings = Array.isArray(data.holdings) ? data.holdings : [];
    const buys = Array.isArray(data.buys) ? data.buys : [];
    const sells = Array.isArray(data.sells) ? data.sells : [];
    const blacklist = Array.isArray(data.blacklist_ids) ? data.blacklist_ids : [];
    const logs = Array.isArray(data.tradeLogs) ? data.tradeLogs : [];
    const syncedScoreConfig = data.scoreConfig && typeof data.scoreConfig === 'object' ? data.scoreConfig : null;

    setHoldingIds(new Set(holdings.map((x: any) => String(x))));
    setBuyIds(new Set(buys.map((x: any) => String(x))));
    setSellIds(new Set(sells.map((x: any) => String(x))));
    setBlacklistIds(new Set(blacklist.map((x: any) => String(x))));
    if (syncedScoreConfig) {
      setScoreConfig(normalizeScoreConfig(syncedScoreConfig));
    }
    setTradeLogs(logs as TradeLogItem[]);
  };

  const handleUploadData = async () => {
    if (typeof window === 'undefined') return;
    const cfg = loadWebdavConfig();
    if (!cfg) {
      window.alert('请先点击”同步”按钮配置 WebDAV。');
      return;
    }
    if (!window.confirm('确认将当前持仓和日志上传到远程 WebDAV 文件？\n这会覆盖远程现有数据。')) {
      return;
    }
    try {
      const url = cfg.endpoint.replace(/\/$/, '') + cfg.path;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (cfg.username) {
        const auth = btoa(`${cfg.username}:${cfg.password ?? ''}`);
        headers.Authorization = `Basic ${auth}`;
      }
      const resp = await apiPost(url, buildSyncPayload(), {
        method: 'PUT',
        headers,
      });
      if (!resp.ok) {
        window.alert('上传失败: ' + (resp.status + ' ' + resp.statusText));
        return;
      }
      window.alert('上传成功。');
    } catch (e: any) {
      window.alert('上传异常: ' + (e?.message || String(e)));
    }
  };

  const handleDownloadData = async () => {
    if (typeof window === 'undefined') return;
    const cfg = loadWebdavConfig();
    if (!cfg) {
      window.alert('请先点击”同步”按钮配置 WebDAV。');
      return;
    }
     if (!window.confirm('确认从远程 WebDAV 文件下载并覆盖本地持仓和日志？')) {
       return;
     }
    try {
      const url = cfg.endpoint.replace(/\/$/, '') + cfg.path;
      const headers: Record<string, string> = {
        Accept: 'application/json, */*',
      };
      if (cfg.username) {
        const auth = btoa(`${cfg.username}:${cfg.password ?? ''}`);
        headers.Authorization = `Basic ${auth}`;
      }
      const resp = await apiPost(url, undefined, {
        method: 'GET',
        headers,
      });
      if (!resp.ok) {
        window.alert('下载失败: ' + (resp.status + ' ' + resp.statusText));
        return;
      }
      const data = await resp.json().catch(() => null);
      if (!data || typeof data !== 'object') {
        window.alert('下载的数据不是有效的 JSON。');
        return;
      }
      applySyncPayload(data);
      window.alert('下载并应用成功。');
    } catch (e: any) {
      window.alert('下载异常: ' + (e?.message || String(e)));
    }
  };

  const hasPendingPick = buyIds.size > 0 || sellIds.size > 0;
  const showAllBonds = false;

  return (
    <div className="min-h-screen bg-slate-900 pb-20">
      {/* Header */}
      <header className="bg-slate-850 border-b border-slate-800 sticky top-0 z-40 backdrop-blur-md bg-opacity-80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 min-h-16 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Activity className="text-white" size={24} />
            </div>
          </div>
          
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={() => setIsTradeLogOpen(true)}
              className="hidden sm:flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
              title="交易日志"
            >
              <FileText size={14} className="text-slate-300" />
              日志
            </button>
            <button
              onClick={handleOpenWebdavSync}
              className="hidden sm:flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
              title="WebDAV 同步设置"
            >
              <RefreshCw size={14} className="text-slate-300" />
              同步
            </button>
            <button
              onClick={() => setIsTradeLogOpen(true)}
              className="sm:hidden p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-all"
              title="交易日志"
            >
              <FileText size={18} className="text-slate-300" />
            </button>
            <button
              onClick={handleOpenWebdavSync}
              className="sm:hidden p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-all"
              title="WebDAV 同步设置"
            >
              <RefreshCw size={18} className="text-slate-300" />
            </button>

            {user && (
              <>
                <button
                  onClick={() => setIsScoreConfigOpen(true)}
                  className="hidden sm:flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
                  title="评分设置"
                >
                  <SlidersHorizontal size={14} className="text-slate-300" />
                  评分
                </button>
                <button
                  onClick={() => setIsScoreConfigOpen(true)}
                  className="sm:hidden p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-all"
                  title="评分设置"
                >
                  <SlidersHorizontal size={18} className="text-slate-300" />
                </button>
              </>
            )}

             <div className="text-right hidden sm:block">
                <div className="text-xs font-medium text-green-400">
                  源: 集思录
                </div>
                <div className="text-xs text-slate-500">更新: {lastUpdated?.toLocaleTimeString() || '暂无'}</div>
             </div>
             
             <div className="flex items-center gap-2">
              <span
                className={`text-xs px-2 py-1 rounded-full border ${
                  user
                    ? 'bg-green-500/10 text-green-300 border-green-500/30'
                    : 'bg-slate-700/40 text-slate-300 border-slate-600'
                }`}
              >
                {user ? '已登录' : '未登录'}
              </span>
              {user ? (
                <button
                  onClick={handleLogout}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-all"
                  title="退出登录"
                >
                  <LogOut size={18} className="text-slate-300" />
                </button>
              ) : (
                <button
                  onClick={() => setIsLoginOpen(true)}
                  className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg font-medium transition-colors"
                >
                  登录
                </button>
              )}
            </div>

             <button 
               onClick={() => loadData()}
               disabled={loading}
               className={`p-2 bg-slate-800 hover:bg-slate-700 text-blue-400 rounded-lg border border-slate-700 transition-all ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
             >
               <RefreshCw size={20} className={loading ? "animate-spin" : ""} />
             </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {errorMsg && (
           <div className="bg-red-500/10 border border-red-500/20 text-red-200 px-4 py-3 rounded-xl text-sm flex items-center gap-2 animate-fade-in">
             <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
             {errorMsg}
           </div>
        )}

        {snapshotMsg && (
           <div className={`px-4 py-3 rounded-xl text-sm flex items-center gap-2 animate-fade-in ${
             snapshotMsg.startsWith('保存失败')
               ? 'bg-red-500/10 border border-red-500/20 text-red-200'
               : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-200'
           }`}>
             <div className={`w-2 h-2 rounded-full ${
               snapshotMsg.startsWith('保存失败') ? 'bg-red-500' : 'bg-emerald-500'
             }`}></div>
             {snapshotMsg}
           </div>
        )}

        {/* 1. My Holdings Section */}
        <section>
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Briefcase className="text-yellow-500" />
                我的持仓监控
              </h2>
              <p className="text-sm text-slate-400 mt-1">关注品种的实时动态</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                value={holdingTargetCount}
                onChange={(e) => setHoldingTargetCount(e.target.value.trim() === '' ? 0 : Number(e.target.value))}
                placeholder="持仓数量"
                className="w-14 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors text-center"
              />
              <button
                onClick={handleUploadData}
                className="text-xs px-3 py-1.5 rounded-lg border bg-emerald-600 text-white border-emerald-500 hover:bg-emerald-500 transition-colors"
              >
                上传
              </button>
              <button
                onClick={handleDownloadData}
                className="text-xs px-3 py-1.5 rounded-lg border bg-indigo-600 text-white border-indigo-500 hover:bg-indigo-500 transition-colors"
              >
                下载
              </button>
              <button
                onClick={handlePickBonds}
                className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
              >
                选债
              </button>
              <button
                onClick={handleRestorePick}
                disabled={!hasPendingPick}
                className={`text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 transition-colors ${
                  hasPendingPick ? 'hover:bg-slate-700' : 'opacity-50 cursor-not-allowed'
                }`}
              >
                还原
              </button>
              <button
                onClick={handleConfirmTrade}
                className="text-xs px-3 py-1.5 rounded-lg border bg-blue-600 text-white border-blue-500 hover:bg-blue-500 transition-colors"
              >
                确定买卖
              </button>
              <button
                onClick={() => setIsBlacklistOpen(true)}
                className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
              >
                黑名单
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="min-h-[200px]">
              <BondTable 
                title="当前持仓" 
                icon={<Briefcase size={18} className="text-yellow-400"/>}
                titleExtra={
                  typeof holdingsOverallChange === 'number' ? (
                    <span
                      className={`text-xs font-normal px-2 py-0.5 rounded-full border ${
                        holdingsOverallChange >= 0
                          ? 'bg-red-500/10 text-red-300 border-red-500/30'
                          : 'bg-green-500/10 text-green-300 border-green-500/30'
                      }`}
                    >
                      {holdingsOverallChange >= 0 ? '+' : ''}
                      {holdingsOverallChange.toFixed(2)}%
                    </span>
                  ) : null
                }
                data={myHoldingsData} 
                holdingIds={holdingIds}
                onToggleHolding={handleToggleHolding}
                columnPreset="holdings"
                emptyMessage="暂无持仓，请在下方市场列表中点击星号添加"
              />
            </div>

            <div className="min-h-[200px]">
              <BondTable 
                title="准备卖出" 
                icon={<ArrowDownCircle size={18} className="text-red-400"/>}
                data={myToSellSorted} 
                holdingIds={holdingIds}
                onToggleHolding={handleToggleHolding}
                columnPreset="holdings"
                emptyMessage="暂无待卖标记"
              />
            </div>

            <div className="min-h-[200px]">
              <BondTable 
                title="准备买入" 
                icon={<ArrowUpCircle size={18} className="text-green-400"/>}
                data={myToBuySorted} 
                holdingIds={holdingIds}
                onToggleHolding={handleToggleHolding}
                columnPreset="holdings"
                emptyMessage="暂无待买标记（可在市场列表里点“待买”）"
              />
            </div>
          </div>
        </section>

        {/* 2. Market Opportunities */}
        <section>
          <div className="mb-4 space-y-1">
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <ListFilter className="text-blue-500" />
              市场优选排行
            </h2>
            <p className="text-sm text-slate-400">基于 total_score 排名（分数越高越靠前）</p>
            {backendConfigDisplay && (
              <div className="text-xs text-slate-400 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2 inline-flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  条件：价格≤{backendConfigDisplay.maxPrice ?? '-'}，溢价≤{backendConfigDisplay.maxPremium ?? '-'}%，
                  年限≥{backendConfigDisplay.yearLeft ?? '-'} 年，TopN=
                  {backendConfigDisplay.topN ?? '-'}
                </span>
                <span>
                  K线：{backendConfigDisplay.klineFetchMode ?? '-'}
                </span>
                <span className="flex flex-wrap gap-x-2 gap-y-1">
                  <span>权重：</span>
                  <span>YTM={backendConfigDisplay.factorWeights.ytm_rt ?? '-'} </span>
                  <span>溢价={backendConfigDisplay.factorWeights.premium_rt ?? '-'} </span>
                  <span>纯债偏离={backendConfigDisplay.factorWeights.bond_ytm ?? '-'} </span>
                  <span>规模={backendConfigDisplay.factorWeights.curr_iss_amt ?? '-'} </span>
                  <span>动量={backendConfigDisplay.factorWeights.stock_mom ?? '-'} </span>
                  <span>换手={backendConfigDisplay.factorWeights.turnover_rt ?? '-'} </span>
                  <span>价格={backendConfigDisplay.factorWeights.price ?? '-'} </span>
                </span>
              </div>
            )}
          </div>
          <div className="min-h-[400px]">
            <BondTable 
              title="市场优选排行" 
              icon={<Sparkles size={18} className="text-blue-400"/>}
              titleExtra={
                <span className="text-xs text-slate-300">
                  共 {marketRankedData.length} 只
                </span>
              }
              data={marketTop20Data} 
              holdingIds={holdingIds}
              onToggleHolding={handleToggleHolding}
              blacklistIds={blacklistIds}
              onAddToBlacklist={handleAddToBlacklist}
              columnPreset="market"
              expandableColumns={true}
              showScoreColumns={true}
              showRedeemColumn={true}
              countOptions={[10, 20, 30, 'ALL']}
              selectedCount={marketTopN}
              onSelectCount={(n) => setMarketTopN(n as 10 | 20 | 30 | 'ALL')}
              toolbar={(
                <div className="w-full sm:w-auto grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
                  <input
                    value={marketFilters.keyword}
                    onChange={(e) =>
                      setMarketFilters((p) => ({ ...p, keyword: e.target.value }))
                    }
                    placeholder="关键词"
                    className="col-span-2 sm:col-span-1 w-full sm:min-w-[120px] bg-slate-900 border border-slate-600 text-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  />

                  <input
                    type="number"
                    value={marketFilters.maxPrice ?? ''}
                    onChange={(e) =>
                      setMarketFilters((p) => ({
                        ...p,
                        maxPrice: e.target.value.trim() === '' ? null : Number(e.target.value),
                      }))
                    }
                    placeholder="价格≤"
                    className="w-full sm:w-20 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  />

                  <input
                    type="number"
                    value={marketFilters.maxPremium ?? ''}
                    onChange={(e) =>
                      setMarketFilters((p) => ({
                        ...p,
                        maxPremium: e.target.value.trim() === '' ? null : Number(e.target.value),
                      }))
                    }
                    placeholder="溢价≤%"
                    className="w-full sm:w-24 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  />

                  <input
                    type="number"
                    value={marketFilters.minRemainingYear ?? ''}
                    onChange={(e) =>
                      setMarketFilters((p) => ({
                        ...p,
                        minRemainingYear:
                          e.target.value.trim() === '' ? null : Number(e.target.value),
                      }))
                    }
                    placeholder="年限≥"
                    className="w-full sm:w-20 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  />

                  <input
                    type="number"
                    value={marketFilters.minTurnoverRate ?? ''}
                    onChange={(e) =>
                      setMarketFilters((p) => ({
                        ...p,
                        minTurnoverRate:
                          e.target.value.trim() === '' ? null : Number(e.target.value),
                      }))
                    }
                    placeholder="换手>%"
                    className="w-full sm:w-24 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  />

                  <input
                    type="number"
                    value={marketFilters.minIncreaseRate ?? ''}
                    onChange={(e) =>
                      setMarketFilters((p) => ({
                        ...p,
                        minIncreaseRate:
                          e.target.value.trim() === '' ? null : Number(e.target.value),
                      }))
                    }
                    placeholder="涨幅≥%"
                    className="w-full sm:w-24 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  />

                  <input
                    type="number"
                    value={marketFilters.minRedeemDays ?? ''}
                    onChange={(e) =>
                      setMarketFilters((p) => ({
                        ...p,
                        minRedeemDays:
                          e.target.value.trim() === '' ? null : Number(e.target.value),
                      }))
                    }
                    placeholder="强赎天数≤"
                    className="w-full sm:w-24 bg-slate-900 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  />

                  <label className="flex items-center gap-1 text-xs text-slate-300 select-none">
                    <input
                      type="checkbox"
                      checked={marketFilters.excludeNewBond}
                      onChange={(e) =>
                        setMarketFilters((p) => ({ ...p, excludeNewBond: e.target.checked }))
                      }
                      className="accent-blue-500"
                    />
                    排除涨幅&gt;29%
                  </label>

                  <button
                    onClick={() =>
                      setMarketFilters({
                        keyword: '',
                        maxPrice: null,
                        maxPremium: null,
                        minRemainingYear: null,
                        minTurnoverRate: null,
                        minIncreaseRate: null,
                        minRedeemDays: null,
                        excludeBRating: false,
                        excludeNewBond: false,
                      })
                    }
                    className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
                  >
                    重置
                  </button>

                  <button
                    type="button"
                    onClick={handleBackendScreen}
                    disabled={loading}
                    className={`col-span-2 sm:col-span-1 text-xs px-3 py-1.5 rounded-lg border bg-blue-600 text-white border-blue-500 hover:bg-blue-500 transition-colors ${
                      loading ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                  >
                    后端选股
                  </button>

                  <button
                    type="button"
                    onClick={handleSaveSnapshot}
                    disabled={loading || savingSnapshot}
                    className={`col-span-2 sm:col-span-1 text-xs px-3 py-1.5 rounded-lg border bg-emerald-600 text-white border-emerald-500 hover:bg-emerald-500 transition-colors ${
                      loading || savingSnapshot ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                  >
                    {savingSnapshot ? '保存中...' : '保存快照'}
                  </button>

                  <button
                    type="button"
                    onClick={handleClearCache}
                    disabled={loading}
                    className={`col-span-2 sm:col-span-1 text-xs px-3 py-1.5 rounded-lg border bg-slate-700 text-amber-300 border-amber-600/50 hover:bg-slate-600 transition-colors ${
                      loading ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                  >
                    清除缓存
                  </button>
                </div>
              )}
              emptyMessage="加载中..."
            />
          </div>
        </section>

        {/* 3. All Bonds List */}
        {showAllBonds && (
          <section>
            <div className="mb-4">
               <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <ListFilter className="text-green-500" />
                  全部可转债
                </h2>
               <p className="text-sm text-slate-400 mt-1">从集思录获取的完整可转债列表，可通过搜索栏筛选。</p>
            </div>
            <div className="min-h-[400px]">
              <BondTable 
                title={`全部列表（${bonds.length} 支）`} 
                icon={<Sparkles size={18} className="text-green-400"/>}
                data={bonds} 
                holdingIds={holdingIds}
                onToggleHolding={handleToggleHolding}
                emptyMessage="暂无数据"
              />
            </div>
          </section>
        )}

      </main>
      {/* Login Modal */}
      <LoginModal 
        isOpen={isLoginOpen} 
        onClose={() => setIsLoginOpen(false)} 
        onLogin={handleLogin} 
      />

      {user && (
        <ScoreConfigModal
          isOpen={isScoreConfigOpen}
          value={scoreConfig}
          onClose={() => setIsScoreConfigOpen(false)}
          onSave={handleSaveScoreConfig}
        />
      )}

      {isTradeLogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-3xl bg-slate-800 border border-slate-700 rounded-xl shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <div className="text-sm font-semibold text-white">交易日志</div>
              <button
                onClick={() => setIsTradeLogOpen(false)}
                className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
              >
                关闭
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-4 space-y-3">
              {tradeLogs.length === 0 ? (
                <div className="text-sm text-slate-400">暂无日志</div>
              ) : (
                tradeLogs.map((l, idx) => (
                  <div key={`${l.ts}-${idx}`} className="border border-slate-700 rounded-lg p-3 bg-slate-900/30">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-slate-400">{new Date(l.ts).toLocaleString()}</div>
                      <div className="text-xs text-slate-400">目标持仓: {l.targetCount}</div>
                    </div>
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs text-green-300 mb-1">买入（{l.buy.length}）</div>
                        <div className="text-xs text-slate-200 space-y-1">
                          {l.buy.length === 0 ? (
                            <div className="text-slate-500">-</div>
                          ) : (
                            l.buy.map((b) => (
                              <div key={b.id} className="truncate">{b.code} {b.name}</div>
                            ))
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-red-300 mb-1">卖出（{l.sell.length}）</div>
                        <div className="text-xs text-slate-200 space-y-1">
                          {l.sell.length === 0 ? (
                            <div className="text-slate-500">-</div>
                          ) : (
                            l.sell.map((b) => (
                              <div key={b.id} className="truncate">{b.code} {b.name}</div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {isBlacklistOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-2xl bg-slate-800 border border-slate-700 rounded-xl shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <div className="text-sm font-semibold text-white">黑名单</div>
              <button
                onClick={() => setIsBlacklistOpen(false)}
                className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
              >
                关闭
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-4 space-y-2">
              {blacklistIds.size === 0 ? (
                <div className="text-sm text-slate-400">暂无黑名单</div>
              ) : (
                Array.from(blacklistIds).map((id) => {
                  const b = allBonds.find((x) => x.id === id) || bonds.find((x) => x.id === id);
                  const label = `${b?.code || id} ${b?.name || ''}`.trim();
                  return (
                    <div key={id} className="flex items-center justify-between gap-3 border border-slate-700 rounded-lg px-3 py-2 bg-slate-900/30">
                      <div className="text-sm text-slate-200 truncate">{label}</div>
                      <button
                        onClick={() => handleRemoveFromBlacklist(id)}
                        className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
      {isWebdavOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-xl shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <div className="text-sm font-semibold text-white">WebDAV 同步设置</div>
              <button
                onClick={() => setIsWebdavOpen(false)}
                className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
              >
                关闭
              </button>
            </div>
            <div className="p-4 space-y-3 text-sm text-slate-200">
              <div>
                <label className="block text-xs text-slate-400 mb-1">WebDAV 文件 URL</label>
                <input
                  className="w-full bg-slate-900 border border-slate-600 text-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                  placeholder="例如：https://dav.jianguoyun.com/dav/bondmaster/data.json"
                  value={webdavUrl}
                  onChange={(e) => setWebdavUrl(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">用户名</label>
                  <input
                    className="w-full bg-slate-900 border border-slate-600 text-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                    placeholder="例如：你的邮箱"
                    value={webdavForm.username}
                    onChange={(e) =>
                      setWebdavForm((p) => ({ ...p, username: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">密码（保存在本机浏览器）</label>
                  <input
                    type="password"
                    className="w-full bg-slate-900 border border-slate-600 text-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500 transition-colors"
                    value={webdavForm.password}
                    onChange={(e) =>
                      setWebdavForm((p) => ({ ...p, password: e.target.value }))
                    }
                  />
                </div>
              </div>
              <div className="text-xs text-slate-400">
                提示：配置会以明文形式保存在当前浏览器的 localStorage，仅建议个人设备使用。
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setIsWebdavOpen(false)}
                  className="text-xs px-3 py-1.5 rounded-lg border bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    const raw = webdavUrl.trim();
                    if (!raw) {
                      return;
                    }
                    let endpoint = raw;
                    let path = '/bondmaster/data.json';
                    const idx = raw.indexOf('/dav/');
                    if (idx > 0) {
                      endpoint = raw.slice(0, idx + 4);
                      path = raw.slice(idx + 4) || '/bondmaster/data.json';
                    }
                    const trimmed: WebdavConfig = {
                      endpoint: endpoint.replace(/\/$/, ''),
                      path: path.startsWith('/') ? path : '/' + path,
                      username: webdavForm.username.trim(),
                      password: webdavForm.password,
                    };
                    saveWebdavConfig(trimmed);
                    setWebdavForm(trimmed);
                    setIsWebdavOpen(false);
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg border bg-blue-600 text-white border-blue-500 hover:bg-blue-500 transition-colors"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;