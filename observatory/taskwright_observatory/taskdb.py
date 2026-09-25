"""只读地读任务目录里新格式的任务数据库 task.sqlite，整理成 Python 的字典与列表。

`dbshow`、`check_db` 与观测台都经这里读新格式的库，读法只有这一份。本模块只读不写：连接以只读方式
打开，代码里没有任何写语句；它也不做核对、不评判内容，只把库里的事实原样摆出来。

新旧格式怎样分：库里有 `slot` 表就是旧格式（更早的、按字段记版本的那一版）；有 `item` 表、条目内容表
还按内容版本号记（有 version_no 列）的，是修订统一之前的格式，本版本不支持；有 `item` 表、条目内容按修订号记的
是新格式。一张表都没有，或者库文件根本不存在，都说明这个任务目录还没有创建任务。

新格式里条目没有单独的版本号：条目在某一时刻的内容由「条目编号加修订号」标识，条目只在它被新增、修改或恢复
的那些修订下有一行。读出来的每个条目带「修订内容」列表，每项是条目在一次修订下的内容，键「修订号」。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

DB_NAME = "task.sqlite"

FORMAT_MISSING = "还没有库"
FORMAT_EMPTY = "空库"
FORMAT_LEGACY = "旧格式"
FORMAT_CURRENT = "新格式"
FORMAT_PRE_REVISION = "修订统一之前的格式"

#: 修订统一之前的库，读取一侧统一这样说。
PRE_REVISION_TEXT = "这个任务是旧格式（修订统一之前建的，条目还按内容版本号记），本版本不支持。"
FORMAT_UNKNOWN = "认不出的格式"

#: 任务定义里不写「材料目录」时用的值，与 agent/src/lib/definition.ts 里的 DEFAULT_MATERIALS_DIR 是同一个。
DEFAULT_MATERIALS_DIR = "inputs/"

#: 库文件不存在、或者库里一张表都没有时，读取一侧统一这样说。
NO_TASK_YET = "这个任务目录还没有创建任务"


#: 忙等待超时（busy timeout），单位是秒：遇到写入者正在合并日志等短暂的锁时，最多等这么久。
#: 与写入一侧 agent/src/lib/schema.ts 的 BUSY_TIMEOUT_MS（5000 毫秒）取同一个数值。
BUSY_TIMEOUT_SECONDS = 5.0


def open_readonly(db_path: Path) -> sqlite3.Connection:
    """只读方式打开一个 SQLite 库。这样即使代码写错了也改不动任何数据。

    库是 WAL 模式（write-ahead logging，改动先写进旁边的 -wal 文件再合并回库文件）时，只读连接
    也要用到 -wal 与 -shm 两个附属文件，所以实测有两点要知道（2026-09-21）：

    1. 任务目录可写时，只读连接能读到写入者已经提交、但还只在 -wal 文件里的最新数据；打开时如果
       两个附属文件不存在，只读连接会自己建出来，关掉后留在目录里，下一次写入时会被合并清掉，无害。
    2. 任务目录不可写、并且两个附属文件都不存在时，只读打开会报 attempt to write a readonly
       database。这时没有 -wal 文件，说明库文件本身就是最新的，所以退一步用 immutable=1（告诉 SQLite
       这个文件不会变、不必加锁）再打开。目录不可写但 -wal 文件在时不走这一步，免得漏读还没合并的改动。
    """
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_SECONDS)
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite3.OperationalError:
        if Path(f"{db_path}-wal").exists():
            raise
        conn = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True, timeout=BUSY_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row
    return conn


def table_names(conn: sqlite3.Connection) -> set[str]:
    return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def format_of_tables(tables: set[str], item_version_columns: set[str] | None = None) -> str:
    if "slot" in tables:
        return FORMAT_LEGACY
    if "item" in tables:
        return FORMAT_PRE_REVISION if "version_no" in (item_version_columns or set()) else FORMAT_CURRENT
    return FORMAT_EMPTY if not tables else FORMAT_UNKNOWN


def item_version_columns(conn: sqlite3.Connection) -> set[str]:
    return {row[1] for row in conn.execute("PRAGMA table_info(item_version)")}


def format_of_workspace(workspace: Path) -> str:
    """这个任务目录的库是哪种格式。库文件不存在返回「还没有库」。"""
    path = Path(workspace) / DB_NAME
    if not path.is_file() or path.stat().st_size == 0:
        return FORMAT_MISSING
    conn = open_readonly(path)
    try:
        return format_of_tables(table_names(conn), item_version_columns(conn))
    finally:
        conn.close()


def _json(text):
    if text is None:
        return None
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return text


def parse_definition(text: str) -> dict:
    """从任务定义的原文快照里取出读取一侧要用的几样：任务名、交付物名、每个集合的前缀与字段声明、完成条件。

    快照是「创建任务」工具校验过的，所以这里不再核对形状，读不出来的项留空。
    """
    raw = _json(text)
    if not isinstance(raw, dict):
        return {"任务名": "", "交付物名称": "", "集合": [], "完成条件": {}, "执行方法": "", "领域规矩": [],
                "文档模板": "", "材料目录": DEFAULT_MATERIALS_DIR, "材料目录是不是缺省值": True}
    deliverable = raw.get("交付物") if isinstance(raw.get("交付物"), dict) else {}
    collections = []
    for entry in deliverable.get("条目集合") or []:
        if not isinstance(entry, dict):
            continue
        collections.append({
            "名称": entry.get("名称", ""),
            "编号前缀": entry.get("编号前缀", ""),
            "字段": [{"名": f.get("名", ""), "类型": f.get("类型", ""), "必填": bool(f.get("必填")),
                      "取值": f.get("取值")} for f in entry.get("字段") or [] if isinstance(f, dict)],
            # 「界面」：只影响显示的可选项（右侧栏页签、分组字段、靠前的组），没写时为空对象。
            "界面": entry.get("界面") if isinstance(entry.get("界面"), dict) else {},
        })
    return {
        "任务名": raw.get("任务名", ""),
        "交付物名称": deliverable.get("名称", ""),
        "集合": collections,
        "完成条件": raw.get("完成条件") if isinstance(raw.get("完成条件"), dict) else {},
        "执行方法": raw.get("执行方法", ""),
        "领域规矩": raw.get("领域规矩") or [],
        "文档模板": deliverable.get("文档模板", ""),
        "材料目录": materials_dir(raw),
        "材料目录是不是缺省值": not isinstance(raw.get("材料目录"), str) or not raw.get("材料目录").strip(),
    }


def materials_dir(raw: dict) -> str:
    """任务定义里的「材料目录」，缺省为 inputs/，结尾补上斜杠。形状的核对在 agent 那一侧做，这里只照读。"""
    value = raw.get("材料目录") if isinstance(raw, dict) else None
    if not isinstance(value, str) or not value.strip():
        return DEFAULT_MATERIALS_DIR
    value = value.strip()
    return value if value.endswith("/") else value + "/"


def read_tasks(conn: sqlite3.Connection) -> list[dict]:
    """把新格式库里的每个任务连同它的条目、条目在各次修订下的内容、来源、修订与事件都取出来。"""
    tasks = []
    for task in conn.execute("SELECT * FROM task ORDER BY started_at, task_id"):
        task_id = task["task_id"]
        definition = parse_definition(task["definition_text"])
        sources = read_sources(conn, task_id)
        contents: dict[str, list[dict]] = {}
        for row in conn.execute(
                "SELECT * FROM item_version WHERE task_id = ? ORDER BY item_id, revision_no", (task_id,)):
            contents.setdefault(row["item_id"], []).append({
                "修订号": row["revision_no"],
                "字段": _json(row["fields"]) or {},
                "来源": sources.get((row["item_id"], row["revision_no"]), []),
                "事件序号": row["event_seq"],
            })
        reviews = _item_records(conn, "SELECT item_id, revision_no, verdict, reason, created_at FROM review "
                                      "WHERE task_id = ? ORDER BY review_id", task_id, "review")
        confirms = _item_records(conn, "SELECT j.item_id, j.revision_no, j.attitude, g.created_at "
                                       "FROM judgement_item j JOIN judgement g ON g.judgement_id = j.judgement_id "
                                       "WHERE j.task_id = ? ORDER BY j.judgement_id", task_id, "judgement_item")
        for item_id, history in contents.items():
            for content in history:
                key = (item_id, content["修订号"])
                content["评审记录"] = [{"结论": r["verdict"], "理由": r["reason"], "时刻": r["created_at"]}
                                       for r in reviews.get(key, [])]
                content["确认记录"] = [{"态度": r["attitude"], "时刻": r["created_at"]}
                                       for r in confirms.get(key, [])]
        order = {c["名称"]: i for i, c in enumerate(definition["集合"])}
        items = []
        for row in conn.execute("SELECT * FROM item WHERE task_id = ?", (task_id,)):
            history = contents.get(row["item_id"], [])
            items.append({
                "条目编号": row["item_id"],
                "所属集合": row["collection"],
                "流水号": row["serial"],
                "在第几次修订新增": row["added_in_revision"],
                "在第几次修订删除": row["deleted_in_revision"],
                "新增的事件序号": row["event_seq"],
                "删除的事件序号": row["deleted_event_seq"],
                "修订内容": history,
                "当前内容": history[-1] if history else None,
            })
        items.sort(key=lambda one: (order.get(one["所属集合"], len(order)), one["流水号"]))
        events = [{
            "事件序号": row["seq"],
            "任务编号": row["task_id"],
            "会话编号": row["session_id"],
            "调用编号": row["call_id"],
            "事件名": row["name"],
            "内容": _json(row["payload"]),
            "发起方": row["actor"],
            "时刻": row["at"],
        } for row in conn.execute("SELECT * FROM event WHERE task_id = ? ORDER BY seq", (task_id,))]
        by_seq = {e["事件序号"]: e for e in events}
        revisions = []
        for row in conn.execute("SELECT * FROM revision WHERE task_id = ? ORDER BY revision_no", (task_id,)):
            event = by_seq.get(row["event_seq"], {})
            revisions.append({
                "修订序号": row["revision_no"],
                "会话编号": row["session_id"],
                "调用编号": row["call_id"],
                "事件序号": row["event_seq"],
                "时刻": row["created_at"],
                "摘要": _json(row["summary"]) or [],
                "操作": ((event.get("内容") or {}).get("operations") or []) if isinstance(event.get("内容"), dict) else [],
            })
        judgements = read_judgements(conn, task_id)
        model_calls = read_model_calls(conn, task_id)
        keys = task.keys()
        user_name = task["task_name"] if "task_name" in keys else None
        tasks.append({
            "任务编号": task_id,
            "任务名": user_name or definition["任务名"],
            "任务类型": definition["任务名"],
            "领域标签": task["domain_tag"] if "domain_tag" in keys else None,
            "任务定义": definition,
            "任务定义文件": task["definition_path"],
            "状态": task["status"],
            "创建它的会话编号": task["session_id"],
            "创建它的调用编号": task["call_id"],
            "创建的事件序号": task["event_seq"],
            "开始时刻": task["started_at"],
            "结束时刻": task["ended_at"],
            "条目": items,
            "修订": revisions,
            "事件": events,
            "判读": judgements,
            "模型调用": model_calls,
        })
    return tasks


def read_judgements(conn: sqlite3.Connection, task_id: str) -> list[dict]:
    """每条确认标记连同逐条明细。依据有三种：打开详情或卡片上点「这几条都看过了」写「已读」，改字段或标为先不管时随修订自动写的是「界面修改」，
    撤回确认写「界面点击」；早期版本的库里还有由模型读用户原话登记的。"""
    if "judgement" not in table_names(conn):
        return []
    details: dict[int, list[dict]] = {}
    if "judgement_item" in table_names(conn):
        for row in conn.execute("SELECT * FROM judgement_item WHERE task_id = ? ORDER BY item_id", (task_id,)):
            details.setdefault(row["judgement_id"], []).append(
                {"条目编号": row["item_id"], "修订号": row["revision_no"], "态度": row["attitude"]})
    return [{
        "判读序号": row["judgement_id"],
        "调用编号": row["call_id"],
        "事件序号": row["event_seq"],
        "依据": _json(row["basis"]),
        "时刻": row["created_at"],
        "明细": details.get(row["judgement_id"], []),
    } for row in conn.execute("SELECT * FROM judgement WHERE task_id = ? ORDER BY judgement_id", (task_id,))]


def read_model_calls(conn: sqlite3.Connection, task_id: str) -> list[dict]:
    """工具里直接发起的模型调用（评审者；早期版本的库里还有登记确认时的调用）。加这张表之前建的库没有它，给空的。"""
    if "model_call" not in table_names(conn):
        return []
    return [{
        "模型调用序号": row["model_call_id"],
        "角色": row["role"],
        "判读序号": row["judgement_id"],
        "评审序号": row["review_id"],
        "工具调用编号": row["tool_call_id"],
        "提示": row["prompt"],
        "输出": row["output"],
        "结果": row["outcome"],
        "模型": row["model"],
        "耗时毫秒": row["duration_ms"],
        "输入用量": row["input_tokens"],
        "输出用量": row["output_tokens"],
        "时刻": row["created_at"],
    } for row in conn.execute("SELECT * FROM model_call WHERE task_id = ? ORDER BY model_call_id", (task_id,))]


def split_user_words_locator(locator: str) -> tuple[str, str] | None:
    """「用户的话」的出处写成「会话编号#会话条目编号」（agent/src/lib/save_revision.ts 的 userWordsLocator）。

    拆得开就返回（会话编号, 条目编号），拆不开（例如最早格式的库里写的「本次对话」）返回 None。
    """
    if not isinstance(locator, str) or locator.count("#") != 1:
        return None
    session_id, entry_id = locator.split("#")
    return (session_id, entry_id) if session_id and entry_id else None


def read_sources(conn: sqlite3.Connection, task_id: str) -> dict[tuple[str, int], list[dict]]:
    """按（条目编号, 修订号）取条目在每次修订下的来源。

    库里一条来源支持几处字段就展开成几行（support_no 从 1 起），这里按「第几条」合回一条，
    所支持的字段放进「支持」列表：每项是字段名与列表里的第几项（从 0 起，为空表示整个字段）；
    列表为空表示这条来源支持整个条目。最早格式的库没有这几列，读出来「支持」一律为空列表。
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(item_source)")}
    field_level = {"support_no", "field", "field_index"} <= columns
    order = "item_id, revision_no, position" + (", support_no" if field_level else "")
    grouped: dict[tuple[str, int], list[dict]] = {}
    for row in conn.execute(f"SELECT * FROM item_source WHERE task_id = ? ORDER BY {order}", (task_id,)):
        key = (row["item_id"], row["revision_no"])
        bucket = grouped.setdefault(key, [])
        if not bucket or bucket[-1]["第几条"] != row["position"]:
            one = {"种类": row["kind"], "出处": row["locator"], "摘录": row["excerpt"],
                   "第几条": row["position"], "事件序号": row["event_seq"], "支持": []}
            if row["kind"] == "用户的话":
                split = split_user_words_locator(row["locator"])
                one["对话出处"] = {"会话编号": split[0], "条目编号": split[1]} if split else None
            bucket.append(one)
        if field_level and row["field"] is not None:
            bucket[-1]["支持"].append({"字段": row["field"], "第几项": row["field_index"]})
    return grouped


