from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, date
from typing import Any, Dict, Iterable, List, Optional

import numpy as np
import pandas as pd
import requests as rq

from backend.config.settings import get_settings

logger = logging.getLogger(__name__)

# In-memory, per-day caches to avoid repeated expensive upstream calls.
_redeem_cache_date: Optional[date] = None
_redeem_cache_df: Optional[pd.DataFrame] = None

_stock_price_cache_date: Optional[date] = None
_stock_price_cache_df: Optional[pd.DataFrame] = None
_stock_price_fetch_mode: Optional[str] = None

# PUREBONDOR (纯债溢价率) per-day cache
_purebond_cache_date: Optional[date] = None
_purebond_cache_df: Optional[pd.DataFrame] = None  # columns: bond_id, PUREBONDOR, date


def clear_caches() -> None:
    """Clear all in-memory per-day caches, forcing fresh upstream fetches."""
    global _redeem_cache_date, _redeem_cache_df
    global _stock_price_cache_date, _stock_price_cache_df, _stock_price_fetch_mode
    global _purebond_cache_date, _purebond_cache_df

    _redeem_cache_date = None
    _redeem_cache_df = None

    _stock_price_cache_date = None
    _stock_price_cache_df = None
    _stock_price_fetch_mode = None

    _purebond_cache_date = None
    _purebond_cache_df = None


def fetch_kline_data(symbols: Iterable[str], data_count: int = 60) -> pd.DataFrame:
    """Fetch k-line data for a list of stock symbols.

    This is a refactor of apk.py:fetch_kline_data, kept as close as possible
    to the original behaviour to maintain score parity.
    """

    url = "https://quotedata.cnfin.com/quote/v1/kline"
    all_df: List[pd.DataFrame] = []

    for sym in symbols:
        if not sym:
            continue
        code = str(sym).zfill(6)
        if code.startswith("6"):
            prod_code = f"{code}.XSHG"
        else:
            prod_code = f"{code}.XSHE"

        params = {
            "localDate": int(time.time() * 1000),
            "get_type": "offset",
            "prod_code": prod_code,
            "candle_period": 6,
            "candle_mode": 1,
            "data_count": data_count,
        }

        settings = get_settings()
        timeout = settings.http_timeout_seconds

        r = rq.get(url, params=params, timeout=timeout)
        r.raise_for_status()
        js = r.json()

        candle = js["data"]["candle"]
        fields = candle["fields"]
        data = candle.get(prod_code, [])
        if not data:
            continue

        df = pd.DataFrame(data, columns=fields)
        df["code"] = prod_code
        all_df.append(df)

    if not all_df:
        return pd.DataFrame()

    final_df = pd.concat(all_df, ignore_index=True)
    final_df["min_time"] = pd.to_datetime(final_df["min_time"].astype(str), format="%Y%m%d")
    final_df.rename(
        columns={
            "min_time": "date",
            "close_px": "close",
            "open_px": "open",
            "high_px": "high",
            "low_px": "low",
            "business_amount": "volume",
        },
        inplace=True,
    )
    return final_df

def _parse_eastmoney_response(text: str) -> Dict[str, Any]:
    text = text.strip()
    # JSON wrapped by single quotes
    if text.startswith("'") and text.endswith("'"):
        return json.loads(text[1:-1])
    # JSONP like callback({...})
    if "(" in text and text.endswith(")"):
        import re as _re
        m = _re.search(r"\((\{.*\})\)", text, flags=_re.S)
        if m:
            return json.loads(m.group(1))
    # plain JSON
    return json.loads(text)

def fetch_purebondor_data(zcodes: Iterable[str]) -> pd.DataFrame:
    """Fetch PUREBONDOR (纯债溢价率, percent) for given bond ids (zcodes).

    Returns a DataFrame with columns: bond_id, PUREBONDOR (float), date (datetime.date)
    """

    zlist = [str(z).strip() for z in zcodes if str(z).strip()]
    if not zlist:
        return pd.DataFrame()

    # Eastmoney datacenter API
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    zcode_str = ",".join([f'"{z}"' for z in zlist])
    params = {
        "columns": "ALL",
        "token": "894050c76af8597a853f5b408b759f5d",
        "reportName": "RPTA_WEB_KZZ_LS",
        "sortColumns": "date",
        "sortTypes": "-1",
        "pageNumber": "1",
        "pageSize": str(len(zlist)),
        "filter": f"(zcode in ({zcode_str}))",
    }

    settings = get_settings()
    timeout = settings.http_timeout_seconds
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://datacenter-web.eastmoney.com/",
    }

    try:
        r = rq.get(url, params=params, headers=headers, timeout=timeout)
        r.raise_for_status()
        js = _parse_eastmoney_response(r.text)
        result = (js.get("result") or {}).get("data") or []
        if not result:
            return pd.DataFrame()
        df1 = pd.DataFrame(result)
    except Exception as exc:  # pragma: no cover - upstream tolerant
        logger.warning("Failed to fetch PUREBONDOR: %s", exc)
        return pd.DataFrame()

    # Identify columns
    z_col = "ZCODE" if "ZCODE" in df1.columns else ("zcode" if "zcode" in df1.columns else None)
    date_col = "DATE" if "DATE" in df1.columns else ("date" if "date" in df1.columns else None)
    pure_col = "PUREBONDOR"
    if z_col is None or date_col is None or pure_col not in df1.columns:
        logger.warning("PUREBONDOR response missing cols: z=%s date=%s pure=%s", z_col, date_col, pure_col in df1.columns)
        return pd.DataFrame()

    df1 = df1.copy()
    df1["__dt"] = pd.to_datetime(df1[date_col], errors="coerce")
    df1 = df1.sort_values([z_col, "__dt"]).drop_duplicates(z_col, keep="last")

    out = df1[[z_col, "__dt", pure_col]].rename(columns={z_col: "bond_id", "__dt": "date"})
    out["bond_id"] = out["bond_id"].astype(str)
    out["date"] = out["date"].dt.date
    out[pure_col] = pd.to_numeric(out[pure_col], errors="coerce")
    return out

