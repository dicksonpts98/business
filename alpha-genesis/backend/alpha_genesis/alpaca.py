"""Alpaca Market Data v2 client and month-partitioned history store.

Credentials come only from APCA_API_KEY_ID / APCA_API_SECRET_KEY in the environment (or are injected at the
network layer by a secrets proxy, in which case this code sends no credential at all). They are never
logged, written to disk, or placed in a URL. Historical data only; no trading endpoints are used here."""
from __future__ import annotations
import hashlib, json, time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import httpx
import pandas as pd
from . import mcal, quality
from .providers import Provider

BASE = "https://data.alpaca.markets"


class AlpacaError(RuntimeError):
    pass


class AlpacaAuthError(AlpacaError):
    pass


class AlpacaEntitlementError(AlpacaError):
    """Authenticated, but the subscription does not permit this request (e.g. recent SIP data on Basic)."""


class AlpacaClient:
    def __init__(self, key_id: str | None, secret: str | None, transport: httpx.BaseTransport | None = None,
                 max_retries: int = 5, sleep=time.sleep, timeout_s: float = 60.0):
        headers = {"Accept": "application/json", "User-Agent": "alpha-genesis/0.1"}
        self.auth_mode = "environment" if (key_id and secret) else "network-injected"
        if key_id and secret:
            headers["APCA-API-KEY-ID"], headers["APCA-API-SECRET-KEY"] = key_id, secret
        self.http = httpx.Client(base_url=BASE, headers=headers, timeout=timeout_s, transport=transport)
        self.max_retries, self._sleep = max_retries, sleep
        self.requests = self.retries = 0
        self.rate_remaining: int | None = None

    def get(self, path: str, params: dict) -> dict:
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            self.requests += 1
            try:
                r = self.http.get(path, params={k: v for k, v in params.items() if v is not None})
            except httpx.HTTPError as e:                      # connection drop / timeout: retry with backoff
                if attempt == self.max_retries:
                    raise AlpacaError(f"network error after {attempt + 1} attempts: {type(e).__name__}") from e
                self.retries += 1
                self._sleep(delay); delay = min(delay * 2, 60)
                continue
            rem = r.headers.get("x-ratelimit-remaining")
            self.rate_remaining = int(rem) if rem and rem.isdigit() else self.rate_remaining
            if r.status_code == 200:
                return r.json()
            msg = _message(r)
            if r.status_code == 401:
                raise AlpacaAuthError(f"401 not authenticated ({msg}). Alpaca expects the APCA-API-KEY-ID and APCA-API-SECRET-KEY headers.")
            if r.status_code == 403:
                raise AlpacaEntitlementError(f"403 {msg}")
            if r.status_code == 422 and "subscription" in msg.lower():
                raise AlpacaEntitlementError(f"422 {msg}")
            if r.status_code == 429 or r.status_code >= 500:
                if attempt == self.max_retries:
                    raise AlpacaError(f"{r.status_code} after {attempt + 1} attempts: {msg}")
                wait = delay
                ra, reset = r.headers.get("retry-after"), r.headers.get("x-ratelimit-reset")
                if ra and ra.replace(".", "").isdigit():
                    wait = float(ra)
                elif r.status_code == 429 and reset and reset.isdigit():
                    wait = max(1.0, min(65.0, int(reset) - time.time()))
                self.retries += 1
                self._sleep(wait); delay = min(delay * 2, 60)
                continue
            raise AlpacaError(f"{r.status_code} {msg}")
        raise AlpacaError("unreachable")

    def bars(self, symbol: str, start: datetime, end: datetime, feed: str = "sip", timeframe: str = "5Min") -> pd.DataFrame:
        """All bars in [start, end), following next_page_token until exhausted."""
        rows, token, pages = [], None, 0
        while True:
            js = self.get(f"/v2/stocks/{symbol}/bars", {"timeframe": timeframe, "start": start.isoformat(), "end": end.isoformat(), "limit": 10000,
                                                         "adjustment": "split", "feed": feed, "sort": "asc", "page_token": token})
            pages += 1
            rows += js.get("bars") or []
            token = js.get("next_page_token")
            if not token:
                break
            if pages > 500:
                raise AlpacaError("pagination did not terminate")
        df = pd.DataFrame([{"timestamp": b["t"], "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": b["v"]} for b in rows],
                          columns=["timestamp", "open", "high", "low", "close", "volume"])
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        return df

    def splits(self, symbols: list[str], start: date, end: date) -> list[dict]:
        js = self.get("/v1/corporate-actions", {"symbols": ",".join(symbols), "types": "forward_split,reverse_split", "start": start.isoformat(), "end": end.isoformat(), "limit": 1000})
        ca = js.get("corporate_actions") or {}
        out = []
        for kind in ("forward_splits", "reverse_splits"):
            for a in ca.get(kind) or []:
                out.append({"symbol": a.get("symbol"), "ex_date": a.get("ex_date"), "kind": kind[:-1], "new_rate": a.get("new_rate"), "old_rate": a.get("old_rate")})
        return out


