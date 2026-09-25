"""只读地读一个任务的库，拼成接口要的形状。本模块不写库，也不做判断。

读法的纪律：读事务只包住查询语句，拼内容、算完成条件、推送都在 COMMIT 之后做。
完成条件经 Node 子进程调用 agent 里的 conditions.ts（与「完成任务」门禁同一组函数），失败时给 None。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import subprocess
from pathlib import Path

from taskwright_observatory import taskdb
from taskwright_server.service.errors import ApiError
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


REVIEW_CONDITION = "每个条目评审通过"
RULE_REQUIRED = "必选"


def review_specs(definition_text: str | None) -> dict[str, dict]:
    """任务定义原文里各集合的「评审规矩」：集合名 → {"规则文件", "关闭", "升为必选"}。没写的集合不在里面。
    观测台共用的 parse_definition 不取这一项，所以这里从原文里读。"""
    raw = _json(definition_text) if definition_text else None
    deliverable = raw.get("交付物") if isinstance(raw, dict) and isinstance(raw.get("交付物"), dict) else {}
    out = {}
    for entry in deliverable.get("条目集合") or []:
        spec = entry.get("评审规矩") if isinstance(entry, dict) else None
        if isinstance(spec, dict) and isinstance(spec.get("规则文件"), str):
            out[entry.get("名称", "")] = spec
    return out


def effective_rules(task_dir: Path | None, spec: dict | None) -> list[dict] | None:
    """一个集合实际要评的规则（与 agent 的 effectiveRules 同一个算法：去掉关闭的，把升为必选的改成必选），
    写成接口的形状 {id, level, text, counter_example, example}。没写评审规矩或规则文件读不出来时为 None。"""
    if not spec or task_dir is None:
        return None
    try:
        rules = json.loads((Path(task_dir) / spec["规则文件"]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(rules, list):
        return None
    off, promote = set(spec.get("关闭") or []), set(spec.get("升为必选") or [])
    return [{"id": r.get("编号"), "level": RULE_REQUIRED if r.get("编号") in promote else r.get("级别"), "text": r.get("条文"),
             "counter_example": r.get("反例"), "example": r.get("正例")}
            for r in rules if isinstance(r, dict) and r.get("编号") not in off]


def rules_hash_text(file_text: str, off: list[str], promote: list[str]) -> str:
    """规则指纹：与 agent/src/lib/review_state.ts 的 rulesHashText 逐字同一个算法。"""
    text = f"{file_text}\n--\n关闭:{','.join(off)}\n升为必选:{','.join(promote)}"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def rules_hash(task_dir: Path | None, spec: dict | None) -> str | None:
    """一个集合现在的规则指纹；没写评审规矩、没给任务目录或规则文件读不到时为 None（这时不按指纹区分评审记录）。"""
    if not spec or task_dir is None:
        return None
    try:
        text = (Path(task_dir) / spec["规则文件"]).read_text(encoding="utf-8")
    except OSError:
        return None
    return rules_hash_text(text, list(spec.get("关闭") or []), list(spec.get("升为必选") or []))


def all_rules(task_dir: Path | None, spec: dict | None) -> list[dict] | None:
    """规则文件里的全部规则，连同这个任务的开关状态 state：required（必选，不能关）、optional、off（已关闭）、promoted（升为必选）。
    给评审页签的规则区用。"""
    if not spec or task_dir is None:
        return None
    try:
        rules = json.loads((Path(task_dir) / spec["规则文件"]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    off, promote = set(spec.get("关闭") or []), set(spec.get("升为必选") or [])
    out = []
    for r in rules if isinstance(rules, list) else []:
        if not isinstance(r, dict):
            continue
        rid = r.get("编号")
        state = ("required" if r.get("级别") == RULE_REQUIRED else "off" if rid in off else "promoted" if rid in promote else "optional")
        out.append({"id": rid, "level": r.get("级别"), "text": r.get("条文"), "counter_example": r.get("反例"), "example": r.get("正例"),
                    "state": state})
    return out


def collection_review_view(definition: dict, name: str, definition_text: str | None, task_dir: Path | None) -> dict:
    """一个集合的评审部分：要不要评审、生效的规则清单、全部规则与开关、规则指纹。"""
    spec = review_specs(definition_text).get(name)
    return {
        "needs_review": REVIEW_CONDITION in (definition.get("完成条件") or {}).get(name, []),
        "review_rules": effective_rules(task_dir, spec),
        "all_rules": all_rules(task_dir, spec),
        "rule_switches": {"off": list(spec.get("关闭") or []), "promote": list(spec.get("升为必选") or [])} if spec else None,
        "rules_hash": rules_hash(task_dir, spec),
    }


def definition_view(definition: dict, definition_text: str | None = None, task_dir: Path | None = None) -> dict:
    """任务定义里前端要的那部分（docs/api.md §4.1 的 definition）：集合名、前缀、字段名、类型、是否必填、枚举取值；
    以及每个集合的评审部分（collection_review_view）。"""
    return {"collections": [{
        "name": c["名称"], "prefix": c["编号前缀"],
        "fields": [{"name": f["名"], "type": f["类型"], "required": bool(f["必填"]), "values": f.get("取值")} for f in c["字段"]],
        **collection_review_view(definition, c["名称"], definition_text, task_dir),
    } for c in definition["集合"]]}


def batch_view(no: int, row: dict) -> dict:
    """一次评审（批次）：第几次、批次编号、时刻、谁发起、范围与计数。row 是 REVIEW_BATCH 事件那一行。"""
    p = _json(row["payload"]) or {}
    return {"no": no, "batch_id": p.get("batch_id") or row["call_id"], "at": clock.from_local_text(row["at"]),
            "started_by": p.get("started_by") or actor_word(row["actor"]), "scope": p.get("scope"),
            "items": p.get("items") or [], "forced": p.get("forced") or [],
            **{k: p.get(k, 0) for k in ("total", "passed", "failed", "unfinished", "problems", "advice")}}


def finding_view(one: dict) -> dict:
    """事件 payload 里的一条发现，写成接口的形状（与整份数据里 reviews[].findings 相同）。"""
    return {"rule_id": one.get("rule_id"), "level": one.get("level"), "field": one.get("field"), "index": one.get("index"),
            "problem": one.get("problem"), "suggestion": one.get("suggestion")}


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


def is_pre_revision(conn: sqlite3.Connection) -> bool:
    """修订统一之前建的库：条目内容表还有 version_no 列。本版本不支持这种库，库表改动不做迁移。"""
    return "version_no" in {row[1] for row in conn.execute("PRAGMA table_info(item_version)")}


OLD_FORMAT_TEXT = "这个任务是旧格式（修订统一之前建的，条目还按内容版本号记），本版本不支持。请新建一个任务。"


def read_all(conn: sqlite3.Connection, after_seq: int | None = None) -> dict:
    """一个读事务里把任务、事件（after_seq 之后的，或全部）、条目、条目在各次修订下的内容、来源、评审、确认都取出来。"""
    if is_pre_revision(conn):
        raise ApiError("old_format", OLD_FORMAT_TEXT)
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
            "contents": [dict(x) for x in conn.execute("SELECT * FROM item_version WHERE task_id = ? ORDER BY item_id, revision_no", (tid,))],
            "revisions": [x[0] for x in conn.execute("SELECT revision_no FROM revision WHERE task_id = ? ORDER BY revision_no", (tid,))],
            "sources": taskdb.read_sources(conn, tid),
            "event_meta": {x["seq"]: {"actor": x["actor"], "at": x["at"], "call_id": x["call_id"]}
                           for x in conn.execute("SELECT seq, actor, at, call_id FROM event")},
            "reviews": read_reviews(conn, tid),
            "findings": read_findings(conn, tid),
            "waivers": read_waivers(conn, tid),
            "batches": [dict(x) for x in conn.execute(
                "SELECT seq, at, actor, call_id, payload FROM event WHERE task_id = ? AND name = 'REVIEW_BATCH' ORDER BY seq", (tid,))],
            "confirmations": [dict(x) for x in conn.execute(
                "SELECT j.item_id, j.revision_no, j.attitude, g.created_at, g.basis, g.call_id, j.judgement_id "
                "FROM judgement_item j JOIN judgement g ON g.judgement_id = j.judgement_id WHERE j.task_id = ? "
                "ORDER BY j.judgement_id", (tid,))],
        }
    return data


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def read_reviews(conn: sqlite3.Connection, task_id: str) -> list[dict]:
    """评审记录；早期的库没有批次、指纹、重评几列，读作空。"""
    extra = (", batch_id, rules_hash, forced" if {"batch_id", "rules_hash", "forced"} <= _columns(conn, "review")
             else ", NULL AS batch_id, NULL AS rules_hash, 0 AS forced")
    return [dict(x) for x in conn.execute(
        f"SELECT item_id, revision_no, verdict, reason, created_at, review_id{extra} FROM review WHERE task_id = ? ORDER BY review_id", (task_id,))]


def read_waivers(conn: sqlite3.Connection, task_id: str) -> list[dict]:
    """评审豁免（用户保留的写法），含已撤销的；早期的库没有这张表，读作空。"""
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_waiver'").fetchone():
        return []
    return [dict(x) for x in conn.execute(
        "SELECT item_id, revision_no, reason, source, created_at, revoked_at FROM review_waiver WHERE task_id = ? ORDER BY waiver_id", (task_id,))]


def read_findings(conn: sqlite3.Connection, task_id: str) -> dict[int, list[dict]]:
    """评审发现：评审编号 → 逐条发现（接口的形状）。0.1 建的库、还没被写入一侧打开过的，发现表没有规则编号与级别两列，读作空。"""
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "review_finding" not in tables:
        return {}
    columns = {row[1] for row in conn.execute("PRAGMA table_info(review_finding)")}
    extra = ", rule_id, level" if {"rule_id", "level"} <= columns else ", NULL AS rule_id, NULL AS level"
    out: dict[int, list[dict]] = {}
    for row in conn.execute(f"SELECT review_id, field, item_index, problem, suggestion{extra} FROM review_finding "
                            "WHERE task_id = ? ORDER BY review_id, ordinal", (task_id,)):
        out.setdefault(row["review_id"], []).append({"rule_id": row["rule_id"], "level": row["level"], "field": row["field"],
                                                     "index": row["item_index"], "problem": row["problem"], "suggestion": row["suggestion"]})
    return out


# ───────────────────────── 拼装 ─────────────────────────

class Library:
    """把 read_all 取出的行拼成接口的形状。"""

    def __init__(self, data: dict):
        self.data = data
        task = data["task"]
        self.definition = taskdb.parse_definition(task["definition_text"])
        self.collections = {c["名称"]: c for c in self.definition["集合"]}
        # 条目在某次修订下的内容：键是（条目编号, 修订号）。条目只在它被新增、修改或恢复的那些修订下有一行。
        self.contents: dict[tuple[str, int], dict] = {(v["item_id"], v["revision_no"]): v for v in data["contents"]}
        self.items = {i["item_id"]: i for i in data["items"]}

    @property
    def task_id(self) -> str:
        return self.data["task"]["task_id"]

    def fields_of(self, item_id: str, revision_no: int | None) -> dict | None:
        """条目在修订 revision_no 下的内容（那次修订改动过它时才有）。"""
        v = self.contents.get((item_id, revision_no)) if revision_no is not None else None
        return _json(v["fields"]) if v else None

    def sources_of(self, item_id: str, revision_no: int | None) -> list[dict]:
        return [source_view(s) for s in self.data["sources"].get((item_id, revision_no), [])] if revision_no else []

    def reviews_of(self, item_id: str, revision_no: int | None = None) -> list[dict]:
        findings = self.data.get("findings") or {}
        return [{"revision_no": r["revision_no"], "verdict": r["verdict"], "reason": r["reason"],
                 "findings": findings.get(r["review_id"], []), "at": clock.from_local_text(r["created_at"]),
                 "batch_id": r.get("batch_id"), "rules_hash": r.get("rules_hash"), "forced": bool(r.get("forced"))}
                for r in self.data["reviews"] if r["item_id"] == item_id and (revision_no is None or r["revision_no"] == revision_no)]

    def waivers_of(self, item_id: str) -> list[dict]:
        """条目的保留记录（含已撤销的），按先后。"""
        return [{"revision_no": w["revision_no"], "reason": w["reason"], "source": w["source"], "at": clock.from_local_text(w["created_at"]),
                 "revoked": w["revoked_at"] is not None}
                for w in self.data.get("waivers") or [] if w["item_id"] == item_id]

    def active_waiver(self, item_id: str, revision_no: int) -> dict | None:
        """条目在某次修订上生效的保留（没撤销的最近一条）。"""
        live = [w for w in self.waivers_of(item_id) if w["revision_no"] == revision_no and not w["revoked"]]
        return live[-1] if live else None

    def batches_view(self) -> list[dict]:
        """评审批次：每次评审一项，按先后，第几次评审即 no。数据来自 REVIEW_BATCH 事件。"""
        return [batch_view(n, b) for n, b in enumerate(self.data.get("batches") or [], start=1)]

    def confirmations_of(self, item_id: str, revision_no: int | None = None) -> list[dict]:
        out = []
        for c in self.data["confirmations"]:
            if c["item_id"] != item_id or (revision_no is not None and c["revision_no"] != revision_no):
                continue
            basis = _json(c["basis"]) or []
            # 确认标记的依据：已读（打开详情或卡片上点「这几条都看过了」）、界面修改（改字段、标为先不管时随修订自动写）、
            # 界面点击（撤回确认，早期版本还有点了确认的）；都不是的是早期版本由执行者登记的「用户的话」。
            said = {b.get("依据") for b in basis if isinstance(b, dict)}
            kind = ("viewed" if "已读" in said else "ui_click" if "界面点击" in said else "ui_edit" if "界面修改" in said
                    else "user_words")
            out.append({"revision_no": c["revision_no"], "accepted": c["attitude"] == "接受",
                        "at": clock.from_local_text(c["created_at"]), "basis": kind})
        return out

    def item_revisions(self, item_id: str) -> list[int]:
        """条目改动过的修订号，从早到晚。"""
        return sorted(no for (iid, no) in self.contents if iid == item_id)

    def current_revision(self, item_id: str) -> int | None:
        """条目当前所在的修订：它最近一次被新增、修改或恢复的那次修订。"""
        numbers = self.item_revisions(item_id)
        return numbers[-1] if numbers else None

    def latest_revision(self) -> int:
        """任务最新的修订号；还没有修订时是 0。"""
        return max(self.data.get("revisions") or [0])

    def alive_at(self, revision_no: int) -> list[tuple[str, int]]:
        """修订 revision_no 时交付物里有哪些条目，以及每个条目那时的内容来自哪次修订：（条目编号, 内容所在的修订号）。"""
        out = []
        for i in self.items.values():
            if i["added_in_revision"] > revision_no:
                continue
            if i["deleted_in_revision"] is not None and i["deleted_in_revision"] <= revision_no:
                continue
            upto = [no for no in self.item_revisions(i["item_id"]) if no <= revision_no]
            if upto:
                out.append((i["item_id"], upto[-1]))
        return out

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
            no = self.current_revision(i["item_id"])
            v = self.contents[(i["item_id"], no)]
            meta = self.data["event_meta"].get(v["event_seq"], {})
            fields = _json(v["fields"]) or {}
            confirmations = self.confirmations_of(i["item_id"])
            accepted = [c for c in confirmations if c["accepted"]]
            latest_for_current = [c for c in confirmations if c["revision_no"] == no]
            current_ok = bool(latest_for_current and latest_for_current[-1]["accepted"])
            by, at = actor_word(meta.get("actor", "")), clock.from_local_text(meta.get("at"))
            revisions = self.item_revisions(i["item_id"])
            items.append({
                "item_id": i["item_id"], "collection": i["collection"],
                "title": title_of(fields, self.collections.get(i["collection"])),
                "revision_no": no, "revision_by": by, "revision_at": at, "revisions": revisions,
                "fields": fields, "sources": self.sources_of(i["item_id"], no),
                "reviews": self.reviews_of(i["item_id"]),
                "waivers": self.waivers_of(i["item_id"]),
                "confirmations": confirmations,
                # 确认是挂在「条目加修订」上的标记：有过接受记录，但条目当前所在的修订上最近一条态度不是接受，就是确认已失效。
                "confirmation_stale": bool(accepted) and not current_ok,
                # 已读是条目级、单向的：在任何一次修订上有过接受的标记（任一依据）就不算未读，之后再改也不翻回未读。
                # 依据写在 confirmation_basis 里：当前修订上接受了取它的依据，否则取最后一次接受的依据；未读时为空。
                "viewed": bool(accepted),
                "confirmation_basis": (latest_for_current[-1]["basis"] if current_ok
                                       else accepted[-1]["basis"] if accepted else None),
            })
        return {
            "task_id": task["task_id"],
            "task_name": task.get("task_name") or self.definition["任务名"],
            "task_type": self.definition["任务名"],
            "domain_tag": task.get("domain_tag"),
            "status": task["status"],
            "started_at": clock.from_local_text(task["started_at"]),
            "ended_at": clock.from_local_text(task["ended_at"]),
            "definition": definition_view(self.definition, task.get("definition_text"), self.data.get("task_dir")),
            "completion": None,
            "items": items,
            "latest_revision": self.latest_revision(),
            "review_batches": self.batches_view(),
        }

    def revisions_view(self, item_id: str) -> list[dict]:
        """条目在它改动过的每次修订下的内容，从早到晚（docs/api.md 4.3 的条目修订列表）。"""
        out = []
        for (iid, no), v in sorted(self.contents.items()):
            if iid != item_id:
                continue
            meta = self.data["event_meta"].get(v["event_seq"], {})
            out.append({"revision_no": no, "by": actor_word(meta.get("actor", "")),
                        "at": clock.from_local_text(meta.get("at")), "fields": _json(v["fields"]) or {},
                        "sources": self.sources_of(iid, no), "reviews": self.reviews_of(iid, no),
                        "confirmations": self.confirmations_of(iid, no)})
        return out

    # ── 库事件（docs/api.md §3.1） ──

    def event_payload(self, e: dict) -> tuple[str, dict] | None:
        """一行事件拼成（事件名, data）；不认识的事件名返回 None。字段与来源取条目在那次修订下的内容。"""
        payload = _json(e["payload"]) or {}
        base = {"seq": e["seq"], "at": clock.from_local_text(e["at"]), "task_id": e["task_id"]}
        actor = actor_word(e["actor"])
        if e["name"] == "REVISION_SAVED":
            ops = []
            for op in payload.get("operations") or []:
                item, after, before = op.get("item"), op.get("to_revision"), op.get("from_revision")
                fields = self.fields_of(item, after)
                coll = self.collections.get(op.get("collection"))
                ops.append({"op": op.get("op"), "collection": op.get("collection"), "item_id": item,
                            "title": title_of(fields if fields is not None else self.fields_of(item, before), coll),
                            "revision_before": before, "revision_after": after,
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
        if e["name"] == "ITEM_VIEWED":
            return "item_viewed", {**base, "items": payload.get("items") or [],
                                   "op_id": e["call_id"] if actor == ACTOR_USER else None, "completion": None}
        op_id = e["call_id"] if actor == ACTOR_USER else None
        if e["name"] == "REVIEW_RECORDED":
            return "review_recorded", {**base, "item_id": payload.get("item_id"), "revision_no": payload.get("revision_no"),
                                       "verdict": payload.get("verdict"), "reason": payload.get("reason"),
                                       "findings": [finding_view(f) for f in payload.get("findings") or []],
                                       "batch_id": payload.get("batch_id"), "rules_hash": payload.get("rules_hash"),
                                       "forced": bool(payload.get("forced")), "op_id": op_id, "completion": None}
        if e["name"] == "REVIEW_UNFINISHED":
            return "review_unfinished", {**base, "item_id": payload.get("item_id"), "revision_no": payload.get("revision_no"),
                                         "reason": payload.get("reason"), "op_id": op_id, "completion": None}
        if e["name"] == "REVIEW_PROGRESS":
            return "review_progress", {**base, "op_id": payload.get("op_id"), "done": payload.get("done"), "total": payload.get("total"),
                                       "current": payload.get("current") or [], "item_id": payload.get("item_id"), "completion": None}
        if e["name"] == "REVIEW_FINISHED":
            return "review_finished", {**base, "op_id": payload.get("op_id"), "total": payload.get("total"),
                                       "passed": payload.get("passed"), "failed": payload.get("failed"),
                                       "unfinished": payload.get("unfinished"), "results": payload.get("results") or [],
                                       "error": payload.get("error"), "completion": None}
        if e["name"] == "REVIEW_BATCH":
            earlier = [b for b in self.data.get("batches") or [] if b["seq"] < e["seq"]]
            return "review_batch", {**base, **batch_view(len(earlier) + 1, {"seq": e["seq"], "at": e["at"], "actor": e["actor"],
                                                                            "call_id": e["call_id"], "payload": e["payload"]}),
                                    "completion": None}
        if e["name"] in ("REVIEW_WAIVED", "REVIEW_UNWAIVED"):
            return ("review_waived" if e["name"] == "REVIEW_WAIVED" else "review_unwaived"), {
                **base, "items": payload.get("items") or [], "reason": payload.get("reason"), "source": payload.get("source"),
                "op_id": op_id, "completion": None}
        if e["name"] == "REVIEW_RULES_CHANGED":
            name = payload.get("collection")
            return "review_rules_changed", {**base, "collection": name, "off": payload.get("off") or [], "promote": payload.get("promote") or [],
                                            "op_id": op_id, "completion": None,
                                            **collection_review_view(self.definition, name, self.data["task"].get("definition_text"),
                                                                     self.data.get("task_dir"))}
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
    data["task_dir"] = task_dir
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
    data["task_dir"] = task_dir
    lib = Library(data)
    view = lib.task_view()
    view["completion"] = completion(task_dir, lib.task_id, lib.definition, lib.totals())
    return data["seq"], view


def item_revisions(task_dir: Path, item_id: str) -> list[dict] | None:
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
    return lib.revisions_view(item_id) if item_id in lib.items else None


def changed_fields(before: dict | None, after: dict | None, collection: dict | None) -> list[str]:
    """前后两次修订逐字段比较，列出值不同的字段名，按任务定义里的字段顺序。新增、删除时（有一边为空）不列。"""
    if before is None or after is None or not collection:
        return []
    def same(a, b):
        return json.dumps(a, ensure_ascii=False, sort_keys=True) == json.dumps(b, ensure_ascii=False, sort_keys=True)
    return [f["名"] for f in collection.get("字段") or [] if not same(before.get(f["名"]), after.get(f["名"]))]


def revision_log(task_dir: Path) -> list[dict] | None:
    """修订日志（docs/api.md 4.3）：每次修订一项，最新的在前。每项写这次修订的时刻、发起方、产生它的会话与调用编号，
    以及碰到的条目：操作、编号、标题、所属集合、改前改后所在的修订、改了哪些字段（前后两次修订逐字段比较）。
    修订表的 intent_act_id 对得上对话行为表里的一项用户行为时，另带 intent（编号、功能码、功能的中文名、摘要），
    修订卡片据此写「因为你说：……」；对不上（用户直接修改、旧库没有这两样）时为空。
    触发它的事与工作编号要读会话记录，由调用方补（app.py 的 Service.revision_log）。任务还没有创建时返回 None。"""
    conn = open_ro(task_dir)
    if conn is None:
        return None
    try:
        data = read_all(conn)
        if data["task"] is None:
            return None
        with Reader(conn):
            rows = [dict(x) for x in conn.execute("SELECT * FROM revision WHERE task_id = ? ORDER BY revision_no",
                                                  (data["task"]["task_id"],))]
            events = {x["seq"]: dict(x) for x in conn.execute("SELECT * FROM event WHERE name = 'REVISION_SAVED'")}
            intents = intent_acts(conn, data["task"]["task_id"], rows)
    finally:
        conn.close()
    lib = Library(data)
    out = []
    for row in reversed(rows):
        event = events.get(row["event_seq"]) or {}
        payload = _json(event.get("payload")) or {}
        ops = []
        for op in payload.get("operations") or []:
            item, before_no, after_no = op.get("item"), op.get("from_revision"), op.get("to_revision")
            before, after = lib.fields_of(item, before_no), lib.fields_of(item, after_no)
            coll = lib.collections.get(op.get("collection"))
            ops.append({"op": op.get("op"), "item_id": item, "collection": op.get("collection"),
                        "title": title_of(after if after is not None else before, coll),
                        "revision_before": before_no, "revision_after": after_no,
                        "fields_changed": changed_fields(before, after, coll) if op.get("op") == "update" else []})
        out.append({"revision_no": row["revision_no"], "at": clock.from_local_text(event.get("at") or row["created_at"]),
                    "by": actor_word(event.get("actor", "")), "session_id": row["session_id"], "call_id": row["call_id"],
                    "undo_of_revision": payload.get("undo_of_revision"), "operations": ops,
                    "intent": intents.get((row["session_id"], row.get("intent_act_id")))})
    return out


def intent_acts(conn, task_id: str, rows: list[dict]) -> dict[tuple[str, str], dict]:
    """修订表里被 intent_act_id 引用的那几项用户行为，键是（会话编号, 行为编号）。库里没有对话行为表时为空。"""
    wanted = {(r["session_id"], r.get("intent_act_id")) for r in rows if r.get("intent_act_id")}
    if not wanted or conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dialogue_act'").fetchone() is None:
        return {}
    from taskwright_server.service.work_summary import function_names
    names = function_names()
    out = {}
    for session_id, act_id in wanted:
        row = conn.execute("SELECT function, summary FROM dialogue_act WHERE task_id = ? AND session_id = ? AND act_id = ? AND speaker = 'user'",
                           (task_id, session_id, act_id)).fetchone()
        if row is not None:
            out[(session_id, act_id)] = {"act_id": act_id, "function": row[0], "function_name": names.get(row[0], row[0]),
                                         "summary": row[1]}
    return out


def materials(task_dir: Path, definition: dict | None) -> list[dict]:
    folder = Path(task_dir) / ((definition or {}).get("材料目录") or taskdb.DEFAULT_MATERIALS_DIR)
    if not folder.is_dir():
        return []
    rel = (definition or {}).get("材料目录") or taskdb.DEFAULT_MATERIALS_DIR
    return [{"path": f"{rel}{p.name}", "bytes": p.stat().st_size, "modified_at": clock.from_epoch(p.stat().st_mtime)}
            for p in sorted(folder.iterdir()) if p.is_file()]
