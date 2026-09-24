"""过程摘要的「理解为」一行：从任务库的 USER_INTENT_RECORDED 与 USER_INTENT_INVALID 事件拼出来。

三种情形各一例：有理解（摘要按记录顺序用「；」连，把握取最低一档，高时不括注）、只有无效理解、界面合成的那句话；
另有刷新后的对话记录与实时推送的步骤行各一例。库是测试自己建的最小库，只有这里读到的两张表。
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_server.service import conversation, library, work_summary

SESSION = "S"


def make_task_dir(events: list[tuple[str, dict]], acts: list[tuple[str, str]] = ()) -> Path:
    """建一个只有事件表与对话行为表的任务库。events 每项是（事件名, 内容），acts 每项是（行为编号, 把握）。"""
    root = Path(tempfile.mkdtemp(prefix="taskwright-understanding-"))
    conn = sqlite3.connect(library.db_file(root))
    conn.execute("CREATE TABLE event (seq INTEGER PRIMARY KEY, session_id TEXT, name TEXT, payload TEXT)")
    conn.execute("CREATE TABLE dialogue_act (session_id TEXT, act_id TEXT, confidence TEXT)")
    for seq, (name, payload) in enumerate(events, 1):
        conn.execute("INSERT INTO event VALUES (?, ?, ?, ?)", (seq, SESSION, name, json.dumps(payload, ensure_ascii=False)))
    for act_id, confidence in acts:
        conn.execute("INSERT INTO dialogue_act VALUES (?, ?, ?)", (SESSION, act_id, confidence))
    conn.commit()
    conn.close()
    return root


def recorded(entry: str, *acts: dict, origin: str = "understanding") -> tuple[str, dict]:
    return "USER_INTENT_RECORDED", {"run_id": "r1", "user_entry": entry, "origin": origin, "acts": list(acts)}


def invalid(entry: str) -> tuple[str, dict]:
    return "USER_INTENT_INVALID", {"run_id": "r1", "user_entry": entry, "reason": "没有写理解"}


class UnderstandingLineTest(unittest.TestCase):
    def dir(self, events, acts=()):
        root = make_task_dir(events, acts)
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        return root

    def test_有理解_摘要按记录顺序用分号连_把握取最低一档_高时不括注(self):
        root = self.dir([
            recorded("u-1",
                     {"act_id": "r1-1", "function": "affirm", "summary": "UC-001、UC-002 的当前修订", "confidence": "high"},
                     {"act_id": "r1-2", "function": "correct", "summary": "UC-003 参与者改为借还台管理员", "confidence": "high"},
                     {"act_id": "r1-3", "function": "inform", "summary": "寒暑假借期先不管", "confidence": "medium"}),
            recorded("u-2", {"act_id": "r2-1", "function": "request", "summary": "把材料整理成条目", "confidence": "high"}),
            # 早先记下的事件内容里没有把握：到对话行为表里按编号查。
            recorded("u-3", {"act_id": "r3-1", "function": "question", "summary": "材料里写了保留几天吗"}),
        ], acts=[("r3-1", "low")])
        lines = work_summary.understanding_lines(root, SESSION)
        self.assertEqual(lines["u-1"], "理解为：同意（affirm）UC-001、UC-002 的当前修订；纠正（correct）UC-003 参与者改为借还台管理员；告知（inform）寒暑假借期先不管（把握中）")
        self.assertEqual(lines["u-2"], "理解为：请求（request）把材料整理成条目")
        self.assertEqual(lines["u-3"], "理解为：询问（question）材料里写了保留几天吗（把握低）")
        # 九种功能的中文名都取自理解格式的 schema，这里不另写一份。
        schema = json.loads(work_summary.INTENT_SCHEMA_PATH.read_text(encoding="utf-8"))
        self.assertEqual(work_summary.function_names(), schema["$defs"]["user_function"]["x-names"])
        self.assertEqual(list(work_summary.function_names().values()),
                         ["告知", "请求", "同意", "否定", "纠正", "要求换一个", "无关", "要澄清", "询问"])
        # 事件内容里没有功能（早先的库）时只写摘要。
        self.assertEqual(work_summary.understanding_text([{"summary": "整理材料", "confidence": "high"}]), "理解为：整理材料")

    def test_只记了无效理解时写正在重写_之后写对了就换成理解(self):
        root = self.dir([invalid("u-1"), invalid("u-2"), recorded("u-2", {"act_id": "r2-1", "function": "other", "summary": "寒暄", "confidence": "high"})])
        lines = work_summary.understanding_lines(root, SESSION)
        self.assertEqual(lines["u-1"], "助手的理解没有按格式写，正在重写")
        self.assertEqual(lines["u-2"], "理解为：无关（other）寒暄")

    def test_界面合成的那句话不显示这一行_没有库时什么都没有(self):
        root = self.dir([recorded("u-1", {"act_id": "r1-1", "summary": "在卡片上选了「允许」", "confidence": "high"}, origin="ui")])
        lines = work_summary.understanding_lines(root, SESSION)
        self.assertIn("u-1", lines)
        self.assertIsNone(lines["u-1"])
        self.assertEqual(work_summary.understanding_lines(Path("/nonexistent"), SESSION), {})
        self.assertEqual(work_summary.understanding_lines(None, SESSION), {})

    def test_刷新后的对话记录里过程摘要带理解(self):
        root = self.dir([recorded("u-1", {"act_id": "r1-1", "function": "request", "summary": "把材料整理成条目", "confidence": "high"})])
        entries = [
            {"type": "message", "id": "u-1", "parentId": None, "timestamp": "2026-09-24T10:00:00.000Z",
             "message": {"role": "user", "content": [{"type": "text", "text": "整理一下"}]}},
            {"type": "message", "id": "a-1", "parentId": "u-1", "timestamp": "2026-09-24T10:00:05.000Z",
             "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "c-1", "name": "reply", "arguments": {"informs": [], "act": None, "text": "好的。"}}]}},
            {"type": "message", "id": "t-1", "parentId": "a-1", "timestamp": "2026-09-24T10:00:06.000Z",
             "message": {"role": "toolResult", "toolCallId": "c-1", "toolName": "reply", "content": [], "details": {}}},
        ]
        summary = next(m for m in conversation.messages(entries, SESSION, {}, root) if m["type"] == "work_summary")
        self.assertEqual(summary["understanding"], "理解为：请求（request）把材料整理成条目")
        self.assertEqual(summary["step_count"], 1, "理解那一行不算一步")
        without = next(m for m in conversation.messages(entries, SESSION, {}) if m["type"] == "work_summary")
        self.assertIsNone(without["understanding"])

    def test_实时推送_助手消息落进会话时推一行理解_排在步骤最前_写对了用同一个键换掉(self):
        from taskwright_server.service import executor as executor_module

        class Hub:
            def __init__(self):
                self.events = []

            def emit(self, name, data):
                self.events.append((name, data))

        root = self.dir([invalid("u-1")])
        hub = Hub()
        ex = executor_module.Executor("T", root, root, {}, hub)
        ex.work = {"work_id": "w-u-1", "last_user_id": "u-1", "triggered_by": "u-1",
                   "steps": {"w-u-1-0": {"step_key": "w-u-1-0", "text": "读了材料"}}}
        ex._understanding_step(SESSION)
        first = [d for n, d in hub.events if n == "step"][-1]
        self.assertEqual((first["step_key"], first["text"], first["in_progress"]), ("w-u-1-intent", "助手的理解没有按格式写，正在重写", True))
        self.assertEqual(list(ex.work["steps"]), ["w-u-1-intent", "w-u-1-0"])
        conn = sqlite3.connect(library.db_file(root))
        conn.execute("INSERT INTO event VALUES (2, ?, 'USER_INTENT_RECORDED', ?)",
                     (SESSION, json.dumps({"user_entry": "u-1", "origin": "understanding",
                                           "acts": [{"act_id": "r1-1", "function": "request", "summary": "整理材料", "confidence": "high"}]}, ensure_ascii=False)))
        conn.commit()
        conn.close()
        ex._understanding_step(SESSION)
        ex._understanding_step(SESSION)       # 没有变化时不重复推
        steps = [d for n, d in hub.events if n == "step"]
        self.assertEqual(len(steps), 2)
        self.assertEqual((steps[-1]["step_key"], steps[-1]["text"], steps[-1]["in_progress"]), ("w-u-1-intent", "理解为：请求（request）整理材料", False))


if __name__ == "__main__":
    unittest.main()
