"""数据隔离的 RPC 集成测试：真实的 pi 进程，执行者换成按脚本回话的假端点。

测两个场景：
1. 复制来的会话续接：把第一套的任务目录与归档目录复制给第二套，第二套续接那条会话文件（第一行记着第一套的任务目录）。
   续接前会话文件的工作目录改写为第二套的任务目录，写入落在第二套自己的库里，第一套的库最大事件序号不变；
   原文件原样备份，后端补记里记一条「续接工作目录」。
2. 任务目录搬家：整个任务目录搬到另一个路径，续接原来的会话文件（第一行记着已经不存在的旧路径）。pi 照常起来，写入落在新位置。
另测扩展写库前的路径核对：pi 带着别的任务根目录起来时，界面操作被拒，说明任务库不在本服务的任务目录之下。
"""

from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path

from taskwright_server.pi_session import PiSession
from tests.integration.rig import Rig, call, profile_for_tests
from tests.integration.test_confirm_and_complete import NEEDS, SOURCE, open_detail, reply_call, save_two


def max_seq(db: Path) -> int:
    import sqlite3
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return int(conn.execute("SELECT COALESCE(MAX(seq), 0) FROM event").fetchone()[0])
    finally:
        conn.close()


def resume(rig: Rig, workspace: Path, runs: Path, session_file: Path, tasks_root: Path) -> None:
    """关掉试验台原来的 pi，在给定的任务目录与归档目录上续接那条会话文件，换成试验台的当前会话。"""
    rig.session.close()

    def start():
        rig.session = PiSession(profile_for_tests(), workspace, runs, rig.label, tasks_root=tasks_root)
        rig.session.start(session_file=session_file)
    rig._with_test_env(start)
    rig.workspace = workspace
    if not rig.session.alive():
        raise RuntimeError(f"pi 没有起来：{rig.session.stderr_text}")


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class IsolationTests(unittest.TestCase):
    SCRIPT = [save_two(), {"tool_calls": [reply_call("整理好了两个用例。", "call-done")]}]

    def test_复制来的会话在第二套续接_写入落在第二套自己的库里_第一套不变(self):
        with Rig(self.SCRIPT, material=SOURCE["excerpt"]) as rig:
            rig.say("把材料整理成需求规格说明。")
            first_db = rig.db_path
            first_ws = rig.workspace
            session_file = Path(rig.session.get_state()["sessionFile"])
            second = rig.root / "second"
            second_ws = second / "tasks" / "TASK-B"
            shutil.copytree(first_ws, second_ws)
            shutil.copytree(rig.root / "runs", second / "runs")
            copied = second / "runs" / session_file.relative_to(rig.root / "runs")
            before_first = max_seq(first_db)
            resume(rig, second_ws, second / "runs", copied, second / "tasks")
            before_second = max_seq(second_ws / "task.sqlite")
            viewed = open_detail(rig, "ui-op-copy", "UC-001", 1, 1)
            after_second = max_seq(second_ws / "task.sqlite")
            after_first = max_seq(first_db)
            header = json.loads(copied.read_text(encoding="utf-8").splitlines()[0])
            backups = [json.loads(b.read_text(encoding="utf-8").splitlines()[0]) for b in copied.parent.glob(copied.name + ".cwd-*.bak")]
            notes = [json.loads(line) for line in rig.session._notes_path.read_text(encoding="utf-8").splitlines() if line.strip()]

        self.assertTrue(viewed["ok"], viewed)
        self.assertEqual(after_second, before_second + 1, "写入落在第二套自己的库里")
        self.assertEqual(after_first, before_first, "第一套的库一行都没多")
        self.assertEqual(header["cwd"], str(second_ws.resolve()))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0]["cwd"], str(first_ws.resolve()), "原文件原样备份")
        rebased = [n for n in notes if n.get("种类") == "续接工作目录" or "续接工作目录" in json.dumps(n, ensure_ascii=False)]
        self.assertTrue(rebased, "后端补记里记下了改写")
        self.assertIn(f"会话文件记的工作目录是 {first_ws.resolve()}，已按本服务的任务目录 {second_ws.resolve()} 续接", json.dumps(rebased, ensure_ascii=False))

    def test_任务目录整个搬家之后续接原会话_pi照常起来_写入落在新位置(self):
        with Rig(self.SCRIPT, material=SOURCE["excerpt"]) as rig:
            rig.say("把材料整理成需求规格说明。")
            session_file = Path(rig.session.get_state()["sessionFile"])
            old_ws = rig.workspace
            rig.session.close()
            new_ws = rig.root / "moved" / "TASK-M"
            new_ws.parent.mkdir()
            old_ws.rename(new_ws)
            resume(rig, new_ws, rig.root / "runs", session_file, new_ws.parent)
            before = max_seq(new_ws / "task.sqlite")
            viewed = open_detail(rig, "ui-op-moved", "UC-001", 1, 1)
            after = max_seq(new_ws / "task.sqlite")

        self.assertFalse(old_ws.exists())
        self.assertTrue(viewed["ok"], viewed)
        self.assertEqual(after, before + 1)

    def test_pi带着别的任务根目录起来时界面操作被拒_什么都不写(self):
        with Rig(self.SCRIPT, material=SOURCE["excerpt"]) as rig:
            rig.say("把材料整理成需求规格说明。")
            session_file = Path(rig.session.get_state()["sessionFile"])
            elsewhere = rig.root / "elsewhere-tasks"
            elsewhere.mkdir()
            resume(rig, rig.workspace, rig.root / "runs", session_file, elsewhere)
            before = max_seq(rig.db_path)
            rejected = open_detail(rig, "ui-op-outside", "UC-001", 1, 1)
            after = max_seq(rig.db_path)

        self.assertFalse(rejected["ok"])
        self.assertIn("不在本服务的任务目录", rejected["error"]["message"])
        self.assertIn("拒绝写入", rejected["error"]["message"])
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
