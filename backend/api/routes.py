from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import json
import re
import time
from urllib.parse import urlencode

import numpy as np
import requests as rq

from backend.config.settings import get_settings
from backend.core.logic import clear_caches, run_pipeline, save_snapshot_parquet
from backend.core.logic import login_and_fetch_bond_list, fetch_redeem_info_cached
import pandas as pd

router = APIRouter()


# ---------- Pydantic models ----------


class FactorWeights(BaseModel):
    ytm_rt: Optional[float] = Field(None)
    premium_rt: Optional[float] = Field(None)
    bond_ytm: Optional[float] = Field(None)
    curr_iss_amt: Optional[float] = Field(None)
    stock_mom: Optional[float] = Field(None)
    turnover_rt: Optional[float] = Field(None)
    price: Optional[float] = Field(None)


class ScreenRequest(BaseModel):
    max_price: Optional[float] = Field(None)
    max_premium_rt: Optional[float] = Field(None)
    min_turnover_rt: Optional[float] = Field(None)
    year_left: Optional[float] = Field(None)
    rating_pattern: Optional[str] = Field(None)
    top_n: Optional[int] = Field(None, ge=1)
    min_redeem_days: Optional[int] = Field(None, ge=0)
    max_increase_rt: Optional[float] = Field(None, ge=0)

    exclude_bond_ids: Optional[List[str]] = Field(None)
    factor_weights: Optional[FactorWeights] = Field(None)
    hold_ids: Optional[List[str]] = Field(None)
    jisilu_cookie: Optional[str] = Field(None)


class BondItem(BaseModel):
    bond_id: str
    bond_nm: str
    price: float
    increase_rt: float
    bond_value: Optional[float] = Field(None)
    premium_rt: float
    ytm_rt: Optional[float] = Field(None)
    stock_last_px: Optional[float] = Field(None)
    total_score: Optional[float] = Field(None)
    year_left: Optional[float] = Field(None)
    turnover_rt: Optional[float] = Field(None)
    rating_cd: Optional[str] = Field(None)
    curr_iss_amt: Optional[float] = Field(None)
    redeem_icon: Optional[str] = Field(None)
    满足强赎: Optional[Union[str, float]] = Field(None)
    redeem_status: Optional[str] = Field(None)
    redeem_ongoing_days: Optional[int] = Field(None)
    force_redeem_price: Optional[float] = Field(None)
    stock_mom_score: Optional[float] = Field(None)
    curr_iss_amt_score: Optional[float] = Field(None)
    bond_ytm_score: Optional[float] = Field(None)
    premium_rt_score: Optional[float] = Field(None)
    ytm_rt_score: Optional[float] = Field(None)


class TradeSuggestionItem(BaseModel):
    bond_id: str
    bond_nm: str
    price: float
    increase_rt: float
    action: str


class Summary(BaseModel):
    total_bonds: int
    selected_count: int
    config_used: Dict[str, Any]
    kline_fetch_mode: Optional[str] = Field(None)


class ScreenResult(BaseModel):
    summary: Summary
    result: List[BondItem]
    sell: List[TradeSuggestionItem]
    buy: List[TradeSuggestionItem]


class ErrorResponse(BaseModel):
    error_code: str
    message: str


class SnapshotRequest(BaseModel):
    jisilu_cookie: Optional[str] = Field(None)


class SnapshotResponse(BaseModel):
    success: bool
    message: str
    filepath: Optional[str] = Field(None)
    bond_count: Optional[int] = Field(None)


# ---------- Routes ----------


@router.get("/health")
async def health() -> Dict[str, Any]:
    """Lightweight health check endpoint.

    It validates that configuration can be loaded and returns basic status
    information. It does not call external services to remain fast.
    """

    status = "ok"
    warnings: List[str] = []

    try:
        settings = get_settings()
        _ = settings.default_config
    except Exception as exc:  # pragma: no cover - defensive
        status = "degraded"
        warnings.append(f"Configuration error: {exc}")

    return {
        "status": status,
        "server_time": datetime.now().isoformat(),
        "version": "1.0.0",
        "warnings": warnings or None,
    }


@router.post("/bonds/cache/clear")
async def clear_cache() -> Dict[str, Any]:
    """Clear all in-memory caches so the next screening fetches fresh data."""
    clear_caches()
    return {"status": "ok", "message": "缓存已清除，下次选股将重新抓取数据"}


