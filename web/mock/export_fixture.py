"""把一份真实的试跑归档导出成假服务用的数据，字段照接口约定（docs/api.md）。

用法（在代码仓根目录）：

    python3 web/mock/export_fixture.py --lab <放试跑归档的目录> --run <归档目录名> [--workspace <任务目录名>]

输出写到 web/mock/runtime/fixture.json；这个目录不入库，
因为里面有材料原文与据材料写成的条目，试验材料不进公开的代码仓。

数据全部取自归档，不手写：
- 任务、条目、每一版、来源：用 taskwright_observatory.taskdb.read_workspace 读任务目录的 task.sqlite；
- 完成条件：用观测台同一个函数调 agent 的核对函数算（经 Node 子进程），与后端的做法一致；
- 对话：读 pi 的会话文件，用户的话成 user_message，执行者最后说的正文成 assistant_reply；
- 过程摘要：用观测台任务页的阶段判定（同一份路径归类声明）得出每个阶段的那一句话；
- 材料：任务目录材料目录下的文件与原文；
- 库事件：按事件表逐条重建成 deliverable_changed 与 task_changed，给假服务做补发与缺口测试用。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from taskwright_observatory import taskdb  # noqa: E402
from taskwright_observatory import taskpage  # noqa: E402
from taskwright_observatory.api import Index  # noqa: E402

OUT = Path(__file__).resolve().parent / "runtime" / "fixture.json"


def iso(local_text: str | None) -> str | None:
    """库里记的是不带时区的本地时间文字；接口一律要带时区的 ISO 8601。"""
    if not local_text:
        return None
    return datetime.fromisoformat(local_text).astimezone().isoformat(timespec="seconds")


def actor_of(raw: str | None) -> str:
    """最早格式的库里执行者写入记的是「模型」，接口里叫 executor。"""
    return "user" if raw in ("user", "用户") else "executor"


def source_of(s: dict) -> dict:
    return {"kind": s.get("种类"), "locator": s.get("出处"), "excerpt": s.get("摘录"),
            "supports": [{"field": x.get("字段") or x.get("field"), "index": x.get("序号", x.get("index"))}
                         for x in (s.get("支持") or [])]}


def title_of(fields: dict, collection_def: dict) -> str:
    first = collection_def["字段"][0]["名"]
    value = fields.get(first)
    return "；".join(value) if isinstance(value, list) else str(value or "")


def completion_of(workspace: Path, task: dict) -> dict | None:
    results, _why = taskpage.check_completion(workspace / taskdb.DB_NAME, task["任务编号"], task["任务定义"]["完成条件"])
    if results is None:
        return None
    counts: dict[str, int] = {}
    for item in task["条目"]:
        if item["在第几次修订删除"] is None:
            counts[item["所属集合"]] = counts.get(item["所属集合"], 0) + 1
    conditions = []
    for r in results:
        missing = [u["item"] for u in r.get("unmet") or [] if u.get("item")]
        total = counts.get(r["collection"], 0)
        conditions.append({"collection": r["collection"], "name": r["condition"], "met": bool(r["satisfied"]),
                           "done": total - len(missing) if r["condition"] != "至少一个条目" else total,
                           "total": total, "missing": missing, "note": r["summary"]})
    return {"all_met": all(c["met"] for c in conditions), "conditions": conditions}


def export_task(workspace: Path) -> tuple[dict, dict, list]:
    data = taskdb.read_workspace(workspace)
    task = data["任务"][0]
    definition = task["任务定义"]
    collections = {c["名称"]: c for c in definition["集合"]}
    items, versions = [], {}
    for item in task["条目"]:
        if item["在第几次修订删除"] is not None:
            continue
        cur = item["当前版本"]
        at = next((iso(r["时刻"]) for r in task["修订"] if r["修订序号"] == cur["由第几次修订产生"]), None)
        events = {e["事件序号"]: e for e in task["事件"]}
        items.append({
            "item_id": item["条目编号"], "collection": item["所属集合"],
            "title": title_of(cur["字段"], collections[item["所属集合"]]),
            "version_no": cur["内容版本号"], "version_by": actor_of(events.get(cur.get("事件序号"), {}).get("发起方")),
            "version_at": at, "version_count": len(item["版本"]),
            "fields": cur["字段"], "sources": [source_of(s) for s in cur.get("来源") or []],
            "reviews": [], "confirmations": [], "confirmation_stale": False,
        })
        versions[item["条目编号"]] = [{
            "version_no": v["内容版本号"], "revision_no": v["由第几次修订产生"],
            "by": actor_of(events.get(v.get("事件序号"), {}).get("发起方")),
            "at": next((iso(r["时刻"]) for r in task["修订"] if r["修订序号"] == v["由第几次修订产生"]), None),
            "fields": v["字段"], "sources": [source_of(s) for s in v.get("来源") or []],
            "reviews": [], "confirmations": [],
        } for v in item["版本"]]
    completion = completion_of(workspace, task)
    snapshot_task = {
        "task_id": task["任务编号"], "task_name": task["任务名"], "task_type": task.get("任务类型") or definition["任务名"],
        "domain_tag": task.get("领域标签"), "status": task["状态"],
        "started_at": iso(task["开始时刻"]), "ended_at": iso(task["结束时刻"]),
        "definition": {"collections": [
            {"name": c["名称"], "prefix": c["编号前缀"],
             "fields": [{"name": f["名"], "type": f["类型"], "required": bool(f["必填"]), "values": f.get("取值")}
                        for f in c["字段"]]} for c in definition["集合"]]},
        "completion": completion, "items": items,
    }
    # 库事件：按事件表重建。只用于假服务的补发演示，字段照第 3.1 节。
    library = []
    for e in task["事件"]:
        if e["事件名"] == "TASK_CREATED":
            library.append({"event": "task_changed", "data": {
                "seq": e["事件序号"], "at": iso(e["时刻"]), "task_id": task["任务编号"], "task_name": task["任务名"],
                "status_before": None, "status_after": "进行中", "actor": actor_of(e["发起方"]), "completion": None}})
        elif e["事件名"] == "REVISION_SAVED":
            rev = next((r for r in task["修订"] if r["事件序号"] == e["事件序号"]), None)
            ops = []
            for op in (rev or {}).get("操作") or []:
                vs = versions.get(op["item"], [])
                after = next((v for v in vs if v["version_no"] == op.get("to_version")), None)
                ops.append({"op": op["op"], "collection": op["collection"], "item_id": op["item"],
                            "title": title_of(after["fields"], collections[op["collection"]]) if after else op["item"],
                            "version_before": op.get("from_version"), "version_after": op.get("to_version"),
                            "fields": after["fields"] if after else None, "sources": after["sources"] if after else []})
            library.append({"event": "deliverable_changed", "data": {
                "seq": e["事件序号"], "at": iso(e["时刻"]), "task_id": task["任务编号"],
                "revision_no": rev["修订序号"] if rev else None, "actor": actor_of(e["发起方"]), "op_id": None,
                "undo_of_revision": None, "operations": ops, "completion": None}})
    return snapshot_task, versions, library


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content or [] if isinstance(p, dict) and p.get("type") == "text")


def export_conversation(session_file: Path, stages: list[dict]) -> list[dict]:
    """用户的话 → user_message；一次运行里执行者最后一段正文 → assistant_reply（这次试跑没有「回复」工具，
    按第 5.2 节第 3 条的兜底，via_reply_tool 为假、act 为空）；运行的过程 → work_summary。"""
    entries = [json.loads(line) for line in session_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    messages: list[dict] = []
    run: dict | None = None
    session_id = next((e.get("id") for e in entries if e.get("type") == "session"), session_file.stem.split("_")[-1])

    def close_run():
        if not run:
            return
        start, end = run["start"], run["end"]
        seconds = round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()) if end else None
        work_id = f"work-{len([m for m in messages if m['type'] == 'work_summary']) + 1}"
        messages.append({"type": "work_summary", "work_id": work_id, "at": iso_utc(end), "seconds": seconds,
                         "step_count": run["steps"], "stages": [{"text": s} for s in run["stages"]]})
        if run["last_text"]:
            messages.append({"type": "assistant_reply", "message_id": run["last_id"], "at": iso_utc(end), "work_id": work_id,
                             "via_reply_tool": False, "informs": [], "act": None, "text": run["last_text"]})

    stage_iter = iter(stages)
    for e in entries:
        if e.get("type") != "message":
            continue
        m = e["message"]
        role = m.get("role")
        if role == "user":
            close_run()
            messages.append({"type": "user_message", "message_id": e["id"], "at": iso_utc(e.get("timestamp")),
                             "text": text_of(m.get("content")), "origin": "typed", "annotation": None, "queued": False})
            run = {"start": e.get("timestamp"), "end": e.get("timestamp"), "steps": 0, "last_text": "", "last_id": None,
                   "stages": [s["一句话"] for s in stage_iter_take(stage_iter)]}
        elif role == "assistant" and run is not None:
            run["end"] = e.get("timestamp")
            calls = [p for p in m.get("content") or [] if isinstance(p, dict) and p.get("type") == "toolCall"]
            run["steps"] += len(calls)
            text = text_of(m.get("content")).strip()
            if text:
                run["last_text"], run["last_id"] = text, e["id"]
    close_run()
    return messages


def stage_iter_take(it):
    """这次试跑只有一句用户的话，执行者的阶段全部属于它。"""
    return list(it)


def iso_utc(stamp: str | None) -> str | None:
    if not stamp:
        return None
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().isoformat(timespec="seconds")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="把一份真实试跑归档导出成假服务用的数据。")
    parser.add_argument("--lab", required=True, help="放试跑归档的目录")
    parser.add_argument("--run", required=True, help="归档目录名")
    parser.add_argument("--workspace", default="workspace-010", help="任务目录名")
    args = parser.parse_args(argv)
    lab = Path(args.lab)
    workspace, run_dir = lab / args.workspace, lab / args.run
    task, versions, library = export_task(workspace)

    index = Index(run_dir, lab)
    sessions = []
    for session_file in sorted((run_dir / "pi-sessions").glob("*/*.jsonl")):
        session_id = session_file.stem.split("_")[-1]
        page = taskpage.page_for_session(index, session_id)
        stages = [s for s in page["阶段"] if s["参与者"] == "执行者"]
        messages = export_conversation(session_file, stages)
        stamps = [m["at"] for m in messages if m.get("at")]
        sessions.append({"session_id": session_id, "name": session_file.parent.name,
                         "started_at": stamps[0] if stamps else None, "last_active_at": stamps[-1] if stamps else None,
                         "message_count": len(messages), "messages": messages})

    materials = []
    for path in sorted((workspace / "inputs").glob("*")):
        if path.is_file():
            materials.append({"path": f"inputs/{path.name}", "bytes": path.stat().st_size,
                              "modified_at": datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds"),
                              "text": path.read_text(encoding="utf-8")})
    template = workspace / "docs" / "templates" / "srs.md"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "说明": f"由 export_fixture.py 从 {args.run} / {args.workspace} 导出，字段照接口约定；不入库。",
        "tasks": [{"task": task, "versions": versions, "library_events": library, "sessions": sessions,
                   "materials": materials, "template": template.read_text(encoding="utf-8") if template.exists() else ""}],
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已导出到 {OUT}：{len(task['items'])} 个条目、{len(library)} 条库事件、{len(sessions)} 条会话、{len(materials)} 份材料。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
