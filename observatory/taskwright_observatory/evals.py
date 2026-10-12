"""评测：读模拟器的评测命令（sim/evals.py）写在演练根目录下的结果，给观测台的三个页面与命令行的对照用。只读。

演练根目录（sim-root）里与评测有关的文件：
- evals.jsonl：每次评测一行（时间、标签、提交号、模型、材料、画像、清单、遍数、各灯通过率、清单命中率、各遍目录）；
- 评测汇总_<标签>.json：一次评测的完整结果（每盏灯每一遍的结果、清单每一组每一遍命中与否、助手问过的问题、
  模拟用户答不上的问题）；旁边同名的 .md 是给人直接读的同一份内容。
评测按标签找，标签在一个演练根目录里不重复。

对照：两次评测并排，每盏灯与清单的每一组各写两个数与差值。灯比的是通过率（通过的遍数比上能算的遍数），清单比的是命中的
遍数比上核对的遍数。后一次比前一次低就是变差。有一边没有能算的遍时不比，差值为空。
"""

from __future__ import annotations

import json
from pathlib import Path

from taskwright_observatory.shared import shorten_home

LIST_FILE = "evals.jsonl"
SUMMARY_PREFIX = "评测汇总_"

NO_ROOT = "启动观测台时没有给演练根目录（--sim-root），所以这里没有评测可看。"


class EvalNotFound(LookupError):
    """没有这次评测。"""


def read_list(root: Path | None) -> dict:
    """评测列表，新的在前。没有给演练根目录时「有没有演练根目录」为假，并带一句说明。"""
    if root is None:
        return {"有没有演练根目录": False, "说明": NO_ROOT, "评测": []}
    path = Path(root) / LIST_FILE
    rows = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return {"有没有演练根目录": True, "演练根目录": shorten_home(str(root)), "说明": "", "评测": rows[::-1]}


def read_detail(root: Path | None, label: str) -> dict:
    """一次评测的完整结果。"""
    if root is None:
        raise EvalNotFound(NO_ROOT)
    path = Path(root) / f"{SUMMARY_PREFIX}{label}.json"
    if "/" in label or "\\" in label or not path.is_file():
        raise EvalNotFound(f"找不到评测「{label}」。")
    return json.loads(path.read_text(encoding="utf-8"))


def _rate(done: int, of: int) -> float | None:
    return done / of if of else None


def _side(done: int, of: int) -> dict:
    return {"分子": done, "分母": of, "比率": _rate(done, of)}


def _delta(a: dict | None, b: dict | None) -> tuple[float | None, bool]:
    """差值（后一次减前一次）与是不是变差。有一边没有能算的遍时不比。"""
    if not a or not b or a["比率"] is None or b["比率"] is None:
        return None, False
    delta = b["比率"] - a["比率"]
    return delta, delta < -1e-9


def compare(root: Path | None, first: str, second: str) -> dict:
    """两次评测的对照：first 在前（通常是早的那一次），second 在后。"""
    a, b = read_detail(root, first), read_detail(root, second)
    head = lambda s: {key: s.get(key) for key in ("标签", "时间", "提交号", "模型", "材料", "画像", "清单", "遍数", "轮数上限", "灯通过率", "清单命中率")}  # noqa: E731
    lamps_b = {row["键"]: row for row in b["灯"]}
    lamp_rows = []
    for row in a["灯"]:
        other = lamps_b.pop(row["键"], None)
        one, two = _side(row["通过遍数"], row["能算的遍数"]), (_side(other["通过遍数"], other["能算的遍数"]) if other else None)
        delta, worse = _delta(one, two)
        lamp_rows.append({"阶段": row["阶段"], "键": row["键"], "说明": row["说明"], "前": one, "后": two, "差值": delta, "变差": worse})
    for row in lamps_b.values():                                 # 只有后一次有的灯
        lamp_rows.append({"阶段": row["阶段"], "键": row["键"], "说明": row["说明"], "前": None,
                          "后": _side(row["通过遍数"], row["能算的遍数"]), "差值": None, "变差": False})
    key = lambda row: (row["部分"], tuple(row["组"]))            # noqa: E731
    groups_b = {key(row): row for row in b["至少应有"]}
    group_rows = []
    for row in a["至少应有"]:
        other = groups_b.pop(key(row), None)
        one, two = _side(row["命中遍数"], row["核对的遍数"]), (_side(other["命中遍数"], other["核对的遍数"]) if other else None)
        delta, worse = _delta(one, two)
        group_rows.append({"部分": row["部分"], **_shown(other or row), "组": row["组"], "前": one, "后": two, "差值": delta, "变差": worse})
    for row in groups_b.values():
        group_rows.append({"部分": row["部分"], **_shown(row), "组": row["组"], "前": None, "后": _side(row["命中遍数"], row["核对的遍数"]),
                           "差值": None, "变差": False})
    notes = []
    for name in ("材料", "画像", "清单"):
        if a.get(name) != b.get(name):
            notes.append(f"两次评测的{name}不同（前一次是 {_show(a.get(name))}，后一次是 {_show(b.get(name))}），数字不能直接比。")
    return {"前": head(a), "后": head(b), "提醒": notes, "灯": lamp_rows, "至少应有": group_rows,
            "变差的灯": sum(1 for row in lamp_rows if row["变差"]), "变差的组": sum(1 for row in group_rows if row["变差"])}