@router.post("/bonds/snapshot/save", response_model=SnapshotResponse, responses={
    400: {"model": ErrorResponse},
    500: {"model": ErrorResponse},
})
async def save_snapshot(payload: SnapshotRequest) -> SnapshotResponse:
    """Save today's merged Jisilu bond data as a parquet snapshot.

    Fetches the full bond list and redeem info using the current session,
    merges them, and saves as a parquet file for backtesting.
    """

    settings = get_settings()
    config = settings.default_config
    jisilu_cookie = payload.jisilu_cookie

    try:
        ddf = login_and_fetch_bond_list(config, jisilu_cookie=jisilu_cookie)
        df_redeem = fetch_redeem_info_cached(config)
        ddf1 = pd.merge(ddf, df_redeem, on="bond_id", how="left")

        filepath = save_snapshot_parquet(ddf1)
        return SnapshotResponse(
            success=True,
            message="快照已保存",
            filepath=filepath,
            bond_count=int(ddf1.shape[0]),
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "SNAPSHOT_ERROR", "message": str(exc)},
        ) from exc


@router.post("/bonds/screen", response_model=ScreenResult, responses={
    400: {"model": ErrorResponse},
    502: {"model": ErrorResponse},
    500: {"model": ErrorResponse},
})
async def screen_bonds(payload: ScreenRequest) -> ScreenResult:
    """Synchronous screening endpoint.

    Accepts screening conditions from the frontend, runs the core pipeline,
    and returns structured results.
    """

    # Build overrides dict from request (excluding None values)
    overrides: Dict[str, Any] = {}
    if payload.max_price is not None:
        overrides["max_price"] = payload.max_price
    if payload.max_premium_rt is not None:
        overrides["max_premium_rt"] = payload.max_premium_rt
    if payload.min_turnover_rt is not None:
        overrides["min_turnover_rt"] = payload.min_turnover_rt
    if payload.year_left is not None:
        overrides["year_left"] = payload.year_left
    if payload.rating_pattern is not None:
        overrides["rating_pattern"] = payload.rating_pattern
    if payload.top_n is not None:
        overrides["top_n"] = payload.top_n
    if payload.min_redeem_days is not None:
        overrides["min_redeem_days"] = payload.min_redeem_days
    if payload.max_increase_rt is not None:
        overrides["max_increase_rt"] = payload.max_increase_rt
    if payload.exclude_bond_ids is not None:
        overrides["exclude_bond_ids"] = payload.exclude_bond_ids

    if payload.factor_weights is not None:
        fw = payload.factor_weights.dict(exclude_none=True)
        if fw:
            overrides["factor_weights"] = fw

    hold_ids = payload.hold_ids or []

    try:
        result = run_pipeline(overrides, hold_ids=hold_ids, jisilu_cookie=payload.jisilu_cookie)
        return ScreenResult(**result)  # type: ignore[arg-type]
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(
            status_code=502,
            detail={"error_code": "UPSTREAM_ERROR", "message": str(exc)},
        ) from exc
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(
            status_code=500,
            detail={"error_code": "INTERNAL_ERROR", "message": str(exc)},
        ) from exc


# ---------- Jisilu proxy endpoints (ported from Next.js API routes) ----------

_JISILU_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


class JisiluLoginRequest(BaseModel):
    user_name: str
    password: str


class JisiluBondsRequest(BaseModel):
    cookie: str
    scoreConfig: Optional[Dict[str, Any]] = Field(None)


def _get_set_cookies(headers: Any) -> List[str]:
    """Extract Set-Cookie headers from a requests response."""
    if hasattr(headers, "getall"):
        return headers.getall("set-cookie")
    raw = headers.get("set-cookie")
    if not raw:
        return []
    return re.split(r",(?=[^;]+?=)", raw)


def _parse_cookie_header(cookie_header: str) -> Dict[str, str]:
    """Parse a Cookie header string into a dict of name=value."""
    result: Dict[str, str] = {}
    parts = cookie_header.split(";")
    for part in parts:
        part = part.strip()
        if not part:
            continue
        idx = part.find("=")
        if idx <= 0:
            continue
        name = part[:idx].strip()
        value = part[idx + 1:]
        result[name] = value
    return result


