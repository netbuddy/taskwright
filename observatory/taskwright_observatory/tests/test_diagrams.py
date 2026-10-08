"""图在观测台读取的一侧：读库认图的两张表、图的来源与条目的来源分开取、打印脚本列出图、核对脚本的第 11 项。

夹具库由 agent 里真实的核心函数写出（agent/tests/fixtures/build_task_db.mts，用 node 运行）：先存两个用例，再存一张图、
改一次、另存一张图再删掉。本机没有 node 时这些测试跳过。
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import check_db, dbshow, taskdb
from taskwright_observatory.tests.test_current_format import ROOT, make_workspace

BUILD_TASK = ROOT / "agent" / "tests" / "fixtures" / "build_task_db.mts"
SAID = "把登录和退出画成一张用例图"
MERMAID = 'flowchart LR\n  a(["UC-001 登录"])\n  b(["UC-002 退出"])'
SOURCE = {"kind": "助手补充", "excerpt": "演示用"}
BATCHES = [
    [{"op": "add", "collection": "用例", "fields": {"名称": "登录", "步骤": ["打开页面"]}, "sources": [SOURCE]},
     {"op": "add", "collection": "用例", "fields": {"名称": "退出", "步骤": ["点退出"]}, "sources": [SOURCE]}],
    {"said": SAID, "diagram": {"name": "登录与退出", "kind": "use_case", "mermaid": MERMAID, "note": "两件事。",
                               "sources": [{"kind": "用户的话", "excerpt": SAID}, {"kind": "条目", "locator": "UC-001"}, {"kind": "条目", "locator": "UC-002"}]}},
    {"diagram": {"diagram": "D-001", "base_revision": 1, "name": "读者的两件事"}},
    {"said": "再画一张", "diagram": {"name": "多余的", "kind": "class", "mermaid": "classDiagram\n  class A", "sources": [{"kind": "用户的话", "excerpt": "再画一张"}]}},
    {"diagram": {"diagram": "D-002", "base_revision": 1, "delete": True}},
]


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，写不出夹具库")
class DiagramsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.workspace = make_workspace(cls.root, "ws-diagrams", with_db=False)
        subprocess.run(["node", str(BUILD_TASK), str(cls.workspace), "docs/task-definitions/demo.json", json.dumps(BATCHES, ensure_ascii=False)],
                       check=True, capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def task(self) -> dict:
        return taskdb.read_workspace(self.workspace)["任务"][0]

    def test_读库认图_每张图带它自己的每次修订与来源(self):
        figures = self.task()["图"]
        self.assertEqual([(f["图的编号"], f["在第几次修订删除"], [v["修订号"] for v in f["修订内容"]]) for f in figures],
                         [("D-001", None, [1, 2]), ("D-002", 2, [1, 2])])
        first, second = figures[0]["修订内容"]
        self.assertEqual((first["操作"], first["图名"], first["种类"], first["种类名"], first["Mermaid 文本"], first["说明"], first["由谁"]),
                         ("add", "登录与退出", "use_case", "用例图", MERMAID, "两件事。", "executor"))
        self.assertEqual((second["操作"], second["图名"]), ("update", "读者的两件事"))
        # 来源沿用到修订 2；依据条目的带引用时它的修订号。
        self.assertEqual([(s["种类"], s["出处"], s.get("依据的修订")) for s in second["来源"]][1:], [("条目", "UC-001", 1), ("条目", "UC-002", 1)])
        self.assertEqual(second["来源"][0]["种类"], "用户的话")
        # 删除那一次修订没有来源。
        self.assertEqual([(v["操作"], len(v["来源"])) for v in figures[1]["修订内容"]], [("add", 1), ("delete", 0)])

    def test_条目的来源里没有图的来源_任务的修订序号不因为存图而动(self):
        task = self.task()
        self.assertEqual([r["修订序号"] for r in task["修订"]], [1])
        conn = taskdb.open_readonly(self.workspace / taskdb.DB_NAME)
        try:
            items = taskdb.read_sources(conn, task["任务编号"])
            figures = taskdb.read_sources(conn, task["任务编号"], "图")
        finally:
            conn.close()
        self.assertEqual(sorted(items), [("UC-001", 1), ("UC-002", 1)])
        self.assertEqual(sorted(figures), [("D-001", 1), ("D-001", 2), ("D-002", 1)])

    def test_打印脚本列出图(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            dbshow.main([str(self.workspace)])
        text = out.getvalue()
        self.assertIn("【图】（不是条目，修订号是图自己的，不占下面的修订列表）", text)
        self.assertIn("D-001「读者的两件事」（用例图），改动过的修订：1、2。", text)
        self.assertIn("D-002「多余的」（类图），在它的修订 2 删除，改动过的修订：1、2。", text)
        self.assertIn("种类是条目，出处是 UC-001，引用时它是修订 1", text)

    def test_核对脚本_带图的库全部通过_弄坏之后第11项指出是哪一行(self):
        results = check_db.check(self.workspace)
        self.assertEqual([one["名目"] for one in results if not one["通过"]], [])
        self.assertEqual(results[-1]["名目"], "图的内容、修订号、来源与事件对得上")
        broken = self.root / "ws-broken"
        shutil.copytree(self.workspace, broken)
        conn = sqlite3.connect(broken / "task.sqlite")
        conn.execute("UPDATE diagram_version SET revision_no = 5 WHERE diagram_id = 'D-001' AND revision_no = 2")
        conn.execute("UPDATE diagram_version SET call_id = '别的调用' WHERE diagram_id = 'D-002' AND revision_no = 1")
        conn.commit()
        conn.close()
        failed = {one["名目"]: one["不通过的行"] for one in check_db.check(broken) if not one["通过"]}
        self.assertEqual(list(failed), ["图的内容、修订号、来源与事件对得上"])
        lines = failed["图的内容、修订号、来源与事件对得上"]
        self.assertTrue(any("图 D-001 的修订号不是从 1 起连续的：[1, 5]" in line for line in lines), lines)
        self.assertTrue(any("来源（图 D-001 在修订 2 下的第 1 条）指向的内容行不存在" in line for line in lines), lines)
        self.assertTrue(any("图 D-002 的修订 1 的调用编号是 别的调用" in line for line in lines), lines)
        shutil.rmtree(broken)


if __name__ == "__main__":
    unittest.main()
