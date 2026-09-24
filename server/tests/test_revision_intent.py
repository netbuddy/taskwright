"""修订日志带上触发修订的那项用户行为（intent）：修订表的 intent_act_id 对得上对话行为表时带编号、功能码、中文名与摘要，
对不上（用户直接修改）时为空；没有对话行为表的旧库照旧给修订日志。夹具库由 agent 的核心函数写出，再补一段对话行为
（与观测台测试共用 observatory 里的夹具）。
"""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_server.service import library
from tests.test_current_format import make_workspace


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，写不出夹具库")
class RevisionIntentTest(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.workspace = make_workspace(Path(self._temp.name), "ws", with_db=True)

    def tearDown(self):
        self._temp.cleanup()

    def test_对得上的修订带用户行为_用户直接修改的没有(self):
        from taskwright_observatory.tests.dialogue_fixture import add_dialogue
        add_dialogue(self.workspace)
        log = {r["revision_no"]: r for r in library.revision_log(self.workspace)}
        self.assertEqual(log[2]["intent"], {"act_id": "r2-1", "function": "correct", "function_name": "纠正",
                                            "summary": "UC-001 的名称改为买家申请退款"})
        self.assertIsNone(log[4]["intent"])
        self.assertIsNone(log[1]["intent"])

    def test_没有对话行为表的库照旧给修订日志(self):
        conn = sqlite3.connect(self.workspace / "task.sqlite")
        conn.execute("DROP TABLE dialogue_act")
        conn.execute("ALTER TABLE revision DROP COLUMN intent_act_id")
        conn.commit()
        conn.close()
        log = library.revision_log(self.workspace)
        self.assertEqual([r["revision_no"] for r in log], [3, 2, 1])
        self.assertTrue(all(r["intent"] is None for r in log))


if __name__ == "__main__":
    unittest.main()