def _cookies_from_set_cookie(set_cookies: List[str]) -> Dict[str, str]:
    """Convert Set-Cookie headers to a dict of name=value."""
    result: Dict[str, str] = {}
    for sc in set_cookies:
        pair = sc.split(";", 1)[0].strip()
        if not pair:
            continue
        idx = pair.find("=")
        if idx <= 0:
            continue
        name = pair[:idx].strip()
        value = pair[idx + 1:]
        result[name] = value
    return result


def _cookie_map_to_header(cookies: Dict[str, str]) -> str:
    """Convert a cookie dict to a Cookie header value."""
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


@router.post("/jisilu/login")
async def jisilu_login(payload: JisiluLoginRequest) -> Dict[str, Any]:
    """Proxy login to Jisilu.cn (ported from Next.js /api/jisilu/login)."""
    try:
        if not payload.user_name or not payload.password:
            raise HTTPException(
                status_code=400,
                detail={"error_code": "MISSING_CREDENTIALS", "message": "缺少用户名或密码"},
            )

        session = rq.Session()

        # Pre-fetch to get initial cookies
        pre_resp = session.get(
            "https://www.jisilu.cn/",
            headers={
                "User-Agent": _JISILU_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            timeout=15,
        )

        # Login
        login_url = "https://www.jisilu.cn/webapi/account/login_process/"
        params = {
            "return_url": "https://www.jisilu.cn/",
            "user_name": payload.user_name,
            "password": payload.password,
            "aes": "1",
            "auto_login": "1",
        }

        resp = session.post(
            login_url,
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": _JISILU_UA,
                "X-Requested-With": "XMLHttpRequest",
                "Origin": "https://www.jisilu.cn",
                "Referer": "https://www.jisilu.cn/",
            },
            data=params,
            timeout=15,
        )

        # Check for login failure in JSON response
        try:
            json_data = resp.json()
            if json_data.get("code") == 413:
                return {
                    "success": False,
                    "message": json_data.get("msg", "手机号/用户名或密码不一致"),
                }
        except Exception:
            pass

        # Merge cookies
        pre_cookies = _cookies_from_set_cookie(_get_set_cookies(pre_resp.headers))
        login_cookies = _cookies_from_set_cookie(_get_set_cookies(resp.headers))
        merged = {**pre_cookies, **login_cookies}

        cookie_header = _cookie_map_to_header(merged)
        if not cookie_header:
            raise HTTPException(
                status_code=500,
                detail={"error_code": "LOGIN_NO_COOKIE", "message": "登录可能成功，但未获得 Cookie"},
            )

        return {"success": True, "message": "登录成功", "cookie": cookie_header}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "LOGIN_ERROR", "message": str(e)},
        ) from e


