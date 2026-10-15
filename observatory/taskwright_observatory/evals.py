"""评测：读模拟器的评测命令（sim/evals.py）写在演练根目录下的结果，给观测台的三个页面与命令行的对照用。只读。

演练根目录（sim-root）里与评测有关的文件：
- evals.jsonl：每次评测一行（时间、标签、提交号、模型、材料、画像、清单、遍数、各灯通过率、清单命中率、各遍目录）；
- 评测汇总_<标签>.json：一次评测的完整结果（每盏灯每一遍的结果、清单每一组每一遍命中与否、助手问过的问题、
  模拟用户答不上的问题）；旁边同名的 .md 是给人直接读的同一份内容。
评测按标签找，标签在一个演练根目录里不重复。

提示词版本：一遍演练里助手用的是哪一版说明。后端每次启动助手进程时，在事件归档旁边的补记里记下三组文件各自的字节数与内容摘要值：
代码仓里按阶段的说明、代码仓里流程的说明（各节点的出口）、任务目录 .pi/skills 下的文件（任务类型的说明，建任务时复制进任务目录）。这里只读那份补记，
不另算摘要：把每份文件写成「路径、摘要值」一行，按路径排好接起来再取一次摘要，前 12 位就是版本。任何一份文件改了、多了或少了，版本都不同；
两次评测的对照按文件列出变了哪几份。任务目录 docs 下的领域知识、评审规则与模板不算在内。

灯按阶段分组：汇总里每盏灯带着它所在的阶段，行已经按阶段排在一起。一个阶段的通过率是这一组各盏灯通过率的平均，没有能算的遍的
那几盏不进平均（与一次评测的灯通过率同一个算法）。

对照：两次评测并排，每盏灯与清单的每一组各写两个数与差值。灯比的是通过率（通过的遍数比上能算的遍数），清单比的是命中的
遍数比上核对的遍数。后一次比前一次低就是变差。有一边没有能算的遍时不比，差值为空。灯按阶段排在一起，每个阶段另比两次的本组通过率；
阶段按每盏灯在各自汇总里带的阶段名分，所以灯增删前后的两次评测也能对照。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from taskwright_observatory.shared import shorten_home

LIST_FILE = "evals.jsonl"
SUMMARY_PREFIX = "评测汇总_"

NO_ROOT = "启动观测台时没有给演练根目录（--sim-root），所以这里没有评测可看。"


#: 一盏灯的键在灯表里找不到阶段时归到的那一组。
OTHER_STAGE = "其他"


def lamps_by_stage(lamp_rows: list[dict]) -> list[dict]:
    """灯按阶段分组，阶段按各行出现的先后。每组一项：阶段、这一组的键、几盏灯、其中几盏有能算的遍、本组通过率（一盏能算的都没有时为空）。"""
    grouped: dict[str, list[dict]] = {}
    for row in lamp_rows:
        grouped.setdefault(row.get("阶段") or OTHER_STAGE, []).append(row)
    out = []
    for stage, rows in grouped.items():
        rates = [row["通过率"] for row in rows if row.get("通过率") is not None]
        out.append({"阶段": stage, "键": [row["键"] for row in rows], "灯数": len(rows), "能算的灯数": len(rates),
                    "通过率": sum(rates) / len(rates) if rates else None})
    return out


#: 启动补记里记着文件摘要值的几项（都在代码仓里；「平台 skill」只在它退役之前的归档里有），与知识仓库摘要里要取的那一段路径（在任务目录里）。
PROMPT_RECORDS = ("按阶段的说明", "流程的说明", "平台 skill")
TASK_SKILLS_PREFIX = ".pi/skills/"
FROM_REPO, FROM_TASK = "代码仓", "任务目录"
NO_LAUNCH_NOTE = "这一遍没有后端在启动助手时的补记（演练没有跑起来，或者跑在后端记下这些之前），取不到提示词版本。"
NO_PROMPT_FILES = "这一遍的启动补记里没有提示词文件的摘要值，取不到提示词版本。"


def _jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def prompt_version(files: list[dict]) -> str | None:
    """一组提示词文件的版本：每份写成「路径、摘要值」一行，按路径排好接起来取 SHA-256 的前 12 位；一份文件都没有时为空。"""
    if not files:
        return None
    lines = sorted(f"{one['路径']}\t{one.get('摘要值') or ''}" for one in files)
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()[:12]


def prompt_of_run(sim: Path) -> dict:
    """一遍演练里助手用的提示词：版本与每份文件（路径、来自代码仓还是任务目录、字节数、摘要值），读自这一遍第一次启动助手时后端的补记。
    取不到时版本为空，「说明」写原因。路径都是相对的：代码仓里的相对代码仓根目录，任务目录里的相对任务目录。"""
    for path in sorted(Path(sim).glob("backend/*/pi-events/*.backend.jsonl")):
        notes = _jsonl(path)
        started = next((n for n in notes if n.get("记录") == "启动"), None)
        if started is None:
            continue
        files = []
        for name in PROMPT_RECORDS:
            record = started.get(name) or {}
            base = str(record.get("代码仓里的路径") or "").strip("/")
            files += [{"路径": f"{base}/{one['路径']}" if base else str(one["路径"]), "来自": FROM_REPO, "字节数": one.get("字节数"), "摘要值": one.get("摘要值") or ""}
                      for one in record.get("文件") or [] if one.get("路径")]
        knowledge = next((n for n in notes if n.get("记录") == "知识仓库摘要"), None) or {}
        files += [{"路径": str(one["路径"]), "来自": FROM_TASK, "字节数": one.get("字节数"), "摘要值": one.get("摘要值") or ""}
                  for one in knowledge.get("文件") or [] if str(one.get("路径") or "").startswith(TASK_SKILLS_PREFIX)]
        files.sort(key=lambda one: one["路径"])
        return {"版本": prompt_version(files), "文件": files, "说明": "" if files else NO_PROMPT_FILES}
    return {"版本": None, "文件": [], "说明": NO_LAUNCH_NOTE}


def prompt_of_summary(summary: dict) -> dict:
    """一次评测用的提示词。汇总里记着就用记着的；早先写出的汇总没有这一项，照它各遍的演练目录现读（只读），目录不在了就取不到。"""
    if "提示词版本" in summary:
        return {"版本": summary.get("提示词版本"), "文件": summary.get("提示词文件") or [], "说明": summary.get("提示词说明") or ""}
    found = {"版本": None, "文件": [], "说明": NO_LAUNCH_NOTE}
    for run in summary.get("各遍") or []:
        if run.get("目录") and Path(run["目录"]).is_dir():
            found = prompt_of_run(Path(run["目录"]))
            if found["版本"]:
                break
    return found


def compare_prompts(a: dict, b: dict) -> dict:
    """两次评测的提示词：版本是不是相同，不同时逐份列出改了的、后一次多出来的、后一次没有的。有一边取不到时不比，照实写。"""
    one, two = prompt_of_summary(a), prompt_of_summary(b)
    out = {"前": {"版本": one["版本"], "文件数": len(one["文件"])}, "后": {"版本": two["版本"], "文件数": len(two["文件"])}, "相同": None, "变了的文件": []}
    missing = [(name, side["说明"]) for name, side in (("前一次", one), ("后一次", two)) if not side["版本"]]
    if missing:
        out["说明"] = "".join(f"{name}取不到提示词版本：{why or NO_LAUNCH_NOTE}" for name, why in missing) + "所以列不出变了哪几份文件。"
        return out
    before, after = ({f["路径"]: f for f in side["文件"]} for side in (one, two))
    for path in sorted({*before, *after}):
        old, new = before.get(path), after.get(path)
        if old and new and old.get("摘要值") == new.get("摘要值"):
            continue
        how = "改了" if old and new else "后一次多出来的" if new else "后一次没有的"
        out["变了的文件"].append({"路径": path, "来自": (new or old).get("来自") or "", "怎样变": how,
                                  "前": (old or {}).get("摘要值"), "后": (new or {}).get("摘要值")})
    out["相同"] = one["版本"] == two["版本"]
    out["说明"] = "两次用的是同一版提示词。" if out["相同"] else f"两次用的提示词不同，有 {len(out['变了的文件'])} 份文件变了。"
    return out


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
    summary = json.loads(path.read_text(encoding="utf-8"))
    # 早先写出的汇总里没有按阶段的那一项：照它每盏灯带的阶段现算，页面不用分两种读法。
    summary.setdefault("灯按阶段", lamps_by_stage(summary.get("灯") or []))
    if "提示词版本" not in summary:
        found = prompt_of_summary(summary)
        summary.update({"提示词版本": found["版本"], "提示词文件": found["文件"], "提示词说明": found["说明"]})
    return summary


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
    head = lambda s: {key: s.get(key) for key in ("标签", "时间", "提交号", "提示词版本", "模型", "材料", "画像", "清单", "遍数", "轮数上限", "灯通过率", "清单命中率")}  # noqa: E731
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
    # 同一个阶段的灯排在一起（只有后一次有的灯也归到它的阶段里）；阶段的先后按前一次、再按后一次里出现的先后。
    stages = list(dict.fromkeys(row.get("阶段") or OTHER_STAGE for row in [*a["灯"], *b["灯"]]))
    lamp_rows.sort(key=lambda row: stages.index(row.get("阶段") or OTHER_STAGE))
    by_stage_a, by_stage_b = ({one["阶段"]: one for one in lamps_by_stage(s["灯"])} for s in (a, b))
    stage_rows = []
    for stage in stages:
        one, two = (None if side.get(stage) is None else {"比率": side[stage]["通过率"], "灯数": side[stage]["灯数"]} for side in (by_stage_a, by_stage_b))
        delta, worse = _delta(one, two)
        stage_rows.append({"阶段": stage, "前": one, "后": two, "差值": delta, "变差": worse})
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
    return {"前": head(a), "后": head(b), "提醒": notes, "提示词": compare_prompts(a, b), "灯": lamp_rows, "灯按阶段": stage_rows, "至少应有": group_rows,
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


def _stage_cell(side: dict | None) -> str:
    if side is None:
        return "没有这一组"
    return ("没有能算的" if side["比率"] is None else f"{round(side['比率'] * 100)}%") + f"（{side['灯数']} 盏）"


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
    prompts = data["提示词"]
    lines += ["", "## 提示词", "", f"- 前一次「{a['标签']}」的提示词版本：{prompts['前']['版本'] or '取不到'}；后一次「{b['标签']}」的提示词版本：{prompts['后']['版本'] or '取不到'}。",
              f"- {prompts['说明']}"]
    if prompts["变了的文件"]:
        lines += ["", f"| 文件 | 在哪里 | 怎样变 | {a['标签']} | {b['标签']} |", "|---|---|---|---|---|"]
        lines += [f"| {one['路径']} | {one['来自']} | {one['怎样变']} | {one['前'] or '没有'} | {one['后'] or '没有'} |" for one in prompts["变了的文件"]]
    lines += ["", "## 灯", "", "各阶段的通过率（一个阶段的通过率是这一组各盏灯通过率的平均；括号里是这一组有几盏灯）：", "",
              f"| 阶段 | {a['标签']} | {b['标签']} | 差值 |", "|---|---|---|---|"]
    lines += [f"| {row['阶段']} | {_stage_cell(row['前'])} | {_stage_cell(row['后'])} | {_delta_cell(row)} |" for row in data["灯按阶段"]]
    lines += ["", "每格是「通过的遍数／能算的遍数」。", "", f"| 阶段 | 灯 | {a['标签']} | {b['标签']} | 差值 |", "|---|---|---|---|---|"]
    lines += [f"| {row['阶段']} | {row['说明']} | {_cell(row['前'])} | {_cell(row['后'])} | {_delta_cell(row)} |" for row in data["灯"]]
    lines += ["", "## 至少应有", "", "每格是「命中的遍数／核对的遍数」。", "", f"| 部分 | 关键词组 | {a['标签']} | {b['标签']} | 差值 |", "|---|---|---|---|---|"]
    lines += [f"| {row.get('部分名') or row['部分']} | {'／'.join(row['组'])} | {_cell(row['前'])} | {_cell(row['后'])} | {_delta_cell(row)} |" for row in data["至少应有"]]
    return "\n".join(lines) + "\n"
