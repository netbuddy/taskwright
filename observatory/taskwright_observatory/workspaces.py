"""读任务目录里的任务数据库 `task.sqlite`。一律以只读方式打开，绝不写。

库有新旧两种格式，靠「库里有没有 `slot` 表」分辨。新格式（条目按修订号记）由 `taskwright_observatory.taskdb`
读，本模块把它包成与旧格式同样的外壳（任务标识、任务类型、状态、事件），好让会话与任务的对应、
调用编号的索引两种格式共用一套；新格式特有的条目、条目在各次修订下的内容、来源原样放在「新库」一项里。
库文件不存在的任务目录也列出来，标明「这个任务目录还没有创建任务」。

旧格式的库是这样几张表：`task` 是任务本身，`slot` 是每个字段的当前值与版本号，
`slot_history` 是每次变更的流水，`event` 是事件流水。`event` 表里的 `call_id` 存的是
pi 给这次工具调用的编号，观测台就是靠它把「模型做了什么」与「库里改了什么」对上。

本模块不认识任何具体的字段名。字段的显示顺序取自任务定义里写的顺序；任务定义里读不到时，
退而按这些字段在库里第一次出现的先后排。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from taskwright_observatory import taskdb
from taskwright_observatory.shared import epoch_from_naive_iso, shorten_home

#: 库里表示「某个字段的值变了」的那种事件叫这个名字。
DATA_CHANGED = "DATA_CHANGED"


def open_readonly(db_path: Path) -> sqlite3.Connection:
    """只读方式打开一个 SQLite 库。新旧两种格式的库都经 taskdb.open_readonly 打开，
    打开的办法只有那一份：带忙等待超时，目录不可写且没有 -wal 文件时退一步用 immutable=1。"""
    return taskdb.open_readonly(db_path)


def _json_or_raw(text):
    """库里的值存的是 JSON 文字。解得开就解，解不开原样返回，不当错误。"""
    if text is None:
        return None
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return text


def _as_display_text(value) -> str:
    """把一个字段值写成一段可以直接放到界面上的文字。空值写成空串。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def field_order(definition, slots, history) -> list[str]:
    """定出整份交付物里字段的先后顺序。

    先看任务定义里「槽位」那一段写的顺序；任务定义读不到时，按字段在库里第一次出现的先后排。
    """
    if isinstance(definition, dict):
        declared = definition.get("槽位")
        if isinstance(declared, dict) and declared:
            order = list(declared.keys())
            extra = [s["name"] for s in slots if s["name"] not in order]
            return order + extra
    seen: list[str] = []
    for row in list(history) + list(slots):
        name = row["name"]
        if name not in seen:
            seen.append(name)
    return seen


def read_task_db(db_path: Path) -> list[dict]:
    """读一个 `task.sqlite`，把里面的每个任务连同它的字段、流水与事件都取出来。"""
    conn = open_readonly(db_path)
    try:
        tasks = []
        for task in conn.execute("SELECT * FROM task"):
            task_id = task["id"]
            definition = _json_or_raw(task["def_json"])
            slots = conn.execute(
                "SELECT * FROM slot WHERE task_id = ?", (task_id,)).fetchall()
            history = conn.execute(
                "SELECT * FROM slot_history WHERE task_id = ? ORDER BY id", (task_id,)).fetchall()
            events = conn.execute(
                "SELECT * FROM event WHERE task_id = ? ORDER BY seq", (task_id,)).fetchall()
            order = field_order(definition, slots, history)
            tasks.append({
                "任务标识": task_id,
                "任务类型": task["def_name"],
                "任务定义文件": task["def_file"],
                "实例名": task["instance"],
                "状态": task["status"],
                "开始时刻": epoch_from_naive_iso(task["started_at"]),
                "结束时刻": epoch_from_naive_iso(task["ended_at"]),
                "领域规矩": (definition or {}).get("领域规矩", "") if isinstance(definition, dict) else "",
                "任务定义里的交付物": (definition or {}).get("交付物") if isinstance(definition, dict) else None,
                "字段顺序": order,
                "字段说明": {
                    name: ((definition or {}).get("槽位", {}) or {}).get(name, {}).get("说明", "")
                    if isinstance(definition, dict) else ""
                    for name in order
                },
                "字段现值": [{
                    "字段": row["name"],
                    "值": _as_display_text(_json_or_raw(row["value"])),
                    "版本号": row["version"],
                    "写入者": row["source"],
                    "更新时刻": epoch_from_naive_iso(row["updated_at"]),
                } for row in slots],
                "变更流水": [{
                    "流水号": row["id"],
                    "字段": row["name"],
                    "旧值": _as_display_text(_json_or_raw(row["old"])),
                    "新值": _as_display_text(_json_or_raw(row["new"])),
                    "版本号": row["version"],
                    "写入者": row["source"],
                    "时刻": epoch_from_naive_iso(row["at"]),
                    "事件序号": row["event_seq"],
                } for row in history],
                "事件": [{
                    "事件序号": row["seq"],
                    "调用编号": row["call_id"] or "",
                    "事件名": row["name"],
                    "来源": row["source"],
                    "发起方": row["actor"],
                    "命令原文": row["command"],
                    "内容": _json_or_raw(row["payload"]),
                    "时刻": epoch_from_naive_iso(row["at"]),
                } for row in events],
            })
        return tasks
    finally:
        conn.close()


