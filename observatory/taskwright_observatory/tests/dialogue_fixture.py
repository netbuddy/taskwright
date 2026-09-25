"""对话行为层测试共用的夹具：在 agent 写出的新库表夹具库里补写一段对话行为。

夹具归档 runs新库表 里有一条会话、两次运行（没有会话文件的条目，拿不到用户消息的条目编号，所以对话层按
「会话里的第几次运行」对上运行号）。这里补写的三次运行：

· r1：用户请求整理。助手文字里先有两个没匹配上的 JSON 片段（漏进文字的工具参数、一段写坏的 JSON，记一条诊断），
  之后写出合格的理解；助手告知一条、请确认 UC-001（期待回应）。
· r2：用户纠正 UC-001 的名称（回应 r1-3），又询问一件事（之前写过一份事实核对没通过的理解，记一条无效）；
  助手提问 TBD-001（期待回应，没有人回应）。
· r3：这次运行在归档里没有（只在库里）：这一轮结束时没有合格的理解（记一条失败）；助手又提问 TBD-001，也没有人回应，
  于是 TBD-001 连着 2 次运行没得到回应。

修订 2 标上理解编号 r2-1；再补一次用户在界面上直接改 UC-001 名称的修订 4，于是 UC-001 的名称按用户的意思改了 2 次。
夹具库里修订与事件的会话编号是 session-fixture，这里一并改成归档里那条会话的编号，好让任务页按会话对上。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

ARCHIVE_SESSION = "01a0be00-0000-7000-8000-000000000005"
TASK_ID = "TASK-001"


def add_dialogue(workspace: Path, session_id: str = ARCHIVE_SESSION) -> None:
    conn = sqlite3.connect(Path(workspace) / "task.sqlite")
    try:
        conn.execute("UPDATE revision SET session_id = ?", (session_id,))
        conn.execute("UPDATE event SET session_id = ?", (session_id,))
        seq = conn.execute("SELECT MAX(seq) FROM event").fetchone()[0]

        def event(name: str, call_id: str, payload: dict, actor: str = "executor") -> int:
            nonlocal seq
            seq += 1
            conn.execute("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (?,?,?,?,?,?,?,?)",
                         (seq, TASK_ID, session_id, call_id, name, json.dumps(payload, ensure_ascii=False), actor, "2026-01-01T00:00:09.000"))
            return seq

        def act(act_id, speaker, function, targets=(), responds_to=None, expects=0, confidence=None, summary="", entry=None, origin="understanding", event_seq=0):
            conn.execute(
                "INSERT INTO dialogue_act (task_id, session_id, act_id, run_id, speaker, function, targets, responds_to, expects_response, "
                "confidence, summary, source_entry, origin, event_seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (TASK_ID, session_id, act_id, act_id.split("-")[0], speaker, function, json.dumps(list(targets), ensure_ascii=False),
                 responds_to, expects, confidence, summary, entry, origin, event_seq, "2026-01-01T00:00:09.000"))

        event("STRUCTURED_OUTPUT_UNMATCHED", "outputs-u-1", {"run_id": "r1", "user_entry": "u-1", "registered": ["user_intent"], "fragments": [
            {"nature": "unmatched", "text": '{"path":"/w/.pi/skills/taskwright-executor/SKILL.md"}', "nearest": "user_intent",
             "errors": {"user_intent": ["缺少 acts", "多了「path」这一项，只能有 acts"]}},
            {"nature": "unparseable", "text": '{"acts": [{"function": "request"', "parse_error": "JSON 解析不了（Unexpected end of JSON input）"}]})
        s = event("USER_INTENT_RECORDED", "intent-u-1", {"run_id": "r1", "user_entry": "u-1", "origin": "understanding", "acts": []})
        act("r1-1", "user", "request", confidence="high", summary="把材料整理成条目", entry="u-1", event_seq=s)
        s = event("EXECUTOR_ACTS_RECORDED", "call-reply-1", {"run_id": "r1", "reply_entry": "a-1", "acts": []})
        act("r1-2", "executor", "inform", summary="我新增了 UC-001。", entry="a-1", origin="reply", event_seq=s)
        act("r1-3", "executor", "confirm", [{"item_id": "UC-001"}], expects=1, summary="请看 UC-001", entry="a-1", origin="reply", event_seq=s)

        event("USER_INTENT_INVALID", "intent-u-2", {"run_id": "r2", "user_entry": "u-2", "reason": "acts[0].targets 里的 UC-009 在这个任务里没有", "written": "{}"})
        s = event("USER_INTENT_RECORDED", "intent-u-2", {"run_id": "r2", "user_entry": "u-2", "origin": "understanding", "acts": []})
        act("r2-1", "user", "correct", [{"item_id": "UC-001", "field": "名称"}], responds_to="r1-3", confidence="high",
            summary="UC-001 的名称改为买家申请退款", entry="u-2", event_seq=s)
        act("r2-2", "user", "question", confidence="medium", summary="退款时限材料里写了吗", entry="u-2", event_seq=s)
        s = event("EXECUTOR_ACTS_RECORDED", "call-reply-2", {"run_id": "r2", "reply_entry": "a-2", "acts": []})
        act("r2-3", "executor", "ask", [{"item_id": "TBD-001"}], expects=1, summary="退款时限是几天？", entry="a-2", origin="reply", event_seq=s)

        event("USER_INTENT_MISSING", "intent-u-3", {"run_id": "r3", "user_entry": "u-3", "reason": "这一轮结束时没有合格的理解",
                                                    "nearest": ["acts[0].function 写的是 \"agree\"，只能是 inform、request 之一"]})
        s = event("EXECUTOR_ACTS_RECORDED", "call-reply-3", {"run_id": "r3", "reply_entry": "a-3", "acts": []})
        act("r3-1", "executor", "ask", [{"item_id": "TBD-001"}], expects=1, summary="退款时限还没定，是几天？", entry="a-3", origin="reply", event_seq=s)

        conn.execute("UPDATE revision SET intent_act_id = 'r2-1' WHERE revision_no = 2")
        s = event("REVISION_SAVED", "ui-op-9", {"revision_no": 4, "operations": [{"op": "update", "item": "UC-001"}]}, actor="user")
        conn.execute("INSERT INTO revision (task_id, revision_no, session_id, call_id, event_seq, created_at, summary) VALUES (?,?,?,?,?,?,?)",
                     (TASK_ID, 4, session_id, "ui-op-9", s, "2026-01-01T00:00:10.000",
                      json.dumps([{"op": "update", "item": "UC-001", "collection": "用例"}], ensure_ascii=False)))
        conn.execute("INSERT INTO item_version (task_id, item_id, revision_no, fields, event_seq) VALUES (?,?,?,?,?)",
                     (TASK_ID, "UC-001", 4, json.dumps({"名称": "买家发起退款", "步骤": ["提交申请", "系统受理"]}, ensure_ascii=False), s))
        conn.commit()
    finally:
        conn.close()