def get_purebondor_data(bonds_df: pd.DataFrame) -> pd.DataFrame:
    """Return PUREBONDOR for given bonds with per-day cache and incremental fetch.

    bonds_df must contain column 'bond_id'.
    """

    global _purebond_cache_date, _purebond_cache_df

    if "bond_id" not in bonds_df.columns:
        return pd.DataFrame()

    req_ids = bonds_df["bond_id"].dropna().astype(str).unique().tolist()
    if not req_ids:
        return pd.DataFrame()

    today = datetime.now().date()

    cache = None
    if _purebond_cache_date == today and _purebond_cache_df is not None:
        cache = _purebond_cache_df

    # First call of the day or empty cache: fetch all
    if cache is None or cache.empty:
        data = fetch_purebondor_data(req_ids)
        if data.empty:
            return data
        _purebond_cache_date = today
        _purebond_cache_df = data.copy()
        return data[data["bond_id"].isin(req_ids)].copy()

    # Otherwise only fetch missing ids and merge
    cached_ids = set(cache["bond_id"].astype(str).unique())
    missing = [bid for bid in req_ids if bid not in cached_ids]
    if missing:
        new_df = fetch_purebondor_data(missing)
        if not new_df.empty:
            cache = pd.concat([cache, new_df], ignore_index=True)
            _purebond_cache_df = cache.copy()

    return cache[cache["bond_id"].isin(req_ids)].copy()

def fetch_latest_stock_snapshot() -> pd.DataFrame:
    """Fetch latest A-share stock snapshot for the whole market.
 
    使用 quotedata 的 sort 接口一次性获取全市场最新行情，其中 last_px 作为
    最新收盘价近似值，后续用于在已有 60 日 K 线缓存的基础上刷新“最后一根”价格。
    """
 
    url = "https://quotedata.cnfin.com/quote/v1/sort"
    params = {
        "sort_field_name": "px_change_rate",
        "sort_type": 1,
        "start_pos": 0,
        "data_count": 9500,
        "en_hq_type_code": "SS.ESA.M,SZ.ESA.M,SZ.ESA.SMSE,SZ.ESA.GEM,SS.KSH,SZ.ESA.SMSE",
        "fields": "null",
        "localDate": int(time.time() * 1000),
    }
 
    settings = get_settings()
    timeout = settings.http_timeout_seconds
 
    r = rq.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    js = r.json()
 
    sort_data = js.get("data", {}).get("sort", {})
    fields = sort_data.get("fields")
    if not fields:
        return pd.DataFrame()
 
    records: List[Dict[str, Any]] = []
    for key, values in sort_data.items():
        if key == "fields":
            continue
        if not isinstance(values, list):
            continue
        if not values:
            continue
 
        n = min(len(fields), len(values))
        row = {fields[i]: values[i] for i in range(n)}
        row["code"] = key
        # 代码形如 "301486.SZ" / "688025.SS"，截取前 6 位作为 stock_id
        row["stock_id"] = str(key).split(".")[0]
        records.append(row)
 
    if not records:
        return pd.DataFrame()
 
    return pd.DataFrame.from_records(records)


