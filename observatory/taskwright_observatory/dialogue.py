"""对话行为层：从任务库只读地取出用户与助手（执行者）的对话行为，按运行对上，并算三个派生事实。

数据的来处都在任务库里（agent 侧写的，本模块只读）：

· dialogue_act 表：每一项对话行为一行，编号是「运行号-序号」（例如 r13-2），运行号是这条会话当前分支上第几句用户的话。
· event 表里的几种事件：USER_INTENT_RECORDED（记下一份理解或界面合成的用户行为，内容里有 user_entry，即那句用户的话的
  会话条目编号）、USER_INTENT_INVALID（一份符合格式、但事实核对没通过的理解，内容里有 user_entry 与原因）、
  USER_INTENT_MISSING（这一轮结束时这句话仍没有合格的理解，唯一算失败的情形，内容里有 user_entry 与本轮各片段最近的错误）、
  STRUCTURED_OUTPUT_UNMATCHED（助手文字里没匹配上任何一种登记格式的 JSON 片段，或解析不了的片段，只是诊断，
  内容里有 user_entry 与逐个片段）、EXECUTOR_ACTS_RECORDED
  （「回复」记下的助手行为，调用编号是那次「回复」工具调用的 pi 调用编号）。观测台的一次运行按这两样对上：
  它的用户消息条目编号对 user_entry，它里面的「回复」调用编号对 EXECUTOR_ACTS_RECORDED 的调用编号；两样都对不上时
  （例如会话文件不在归档里、拿不到条目编号），按它是这条会话里的第几次运行对运行号（第 N 次运行就是 rN：运行号数的是
  用户的话，观测台的一次运行也由一句用户的话引出，兜底提醒那句不另起运行）。

三个派生事实的口径与 agent 侧 agent/src/lib/dialogue_acts.ts 的 dialogueFacts 一致：
还在等回应的执行者行为、连续追问（按运行先后，针对同一条目的期待回应的行为，被回应过就从 0 重数）、
改口（这条会话里发起方是用户、或者带着 intent_act_id 的修订，数每个条目每个字段的值改过几次，2 次及以上才列）。

功能的中文名从理解格式的 schema（agent/prompts/schemas/user_intent.schema.json）取，这里不另写一份。
「运行号」只在一条会话里连续，与观测台按任务连续数的「运行序号」不是同一个数，两者并列显示。
"""

from __future__ import annotations

import functools
import json
import sqlite3
from pathlib import Path

#: 理解格式的 schema：用户侧九种功能与执行者侧五种向用户要的回应的中文名只写在这里。
INTENT_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "agent" / "prompts" / "schemas" / "user_intent.schema.json"

RECORDED = "USER_INTENT_RECORDED"
INVALID = "USER_INTENT_INVALID"
MISSING = "USER_INTENT_MISSING"
UNMATCHED = "STRUCTURED_OUTPUT_UNMATCHED"
EXECUTOR_RECORDED = "EXECUTOR_ACTS_RECORDED"

#: 诊断行里每个片段显示前多少字。
FRAGMENT_SHOWN = 200
#: 片段的性质写成的中文。
FRAGMENT_NATURE = {"unmatched": "没有匹配上任何一种格式", "unparseable": "解析不了"}

#: 把握三档的中文说法。
CONFIDENCE_WORDS = {"high": "把握高", "medium": "把握中", "low": "把握低"}


@functools.cache
def function_names() -> dict[str, dict[str, str]]:
    """{"user": {英文码: 中文名}, "executor": {英文码: 中文名}}；执行者侧另加告知 inform。读不到 schema 时两边都是空的。"""
    try:
        defs = json.loads(INTENT_SCHEMA_PATH.read_text(encoding="utf-8"))["$defs"]
        user = dict(defs["user_function"]["x-names"])
        executor = {"inform": user.get("inform", "告知"), **defs["executor_function"]["x-names"]}
        return {"user": user, "executor": executor}
    except (OSError, ValueError, KeyError, TypeError):
        return {"user": {}, "executor": {}}


def function_label(code: str, speaker: str) -> str:
    """「中文名（英文码）」；不认识的码原样写。"""
    name = function_names()["user" if speaker == "user" else "executor"].get(code)
    return f"{name}（{code}）" if name else code


def _json(text):
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def has_dialogue(conn: sqlite3.Connection) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dialogue_act'").fetchone() is not None


def _run_number(run_id: str) -> int:
    try:
        return int(str(run_id).lstrip("r"))
    except ValueError:
        return 0


def target_text(targets: list[dict]) -> str:
    """针对的条目与位置写成一句：UC-003 的参与者、UC-001 的步骤第 2 项。"""
    out = []
    for t in targets or []:
        one = str(t.get("item_id") or "")
        if t.get("field"):
            one += f" 的{t['field']}"
            if t.get("index") is not None:
                one += f"第 {int(t['index']) + 1} 项"
        out.append(one)
    return "、".join(x for x in out if x)