def _message(r: httpx.Response) -> str:
    """Server-provided error text only (never request headers), trimmed."""
    try:
        return str(r.json().get("message", ""))[:240]
    except Exception:
        t = r.text
        return (t[t.find("<title>") + 7:t.find("</title>")] if "<title>" in t else t)[:120]


def _months(start: date, end: date) -> list[str]:
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


class AlpacaHistory(Provider):
    """Provider backed by a local month-partitioned Parquet cache of Alpaca bars.

    <root>/<SYMBOL>/<YYYY-MM>.parquet + manifest.json (rows, sha256, feed, first/last bar, fetched_at).
    A month is fetched once; only months not yet complete (the current one) are refreshed, so updates
    are incremental and repeatable. If the preferred feed is refused, the exact server message is kept
    in the manifest and the next permitted feed is used — never synthetic data."""
    name, verified = "alpaca", False

    def __init__(self, root: Path, client: AlpacaClient, feeds: tuple[str, ...] = ("sip", "iex"), fx=None, today: date | None = None):
        self.root, self.client, self.feeds, self.fx = Path(root), client, feeds, fx
        self.root.mkdir(parents=True, exist_ok=True)
        self._today = today
        self._mem: dict[tuple[str, str], pd.DataFrame] = {}
        mf = self.root / "manifest.json"
        self.manifest = json.loads(mf.read_text()) if mf.exists() else {"months": {}, "restrictions": [], "splits": [], "feed_used": {}}

    @property
    def today(self) -> date:
        return self._today or datetime.now(timezone.utc).date()

    def _save_manifest(self):
        tmp = self.root / "manifest.tmp"
        tmp.write_text(json.dumps(self.manifest, indent=1, sort_keys=True))
        tmp.replace(self.root / "manifest.json")

    def _fetch_month(self, sym: str, month: str) -> pd.DataFrame:
        y, m = map(int, month.split("-"))
        start = datetime(y, m, 1, tzinfo=timezone.utc)
        end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=timezone.utc)
        # Basic plans may not query the most recent 15 minutes of SIP data: stay clear of the live edge.
        end = min(end, datetime.now(timezone.utc) - timedelta(minutes=20)) if self._today is None else end
        last_err = None
        for feed in self.feeds:
            try:
                df = self.client.bars(sym, start, end, feed)
            except AlpacaEntitlementError as e:
                last_err = e
                note = {"symbol": sym, "month": month, "feed": feed, "error": str(e)}
                if note not in self.manifest["restrictions"]:
                    self.manifest["restrictions"].append(note)
                continue
            self.manifest["feed_used"][f"{sym}/{month}"] = feed
            return df
        self._save_manifest()
        raise AlpacaEntitlementError(f"{sym} {month}: no permitted feed among {self.feeds}: {last_err}")

    def month(self, sym: str, month: str) -> pd.DataFrame:
        """Regular-session 5-minute bars of one month (UTC bar-open timestamps), from cache when complete."""
        key = (sym, month)
        if key in self._mem:
            return self._mem[key]
        p = self.root / sym / f"{month}.parquet"
        meta = self.manifest["months"].get(f"{sym}/{month}")
        complete = meta is not None and meta.get("complete")
        if p.exists() and complete:
            if hashlib.sha256(p.read_bytes()).hexdigest() != meta["sha256"]:
                raise IOError(f"cached file {p} does not match its recorded checksum; delete it to re-download")
            df = pd.read_parquet(p)
        else:
            raw = self._fetch_month(sym, month)
            n_raw = len(raw)
            raw = raw.drop_duplicates("timestamp").sort_values("timestamp")
            keep = [mcal.bar_index(t.to_pydatetime()) is not None for t in raw["timestamp"]]      # regular session, on the 5-minute grid
            df = raw[keep].reset_index(drop=True)
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            df.to_parquet(tmp, index=False)
            tmp.replace(p)
            y, m = map(int, month.split("-"))
            month_end = date(y + (m == 12), m % 12 + 1, 1)
            self.manifest["months"][f"{sym}/{month}"] = {
                "rows": int(len(df)), "raw_rows": int(n_raw), "duplicates_removed": int(n_raw - raw.shape[0]), "outside_session_removed": int(raw.shape[0] - len(df)),
                "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "feed": self.manifest["feed_used"].get(f"{sym}/{month}"),
                "first": df["timestamp"].iloc[0].isoformat() if len(df) else None, "last": df["timestamp"].iloc[-1].isoformat() if len(df) else None,
                "complete": bool(self.today >= month_end + timedelta(days=1)), "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            self._save_manifest()
        df = df.assign(symbol=sym)
        self._mem[key] = df
        return df

    def update(self, symbols: list[str], start: date, end: date | None = None, log=lambda *_: None) -> dict:
        """Download whatever is missing in [start, end]. Safe to re-run; resumes after an interruption."""
        end = end or self.today
        before = self.client.requests
        for sym in symbols:
            for mth in _months(start, end):
                had = self.manifest["months"].get(f"{sym}/{mth}", {}).get("complete")
                self.month(sym, mth)
                if not had:
                    log(f"alpaca: {sym} {mth} -> {self.manifest['months'][f'{sym}/{mth}']['rows']} bars ({self.manifest['feed_used'].get(f'{sym}/{mth}')})")
        try:
            self.manifest["splits"] = self.client.splits(symbols, start, end)
        except AlpacaError as e:
            self.manifest["splits_error"] = str(e)
        self._save_manifest()
        return {"requests": self.client.requests - before, "retries": self.client.retries, "summary": self.summary(symbols)}

    def summary(self, symbols: list[str]) -> dict:
        out = {}
        for sym in symbols:
            ms = {k.split("/")[1]: v for k, v in self.manifest["months"].items() if k.startswith(sym + "/")}
            if ms:
                out[sym] = {"months": len(ms), "bars": sum(v["rows"] for v in ms.values()), "first": min(v["first"] for v in ms.values() if v["first"]),
                            "last": max(v["last"] for v in ms.values() if v["last"]), "feeds": sorted({v["feed"] for v in ms.values() if v["feed"]}),
                            "duplicates_removed": sum(v["duplicates_removed"] for v in ms.values())}
        return {"symbols": out, "restrictions": self.manifest["restrictions"], "splits": self.manifest.get("splits", []), "auth": self.client.auth_mode}

    def all_days(self, symbols: list[str], start: date, end: date) -> list[date]:
        days = set()
        for sym in symbols:
            for mth in _months(start, end):
                df = self.month(sym, mth)
                days |= set(df["timestamp"].dt.tz_convert("America/New_York").dt.date)
        return sorted(d for d in days if start <= d <= end and mcal.is_trading_day(d))

    # -- Provider interface ------------------------------------------------------------
    def fetch_session(self, day, symbols):
        out = []
        for sym in symbols:
            df = self.month(sym, f"{day:%Y-%m}")
            out.append(df[df["timestamp"].dt.tz_convert("America/New_York").dt.date == day])
        return pd.concat(out, ignore_index=True) if out else pd.DataFrame()

    def fetch_fx(self, day):
        return self.fx.rate_before(day) if self.fx else None

    def next_session(self, after):
        nxt = mcal.next_trading_day(after)
        s = mcal.session(nxt)
        if self._today is not None:                       # fixed clock (tests, replays)
            return nxt if nxt <= self._today else None
        return nxt if datetime.now(timezone.utc) >= s[1] + timedelta(minutes=30) else None     # completed = closed 30+ minutes ago


class BankOfCanadaFx:
    """Official daily USD/CAD from the Bank of Canada Valet API (free, no key). Cached on disk; a session
    is sized with the latest rate published strictly before that session's date."""
    URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json"

    def __init__(self, cache: Path, transport: httpx.BaseTransport | None = None):
        self.cache, self.transport = Path(cache), transport
        self.df = pd.read_parquet(self.cache) if self.cache.exists() else pd.DataFrame(columns=["date", "rate"])

    def update(self, start: date, end: date | None = None) -> int:
        have = self.df["date"].max() if len(self.df) else None
        frm = max(start, have - timedelta(days=5)) if have is not None and (not len(self.df) or self.df["date"].min() <= start + timedelta(days=7)) else start
        r = httpx.Client(transport=self.transport, timeout=60, headers={"User-Agent": "alpha-genesis/0.1"}).get(
            self.URL, params={"start_date": frm.isoformat(), **({"end_date": end.isoformat()} if end else {})})
        if r.status_code != 200:
            raise quality.DataError(f"Bank of Canada rates request failed: HTTP {r.status_code}")
        obs = [(date.fromisoformat(o["d"]), float(o["FXUSDCAD"]["v"])) for o in r.json().get("observations", []) if o.get("FXUSDCAD", {}).get("v")]
        new = pd.DataFrame(obs, columns=["date", "rate"])
        bad = new[(new["rate"] < 0.9) | (new["rate"] > 1.8)]
        if len(bad):
            raise quality.DataError(f"implausible USD/CAD values from source: {bad.head(3).to_dict('records')}")
        self.df = pd.concat([self.df, new]).drop_duplicates("date", keep="last").sort_values("date").reset_index(drop=True)
        self.cache.parent.mkdir(parents=True, exist_ok=True)
        self.df.to_parquet(self.cache, index=False)
        return len(new)

    def rate_before(self, day: date):
        d = self.df[self.df["date"] < day]
        return (float(d["rate"].iloc[-1]), d["date"].iloc[-1]) if len(d) else None
