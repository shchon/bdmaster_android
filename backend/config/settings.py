from __future__ import annotations

from functools import lru_cache
from typing import Any, Dict

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables.

    This object is the single source of truth for backend configuration.
    """

    # Pydantic v2 settings configuration
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # Jisilu account hashes (required)
    jsl_username_hash: str = Field(..., env="JSL_USERNAME_HASH")
    jsl_password_hash: str = Field(..., env="JSL_PASSWORD_HASH")

    # Optional overrides for default screening parameters
    bonds_default_max_price: float = Field(500)
    bonds_default_max_premium_rt: float = Field(25, env="BONDS_DEFAULT_MAX_PREMIUM_RT")
    bonds_default_min_turnover_rt: float = Field(1, env="BONDS_DEFAULT_MIN_TURNOVER_RT")
    bonds_default_year_left: float = Field(0.5, env="BONDS_DEFAULT_YEAR_LEFT")
    bonds_default_rating_pattern: str = Field("A", env="BONDS_DEFAULT_RATING_PATTERN")
    bonds_default_top_n: int = Field(70, env="BONDS_DEFAULT_TOP_N")

    bonds_default_factor_weight_ytm_rt: float = Field(1.0, env="BONDS_DEFAULT_FACTOR_WEIGHT_YTM_RT")
    bonds_default_factor_weight_premium_rt: float = Field(1.0, env="BONDS_DEFAULT_FACTOR_WEIGHT_PREMIUM_RT")
    bonds_default_factor_weight_bond_ytm: float = Field(1.0, env="BONDS_DEFAULT_FACTOR_WEIGHT_BOND_YTM")
    bonds_default_factor_weight_curr_iss_amt: float = Field(1.0, env="BONDS_DEFAULT_FACTOR_WEIGHT_CURR_ISS_AMT")
    bonds_default_factor_weight_stock_mom: float = Field(1.0, env="BONDS_DEFAULT_FACTOR_WEIGHT_STOCK_MOM")
    bonds_default_factor_weight_turnover_rt: float = Field(1.0, env="BONDS_DEFAULT_FACTOR_WEIGHT_TURNOVER_RT")
    bonds_default_factor_weight_price: float = Field(1.0, env="BONDS_DEFAULT_FACTOR_WEIGHT_PRICE")

    # 强赎天数过滤默认值，0 表示不过滤（不强赎=0天也会通过）
    bonds_default_min_redeem_days: int = Field(0, env="BONDS_DEFAULT_MIN_REDEEM_DAYS")

    # 涨幅上限过滤默认值，仅保留涨幅 ≤ 该值的可转债
    bonds_default_max_increase_rt: float = Field(96.0, env="BONDS_DEFAULT_MAX_INCREASE_RT")

    http_timeout_seconds: float = Field(10.0, env="BONDS_HTTP_TIMEOUT_SECONDS")

    snapshot_dir: str = Field("snapshots", env="BONDS_SNAPSHOT_DIR")

    log_level: str = Field("INFO", env="BONDS_LOG_LEVEL")

    @property
    def default_config(self) -> Dict[str, Any]:
        """Return the base CONFIG dict equivalent to apk.py's CONFIG.

        Environment variables may override some of the numeric defaults, but
        the overall structure must remain compatible with the legacy script
        so that results stay nearly identical.
        """

        return {
            "url": "https://www.jisilu.cn/data/cbnew/cb_list_new/?___jsl=LST___t=1647874922105",
            "url_login": "https://www.jisilu.cn/webapi/account/login_process/",
            "url_redeem": "https://www.jisilu.cn/webapi/cb/redeem/",
            "login_data": {
                "user_name": self.jsl_username_hash,
                "password": self.jsl_password_hash,
                "aes": 1,
                "auto_login": 1,
            },
            "header": {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/99.0.4844.51 Safari/537.36 Edg/99.0.1150.30"
                )
            },
            "min_turnover_rt": self.bonds_default_min_turnover_rt,
            "max_price": self.bonds_default_max_price,
            "max_premium_rt": self.bonds_default_max_premium_rt,
            "rating_pattern": self.bonds_default_rating_pattern,
            "top_n": self.bonds_default_top_n,
            "year_left": self.bonds_default_year_left,
            # Exclusion list defaults to empty; callers may override per request
            "exclude_bond_ids": [],
            "max_increase_rt": self.bonds_default_max_increase_rt,
            "cookie_file": "jisilu_cookies.csv",
            "factor_weights": {
                "ytm_rt": self.bonds_default_factor_weight_ytm_rt,
                "premium_rt": self.bonds_default_factor_weight_premium_rt,
                "bond_ytm": self.bonds_default_factor_weight_bond_ytm,
                "curr_iss_amt": self.bonds_default_factor_weight_curr_iss_amt,
                "stock_mom": self.bonds_default_factor_weight_stock_mom,
                "turnover_rt": self.bonds_default_factor_weight_turnover_rt,
                "price": self.bonds_default_factor_weight_price,
            },
            "min_redeem_days": self.bonds_default_min_redeem_days,
            "http_timeout_seconds": self.http_timeout_seconds,
        }


@lru_cache()
def get_settings() -> Settings:
    """Return a cached Settings instance.

    Using lru_cache ensures we only parse environment variables once.
    """

    return Settings()
