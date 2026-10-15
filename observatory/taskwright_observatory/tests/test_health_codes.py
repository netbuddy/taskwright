"""健康页「每百次调用被拒次数，按原因码」那一栏，与读拒绝记录时带出的原因码。

数据是造出来的：两条会话的工具调用（形状同 runs.py 读出的那样），与按调用编号排好的拒绝记录（形状同 taskdb.read_tool_rejections）。
测这些事：分母取归档里每个工具的调用次数；分子按调用编号找拒绝记录，一次拒绝里同一个原因码只算一次；
没有原因码的旧记录、被拒而库里没有记录的各合成一行；别的会话记下的同编号拒绝不算进来；格式 9 的库读得出两列，旧库给空的。

跑法：在代码仓目录下运行 `python3 -m unittest taskwright_observatory.tests.test_health_codes`。
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory.health import NO_CODE, NO_RECORD, reason_code_rows
from taskwright_observatory.taskdb import read_tool_rejections


def call(call_id: str, tool: str, rejected: bool) -> dict:
    return {"调用编号": call_id, "工具": tool, "是否被拒": rejected}


def session(session_id: str, calls: list[dict]) -> dict:
    return {"会话编号": session_id, "运行": [{"轮": [{"工具调用": calls}]}]}


def record(session_id: str, codes: list[str], kind: str = "输入不合规") -> dict:
    return {"会话编号": session_id, "全部原因码": codes, "原因种类": kind}


class 按原因码计数(unittest.TestCase):
    def test_分母是归档里的调用次数_分子按调用编号找拒绝记录(self):
        sessions = [
            session("会话甲", [call("c1", "save_revision", True), call("c2", "save_revision", False), call("c3", "save_revision", True),
                               call("c4", "reply", True), call("c5", "reply", False), call("c6", "reply", True), call("c7", "get_item", True)]),
            session("会话乙", [call("c8", "save_revision", False)]),
        ]
        index = {
            # 一次拒绝里两个操作都是同一个原因：只算一次；另一个原因码另算。
            "c1": [record("会话甲", ["save_revision.collection_unknown", "save_revision.collection_unknown", "source.missing"])],
            "c3": [record("会话甲", ["gate.stage_item_write"], "缺前置步骤")],
            # 格式 9 之前记下的：没有原因码。
            "c4": [record("会话甲", [])],
            # c6 被拒而库里没有记录；c7 的同编号记录是别的会话记下的，不算。
            "c7": [record("会话丙", ["get_item.item_not_found"])],
        }
        rows = reason_code_rows(sessions, index, {"save_revision": "保存修订"})
        got = {(row["原因码"], row["工具"]): (row["被拒次数"], row["调用次数"], row["每百次调用被拒次数"], row["其中记作缺前置步骤"]) for row in rows}
        self.assertEqual(got, {
            ("save_revision.collection_unknown", "save_revision"): (1, 4, 25.0, 0),
            ("source.missing", "save_revision"): (1, 4, 25.0, 0),
            ("gate.stage_item_write", "save_revision"): (1, 4, 25.0, 1),
            (NO_CODE, "reply"): (1, 3, 33.3, 0),
            (NO_RECORD, "reply"): (1, 3, 33.3, 0),
            (NO_RECORD, "get_item"): (1, 1, 100.0, 0),
        })
        self.assertEqual({row["工具中文名"] for row in rows if row["工具"] == "save_revision"}, {"保存修订"})


class 读出原因码(unittest.TestCase):
    def _db(self, with_codes: bool) -> sqlite3.Connection:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        conn = sqlite3.connect(Path(tmp.name) / "task.sqlite")
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        codes = ", reason_code TEXT, reason_codes TEXT" if with_codes else ""
        conn.execute("CREATE TABLE tool_rejection (rejection_id INTEGER PRIMARY KEY, task_id TEXT, session_id TEXT, work_id TEXT, call_id TEXT, "
                     f"tool_name TEXT, reason_kind TEXT, fact TEXT, guidance TEXT, input_excerpt TEXT, created_at TEXT{codes})")
        return conn

    def test_格式9的库读得出第一个与全部原因码_旧库给空的(self):
        conn = self._db(True)
        conn.execute("INSERT INTO tool_rejection (task_id, session_id, call_id, tool_name, reason_kind, fact, input_excerpt, created_at, reason_code, reason_codes) "
                     "VALUES ('T', 's', 'c1', 'reply', 'input', '事实', '{}', 't', 'reply.informs_missing', '[\"reply.informs_missing\", \"reply.act_missing\"]')")
        conn.execute("INSERT INTO tool_rejection (task_id, session_id, call_id, tool_name, reason_kind, fact, input_excerpt, created_at) "
                     "VALUES ('T', 's', 'c2', 'reply', 'gate', '事实', '{}', 't')")
        rows = read_tool_rejections(conn, "T")
        self.assertEqual([(row["原因码"], row["全部原因码"], row["原因种类"]) for row in rows],
                         [("reply.informs_missing", ["reply.informs_missing", "reply.act_missing"], "输入不合规"), (None, [], "缺前置步骤")])
        old = self._db(False)
        old.execute("INSERT INTO tool_rejection (task_id, session_id, call_id, tool_name, reason_kind, fact, input_excerpt, created_at) "
                    "VALUES ('T', 's', 'c1', 'reply', 'input', '事实', '{}', 't')")
        self.assertEqual([(row["原因码"], row["全部原因码"]) for row in read_tool_rejections(old, "T")], [(None, [])])


if __name__ == "__main__":
    unittest.main()
