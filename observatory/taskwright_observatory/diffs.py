"""改前改后的文字比对与列表比对。

任务页上「修改」操作的改前改后并排显示，删去的字标成划掉的红底、新增的字标成绿底；文本列表按项比，
配上的项再逐字比。比对放在后端做，是为了能用标准库写单元测试，界面只管按分段上色。
"""

from __future__ import annotations

import re

#: 文字比对时两边各自最多比多少个词块。再长就不逐字比，整段标成删去与新增，免得页面卡住。
MAX_DIFF_TOKENS = 3000


# ───────────────────────── 文字比对与列表比对 ─────────────────────────

_TOKEN = re.compile(r"[A-Za-z0-9_]+|\s+|.", re.S)


def tokenize(text: str) -> list[str]:
    """把一段文字切成比对用的词块：连着的英文字母与数字算一块，空白算一块，其余每个字各算一块。

    中文没有词间空格，按字比最直观；英文与编号按词比，免得一个编号被拆成零碎的几个字母。
    """
    return _TOKEN.findall(text or "")


def _lcs_table(a: list, b: list) -> list[list[int]]:
    n, m = len(a), len(b)
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, below = table[i], table[i + 1]
        for j in range(m - 1, -1, -1):
            row[j] = below[j + 1] + 1 if a[i] == b[j] else max(below[j], row[j + 1])
    return table


def _align(a: list, b: list) -> list[tuple[str, int | None, int | None]]:
    """按最长公共子序列把两串对齐，给出一串（标记，a 里的位置，b 里的位置）。

    标记是「同」「删」「增」三种之一。
    """
    table = _lcs_table(a, b)
    out: list[tuple[str, int | None, int | None]] = []
    i = j = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            out.append(("同", i, j)); i += 1; j += 1
        elif table[i + 1][j] >= table[i][j + 1]:
            out.append(("删", i, None)); i += 1
        else:
            out.append(("增", None, j)); j += 1
    while i < len(a):
        out.append(("删", i, None)); i += 1
    while j < len(b):
        out.append(("增", None, j)); j += 1
    return out


def diff_text(before: str, after: str) -> list[dict]:
    """两段文字的逐字比对，给出一串分段：每段是 {"标记": 同／删／增, "文": …}，相邻同标记的并成一段。

    界面把「删」画成划掉的红底、把「增」画成绿底；改前那一栏只画「同」与「删」，改后那一栏只画「同」与「增」。
    """
    before, after = before or "", after or ""
    a, b = tokenize(before), tokenize(after)
    if len(a) > MAX_DIFF_TOKENS or len(b) > MAX_DIFF_TOKENS:
        parts = []
        if before:
            parts.append({"标记": "删", "文": before})
        if after:
            parts.append({"标记": "增", "文": after})
        return parts
    parts: list[dict] = []
    for mark, i, j in _align(a, b):
        text = a[i] if mark in ("同", "删") else b[j]
        if parts and parts[-1]["标记"] == mark:
            parts[-1]["文"] += text
        else:
            parts.append({"标记": mark, "文": text})
    return parts


def diff_list(before: list, after: list) -> list[dict]:
    """两个文本列表的逐项比对。

    先按整项相同找出没有变的项；两段没变的项之间，删去的与新增的按先后一一配对，配上的算「修改」
    （修改的那一项里再做逐字比对），配不上的剩下的算「删除」或「新增」。
    每一项给出 {"标记": 未变／修改／新增／删除, "改前第几项", "改后第几项", "文" 或 "改前"、"改后"、"段"}。
    """
    before = [str(x) for x in (before or [])]
    after = [str(x) for x in (after or [])]
    steps: list[dict] = []
    gone: list[int] = []
    came: list[int] = []

    def flush():
        paired = min(len(gone), len(came))
        for k in range(paired):
            i, j = gone[k], came[k]
            steps.append({"标记": "修改", "改前第几项": i + 1, "改后第几项": j + 1,
                          "改前": before[i], "改后": after[j], "段": diff_text(before[i], after[j])})
        for i in gone[paired:]:
            steps.append({"标记": "删除", "改前第几项": i + 1, "改后第几项": None, "文": before[i]})
        for j in came[paired:]:
            steps.append({"标记": "新增", "改前第几项": None, "改后第几项": j + 1, "文": after[j]})
        gone.clear()
        came.clear()

    for mark, i, j in _align(before, after):
        if mark == "同":
            flush()
            steps.append({"标记": "未变", "改前第几项": i + 1, "改后第几项": j + 1, "文": before[i]})
        elif mark == "删":
            gone.append(i)
        else:
            came.append(j)
    flush()
    return steps