@router.post("/jisilu/bonds")
async def jisilu_bonds(payload: JisiluBondsRequest) -> Dict[str, Any]:
    """Proxy bond data fetch from Jisilu.cn (ported from Next.js /api/jisilu/bonds).

    Returns ALL bonds with basic scoring for the portfolio monitoring view.
    """
    try:
        if not payload.cookie:
            return {"success": False, "message": "缺少 Cookie，请先登录集思录"}

        cookie = payload.cookie
        score_config_raw = payload.scoreConfig
        settings = get_settings()
        config = settings.default_config
        http_timeout = settings.http_timeout_seconds

        # Parse score config from request body
        from backend.core.logic import compute_scores as compute_scores_logic

        timestamp = int(time.time() * 1000)
        base_url = f"https://www.jisilu.cn/data/cbnew/cb_list_new/?___jsl=LST___t={timestamp}"

        base_cookies = _parse_cookie_header(cookie)

        session = rq.Session()

        # Pre-fetch to warm up session cookies
        pre_resp = session.get(
            "https://www.jisilu.cn/data/cbnew/",
            headers={
                "User-Agent": _JISILU_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Origin": "https://www.jisilu.cn",
                "Referer": "https://www.jisilu.cn/",
                "Cookie": cookie,
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            },
            timeout=http_timeout,
        )
        pre_cookies = _cookies_from_set_cookie(_get_set_cookies(pre_resp.headers))
        merged = {**base_cookies, **pre_cookies}
        merged_cookie = _cookie_map_to_header(merged)

        # Fetch redeem info
        def _fetch_redeem_map() -> Dict[str, Dict[str, Any]]:
            url = f"https://www.jisilu.cn/webapi/cb/redeem/?___t={int(time.time() * 1000)}"
            resp = session.get(
                url,
                headers={
                    "User-Agent": _JISILU_UA,
                    "X-Requested-With": "XMLHttpRequest",
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Origin": "https://www.jisilu.cn",
                    "Referer": "https://www.jisilu.cn/data/cbnew/",
                    "Cookie": merged_cookie,
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                },
                timeout=http_timeout,
            )
            if not resp.ok:
                return {}

            text = resp.text
            try:
                data = json.loads(text)
            except Exception:
                data = text

            rows: List[Any] = []
            if isinstance(data, dict):
                rows = data.get("rows", data.get("data", {}).get("rows", data.get("data", [])))
            elif isinstance(data, list):
                rows = data

            result: Dict[str, Dict[str, Any]] = {}
            for row in rows:
                item = row.get("cell", row)
                bond_id = str(item.get("bond_id", item.get("id", "")))
                if not bond_id:
                    continue
                result[bond_id] = {
                    "redeem_status": str(item.get("redeem_status", item.get("redeemStatus", ""))),
                    "redeem_icon": str(item.get("redeem_icon", item.get("redeemIcon", ""))),
                    "redeem_remain_days": (
                        int(item["redeem_remain_days"])
                        if item.get("redeem_remain_days") is not None
                        else None
                    ),
                }
            return result

        redeem_map: Dict[str, Dict[str, Any]] = {}
        try:
            redeem_map = _fetch_redeem_map()
        except Exception:
            pass

        # Paginated fetch of bond list
        rp = 30
        all_rows: List[Dict[str, Any]] = []
        seen_ids: set = set()
        total: Optional[int] = None

        def _fetch_page(page: int) -> Optional[dict]:
            url = f"{base_url}&page={page}&rp={rp}"
            body = {"page": str(page), "rp": str(rp)}
            resp = session.post(
                url,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "User-Agent": _JISILU_UA,
                    "X-Requested-With": "XMLHttpRequest",
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Origin": "https://www.jisilu.cn",
                    "Referer": "https://www.jisilu.cn/data/cbnew/",
                    "Cookie": merged_cookie,
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                },
                data=urlencode(body),
                timeout=http_timeout,
            )
            if not resp.ok:
                return None
            try:
                return resp.json()
            except Exception:
                return None

        page = 1
        while page <= 200:
            data = _fetch_page(page)
            if data is None:
                return {
                    "success": False,
                    "message": f"网络错误: 第 {page} 页请求失败",
                }

            page_rows = data.get("rows") or []
            if total is None and isinstance(data.get("total"), int):
                total = data["total"]

            if len(page_rows) == 0:
                break

            if isinstance(data, str) and "登录" in data:
                return {
                    "success": False,
                    "message": "Cookie 无效或会话已过期，请重新登录",
                }

            for row in page_rows:
                item = row.get("cell", row)
                bond_id = str(item.get("bond_id", item.get("id", "")))
                if not bond_id:
                    all_rows.append(row)
                    continue
                if bond_id in seen_ids:
                    continue
                seen_ids.add(bond_id)
                all_rows.append(row)

            if total is not None and len(all_rows) >= total:
                break

            page += 1

        # Helper: safe parse float
        def _safe_float(val: Any) -> float:
            if isinstance(val, (int, float)):
                return float(val)
            if isinstance(val, str):
                parsed = float(val.replace("%", "")) if val else 0.0
                return parsed if not np.isnan(parsed) else 0.0
            return 0.0

        # Score series helper (percentile rank, same as Next.js frontend logic)
        def _score_series(values: List[Optional[float]], larger_better: bool) -> List[float]:
            scored = [0.0] * len(values)
            rows_list = [(i, v) for i, v in enumerate(values) if v is not None]
            n = len(rows_list)
            if n == 0:
                return scored
            rows_list.sort(key=lambda x: x[1])
            i = 0
            while i < n:
                j = i + 1
                while j < n and rows_list[j][1] == rows_list[i][1]:
                    j += 1
                rank_avg = (i + 1 + j) / 2.0
                pct = rank_avg / n
                s = pct if larger_better else 1.0 - pct
                for k in range(i, j):
                    scored[rows_list[k][0]] = s
                i = j
            return scored

        # Build bond list
        bonds: List[Dict[str, Any]] = []
        for row in all_rows:
            item = row.get("cell", row)

            bond_value = _safe_float(item.get("bond_value", 0))
            price = _safe_float(item.get("price", 0))
            pure_bond_premium = ((price - bond_value) / bond_value * 100) if bond_value > 0 else 0.0

            redeem = redeem_map.get(str(item.get("bond_id", item.get("id", ""))), {})
            redeem_remain = redeem.get("redeem_remain_days")
            if redeem_remain is not None:
                normalized = 15 if redeem_remain == -1 else redeem_remain
                redeem_ongoing = 15 - normalized
            else:
                redeem_ongoing = None

            bonds.append({
                "id": str(item.get("bond_id", "")),
                "code": str(item.get("bond_id", "")),
                "name": str(item.get("bond_nm", "")),
                "price": price,
                "priceChange": _safe_float(item.get("increase_rt", 0)),
                "premiumRate": _safe_float(item.get("premium_rt", 0)),
                "stockId": str(item.get("stock_id", "")),
                "stockName": str(item.get("stock_nm", "")),
                "stockPrice": _safe_float(item.get("sprice", 0)),
                "stockChange": _safe_float(item.get("sincrease_rt", 0)),
                "listDate": str(item.get("list_dt", "")),
                "bondValue": bond_value,
                "pureBondPremiumRate": pure_bond_premium,
                "redeemStatus": redeem.get("redeem_status"),
                "redeemIcon": redeem.get("redeem_icon"),
                "redeemOngoingDays": redeem_ongoing,
                "rating": str(item.get("rating_cd", "")),
                "forceRedeemPrice": _safe_float(item.get("force_redeem_price", 0)),
                "maturityDate": str(item.get("maturity_dt", "")),
                "remainingYear": _safe_float(item.get("year_left", 0)),
                "currIssAmt": _safe_float(item.get("curr_iss_amt", 0)),
                "volume": _safe_float(item.get("volume", item.get("vol_in_2", 0))),
                "turnoverRate": _safe_float(item.get("turnover_rt", 0)),
                "ytmRt": _safe_float(item.get("ytm_rt", 0)),
                "doubleLow": _safe_float(item.get("dblow", 0)),
            })

        # Apply scoring if config is provided
        if score_config_raw and isinstance(score_config_raw, dict):
            factors = score_config_raw.get("factors", {})
            f_ytm = factors.get("ytmRt", {})
            f_prem = factors.get("premiumRate", {})
            f_amt = factors.get("currIssAmt", {})
            f_pure = factors.get("pureBondPremiumRate", {})

            w_ytm = f_ytm.get("weight", 1.0) if f_ytm.get("enabled", True) else 0.0
            w_prem = f_prem.get("weight", 1.0) if f_prem.get("enabled", True) else 0.0
            w_amt = f_amt.get("weight", 1.0) if f_amt.get("enabled", True) else 0.0
            w_pure = f_pure.get("weight", 1.0) if f_pure.get("enabled", True) else 0.0

            s_ytm = _score_series([b.get("ytmRt") for b in bonds], f_ytm.get("largerBetter", True))
            s_prem = _score_series([b.get("premiumRate") for b in bonds], f_prem.get("largerBetter", False))
            s_amt = _score_series([b.get("currIssAmt") for b in bonds], f_amt.get("largerBetter", False))
            s_pure = _score_series([b.get("pureBondPremiumRate") for b in bonds], f_pure.get("largerBetter", False))

            for idx, b in enumerate(bonds):
                b["sYtm"] = s_ytm[idx]
                b["sPrem"] = s_prem[idx]
                b["sAmt"] = s_amt[idx]
                b["sPureOr"] = s_pure[idx]
                b["totalScore"] = (
                    s_ytm[idx] * w_ytm
                    + s_prem[idx] * w_prem
                    + s_amt[idx] * w_amt
                    + s_pure[idx] * w_pure
                )

        bonds.sort(key=lambda b: b.get("doubleLow", 999))

        return {"success": True, "count": len(bonds), "bonds": bonds}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "BONDS_ERROR", "message": str(e)},
        ) from e