def read_session(conn: sqlite3.Connection, task_id: str, session_id: str) -> dict:
    """一条会话的对话行为与三种事件。没有对话行为表的旧库返回空的结构（「有没有」为假）。"""
    if not has_dialogue(conn):
        return {"有没有": False, "行为": [], "理解事件": [], "无效": [], "失败": [], "未匹配": [], "回复事件": []}
    columns = ("act_id", "run_id", "speaker", "function", "targets", "responds_to", "expects_response",
               "confidence", "summary", "source_entry", "origin", "event_seq")
    rows = conn.execute(f"SELECT {', '.join(columns)} FROM dialogue_act WHERE task_id = ? AND session_id = ? ORDER BY rowid",
                        (task_id, session_id)).fetchall()
    acts = []
    for row in rows:
        act = dict(zip(columns, row))
        act["targets"] = _json(act["targets"]) or []
        acts.append(act)
    names = (RECORDED, INVALID, MISSING, UNMATCHED, EXECUTOR_RECORDED)
    events = conn.execute(f"SELECT seq, name, call_id, payload FROM event WHERE task_id = ? AND session_id = ? "
                          f"AND name IN ({', '.join('?' * len(names))}) ORDER BY seq", (task_id, session_id, *names)).fetchall()
    shaped = [{"序号": s, "事件名": n, "调用编号": c, "内容": _json(p) or {}} for s, n, c, p in events]
    return {"有没有": True, "行为": acts,
            "理解事件": [e for e in shaped if e["事件名"] == RECORDED],
            "无效": [e for e in shaped if e["事件名"] == INVALID],
            "失败": [e for e in shaped if e["事件名"] == MISSING],
            "未匹配": [e for e in shaped if e["事件名"] == UNMATCHED],
            "回复事件": [e for e in shaped if e["事件名"] == EXECUTOR_RECORDED]}


def fragment_row(fragment: dict) -> dict:
    """一个没匹配上的片段写成诊断行：性质、前 FRAGMENT_SHOWN 字、校验错误（按登记格式分列）或解析错误。"""
    nature = fragment.get("nature") or ""
    errors = fragment.get("errors") or {}
    lines = ([f"对 {name}：" + "；".join(found) for name, found in errors.items() if found] if nature == "unmatched"
             else [fragment.get("parse_error") or ""])
    return {"性质": FRAGMENT_NATURE.get(nature, nature), "前200字": (fragment.get("text") or "")[:FRAGMENT_SHOWN],
            "离得最近的格式": fragment.get("nearest") or "", "错误": [x for x in lines if x]}


def run_layer(session: dict, user_entry: str, reply_call_ids: list[str], ordinal: int | None = None) -> dict | None:
    """一次运行的对话行为层：用户行为（左列）、助手行为（右列）、这一轮是否没有合格的理解（失败，一轮至多一次），
    以及只作诊断的两样：没匹配上的 JSON 片段、符合格式但事实核对没通过的理解。
    ordinal 是这次运行在它那条会话里是第几次运行，前两种办法都对不上时用它。
    这次运行在库里一项对话行为也没有、也没有失败与诊断记录时返回 None。"""
    if not session.get("有没有"):
        return None
    acts = session["行为"]
    run_id = next((a["run_id"] for a in acts if a["speaker"] == "user" and user_entry and a["source_entry"] == user_entry), None)
    if run_id is None:
        hit = next((e for e in session["回复事件"] if e["调用编号"] in reply_call_ids), None)
        run_id = (hit or {}).get("内容", {}).get("run_id")
    notes = session["无效"] + session["失败"] + session["未匹配"]
    if run_id is None and ordinal is not None:
        guess = f"r{ordinal}"
        if any(a["run_id"] == guess for a in acts) or any(e["内容"].get("run_id") == guess for e in notes):
            run_id = guess
    if not user_entry and run_id:
        user_entry = next((a["source_entry"] for a in acts if a["speaker"] == "user" and a["run_id"] == run_id), "") or next(
            (e["内容"].get("user_entry") for e in notes if e["内容"].get("run_id") == run_id), "")
    mine = lambda kind: [e["内容"] for e in session[kind] if user_entry and e["内容"].get("user_entry") == user_entry]
    invalid = [x.get("reason", "") for x in mine("无效")]
    missing = mine("失败")
    fragments = [fragment_row(f) for x in mine("未匹配") for f in x.get("fragments") or []]
    if run_id is None and not (invalid or missing or fragments):
        return None
    answered: dict[str, str] = {}
    for a in acts:
        if a["speaker"] == "user" and a["responds_to"] and a["responds_to"] not in answered:
            answered[a["responds_to"]] = a["act_id"]
    here = [a for a in acts if a["run_id"] == run_id] if run_id else []
    user = [{"编号": a["act_id"], "功能": function_label(a["function"], "user"), "功能码": a["function"],
             "针对": target_text(a["targets"]), "回应": a["responds_to"] or "",
             "把握": CONFIDENCE_WORDS.get(a["confidence"] or "", ""), "摘要": a["summary"],
             "来处": "界面点击合成" if a["origin"] == "ui" else "助手写的理解"}
            for a in here if a["speaker"] == "user"]
    executor = []
    for a in here:
        if a["speaker"] != "executor":
            continue
        by = answered.get(a["act_id"])
        state = ("已回应" if by else "等回应") if a["expects_response"] else "不等回应"
        executor.append({"编号": a["act_id"], "功能": function_label(a["function"], "executor"), "功能码": a["function"],
                         "期待回应": bool(a["expects_response"]), "状态": state, "回应它的": by or "",
                         "针对": target_text(a["targets"]), "摘要": a["summary"]})
    origin = "界面点击合成" if any(u["来处"] == "界面点击合成" for u in user) else ("助手写的理解" if user else "")
    return {"运行号": run_id or "", "用户行为": user, "助手行为": executor, "用户行为的来处": origin,
            "没有合格的理解": bool(missing), "失败时最近的错误": (missing[0].get("nearest") or []) if missing else [],
            "未匹配片段": fragments, "事实核对没通过": invalid}