def support_text(supports: list[dict]) -> str:
    """把一条来源所支持的几处写成一句话，给 dbshow 与观测台用。列表里的第几项按人读的习惯从 1 起写。"""
    if not supports:
        return "整个条目"
    parts = []
    for one in supports:
        index = one.get("第几项")
        parts.append(f"「{one['字段']}」" + (f"第 {index + 1} 项" if isinstance(index, int) else ""))
    return "、".join(parts)


def _item_records(conn: sqlite3.Connection, sql: str, task_id: str, table: str) -> dict:
    """按（条目编号, 修订号）分组取评审或确认的记录。那张表不在库里时给空的。"""
    if table not in table_names(conn):
        return {}
    grouped: dict[tuple[str, int], list] = {}
    for row in conn.execute(sql, (task_id,)):
        grouped.setdefault((row["item_id"], row["revision_no"]), []).append(row)
    return grouped


def read_workspace(workspace: Path) -> dict:
    """读一个任务目录。返回格式、任务列表；库文件不存在或是旧格式时任务列表为空。"""
    fmt = format_of_workspace(workspace)
    result = {"格式": fmt, "任务": []}
    if fmt != FORMAT_CURRENT:
        return result
    conn = open_readonly(Path(workspace) / DB_NAME)
    try:
        result["任务"] = read_tasks(conn)
    finally:
        conn.close()
    return result


def content_at(item: dict, revision_no: int | None) -> dict | None:
    """取条目在修订 revision_no 下的内容（那次修订改动过它才有）。修订号为空或者找不到就返回 None。"""
    if revision_no is None:
        return None
    for one in item["修订内容"]:
        if one["修订号"] == revision_no:
            return one
    return None


def snapshot_at(task: dict, revision_no: int) -> list[dict]:
    """推出修订 N 时整份交付物的样子：每个条目在修订号不大于 N 的最近一次改动，去掉那时已删除的条目。

    库里不存整份快照，要看就这样现推。返回的每一项是（条目编号、所属集合、那时的内容）。
    """
    shown = []
    for item in task["条目"]:
        if item["在第几次修订新增"] > revision_no:
            continue
        deleted = item["在第几次修订删除"]
        if deleted is not None and deleted <= revision_no:
            continue
        upto = [v for v in item["修订内容"] if v["修订号"] <= revision_no]
        if upto:
            shown.append({"条目编号": item["条目编号"], "所属集合": item["所属集合"], "内容": upto[-1]})
    return shown
