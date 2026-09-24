"""工具的中文显示名。

这是一份可改的映射配置，不是代码里的常量：界面上要把 `save_version` 显示成
「保存版本（save_version）」就在 `tool_names.json` 里加一行。表里查不到的工具，
界面只显示它的英文标识，不编一个中文名出来。
"""

from __future__ import annotations

import json
from pathlib import Path

CONFIG = Path(__file__).resolve().parent / "tool_names.json"


def load_tool_names() -> dict[str, str]:
    """读工具中文名映射。文件不在或读不懂时返回空表，界面照样能用，只是没有中文名。"""
    try:
        value = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {str(k): str(v) for k, v in value.items() if isinstance(value, dict)}