def login_and_fetch_bond_list(config: Dict[str, Any], jisilu_cookie: Optional[str] = None) -> pd.DataFrame:
    """Login to Jisilu and fetch the convertible bond list as a DataFrame.

    Uses the same JSON API as the Next.js frontend (cb_list_new with form body),
    paginating until all bonds are collected.

    If jisilu_cookie is provided (passed from the frontend), use it directly
    instead of going through the login flow.
    """

    url_login = config["url_login"]
    login_data = config["login_data"]

    session = rq.session()

    # Build headers matching the Next.js frontend requests
    api_headers = {
        "User-Agent": config["header"]["User-Agent"],
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Origin": "https://www.jisilu.cn",
        "Referer": "https://www.jisilu.cn/data/cbnew/",
    }

    cookie_file = config.get("cookie_file", "jisilu_cookies.csv")

    if jisilu_cookie:
        api_headers["Cookie"] = jisilu_cookie
    else:
        _load_cookies(session, cookie_file)
        session.post(url=url_login, headers=config["header"], data=login_data)
        _save_cookies(session, cookie_file)

    # Pre-fetch the main page to warm up session cookies (same as Next.js)
    try:
        session.get(
            "https://www.jisilu.cn/data/cbnew/",
            headers={
                "User-Agent": config["header"]["User-Agent"],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Origin": "https://www.jisilu.cn",
                "Referer": "https://www.jisilu.cn/",
            },
            timeout=config.get("http_timeout_seconds", 10),
        )
    except Exception:
        pass  # best-effort, not critical

    timestamp = int(time.time() * 1000)
    base_url = (
        f"https://www.jisilu.cn/data/cbnew/cb_list_new/"
        f"?___jsl=LST___t={timestamp}"
    )

    all_rows: List[Dict[str, Any]] = []
    rp = 30

    def _fetch_page(page: int) -> Optional[dict]:
        url = f"{base_url}&page={page}&rp={rp}"
        body = {"page": str(page), "rp": str(rp)}
        resp = session.post(url, headers=api_headers, data=body)
        if not resp.ok:
            return None
        try:
            return resp.json()
        except Exception:
            return None

    # Fetch first page
    data = _fetch_page(1)

    # If login failed or session expired, retry once
    if data is None or not data.get("rows"):
        session.post(url=url_login, headers=config["header"], data=login_data)
        _save_cookies(session, cookie_file)
        data = _fetch_page(1)

    if data is None:
        raise RuntimeError(
            "无法获取可转债列表数据，请检查登录状态或接口是否变化。"
        )

    # Collect rows from all pages
    total: int = data.get("total", 0)
    page = 1
    while data is not None:
        page_rows = data.get("rows") or []
        for row in page_rows:
            cell = row.get("cell", row)
            all_rows.append(cell)

        if total > 0 and len(all_rows) >= total:
            break
        if not page_rows:
            break

        page += 1
        if page > 200:
            break
        data = _fetch_page(page)

    if len(all_rows) < 35:
        raise RuntimeError(
            f"可转债列表数据不足 (仅 {len(all_rows)} 条)，"
            "请检查登录状态或接口是否变化。"
        )

    ddf = pd.DataFrame(all_rows)
    ddf = ddf[
        [
            "bond_id",
            "bond_nm",
            "price",
            "volume",
            "btype",
            "premium_rt",
            "turnover_rt",
            "sprice",
            "force_redeem_price",
            "curr_iss_amt",
            "year_left",
            "increase_rt",
            "sincrease_rt",
            "rating_cd",
            "maturity_dt",
            "list_dt",
            "ytm_rt",
            "bond_value",
            "stock_nm",
            "stock_id",
        ]
    ]

    # JSON API returns numeric fields as strings; convert to proper numeric types
    _numeric_cols = [
        "price", "volume", "premium_rt", "turnover_rt", "sprice",
        "force_redeem_price", "curr_iss_amt", "year_left", "increase_rt",
        "sincrease_rt", "ytm_rt", "bond_value",
    ]
    for _col in _numeric_cols:
        if _col in ddf.columns:
            ddf[_col] = pd.to_numeric(ddf[_col], errors="coerce")

    ddf["date"] = datetime.now().date()
    return ddf


def fetch_redeem_info(config: Dict[str, Any]) -> pd.DataFrame:
    """Fetch redeem information for convertible bonds from Jisilu."""

    url_redeem = config["url_redeem"]
    header = config["header"]
    settings = get_settings()
    timeout = settings.http_timeout_seconds

    redeem_html = rq.get(url=url_redeem, headers=header, timeout=timeout).text
    str1 = redeem_html[redeem_html.find("[") : redeem_html.find("]}") + 1]
    df_redeem = pd.DataFrame(json.loads(str1))
    logger.info("集思录强赎API返回列: %s", list(df_redeem.columns))
    cols = ["bond_id"]
    for c in ["redeem_remain_days", "redeem_status", "redeem_icon"]:
        if c in df_redeem.columns:
            cols.append(c)
    df_redeem = df_redeem[cols]
    return df_redeem


def fetch_redeem_info_cached(config: Dict[str, Any]) -> pd.DataFrame:
    """Fetch redeem info with a simple per-day cache.

    集思录强赎信息在交易日内通常变化不大，多次调用时可以复用当日结果，
    避免对同一接口重复全量抓取。
    """

    global _redeem_cache_date, _redeem_cache_df

    today = datetime.now().date()
    if _redeem_cache_date == today and _redeem_cache_df is not None:
        return _redeem_cache_df.copy()

    df = fetch_redeem_info(config)
    _redeem_cache_date = today
    _redeem_cache_df = df.copy()
    return df


