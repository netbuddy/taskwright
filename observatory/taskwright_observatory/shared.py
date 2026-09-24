"""几样各个读取模块都要用的小工具：时间写法、路径缩写、取不到时说「未知」。

这里不放任何与任务内容有关的知识，也不写死任何字段名、工具名与任务名。
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path

#: 取不到依据时统一用这个词，界面上按「未知」显示，不猜也不填默认值。
UNKNOWN = "未知"


def shorten_home(text: str) -> str:
    """把路径里用户家目录那一段换成一个波浪号，免得界面上出现又长又与本机绑定的路径。"""
    if not text:
        return text
    home = str(Path.home())
    return text.replace(home, "~")


def local_time(epoch_seconds: float | None) -> str:
    """把一个时间戳写成本地时间「年-月-日 时:分:秒」。给空值就返回空串。"""
    if epoch_seconds is None:
        return ""
    return _dt.datetime.fromtimestamp(epoch_seconds).strftime("%Y-%m-%d %H:%M:%S")


def local_clock(epoch_seconds: float | None) -> str:
    """把一个时间戳写成本地时间「时:分:秒」，用在一行里放不下完整时间的地方。"""
    if epoch_seconds is None:
        return ""
    return _dt.datetime.fromtimestamp(epoch_seconds).strftime("%H:%M:%S")


def epoch_from_millis(value) -> float | None:
    """pi 的事件里时间是毫秒整数。换算成秒；不是数就返回空值。"""
    if isinstance(value, (int, float)):
        return float(value) / 1000.0
    return None


def epoch_from_iso(text: str | None) -> float | None:
    """把 pi 会话文件里那种以字母 Z 结尾的世界时写法换算成时间戳。"""
    if not text:
        return None
    try:
        return _dt.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def epoch_from_naive_iso(text: str | None) -> float | None:
    """把任务库里那种不带时区的本地时间写法换算成时间戳。"""
    if not text:
        return None
    try:
        return _dt.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def short_id(value: str | None, head: int = 6, tail: int = 4) -> str:
    """把一长串编号缩成「前六位…后四位」，完整值放在悬停提示里。"""
    if not value:
        return ""
    if len(value) <= head + tail + 1:
        return value
    return f"{value[:head]}…{value[-tail:]}"


def text_of_content(content) -> str:
    """pi 的消息内容是一个个小块。把其中的文字块连起来，别的块跳过。"""
    if not isinstance(content, list):
        return ""
    parts = [block.get("text", "") for block in content
             if isinstance(block, dict) and block.get("type") == "text"]
    return "".join(parts).strip()


def tool_calls_of_content(content) -> list[dict]:
    """从一条模型消息里取出它这一次发起的每一次工具调用。"""
    if not isinstance(content, list):
        return []
    return [block for block in content
            if isinstance(block, dict) and block.get("type") == "toolCall"]