def _shown(row: dict) -> dict:
    """清单里一行给人看的「部分」（「模型」一节有：「部分」写图的种类的键，「部分名」写种类的名字）；没有时什么都不带。"""
    return {"部分名": row["部分名"]} if row.get("部分名") else {}


def _show(value) -> str:
    return "、".join(value) if isinstance(value, list) else str(value)


def _cell(side: dict | None) -> str:
    if side is None:
        return "没有这一项"
    return f"{side['分子']}／{side['分母']}" + ("" if side["比率"] is None else f"（{round(side['比率'] * 100)}%）")


def _delta_cell(row: dict) -> str:
    if row["差值"] is None:
        return "不比"
    points = round(row["差值"] * 100)
    return ("持平" if points == 0 else f"{'+' if points > 0 else '−'}{abs(points)} 个百分点") + ("，**变差**" if row["变差"] else "")


def compare_markdown(data: dict) -> str:
    """对照写成一段 Markdown：页头、每盏灯一行、清单每组一行。"""
    a, b = data["前"], data["后"]
    percent = lambda rate: "没有能算的" if rate is None else f"{round(rate * 100)}%"      # noqa: E731
    lines = [f"# 评测对照：{a['标签']} 与 {b['标签']}", "",
             f"- 前一次「{a['标签']}」：{a.get('时间')}，提交 {(a.get('提交号') or '没有记')[:12]}，{a.get('遍数')} 遍，灯通过率 {percent(a.get('灯通过率'))}，清单命中率 {percent(a.get('清单命中率'))}",
             f"- 后一次「{b['标签']}」：{b.get('时间')}，提交 {(b.get('提交号') or '没有记')[:12]}，{b.get('遍数')} 遍，灯通过率 {percent(b.get('灯通过率'))}，清单命中率 {percent(b.get('清单命中率'))}",
             f"- 变差的灯有 {data['变差的灯']} 盏，清单里变差的组有 {data['变差的组']} 组。"]
    lines += [f"- 提醒：{note}" for note in data["提醒"]]
    lines += ["", "## 灯", "", "每格是「通过的遍数／能算的遍数」。", "", f"| 阶段 | 灯 | {a['标签']} | {b['标签']} | 差值 |", "|---|---|---|---|---|"]
    lines += [f"| {row['阶段']} | {row['说明']} | {_cell(row['前'])} | {_cell(row['后'])} | {_delta_cell(row)} |" for row in data["灯"]]
    lines += ["", "## 至少应有", "", "每格是「命中的遍数／核对的遍数」。", "", f"| 部分 | 关键词组 | {a['标签']} | {b['标签']} | 差值 |", "|---|---|---|---|---|"]
    lines += [f"| {row.get('部分名') or row['部分']} | {'／'.join(row['组'])} | {_cell(row['前'])} | {_cell(row['后'])} | {_delta_cell(row)} |" for row in data["至少应有"]]
    return "\n".join(lines) + "\n"
