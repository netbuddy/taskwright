"""只读地读一个任务的库，拼成接口要的形状。本模块不写库，也不做判断。

读法的纪律：读事务只包住查询语句，拼内容、算完成条件、推送都在 COMMIT 之后做。
完成条件经 Node 子进程调用 agent 里的 conditions.ts（与「完成任务」门禁同一组函数），失败时给 None。
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
from pathlib import Path

from taskwright_observatory import taskdb
from taskwright_server.service import clock

REPO_ROOT = Path(__file__).resolve().parents[3]
CHECK_COMPLETION = REPO_ROOT / "agent" / "src" / "cli" / "check_completion.mts"
ACTOR_USER = "user"


def db_file(task_dir: Path) -> Path:
    return Path(task_dir) / taskdb.DB_NAME


def open_ro(task_dir: Path) -> sqlite3.Connection | None:
    path = db_file(task_dir)
    if not path.is_file() or path.stat().st_size == 0:
        return None
    conn = taskdb.open_readonly(path)
    conn.isolation_level = None     # 读事务由这里显式 BEGIN 与 COMMIT
    return conn


def _json(text):
    return taskdb._json(text)


def actor_word(actor: str) -> str:
    """库里的发起方写法换成接口的写法：最早格式里的「模型」算执行者。"""
    return ACTOR_USER if actor == ACTOR_USER else "executor"


def title_of(fields: dict | None, collection: dict | None) -> str:
    """条目的标题：集合声明的第一个字段在这一版里的值。"""
    if not fields or not collection or not collection.get("字段"):
        return ""
    value = fields.get(collection["字段"][0]["名"])
    if isinstance(value, list):
        return "、".join(str(v) for v in value)
    return str(value or "")


def definition_view(definition: dict) -> dict:
    """任务定义里前端要的那部分（docs/api.md §4.1 的 definition）：集合名、前缀、字段名、类型、是否必填、枚举取值。"""
    return {"collections": [{
        "name": c["名称"], "prefix": c["编号前缀"],
        "fields": [{"name": f["名"], "type": f["类型"], "required": bool(f["必填"]), "values": f.get("取值")} for f in c["字段"]],
    } for c in definition["集合"]]}


def source_view(one: dict) -> dict:
    return {"kind": one["种类"], "locator": one["出处"], "excerpt": one["摘录"],
            "supports": [{"field": s["字段"], "index": s["第几项"]} for s in one.get("支持") or []]}


# ───────────────────────── 完成条件 ─────────────────────────

def completion(task_dir: Path, task_id: str, definition: dict, totals: dict[str, int]) -> dict | None:
    """按任务定义的完成条件逐项核对，给docs/api.md §4.2 的形状；子进程失败返回 None。totals 是每个集合现有的条目数。"""
    node = shutil.which("node")
    if node is None:
        return None
    try:
        done = subprocess.run([node, str(CHECK_COMPLETION), str(db_file(task_dir)), task_id,
                               json.dumps(definition["完成条件"], ensure_ascii=False)],
                              capture_output=True, text=True, timeout=30)
        out = json.loads(done.stdout) if done.returncode == 0 else None
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        out = None
    results = out.get("results") if isinstance(out, dict) else None
    if not isinstance(results, list):
        return None
    conditions = []
    for r in results:
        total = totals.get(r["collection"], 0)
        missing = [u["item"] for u in r.get("unmet") or [] if u.get("item")]
        # met 是门禁意义上的满足（暂无条目也算）；state 给报告用：met、unmet、empty（集合为空，这一条无从谈起）
        conditions.append({"collection": r["collection"], "name": r["condition"], "met": bool(r["satisfied"]),
                           "state": r.get("state") or ("met" if r["satisfied"] else "unmet"),
                           "done": total - len(missing), "total": total, "missing": missing, "note": r.get("summary", "")})
    return {"all_met": all(c["met"] for c in conditions), "unmet_count": sum(c["state"] == "unmet" for c in conditions),
            "brief": out.get("brief", ""), "conditions": conditions}


# ───────────────────────── 读库（都在调用方开好的读事务里） ─────────────────────────

class Reader:
    """在一个读事务里取一次库的全部所需，取完就提交；之后的拼装只用内存里的这些行。"""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self) -> "Reader":
        self.conn.execute("BEGIN")
        return self

    def __exit__(self, *exc) -> None:
        self.conn.execute("COMMIT")

    def task(self) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM task ORDER BY started_at LIMIT 1").fetchone()

    def max_seq(self) -> int:
        return int(self.conn.execute("SELECT COALESCE(MAX(seq), 0) FROM event").fetchone()[0])


def read_all(conn: sqlite3.Connection, after_seq: int | None = None) -> dict:
    """一个读事务里把任务、事件（after_seq 之后的，或全部）、条目、版本、来源、评审、确认都取出来。"""
    with Reader(conn) as r:
        task = r.task()
        seq = r.max_seq()
        if task is None:
            return {"task": None, "seq": seq}
        tid = task["task_id"]
        events = [dict(e) for e in conn.execute(
            "SELECT * FROM event WHERE seq > ? ORDER BY seq", (after_seq or 0,))] if after_seq is not None else []
        data = {
            "task": dict(task),
            "seq": seq,
            "events": events,
            "items": [dict(x) for x in conn.execute("SELECT * FROM item WHERE task_id = ?", (tid,))],
            "versions": [dict(x) for x in conn.execute("SELECT * FROM item_version WHERE task_id = ? ORDER BY item_id, version_no", (tid,))],
            "sources": taskdb.read_sources(conn, tid),
            "event_meta": {x["seq"]: {"actor": x["actor"], "at": x["at"], "call_id": x["call_id"]}
                           for x in conn.execute("SELECT seq, actor, at, call_id FROM event")},
            "reviews": [dict(x) for x in conn.execute(
                "SELECT item_id, version_no, verdict, reason, created_at, review_id FROM review WHERE task_id = ? ORDER BY review_id", (tid,))],
            "confirmations": [dict(x) for x in conn.execute(
                "SELECT j.item_id, j.version_no, j.attitude, g.created_at, g.basis, g.call_id, j.judgement_id "
                "FROM judgement_item j JOIN judgement g ON g.judgement_id = j.judgement_id WHERE j.task_id = ? "
                "ORDER BY j.judgement_id", (tid,))],
        }
    return data


# ───────────────────────── 拼装 ─────────────────────────

class Library:
    """把 read_all 取出的行拼成接口的形状。"""

    def __init__(self, data: dict):
        self.data = data
        task = data["task"]
        self.definition = taskdb.parse_definition(task["definition_text"])
        self.collections = {c["名称"]: c for c in self.definition["集合"]}
        self.versions: dict[tuple[str, int], dict] = {(v["item_id"], v["version_no"]): v for v in data["versions"]}
        self.items = {i["item_id"]: i for i in data["items"]}

    @property
    def task_id(self) -> str:
        return self.data["task"]["task_id"]

    def fields_of(self, item_id: str, version_no: int | None) -> dict | None:
        v = self.versions.get((item_id, version_no)) if version_no is not None else None
        return _json(v["fields"]) if v else None

    def sources_of(self, item_id: str, version_no: int | None) -> list[dict]:
        return [source_view(s) for s in self.data["sources"].get((item_id, version_no), [])] if version_no else []

    def reviews_of(self, item_id: str, version_no: int | None = None) -> list[dict]:
        # findings：评审发现的逐条列表，要等评审工具提供之后的写法；现在库里只有一段理由，先给空列表。
        return [{"version_no": r["version_no"], "verdict": r["verdict"], "reason": r["reason"], "findings": [],
                 "at": clock.from_local_text(r["created_at"])}
                for r in self.data["reviews"] if r["item_id"] == item_id and (version_no is None or r["version_no"] == version_no)]

    def confirmations_of(self, item_id: str, version_no: int | None = None) -> list[dict]:
        out = []
        for c in self.data["confirmations"]:
            if c["item_id"] != item_id or (version_no is not None and c["version_no"] != version_no):
                continue
            basis = _json(c["basis"]) or []
            ui = any(isinstance(b, dict) and b.get("依据") == "界面点击" for b in basis)
            out.append({"version_no": c["version_no"], "accepted": c["attitude"] == "接受", "at": clock.from_local_text(c["created_at"]),
                        "basis": "ui_click" if ui else "user_words"})
        return out

    def current_version(self, item_id: str) -> int | None:
        numbers = [no for (iid, no) in self.versions if iid == item_id]
        return max(numbers) if numbers else None

    def totals(self) -> dict[str, int]:
        out = {name: 0 for name in self.collections}
        for i in self.items.values():
            if i["deleted_in_revision"] is None:
                out[i["collection"]] = out.get(i["collection"], 0) + 1
        return out

    # ── 整份数据里的 task（docs/api.md §4.1） ──

    def task_view(self) -> dict:
        task = self.data["task"]
        order = {name: n for n, name in enumerate(self.collections)}
        items = []
        for i in sorted(self.items.values(), key=lambda x: (order.get(x["collection"], 99), x["serial"])):
            if i["deleted_in_revision"] is not None:
                continue
            no = self.current_version(i["item_id"])
            v = self.versions[(i["item_id"], no)]
            meta = self.data["event_meta"].get(v["event_seq"], {})
            fields = _json(v["fields"]) or {}
            confirmations = self.confirmations_of(i["item_id"])
            accepted = [c for c in confirmations if c["accepted"]]
            latest_for_current = [c for c in confirmations if c["version_no"] == no]
            items.append({
                "item_id": i["item_id"], "collection": i["collection"],
                "title": title_of(fields, self.collections.get(i["collection"])),
                "version_no": no, "version_by": actor_word(meta.get("actor", "")), "version_at": clock.from_local_text(meta.get("at")),
                "version_count": sum(1 for (iid, _) in self.versions if iid == i["item_id"]),
                "fields": fields, "sources": self.sources_of(i["item_id"], no),
                "reviews": self.reviews_of(i["item_id"]),
                "confirmations": confirmations,
                # 确认过的版本不是当前版本：有过接受记录，但当前版本最近一条态度不是接受。
                "confirmation_stale": bool(accepted) and not (latest_for_current and latest_for_current[-1]["accepted"]),
            })
        return {
            "task_id": task["task_id"],
            "task_name": task.get("task_name") or self.definition["任务名"],
            "task_type": self.definition["任务名"],
            "domain_tag": task.get("domain_tag"),
            "status": task["status"],
            "started_at": clock.from_local_text(task["started_at"]),
            "ended_at": clock.from_local_text(task["ended_at"]),
            "definition": definition_view(self.definition),
            "completion": None,
            "items": items,
        }

    def versions_view(self, item_id: str) -> list[dict]:
        out = []
        for (iid, no), v in sorted(self.versions.items()):
            if iid != item_id:
                continue
            meta = self.data["event_meta"].get(v["event_seq"], {})
            out.append({"version_no": no, "revision_no": v["revision_no"], "by": actor_word(meta.get("actor", "")),
                        "at": clock.from_local_text(meta.get("at")), "fields": _json(v["fields"]) or {},
                        "sources": self.sources_of(iid, no), "reviews": self.reviews_of(iid, no),
                        "confirmations": self.confirmations_of(iid, no)})
        return out

    # ── 库事件（docs/api.md §3.1） ──

    def event_payload(self, e: dict) -> tuple[str, dict] | None:
        """一行事件拼成（事件名, data）；不认识的事件名返回 None。字段与来源取「当时那一版」。"""
        payload = _json(e["payload"]) or {}
        base = {"seq": e["seq"], "at": clock.from_local_text(e["at"]), "task_id": e["task_id"]}
        actor = actor_word(e["actor"])
        if e["name"] == "REVISION_SAVED":
            ops = []
            for op in payload.get("operations") or []:
                item, after, before = op.get("item"), op.get("to_version"), op.get("from_version")
                fields = self.fields_of(item, after)
                coll = self.collections.get(op.get("collection"))
                ops.append({"op": op.get("op"), "collection": op.get("collection"), "item_id": item,
                            "title": title_of(fields if fields is not None else self.fields_of(item, before), coll),
                            "version_before": before, "version_after": after,
                            "fields": fields, "sources": self.sources_of(item, after)})
            return "deliverable_changed", {**base, "revision_no": payload.get("revision_no"), "actor": actor,
                                           "op_id": e["call_id"] if actor == ACTOR_USER else None,
                                           "undo_of_revision": payload.get("undo_of_revision"), "operations": ops,
                                           "completion": None}
        if e["name"] == "TASK_CREATED":
            return "task_changed", {**base, "task_name": payload.get("task_name"), "status_before": None,
                                    "status_after": "进行中", "actor": actor, "completion": None}
        if e["name"] == "TASK_COMPLETED":
            task = self.data["task"]
            return "task_changed", {**base, "task_name": task.get("task_name") or self.definition["任务名"],
                                    "status_before": payload.get("status_before") or "进行中",
                                    "status_after": payload.get("status_after") or "已完成", "actor": actor, "completion": None}
        if e["name"] == "CONFIRMATION_RECORDED":
            return "confirmation_recorded", {**base, "items": payload.get("items") or [], "basis": payload.get("basis") or "ui_click",
                                             "op_id": e["call_id"] if actor == ACTOR_USER else None, "completion": None}
        return None


def library_events(task_dir: Path, after_seq: int) -> tuple[list[tuple[str, dict]], int]:
    """取 after_seq 之后的全部事件并拼好；完成条件算一次，附在最后一条上。返回（事件列表, 当前最大序号）。"""
    conn = open_ro(task_dir)
    if conn is None:
        return [], 0
    try:
        data = read_all(conn, after_seq)     # 读事务在这里面开、在这里面提交
    finally:
        conn.close()
    if data["task"] is None or not data["events"]:
        return [], data["seq"]
    lib = Library(data)
    out = [p for p in (lib.event_payload(e) for e in data["events"]) if p is not None]
    if out:
        out[-1][1]["completion"] = completion(task_dir, lib.task_id, lib.definition, lib.totals())
    return out, data["seq"]


def task_snapshot(task_dir: Path) -> tuple[int, dict | None]:
    """整份数据里的 seq 与 task：取号与读表在同一个读事务里；完成条件在提交之后算。"""
    conn = open_ro(task_dir)
    if conn is None:
        return 0, None
    try:
        data = read_all(conn)
    finally:
        conn.close()
    if data["task"] is None:
        return data["seq"], None
    lib = Library(data)
    view = lib.task_view()
    view["completion"] = completion(task_dir, lib.task_id, lib.definition, lib.totals())
    return data["seq"], view


def item_versions(task_dir: Path, item_id: str) -> list[dict] | None:
    conn = open_ro(task_dir)
    if conn is None:
        return None
    try:
        data = read_all(conn)
    finally:
        conn.close()
    if data["task"] is None:
        return None
    lib = Library(data)
    return lib.versions_view(item_id) if item_id in lib.items else None


def materials(task_dir: Path, definition: dict | None) -> list[dict]:
    folder = Path(task_dir) / ((definition or {}).get("材料目录") or taskdb.DEFAULT_MATERIALS_DIR)
    if not folder.is_dir():
        return []
    rel = (definition or {}).get("材料目录") or taskdb.DEFAULT_MATERIALS_DIR
    return [{"path": f"{rel}{p.name}", "bytes": p.stat().st_size, "modified_at": clock.from_epoch(p.stat().st_mtime)}
            for p in sorted(folder.iterdir()) if p.is_file()]