def read_current_format(path: Path) -> list[dict]:
    """读一个新格式的库，每个任务包成与旧格式同样的外壳。"""
    tasks = []
    for task in taskdb.read_workspace(path)["任务"]:
        tasks.append({
            "格式": taskdb.FORMAT_CURRENT,
            "任务标识": task["任务编号"],
            "任务类型": task["任务名"],
            "状态": task["状态"],
            "事件": [{
                "事件序号": e["事件序号"],
                "调用编号": e["调用编号"] or "",
                "事件名": e["事件名"],
                "来源": "",
                "发起方": e["发起方"],
                "命令原文": "",
                "内容": e["内容"],
                "会话编号": e["会话编号"],
                "时刻": epoch_from_naive_iso(e["时刻"]),
            } for e in task["事件"]],
            "新库": task,
        })
    return tasks


def looks_like_workspace(path: Path) -> bool:
    """没有库文件的目录算不算一个任务目录：有任务定义目录或者 pi 的任务目录就算。"""
    return (path / "task.sqlite").is_file() or (path / "docs" / "task-definitions").is_dir() \
        or (path / ".pi").is_dir()


def scan_workspaces(workspaces_dir: Path) -> list[dict]:
    """把一个目录下每个任务目录都读进来：有库的读库，没有库的标明还没有创建任务。"""
    base = Path(workspaces_dir)
    found: list[dict] = []
    if not base.is_dir():
        return found
    candidates = []
    if looks_like_workspace(base):
        candidates.append(base)
    candidates += [p for p in sorted(base.iterdir()) if p.is_dir() and looks_like_workspace(p)]
    for path in candidates:
        entry = {
            "任务目录": path.name,
            "任务目录路径": shorten_home(str(path)),
            "读库出错": "",
            "格式": "",
            "说明": "",
            "任务": [],
        }
        try:
            fmt = taskdb.format_of_workspace(path)
            entry["格式"] = fmt
            if fmt in (taskdb.FORMAT_MISSING, taskdb.FORMAT_EMPTY):
                entry["说明"] = taskdb.NO_TASK_YET + "。"
            elif fmt == taskdb.FORMAT_CURRENT:
                entry["任务"] = read_current_format(path)
            elif fmt == taskdb.FORMAT_LEGACY:
                entry["任务"] = read_task_db(path / "task.sqlite")
                for task in entry["任务"]:
                    task["格式"] = taskdb.FORMAT_LEGACY
            elif fmt == taskdb.FORMAT_PRE_REVISION:
                entry["说明"] = taskdb.PRE_REVISION_TEXT
            else:
                entry["说明"] = "这个任务目录的库里的表既不是旧格式也不是新格式，观测台认不出来。"
        except sqlite3.Error as error:
            entry["读库出错"] = str(error)
            entry["任务"] = []
        found.append(entry)
    return found


def model_calls_by_tool_call(workspaces: list[dict]) -> dict[str, list[dict]]:
    """建一张「工具调用编号 → 这次工具调用里直接发起的模型调用」的表。

    被拒绝的工具调用没有写事件，但它发起过的模型调用照样记在库里，所以单独建这张表，不走事件。
    """
    index: dict[str, list[dict]] = {}
    for workspace in workspaces:
        for task in workspace["任务"]:
            for call in (task.get("新库") or {}).get("模型调用", []):
                index.setdefault(call["工具调用编号"], []).append({**call, "任务目录": workspace["任务目录"]})
    return index


def index_by_call_id(workspaces: list[dict]) -> dict[str, list[dict]]:
    """建一张「调用编号 → 这次调用在库里写下的事件」的表。

    观测台靠它把会话里模型的一次工具调用，与某个任务目录里某个任务的一条库变更对上。
    """
    index: dict[str, list[dict]] = {}
    for workspace in workspaces:
        for task in workspace["任务"]:
            for event in task["事件"]:
                call_id = event["调用编号"]
                if not call_id:
                    continue
                index.setdefault(call_id, []).append({
                    "任务目录": workspace["任务目录"],
                    "任务标识": task["任务标识"],
                    "任务类型": task["任务类型"],
                    **event,
                })
    return index