def compute_scores(ddf: pd.DataFrame, config: Dict[str, Any]) -> pd.DataFrame:
    """Compute factor scores and total_score on a bond DataFrame.

    Logic mirrors apk.py:compute_scores.
    """

    ddf = ddf.copy()
    
    weights_cfg = config.get("factor_weights", {})
    w_ytm = weights_cfg.get("ytm_rt", 1.0)
    w_premium = weights_cfg.get("premium_rt", 1.0)
    w_bond_ytm = weights_cfg.get("bond_ytm", 1.0)
    w_curr_amt = weights_cfg.get("curr_iss_amt", 1.0)
    w_mom = weights_cfg.get("stock_mom", 1.0)
    w_turnover = weights_cfg.get("turnover_rt", 1.0)
    w_price = weights_cfg.get("price", 1.0)

    # Ensure PUREBONDOR is available by merging from cached crawler result when needed
    # if "PUREBONDOR" not in ddf.columns:
    #     pure_df = get_purebondor_data(ddf)
    #     if not pure_df.empty:
    #         ddf = ddf.merge(pure_df[["bond_id", "PUREBONDOR"]], on="bond_id", how="left")

    if "PUREBONDOR" in ddf.columns:
        ddf["bond_ytm"] = pd.to_numeric(ddf["PUREBONDOR"], errors="coerce") / 100.0
    elif "price" in ddf.columns and "bond_value" in ddf.columns:
        ddf["bond_ytm"] = ddf["price"] / ddf["bond_value"] - 1
    else:
        ddf["bond_ytm"] = np.nan

    ddf["ytm_rt_score"] = ddf["ytm_rt"].rank(pct=True)
    ddf["premium_rt_score"] = 1 - ddf["premium_rt"].rank(pct=True)
    # Turnover: bigger turnover is preferred by default, so use ascending rank.
    ddf["turnover_rt_score"] = ddf["turnover_rt"].rank(pct=True)
    ddf["bond_ytm_score"] = 1 - ddf["bond_ytm"].rank(pct=True)
    ddf["curr_iss_amt_score"] = 1 - ddf["curr_iss_amt"].rank(pct=True)
    # Price: lower bond price is preferred by default.
    ddf["price_score"] = 1 - ddf["price"].rank(pct=True)

    # Fill NaN factor scores with 0.5 (neutral percentile) so one missing
    # factor doesn't poison the entire total_score via NaN propagation.
    for col in ["ytm_rt_score", "premium_rt_score", "turnover_rt_score",
                "bond_ytm_score", "curr_iss_amt_score", "price_score"]:
        ddf[col] = ddf[col].fillna(0.5)

    stock_price_df = get_stock_price_data(ddf, end_date=None, count=60)
 
    # 在 60 日 K 线缓存基础上，用集思录列表中的 sprice 作为正股最新价，
    # 刷新每只股票的最后一个收盘价；同时在债券表上记录 stock_last_px。
    if "stock_id" in ddf.columns and "sprice" in ddf.columns:
        # 构造一个形如 snapshot_df 的 DataFrame，复用已有的更新逻辑
        snapshot_df = ddf[["stock_id", "sprice"]].copy()
        snapshot_df["stock_id"] = snapshot_df["stock_id"].astype(str)
        snapshot_df = snapshot_df.rename(columns={"sprice": "last_px"})
    
        stock_price_df = _apply_latest_close_from_snapshot(stock_price_df, snapshot_df)
        ddf["stock_last_px"] = ddf["sprice"]
    
    ddf = compute_stock_momentum_scores(ddf, stock_price_df)
    ddf["stock_mom_score"] = ddf["stock_mom_score"].fillna(0.5)

    ddf["total_score"] = (
        w_ytm * ddf["ytm_rt_score"]
        + w_premium * ddf["premium_rt_score"]
        + w_bond_ytm * ddf["bond_ytm_score"]
        + w_curr_amt * ddf["curr_iss_amt_score"]
        + w_mom * ddf["stock_mom_score"]
        + w_turnover * ddf["turnover_rt_score"]
        + w_price * ddf["price_score"]
    )

    return ddf


def _normalize_redeem_remain_days(val: Any) -> Optional[int]:
    """Normalize redeem_remain_days: -1 → 15 (未触发), NaN/None → None."""
    if val is None or pd.isna(val):
        return None
    try:
        v = int(val)
    except (ValueError, TypeError):
        return None
    if v == -1:
        return 15
    return v


def filter_bonds(ddf1: pd.DataFrame, config: Dict[str, Any]) -> pd.DataFrame:
    """Filter bonds according to turnover, price, premium, rating, redeem days etc."""

    ddf2 = ddf1.copy()
    ddf2 = ddf2[ddf2["year_left"] > config["year_left"]]
    ddf2 = ddf2[ddf2["turnover_rt"] > config["min_turnover_rt"]]
    ddf2 = ddf2[ddf2["price"] <= config["max_price"]]
    ddf2 = ddf2[ddf2["premium_rt"] <= config["max_premium_rt"]]
    ddf2 = ddf2[ddf2["rating_cd"].str.contains(config["rating_pattern"], na=False)]
    ddf2 = ddf2[~ddf2["stock_nm"].str.contains("st", case=False, na=False)]

    # 强赎过滤：redeem_remain_days == 0 表示已进入强赎，直接过滤掉
    if "redeem_remain_days" in ddf2.columns:
        ddf2 = ddf2[ddf2["redeem_remain_days"] != 0]

    # 强赎持续天数 = 15 - redeem_remain_days（-1 视为 15 天剩余）
    if "redeem_remain_days" in ddf2.columns:
        ddf2["redeem_ongoing_days"] = ddf2["redeem_remain_days"].apply(
            lambda x: 15 - _normalize_redeem_remain_days(x) if _normalize_redeem_remain_days(x) is not None else None
        )
        min_redeem_days = config.get("min_redeem_days", 0)
        if min_redeem_days > 0:
            # 保留条件：
            # 1. redeem_ongoing_days 为空（无数据）
            # 2. redeem_ongoing_days < min_redeem_days（严格小于上限）
            # 3. redeem_ongoing_days == min_redeem_days 且 正股价 <= 强赎触发价（等于上限但未实质触发）
            frp = pd.to_numeric(ddf2["force_redeem_price"], errors="coerce")
            sp = pd.to_numeric(ddf2["sprice"], errors="coerce")
            keep_mask = (
                ddf2["redeem_ongoing_days"].isna()
                | (ddf2["redeem_ongoing_days"] < min_redeem_days)
                | (
                    (ddf2["redeem_ongoing_days"] == min_redeem_days)
                    & (sp <= frp)
                )
            )
            ddf2 = ddf2[keep_mask]

    # 涨幅上限过滤（仅保留涨幅 ≤ max_increase_rt 的债）
    max_increase_rt = config.get("max_increase_rt", 0)
    if "increase_rt" in ddf2.columns and max_increase_rt > 0:
        ddf2["increase_rt"] = pd.to_numeric(ddf2["increase_rt"], errors="coerce")
        ddf2 = ddf2[ddf2["increase_rt"] <= max_increase_rt]

    frp = pd.to_numeric(ddf2["force_redeem_price"], errors="coerce")
    ddf2["满足强赎"] = ddf2["sprice"] / frp.replace(0, np.nan)
    return ddf2


