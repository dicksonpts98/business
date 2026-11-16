"""US equity exchange calendar (NYSE/Nasdaq regular session), rule-based, timezone-safe.

Timestamps are stored in UTC; sessions are defined in America/New_York so DST is handled
by zoneinfo rather than fixed offsets."""
from __future__ import annotations
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
UTC = timezone.utc
OPEN, CLOSE, EARLY_CLOSE = time(9, 30), time(16, 0), time(13, 0)


def _nth(year, month, weekday, n):
    d = date(year, month, 1)
    d += timedelta(days=(weekday - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def _last(year, month, weekday):
    d = date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def _easter(year):
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return date(year, month, day)


def _observed(d: date) -> date | None:
    if d.weekday() == 5:  # Saturday -> Friday (NYSE skips if that crosses a year end for New Year)
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


@lru_cache(maxsize=None)
def holidays(year: int) -> frozenset[date]:
    hs = set()
    ny = date(year, 1, 1)
    if ny.weekday() == 6:
        hs.add(ny + timedelta(days=1))
    elif ny.weekday() != 5:  # Saturday New Year is not observed on the prior Friday
        hs.add(ny)
    hs.add(_nth(year, 1, 0, 3))            # MLK
    hs.add(_nth(year, 2, 0, 3))            # Presidents
    hs.add(_easter(year) - timedelta(days=2))  # Good Friday
    hs.add(_last(year, 5, 0))              # Memorial
    if year >= 2022:
        hs.add(_observed(date(year, 6, 19)))   # Juneteenth
    hs.add(_observed(date(year, 7, 4)))
    hs.add(_nth(year, 9, 0, 1))            # Labor
    hs.add(_nth(year, 11, 3, 4))           # Thanksgiving
    hs.add(_observed(date(year, 12, 25)))
    return frozenset(hs)


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in holidays(d.year)


def is_early_close(d: date) -> bool:
    if not is_trading_day(d):
        return False
    if d == _nth(d.year, 11, 3, 4) + timedelta(days=1):
        return True
    if (d.month, d.day) == (12, 24):
        return True
    if (d.month, d.day) == (7, 3) and is_trading_day(date(d.year, 7, 4)) is False and d.weekday() < 4:
        return True
    return False


def session(d: date) -> tuple[datetime, datetime] | None:
    """(open, close) as UTC datetimes, or None when the exchange is closed."""
    if not is_trading_day(d):
        return None
    o = datetime.combine(d, OPEN, NY)
    c = datetime.combine(d, EARLY_CLOSE if is_early_close(d) else CLOSE, NY)
    return o.astimezone(UTC), c.astimezone(UTC)


def n_bars(d: date, bar_minutes: int = 5) -> int:
    s = session(d)
    return 0 if s is None else int((s[1] - s[0]).total_seconds() // (bar_minutes * 60))


def trading_days(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if is_trading_day(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def next_trading_day(d: date) -> date:
    d += timedelta(days=1)
    while not is_trading_day(d):
        d += timedelta(days=1)
    return d


def bar_open_utc(d: date, bar: int, bar_minutes: int = 5) -> datetime:
    return (datetime.combine(d, OPEN, NY) + timedelta(minutes=bar * bar_minutes)).astimezone(UTC)


def bar_index(ts_utc: datetime, bar_minutes: int = 5) -> tuple[date, int] | None:
    """Map a UTC bar-open timestamp onto (session date, bar slot); None if outside the regular session."""
    if ts_utc.tzinfo is None:
        raise ValueError("naive timestamp: timezone required")
    loc = ts_utc.astimezone(NY)
    s = session(loc.date())
    if s is None or not (s[0] <= ts_utc < s[1]):
        return None
    mins = (loc.hour * 60 + loc.minute) - (9 * 60 + 30)
    if mins % bar_minutes:
        return None
    return loc.date(), mins // bar_minutes


def is_open(ts_utc: datetime) -> bool:
    s = session(ts_utc.astimezone(NY).date())
    return s is not None and s[0] <= ts_utc < s[1]