#: 连续追问到几次才列进页头。与 agent 侧给执行者的文字同一个口径：只列连着 2 次及以上没得到回应的条目。
FOLLOW_UP_AT_LEAST = 2


def facts(conn: sqlite3.Connection, task_id: str, session_id: str) -> dict:
    """一条会话的三个派生事实，口径与 agent 侧 dialogueFacts 一致。连续追问只列连着 FOLLOW_UP_AT_LEAST 次及以上的条目。"""
    empty = {"等回应": [], "连续追问": [], "改口": []}
    if not has_dialogue(conn):
        return empty
    session = read_session(conn, task_id, session_id)
    acts = session["行为"]
    responded = {a["responds_to"] for a in acts if a["speaker"] == "user" and a["responds_to"]}
    waiting = [{"编号": a["act_id"], "功能": function_label(a["function"], "executor"), "摘要": a["summary"],
                "针对": target_text(a["targets"])}
               for a in acts if a["speaker"] == "executor" and a["expects_response"] and a["act_id"] not in responded]
    expecting = sorted([a for a in acts if a["speaker"] == "executor" and a["expects_response"]],
                       key=lambda a: _run_number(a["run_id"]))
    streaks: dict[str, dict] = {}
    for a in expecting:
        for t in a["targets"]:
            item = t.get("item_id")
            if not item:
                continue
            if a["act_id"] in responded:
                streaks.pop(item, None)
                continue
            s = streaks.setdefault(item, {"runs": [], "acts": []})
            if a["run_id"] not in s["runs"]:
                s["runs"].append(a["run_id"])
            s["acts"].append(a["act_id"])
    follow = [{"条目": item, "连续运行次数": len(s["runs"]), "行为": s["acts"]} for item, s in streaks.items()
              if len(s["runs"]) >= FOLLOW_UP_AT_LEAST]
    return {"等回应": waiting, "连续追问": follow, "改口": rephrasings(conn, task_id, session_id)}


def page_facts(conn: sqlite3.Connection, task_id: str, session_ids: list[str]) -> dict | None:
    """一页（一条会话或整个任务的几条会话）的三个派生事实，各会话的合在一起，每项注明是哪条会话的。
    库里没有对话行为表时返回 None，页头不显示这一行。"""
    if not has_dialogue(conn):
        return None
    out = {"等回应": [], "连续追问": [], "改口": []}
    for number, session_id in enumerate(session_ids, 1):
        one = facts(conn, task_id, session_id)
        for key in out:
            out[key].extend({**x, "会话序号": number} for x in one[key])
    return out


def rephrasings(conn: sqlite3.Connection, task_id: str, session_id: str) -> list[dict]:
    """改口：这条会话里因用户的话（带 intent_act_id）或用户直接操作而改的修订，每个条目每个字段改过 2 次及以上的，附历次的值。"""
    columns = {r[1] for r in conn.execute("PRAGMA table_info(revision)")}
    intent = "r.intent_act_id" if "intent_act_id" in columns else "NULL"
    revisions = conn.execute(
        f"SELECT r.revision_no, r.summary, e.actor, {intent} FROM revision r JOIN event e ON e.seq = r.event_seq "
        "WHERE r.task_id = ? AND r.session_id = ? ORDER BY r.revision_no", (task_id, session_id)).fetchall()
    changes: dict[tuple[str, str], list[dict]] = {}
    for revision_no, summary, actor, intent_act in revisions:
        if actor != "user" and not intent_act:
            continue
        for op in _json(summary) or []:
            if op.get("op") != "update":
                continue
            item = op.get("item")
            now = conn.execute("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no = ?",
                               (task_id, item, revision_no)).fetchone()
            old = conn.execute("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no < ? "
                               "ORDER BY revision_no DESC LIMIT 1", (task_id, item, revision_no)).fetchone()
            if not now or not old:
                continue
            a, b = _json(old[0]) or {}, _json(now[0]) or {}
            for field in dict.fromkeys([*a, *b]):
                if json.dumps(a.get(field), ensure_ascii=False) == json.dumps(b.get(field), ensure_ascii=False):
                    continue
                changes.setdefault((item, field), []).append({"修订号": revision_no, "值": b.get(field)})
    return [{"条目": item, "字段": field, "次数": len(values), "历次": values}
            for (item, field), values in changes.items() if len(values) >= 2]