def apply_exclusions(selected_bonds: pd.DataFrame, config: Dict[str, Any]) -> pd.DataFrame:
    """Apply exclusion list from config to selected bonds."""

    selected_bonds = selected_bonds.copy()
    pai = config.get("exclude_bond_ids", [])
    if pai:
        selected_bonds = selected_bonds[~selected_bonds["bond_id"].isin(pai)]
    selected_bonds.reset_index(drop=True, inplace=True)
    selected_bonds["bond_nm"] = selected_bonds["bond_nm"] + "_" + selected_bonds.index.astype(str)
    return selected_bonds


def get_stock_price_data(bonds_df: pd.DataFrame, end_date: Any, count: int = 60) -> pd.DataFrame:
    """Fetch stock price history for all unique stock_id in bonds_df.

    为避免在同一交易日内对同一批股票重复抓取 60 日 K 线，这里引入一个
    简单的按交易日缓存 + 增量抓取策略：

    - 当天第一次调用（或缓存失效）：抓取当前所有需要的 stock_id 的 60 日数据，写入缓存。
    - 当天后续调用：
      - 如缓存已覆盖所有所需 stock_id，则直接从缓存中切片返回；
      - 如当前股票集合比缓存更大，则仅对“新增的 stock_id”增量抓取，并与缓存合并后返回。
    """
    global _stock_price_cache_date, _stock_price_cache_df, _stock_price_fetch_mode

    stock_ids = bonds_df.get("stock_id")
    if stock_ids is None:
        raise ValueError("bonds_df中未找到stock_id字段")

    unique_ids = stock_ids.dropna().astype(str).str.zfill(6).unique()
    if len(unique_ids) == 0:
        return pd.DataFrame()

    today = datetime.now().date()
    cache: Optional[pd.DataFrame] = None

    # 默认认为是纯缓存命中，后续分支中如有实际抓取再覆盖
    _stock_price_fetch_mode = "cache_only"

    # 如缓存是当日的，则尝试复用
    if _stock_price_cache_date == today and _stock_price_cache_df is not None:
        cache = _stock_price_cache_df

    # 若无当日缓存，或缓存为空，则视为当天首次调用：全量抓取
    if cache is None or cache.empty:
        _stock_price_fetch_mode = "full"
        data = fetch_kline_data(unique_ids, data_count=count)
        if data.empty:
            return data

        # 显式增加 stock_id 列，方便后续切片与增量判断
        data["stock_id"] = data["code"].astype(str).str[:6]

        _stock_price_cache_date = today
        _stock_price_cache_df = data.copy()
        return data

    # 走到这里说明有当日缓存，先确保缓存中有 stock_id 列
    if "stock_id" not in cache.columns:
        if "code" not in cache.columns:
            # 保险起见，无法识别股票时退化为全量重抓
            _stock_price_fetch_mode = "full"
            data = fetch_kline_data(unique_ids, data_count=count)
            if data.empty:
                return data
            data["stock_id"] = data["code"].astype(str).str[:6]
            _stock_price_cache_date = today
            _stock_price_cache_df = data.copy()
            return data

        cache = cache.copy()
        cache["stock_id"] = cache["code"].astype(str).str[:6]
        _stock_price_cache_df = cache

    cached_ids = set(cache["stock_id"].dropna().astype(str).unique())
    missing_ids = [sid for sid in unique_ids if sid not in cached_ids]

    # 如存在新增的 stock_id，仅对增量部分抓取 60 日 K 线并合并到缓存
    if missing_ids:
        _stock_price_fetch_mode = "incremental"
        new_data = fetch_kline_data(missing_ids, data_count=count)
        if not new_data.empty:
            new_data["stock_id"] = new_data["code"].astype(str).str[:6]
            cache = pd.concat([cache, new_data], ignore_index=True)
            _stock_price_cache_df = cache.copy()

    # 最终对外仅返回当前请求所需股票的 K 线切片
    return cache[cache["stock_id"].isin(unique_ids)].copy()

def _apply_latest_close_from_snapshot(
    stock_price_df: pd.DataFrame,
    snapshot_df: pd.DataFrame,
) -> pd.DataFrame:
    """Update the last close price per stock_id using latest snapshot data.
 
    - stock_price_df: 历史 K 线数据，包含 code/stock_id/date/close 等列。
    - snapshot_df: 全市场最新行情快照，至少包含 stock_id 和 last_px。
 
    函数会在每个 stock_id 内找到 date 最大的一行，将其 close 替换为
    snapshot 中对应的 last_px，从而在不重抓 60 日历史的前提下，让
    动量计算使用最新价格。
    """
 
    if stock_price_df.empty or snapshot_df.empty:
        return stock_price_df
 
    df = stock_price_df.copy()
 
    # 确保存在 stock_id 列
    if "stock_id" not in df.columns:
        if "code" not in df.columns:
            return df
        df["stock_id"] = df["code"].astype(str).str[:6]
 
    if "stock_id" not in snapshot_df.columns or "last_px" not in snapshot_df.columns:
        return df
 
    snap = snapshot_df[["stock_id", "last_px"]].dropna()
    if snap.empty:
        return df
 
    # 构建 stock_id -> last_px 映射
    last_px_map = (
        snap.dropna(subset=["stock_id", "last_px"])
        .assign(stock_id=lambda x: x["stock_id"].astype(str))
        .set_index("stock_id")["last_px"]
        .to_dict()
    )
 
    if not last_px_map:
        return df
 
    # 逐个 stock_id 更新其最新一行的 close
    if "date" in df.columns:
        # 使用 date 最大的一行作为最新 K 线
        for sid, last_close in last_px_map.items():
            mask = df["stock_id"] == sid
            if not mask.any():
                continue
            sub = df.loc[mask]
            try:
                idx = sub["date"].idxmax()
            except Exception:
                idx = sub.index.max()
            df.at[idx, "close"] = last_close
    else:
        # 没有 date 列时，退化为更新索引最大的那一行
        for sid, last_close in last_px_map.items():
            mask = df["stock_id"] == sid
            if not mask.any():
                continue
            idx = df.index[mask].max()
            df.at[idx, "close"] = last_close
 
    return df

