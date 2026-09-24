"""适配层：把库里「按字段记版本」的流水，投影成「整份交付物的一次次修订」。

库现在是按字段记版本的：每个字段各有各的版本号，谁也不知道「整份交付物长什么样」。
界面上要看的却是整份交付物怎么一步步变成现在这样，所以这里做一次投影：

    每一条由 pi 进程里的工具写下的数据变更事件（也就是带着 pi 调用编号的那种），算整份交付物的一次修订。
    这一次修订的内容，是把在它之前的每一条变更依次重放一遍之后，全部字段合起来的样子。
    同时记下这一次改动的是哪个字段、旧值与新值各是什么。

建库时那一批变更不带调用编号（它们是建立任务时把字段都摆成空值），所以不算修订，
只作为第一次修订之前的底子。

新格式的库表按条目记版本，那种库里修订本来就是一张表，不需要投影；
`project_current_format` 把它整理成界面要的样子：每次修订里每个操作落到了哪个条目的哪一版、
改前改后各是什么。库里不另存改前改后的文字，这里按事件里记的改前版本号与改后版本号，
从条目版本表里取出相邻两版来对比。
"""

from __future__ import annotations

from taskwright_observatory import taskdb
from taskwright_observatory.shared import local_time


def project_revisions(task: dict) -> dict:
    """把一个任务投影成一串修订。新格式的库交给 project_current_format，旧格式照原来的投影。"""
    if task.get("格式") == taskdb.FORMAT_CURRENT:
        return project_current_format(task["新库"])
    return project_legacy(task)


def project_legacy(task: dict) -> dict:
    """旧格式：返回底子快照、修订清单，以及没能归入修订的那几条变更。"""
    events_by_seq = {event["事件序号"]: event for event in task["事件"]}
    order = task["字段顺序"]
    snapshot = {name: "" for name in order}

    revisions: list[dict] = []
    baseline_rows: list[dict] = []
    for row in sorted(task["变更流水"], key=lambda r: r["事件序号"]):
        if row["字段"] not in snapshot:
            snapshot[row["字段"]] = ""
            order = order + [row["字段"]]
        before = dict(snapshot)
        snapshot[row["字段"]] = row["新值"]
        event = events_by_seq.get(row["事件序号"], {})
        call_id = event.get("调用编号", "")
        if not call_id:
            baseline_rows.append(row)
            continue
        revisions.append({
            "修订序号": len(revisions) + 1,
            "时刻": row["时刻"],
            "时刻文字": local_time(row["时刻"]),
            "改动字段": [row["字段"]],
            "旧值": row["旧值"],
            "新值": row["新值"],
            "写入者": row["写入者"],
            "该字段第几版": row["版本号"],
            "事件序号": row["事件序号"],
            "调用编号": call_id,
            "库里记的命令原文": event.get("命令原文", ""),
            "工具": event.get("来源", ""),
            "上一次快照": before,
            "快照": dict(snapshot),
        })

    return {
        "任务标识": task["任务标识"],
        "任务类型": task["任务类型"],
        "字段顺序": order,
        "底子": {name: "" for name in order},
        "建库时的变更条数": len(baseline_rows),
        "修订": revisions,
        "修订次数": len(revisions),
    }


def revision_by_call_id(projection: dict) -> dict[str, dict]:
    """建一张「调用编号 → 这次调用产生的那一次修订」的表，给会话详情挂里程碑用。"""
    return {rev["调用编号"]: rev for rev in projection["修订"] if rev["调用编号"]}


def collection_fields(task: dict) -> dict[str, list[dict]]:
    """集合名 → 这个集合在任务定义里声明的字段（名、类型、必填、取值）。"""
    return {c["名称"]: c["字段"] for c in task["任务定义"]["集合"]}


def describe_operation(task: dict, op: dict) -> dict:
    """把修订事件里记的一个操作，整理成「交付物的变化」里的一项。

    渲染按字段类型通用：新增的条目按声明的字段逐项列出；修改的条目只列变了的字段，改前改后并排；
    删除的条目注明在第几次修订删除。不为任何一个集合写专门的规则。
    """
    items = {i["条目编号"]: i for i in task["条目"]}
    item = items.get(op.get("item"), {"版本": [], "在第几次修订删除": None})
    declared = collection_fields(task).get(op.get("collection"), [])
    before = taskdb.version_of(item, op.get("from_version"))
    after = taskdb.version_of(item, op.get("to_version"))
    kind = op.get("op")
    shown = {
        "操作": kind,
        "操作的中文名": {"add": "新增", "update": "修改", "delete": "删除", "restore": "恢复"}.get(kind, str(kind)),
        "条目编号": op.get("item"),
        "所属集合": op.get("collection"),
        "改前版本": op.get("from_version"),
        "改后版本": op.get("to_version"),
        "字段": [],
        "来源": [],
        "来源变了吗": False,
        "改前来源": [],
    }
    if kind == "add" and after:
        shown["字段"] = [{"名": f["名"], "类型": f["类型"], "必填": f["必填"],
                          "值": after["字段"].get(f["名"])} for f in declared]
        shown["来源"] = after["来源"]
    elif kind in ("update", "restore") and after:
        old_fields = before["字段"] if before else {}
        for f in declared:
            a, b = old_fields.get(f["名"]), after["字段"].get(f["名"])
            if a != b:
                shown["字段"].append({"名": f["名"], "类型": f["类型"], "必填": f["必填"], "改前": a, "改后": b})
        strip = lambda rows: [(r["种类"], r["出处"], r["摘录"], str(r.get("支持") or [])) for r in rows]  # noqa: E731
        shown["来源"] = after["来源"]
        shown["改前来源"] = before["来源"] if before else []
        shown["来源变了吗"] = strip(shown["来源"]) != strip(shown["改前来源"])
    elif kind == "delete":
        shown["在第几次修订删除"] = item.get("在第几次修订删除")
    return shown


def project_current_format(task: dict) -> dict:
    """新格式：把修订表整理成界面要的修订清单。"""
    revisions = []
    for revision in task["修订"]:
        revisions.append({
            "修订序号": revision["修订序号"],
            "时刻文字": revision["时刻"].replace("T", " ")[:19],
            "调用编号": revision["调用编号"],
            "会话编号": revision["会话编号"],
            "事件序号": revision["事件序号"],
            "变化": [describe_operation(task, op) for op in revision["操作"]],
        })
    return {
        "格式": taskdb.FORMAT_CURRENT,
        "任务标识": task["任务编号"],
        "任务类型": task["任务名"],
        "修订": revisions,
        "修订次数": len(revisions),
    }
