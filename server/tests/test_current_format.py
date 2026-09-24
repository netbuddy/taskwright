"""新格式（条目按修订号记）任务数据库的读取一侧测试：taskdb、dbshow、check_db 与观测台。

夹具库由 agent 里真实的核心函数写出（tests/build_current_db.mts，用 node 运行），
所以这里读的就是工具真正写出来的库。本机没有 node 时这些测试跳过。
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
from taskwright_observatory.api import Index
from taskwright_observatory.revisions import project_current_format

HERE = Path(__file__).resolve().parent
DEFINITION = {
    "任务名": "演示任务",
    "交付物": {
        "名称": "演示交付物", "文档模板": "docs/templates/demo.md", "每个条目附带": "来源",
        "条目集合": [
            {"名称": "用例", "编号前缀": "UC", "字段": [
                {"名": "名称", "类型": "文本", "必填": True},
                {"名": "步骤", "类型": "文本列表", "必填": True}]},
            {"名称": "待定事项", "编号前缀": "TBD", "字段": [
                {"名": "事项", "类型": "文本", "必填": True},
                {"名": "状态", "类型": "枚举", "必填": True, "取值": ["未解决", "已解决"]},
                {"名": "关联条目", "类型": "条目引用", "必填": False}]},
        ],
    },
    "完成条件": {"用例": ["至少一个条目"], "待定事项": ["没有状态为未解决的条目"]},
    "执行方法": ".pi/skills/demo/SKILL.md",
    "领域规矩": ["docs/domain-knowledge/demo.md"],
}


def make_workspace(root: Path, name: str, with_db: bool) -> Path:
    workspace = root / name
    (workspace / "docs" / "task-definitions").mkdir(parents=True)
    (workspace / "docs" / "task-definitions" / "demo.json").write_text(
        json.dumps(DEFINITION, ensure_ascii=False), encoding="utf-8")
    if with_db:
        subprocess.run(["node", str(HERE / "build_current_db.mts"), str(workspace)],
                       check=True, capture_output=True, text=True)
    return workspace


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，写不出夹具库")
class CurrentFormatTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.workspace = make_workspace(cls.root, "ws-new", with_db=True)
        cls.empty = make_workspace(cls.root, "ws-empty", with_db=False)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_format_detection(self):
        self.assertEqual(taskdb.format_of_workspace(self.workspace), taskdb.FORMAT_CURRENT)
        self.assertEqual(taskdb.format_of_workspace(self.empty), taskdb.FORMAT_MISSING)
        legacy = self.root / "ws-legacy"
        legacy.mkdir()
        conn = sqlite3.connect(legacy / "task.sqlite")
        conn.execute("CREATE TABLE slot (name TEXT)")
        conn.close()
        self.assertEqual(taskdb.format_of_workspace(legacy), taskdb.FORMAT_LEGACY)
        shutil.rmtree(legacy)

    def test_read_workspace(self):
        [task] = taskdb.read_workspace(self.workspace)["任务"]
        self.assertEqual(task["任务编号"], "TASK-001")
        self.assertEqual(task["任务名"], "演示任务")
        self.assertEqual([r["修订序号"] for r in task["修订"]], [1, 2, 3])
        items = {i["条目编号"]: i for i in task["条目"]}
        self.assertEqual(sorted(items), ["TBD-001", "UC-001", "UC-002"])
        self.assertEqual(items["UC-001"]["当前内容"]["字段"]["名称"], "买家申请退款")
        self.assertEqual([c["修订号"] for c in items["UC-001"]["修订内容"]], [1, 2])
        self.assertEqual(items["UC-001"]["修订内容"][1]["来源"][0]["种类"], "文档原文")   # 沿用修订 1 时的来源
        # 修改时给了来源只替换改到的字段上的来源：支持整个条目的文档原文沿用，用户的话接在后面。
        self.assertEqual([one["种类"] for one in items["TBD-001"]["当前内容"]["来源"]], ["文档原文", "用户的话"])
        self.assertEqual(items["UC-002"]["在第几次修订删除"], 3)

    def test_snapshot_at(self):
        [task] = taskdb.read_workspace(self.workspace)["任务"]
        at1 = {one["条目编号"]: one["内容"]["修订号"] for one in taskdb.snapshot_at(task, 1)}
        at2 = {one["条目编号"]: one["内容"]["修订号"] for one in taskdb.snapshot_at(task, 2)}
        at3 = {one["条目编号"] for one in taskdb.snapshot_at(task, 3)}
        self.assertEqual(at1, {"UC-001": 1, "TBD-001": 1})
        self.assertEqual(at2, {"UC-001": 2, "TBD-001": 2, "UC-002": 2})
        self.assertEqual(at3, {"UC-001", "TBD-001"})

    def test_check_db_passes_and_catches_broken_rows(self):
        self.assertTrue(all(one["通过"] for one in check_db.check(self.workspace)))
        broken = self.root / "ws-broken"
        shutil.copytree(self.workspace, broken)
        conn = sqlite3.connect(broken / "task.sqlite")
        conn.execute("UPDATE item_version SET event_seq = 99 WHERE item_id = 'UC-001' AND revision_no = 2")
        conn.execute("DELETE FROM event WHERE seq = 2")
        conn.commit()
        conn.close()
        failed = {one["名目"]: one["不通过的行"] for one in check_db.check(broken) if not one["通过"]}
        self.assertIn("每一处写入都找得到同一个调用编号或操作编号的事件", failed)
        self.assertIn("事件序号连续", failed)
        self.assertTrue(any("条目 UC-001 在修订 2 下的内容" in line for line in failed["每一处写入都找得到同一个调用编号或操作编号的事件"]))
        shutil.rmtree(broken)

    def test_check_db_actor_and_operation_id(self):
        """第 8 项：发起方只能是执行者或用户；用户的编号以 ui- 开头，执行者的不以 ui- 开头。"""
        broken = self.root / "ws-actor"
        shutil.copytree(self.workspace, broken)
        conn = sqlite3.connect(broken / "task.sqlite")
        conn.execute("UPDATE event SET actor = 'user' WHERE seq = 2")
        conn.execute("UPDATE event SET actor = '驱动程序' WHERE seq = 3")
        conn.commit()
        conn.close()
        failed = {one["名目"]: one["不通过的行"] for one in check_db.check(broken) if not one["通过"]}
        lines = failed["发起方与编号相符"]
        self.assertTrue(any("第 2 号事件的发起方是用户，编号却是 call-r1" in line for line in lines))
        self.assertTrue(any("第 3 号事件的发起方是「驱动程序」" in line for line in lines))
        shutil.rmtree(broken)

    def test_sources_at_field_level_and_user_words(self):
        """来源按条合回，所支持的字段在「支持」里；用户的话的出处拆得出会话编号与条目编号。"""
        task = taskdb.read_workspace(self.workspace)["任务"][0]
        items = {i["条目编号"]: i for i in task["条目"]}
        first = items["UC-001"]["修订内容"][0]["来源"]
        self.assertEqual(len(first), 1, "一条来源支持两处，库里两行，读出来仍是一条")
        self.assertEqual(first[0]["支持"], [{"字段": "名称", "第几项": None}, {"字段": "步骤", "第几项": 0}])
        self.assertEqual(taskdb.support_text(first[0]["支持"]), "「名称」、「步骤」第 1 项")
        words = items["TBD-001"]["当前内容"]["来源"][1]
        self.assertEqual(words["种类"], "用户的话")
        self.assertEqual(words["出处"], "session-fixture#entry-9")
        self.assertEqual(words["对话出处"], {"会话编号": "session-fixture", "条目编号": "entry-9"})
        self.assertEqual(taskdb.support_text([]), "整个条目")

    def test_dbshow(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(dbshow.main([str(self.empty)]), 0)
        self.assertIn("这个任务目录还没有创建任务", out.getvalue())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(dbshow.main([str(self.workspace)]), 0)
        text = out.getvalue()
        for heading in ("【任务】", "【各集合的条目（最新内容）】", "【每个条目改动过的修订与来源】", "【修订列表】", "【事件列表】"):
            self.assertIn(heading, text)
        self.assertIn("支持「名称」、「步骤」第 1 项", text)
        self.assertIn("出处是 session-fixture#entry-9，支持「状态」", text)
        self.assertIn("UC-002（集合「用例」），在修订 2 新增，在修订 3 删除", text)
        self.assertIn("修改 UC-001（修订 1 → 修订 2）", text)
        self.assertNotIn("版本", text.split("【事件列表】")[0])
        self.assertIn("关联条目：UC-001", text)

    def test_projection_describes_changes_by_field_type(self):
        [task] = taskdb.read_workspace(self.workspace)["任务"]
        projection = project_current_format(task)
        second = projection["修订"][1]["变化"]
        update_uc = next(c for c in second if c["条目编号"] == "UC-001")
        self.assertEqual((update_uc["改前所在修订"], update_uc["改后所在修订"]), (1, 2))
        self.assertEqual([f["名"] for f in update_uc["字段"]], ["名称"])        # 只列变了的字段
        self.assertEqual(update_uc["字段"][0]["改前"], "申请退款")
        self.assertFalse(update_uc["来源变了吗"])
        update_tbd = next(c for c in second if c["条目编号"] == "TBD-001")
        self.assertTrue(update_tbd["来源变了吗"])
        self.assertEqual({f["名"] for f in update_tbd["字段"]}, {"状态", "关联条目"})
        add = next(c for c in second if c["操作"] == "add")
        self.assertEqual([f["名"] for f in add["字段"]], ["名称", "步骤"])       # 按声明逐项列出
        self.assertEqual(add["字段"][1]["值"], ["撤销"])
        deleted = projection["修订"][2]["变化"][0]
        self.assertEqual((deleted["操作"], deleted["在第几次修订删除"]), ("delete", 3))

    def test_observatory_index(self):
        archive = self.root / "archive"
        archive.mkdir(exist_ok=True)
        index = Index(archive, self.root)
        key = "ws-new/TASK-001"
        self.assertIn(key, index.tasks)
        self.assertEqual(index.revision_by_call[("ws-new", "call-r2")]["修订序号"], 2)
        detail = index.task_detail(key)
        self.assertEqual(detail["格式"], taskdb.FORMAT_CURRENT)
        self.assertEqual([c["现有条目数"] for c in detail["集合"]], [1, 1])
        self.assertEqual(detail["修订次数"], 3)
        empty = index.task_detail("ws-empty/")
        self.assertTrue(empty["没有任务"])
        self.assertIn("这个任务目录还没有创建任务", empty["说明"])
        # 观测台只在会话所在的任务目录里查调用编号（2026-09-22 起），所以这里带上任务目录名 ws-new。
        created = index.changes_of_call({"调用编号": "call-create", "是否被拒": False, "工具": "create_task"}, "ws-new")
        self.assertEqual(created[0]["种类"], "任务的变化")
        saved = index.changes_of_call({"调用编号": "call-r1", "是否被拒": False, "工具": "save_revision"}, "ws-new")
        self.assertEqual(saved[0]["种类"], "交付物的变化")
        self.assertEqual(saved[0]["修订序号"], 1)
        rejected = index.changes_of_call({"调用编号": "call-x", "是否被拒": True, "工具": "save_revision",
                                          "参数": {"operations": [{"op": "add", "collection": "用例"}]}}, "ws-new")
        self.assertEqual(rejected[0]["种类"], "被拒绝的保存修订")
        self.assertEqual(len(rejected[0]["想做的操作"]), 1)
        self.assertEqual(index.changes_of_call({"调用编号": "call-y", "是否被拒": False, "工具": "read"}, "ws-new"), [])


if __name__ == "__main__":
    unittest.main()