def compute_stock_momentum_scores(bonds_df: pd.DataFrame, stock_price_df: pd.DataFrame) -> pd.DataFrame:
    """Compute 10-day and 60-day momentum scores for each bond based on the underlying stock."""

    if stock_price_df.empty:
        bonds_scored = bonds_df.copy()
        bonds_scored["mom10"] = np.nan
        bonds_scored["mom60"] = np.nan
        bonds_scored["mom10_score"] = np.nan
        bonds_scored["mom60_score"] = np.nan
        bonds_scored["stock_mom_score"] = np.nan
        return bonds_scored

    if "close" not in stock_price_df.columns:
        raise ValueError("stock_price_df中未找到close列")

    sp = stock_price_df.copy()

    if "code" not in sp.columns:
        raise ValueError("stock_price_df中未找到code列，无法识别股票")

    sp["stock_id"] = sp["code"].astype(str).str[:6]
    sp = sp.sort_index()

    def _calc_mom(group: pd.DataFrame) -> pd.Series:
        closes = group["close"].dropna()
        if closes.empty:
            return pd.Series({"mom10": np.nan, "mom60": np.nan})

        closes = closes.sort_index()
        c0 = closes.iloc[-1]

        if len(closes) >= 10:
            c10 = closes.iloc[-10]
        else:
            c10 = closes.iloc[0]

        if len(closes) >= 60:
            c60 = closes.iloc[-60]
        else:
            c60 = closes.iloc[0]

        mom10 = c0 / c10 - 1 if c10 != 0 else np.nan
        mom60 = c0 / c60 - 1 if c60 != 0 else np.nan
        return pd.Series({"mom10": mom10, "mom60": mom60})

    mom_df = sp.groupby("stock_id").apply(_calc_mom).reset_index()

    bonds_scored = bonds_df.copy()
    if "stock_id" not in bonds_scored.columns:
        raise ValueError("bonds_df中未找到stock_id列，无法合并动量得分")

    bonds_scored = bonds_scored.merge(mom_df, on="stock_id", how="left")

    if "mom10" in bonds_scored.columns:
        bonds_scored["mom10_score"] = bonds_scored["mom10"].rank(pct=True)
    else:
        bonds_scored["mom10_score"] = np.nan

    if "mom60" in bonds_scored.columns:
        bonds_scored["mom60_score"] = bonds_scored["mom60"].rank(pct=True)
    else:
        bonds_scored["mom60_score"] = np.nan

    bonds_scored["stock_mom_score"] = 0.5 * bonds_scored["mom10_score"] + 0.5 * bonds_scored["mom60_score"]

    return bonds_scored


def compute_trade_suggestions(
    all_bonds_df: pd.DataFrame,
    selected_bonds_df: pd.DataFrame,
    hold_ids: List[str],
) -> Dict[str, pd.DataFrame]:
    """Compute sell and buy suggestion tables based on current holdings.

    all_bonds_df: full bond list with at least bond_id, bond_nm, price, increase_rt.
    selected_bonds_df: scored and filtered bonds sorted by total_score.
    hold_ids: list of bond_id that are currently held.
    """

    hold_set = {str(bid) for bid in hold_ids}

    top20 = selected_bonds_df.head(20)
    top20_ids = set(top20["bond_id"].astype(str))

    to_sell_ids = hold_set - top20_ids
    to_buy_ids = top20_ids - hold_set

    sell_source = all_bonds_df if "bond_id" in all_bonds_df.columns else selected_bonds_df

    sell_table = (
        sell_source[sell_source["bond_id"].astype(str).isin(to_sell_ids)]
        .loc[:, ["bond_id", "bond_nm", "price", "increase_rt"]]
        .assign(action="卖出")
    )

    buy_table = (
        top20[top20["bond_id"].astype(str).isin(to_buy_ids)]
        .loc[:, ["bond_id", "bond_nm", "price", "increase_rt"]]
        .assign(action="买入")
    )

    return {"sell": sell_table, "buy": buy_table}


