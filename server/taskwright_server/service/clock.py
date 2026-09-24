"""时间一律给带时区的 ISO 8601 文字。

库里记的是本机的挂钟时间文字（例如 2026-09-21T18:56:34.219，没有时区），pi 会话条目记的是世界时
（例如 2026-09-22T01:56:44.120Z），两种都换成本机时区、精确到秒。
"""

from __future__ import annotations

import datetime as _dt


def now() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def from_local_text(text: str | None) -> str | None:
    """库里的本地时间文字 → 带时区的 ISO 8601。"""
    if not text:
        return None
    try:
        return _dt.datetime.fromisoformat(text).astimezone().isoformat(timespec="seconds")
    except ValueError:
        return text


def from_utc_iso(text: str | None) -> str | None:
    """pi 会话条目的世界时 → 本机时区的 ISO 8601。"""
    if not text:
        return None
    try:
        return _dt.datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone().isoformat(timespec="seconds")
    except ValueError:
        return text


def from_epoch(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    return _dt.datetime.fromtimestamp(seconds).astimezone().isoformat(timespec="seconds")


def parse_utc_iso(text: str | None) -> float | None:
    """pi 会话条目的世界时 → 秒数（用来算一次工作用了多久）。解析不了返回 None。"""
    if not text:
        return None
    try:
        return _dt.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