def run_pipeline(config_overrides: Dict[str, Any], hold_ids: Optional[List[str]] = None, jisilu_cookie: Optional[str] = None) -> Dict[str, Any]:
    """Main pipeline used by the API layer.

    - Merge default CONFIG with overrides from the request.
    - Fetch bond list and redeem info.
    - Filter, score, and select Top N bonds.
    - Apply exclusions and generate trade suggestions based on hold_ids.
    - Return structured dict suitable for ScreenResult.
    """

    settings = get_settings()
    base_config = settings.default_config

    config = _merge_config(base_config, config_overrides)

    logger.info("Running pipeline with config overrides: %s", list(config_overrides.keys()))

    # 1. Fetch base bond list and redeem info
    ddf = login_and_fetch_bond_list(config, jisilu_cookie=jisilu_cookie)
    df_redeem = fetch_redeem_info_cached(config)
    ddf1 = pd.merge(ddf, df_redeem, on="bond_id", how="left")

    # 2. Filter and score
    ddf2 = filter_bonds(ddf1, config)
    ddf2 = compute_scores(ddf2, config)

    selected_bonds = ddf2.sort_values("total_score", ascending=False).head(config["top_n"])

    # treat 满足强赎 字段 same as apk.py: values < 1 shown as empty string
    selected_bonds["满足强赎"] = selected_bonds["满足强赎"].where(selected_bonds["满足强赎"] >= 1, "")

    selected_bonds = apply_exclusions(selected_bonds, config)

    # 3. Trade suggestions based on hold_ids
    hold_ids = hold_ids or []
    suggestions = compute_trade_suggestions(ddf1, selected_bonds, hold_ids)

    sell_table = suggestions["sell"]
    buy_table = suggestions["buy"]

    # 将 K 线抓取模式转成易读字符串放入 summary
    mode_display: Optional[str]
    if _stock_price_fetch_mode == "full":
        mode_display = "全量抓取"
    elif _stock_price_fetch_mode == "incremental":
        mode_display = "增量抓取+合并"
    elif _stock_price_fetch_mode == "cache_only":
        mode_display = "命中缓存"
    else:
        mode_display = None

    summary = {
        "total_bonds": int(ddf1.shape[0]),
        "selected_count": int(selected_bonds.shape[0]),
        "config_used": config,
        "kline_fetch_mode": mode_display,
    }

    

    # 构建输出列，包含 redeem_ongoing_days（如存在）
    _output_cols = [
        "bond_id", "bond_nm", "price", "increase_rt", "bond_value",
        "premium_rt", "ytm_rt", "stock_last_px", "total_score",
        "year_left", "turnover_rt", "rating_cd", "curr_iss_amt",
        "redeem_icon", "满足强赎", "redeem_status", "redeem_ongoing_days",
        "force_redeem_price",
        "stock_mom_score", "curr_iss_amt_score", "bond_ytm_score",
        "premium_rt_score", "price_score", "ytm_rt_score",
    ]
    _available_cols = [c for c in _output_cols if c in selected_bonds.columns]
    result_df = selected_bonds[_available_cols]

    # Replace NaN/inf in DataFrames with None so that final JSON is standards-compliant.
    # json.dumps with allow_nan=False (Starlette default) does not accept NaN/Infinity.
    result_df = result_df.replace({np.inf: np.nan, -np.inf: np.nan})
    # float columns cannot hold Python None (stored back as NaN); cast to object first.
    for col in result_df.select_dtypes(include=["float"]).columns:
        result_df[col] = result_df[col].astype(object)
    result_df = result_df.where(pd.notna(result_df), None)

    sell_table_clean = sell_table.replace({np.inf: np.nan, -np.inf: np.nan})
    for col in sell_table_clean.select_dtypes(include=["float"]).columns:
        sell_table_clean[col] = sell_table_clean[col].astype(object)
    sell_table_clean = sell_table_clean.where(pd.notna(sell_table_clean), None)

    buy_table_clean = buy_table.replace({np.inf: np.nan, -np.inf: np.nan})
    for col in buy_table_clean.select_dtypes(include=["float"]).columns:
        buy_table_clean[col] = buy_table_clean[col].astype(object)
    buy_table_clean = buy_table_clean.where(pd.notna(buy_table_clean), None)

    # Also guard summary against accidental NaN/inf
    def _clean_scalar(v: Any) -> Any:
        if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
            return None
        return v

    summary = {k: _clean_scalar(v) for k, v in summary.items()}

    return {
        "summary": summary,
        "result": result_df.to_dict(orient="records"),
        "sell": sell_table_clean.to_dict(orient="records"),
        "buy": buy_table_clean.to_dict(orient="records"),
    }


def save_snapshot_parquet(
    ddf: pd.DataFrame,
    output_dir: Optional[str] = None,
) -> str:
    """Save the merged bond+redeem DataFrame as a parquet snapshot.

    Columns are aligned with snapshot_merged.parquet format where possible.
    Returns the absolute path of the saved file.
    """

    today = datetime.now().date()
    snapshot_df = ddf.copy()

    # Ensure date column is present
    if "date" not in snapshot_df.columns:
        snapshot_df["date"] = today

    # Build aligned output with column names matching snapshot_merged.parquet
    out = pd.DataFrame()

    # --- direct mappings from ddf1 ---
    _direct = {
        "bond_id": "bond_id",
        "date": "date",
        "price": "jsl_price",
        "volume": "jsl_volume",
        "sprice": "jsl_sprice",
        "curr_iss_amt": "jsl_curr_iss_amt",
        "ytm_rt": "jsl_ytm_rt",
        "premium_rt": "jsl_premium_rt",
        "turnover_rt": "jsl_turnover_rt",
        "stock_id": "stock_id",
        "stock_nm": "stock_nm",
        "bond_value": "bond_value",
        "force_redeem_price": "强赎价格",
        "year_left": "剩余年限",
        "maturity_dt": "到期日",
        "increase_rt": "pct_chg",
    }
    for src, dst in _direct.items():
        if src in snapshot_df.columns:
            out[dst] = snapshot_df[src]

    # --- computed columns ---
    out["bond_id"] = out["bond_id"].astype(str)

    if "stock_nm" in snapshot_df.columns:
        out["is_st"] = (
            snapshot_df["stock_nm"]
            .astype(str)
            .str.contains("st", case=False, na=False)
            .astype(int)
        )

    if "price" in snapshot_df.columns and "bond_value" in snapshot_df.columns:
        bv = pd.to_numeric(snapshot_df["bond_value"], errors="coerce")
        pr = pd.to_numeric(snapshot_df["price"], errors="coerce")
        out["bond_over_rate"] = (pr / bv.replace(0, np.nan) - 1) * 100

    if "sprice" in snapshot_df.columns and "force_redeem_price" in snapshot_df.columns:
        sp = pd.to_numeric(snapshot_df["sprice"], errors="coerce")
        frp = pd.to_numeric(snapshot_df["force_redeem_price"], errors="coerce")
        out["转股价_tt"] = frp
        # cb_value = 100 / 转股价 * 正股价
        out["cb_value"] = 100.0 / frp.replace(0, np.nan) * sp

    if "rating_cd" in snapshot_df.columns:
        _rating_map = {"AAA": 3, "AA+": 2.5, "AA": 2, "AA-": 1.5, "A+": 1, "A": 0.5, "A-": 0, "BBB+": -0.5}
        out["rating_num"] = snapshot_df["rating_cd"].map(_rating_map)

    if "increase_rt" in snapshot_df.columns:
        out["pct_chg"] = pd.to_numeric(snapshot_df["increase_rt"], errors="coerce")

    out["jsl_amt_change"] = np.nan
    out["jsl_convert_value"] = np.nan
    out["jsl_stock_volume"] = np.nan

    out["cflg"] = "Y"
    out["bqflg"] = "Y"

    # --- redeem derived fields ---
    if "redeem_remain_days" in snapshot_df.columns:
        rrd = pd.to_numeric(snapshot_df["redeem_remain_days"], errors="coerce")
        out["_scnt"] = rrd
        out["_cnt"] = rrd.where(rrd > 0, np.nan)
        out["is_redeem"] = (rrd == 0).astype(int)
        out["redeem_30"] = ((rrd > 0) & (rrd <= 30)).astype(int)
        out["no_redeem"] = (rrd == -1).astype(int)

    if "redeem_status" in snapshot_df.columns:
        rs = snapshot_df["redeem_status"].astype(str)
        out["_type"] = rs.replace({"": np.nan, "nan": np.nan})
        # Mark bonds currently in redemption
        out["is_redeem"] = out.get("is_redeem", pd.Series(0, index=out.index))

    if "redeem_icon" in snapshot_df.columns:
        ri = snapshot_df["redeem_icon"].astype(str)
        out["_start_dt"] = ri.replace({"": np.nan, "nan": np.nan})
        out["_end_dt"] = np.nan
        out["_skip_dt"] = np.nan

    out["convert_price_tips"] = np.nan
    out["到期债"] = 0
    out["最后交易日"] = np.nan
    out["high"] = np.nan
    out["low"] = np.nan

    # Ensure all numeric columns have sensible dtypes
    for col in out.columns:
        if col in ("bond_id", "stock_id", "stock_nm", "cflg", "bqflg",
                    "_type", "_start_dt", "_end_dt", "_skip_dt", "convert_price_tips",
                    "到期日", "最后交易日"):
            continue
        if col == "date" or col.endswith("_dt"):
            continue
        out[col] = pd.to_numeric(out[col], errors="coerce")

    # Determine output path
    if output_dir is None:
        settings = get_settings()
        output_dir = settings.snapshot_dir
    os.makedirs(output_dir, exist_ok=True)

    filename = f"snapshot_{today.strftime('%Y%m%d')}.parquet"
    filepath = os.path.join(output_dir, filename)

    out.to_parquet(filepath, index=False)
    logger.info("Saved snapshot parquet: %s (%d bonds)", filepath, len(out))
    return filepath


def _merge_config(base_config: Dict[str, Any], overrides: Dict[str, Any]) -> Dict[str, Any]:
    """Merge request-level overrides into the base CONFIG.

    - Simple scalar fields are overwritten directly.
    - factor_weights is merged per-key.
    """

    config = dict(base_config)

    # Factor weights require special handling
    factor_overrides = overrides.pop("factor_weights", None)
    if factor_overrides:
        merged_weights = dict(config.get("factor_weights", {}))
        for key, value in factor_overrides.items():
            if value is not None:
                merged_weights[key] = value
        config["factor_weights"] = merged_weights

    for key, value in overrides.items():
        if value is not None:
            config[key] = value

    return config


def _load_cookies(session: rq.Session, cookie_file: str) -> None:
    """Load cookies from local CSV file into the session if present."""

    if not cookie_file:
        return
    if not os.path.exists(cookie_file):
        return
    try:
        import csv

        with open(cookie_file, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if not row.get("name"):
                    continue
                session.cookies.set(
                    name=row["name"],
                    value=row.get("value", ""),
                    domain=row.get("domain") or None,
                    path=row.get("path") or "/",
                )
    except Exception as exc:  # pragma: no cover - best effort only
        logger.warning("Failed to load cookies from %s: %s", cookie_file, exc)


def _save_cookies(session: rq.Session, cookie_file: str) -> None:
    """Persist current session cookies to a local CSV file."""

    if not cookie_file:
        return
    try:
        import csv

        fieldnames = ["name", "value", "domain", "path"]
        with open(cookie_file, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for cookie in session.cookies:  # type: ignore[attr-defined]
                writer.writerow(
                    {
                        "name": cookie.name,
                        "value": cookie.value,
                        "domain": cookie.domain,
                        "path": cookie.path,
                    }
                )
    except Exception as exc:  # pragma: no cover - best effort only
        logger.warning("Failed to save cookies to %s: %s", cookie_file, exc)
