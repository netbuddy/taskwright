"""数据隔离与任务占用的单元测试：占用标记的写入、占用拒绝、遗留标记覆盖、退出时删除；续接前改写会话文件记的工作目录；
任务目录里不留指向自己绝对路径的东西。不起 pi（起 pi 的两个场景在 tests/integration/test_isolation.py）。"""

from __future__ import annotations

import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from taskwright_server import launch
from taskwright_server.pi_session import rebase_session_cwd
from taskwright_server.service import occupancy
from taskwright_server.service.app import Service
from taskwright_server.service.errors import ApiError


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，建不了任务")
class OccupancyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_接手时写占用标记_退出时删掉(self):
        service = Service(self.root / "tasks", self.root / "runs", launch.load_profile("dev"), port=8861)
        task_id = service.create({"task_type": "srs-authoring", "task_name": "占用测试"})["task_id"]
        folder = service.task(task_id).dir
        lock = json.loads((folder / occupancy.LOCK_NAME).read_text(encoding="utf-8"))
        self.assertEqual((lock["port"], lock["pid"], lock["host"]), (8861, os.getpid(), socket.gethostname()))
        self.assertIn("started_at", lock)
        service.close()
        self.assertFalse((folder / occupancy.LOCK_NAME).exists())

    def test_别的活着的服务占用时拒绝服务_列表写明被谁占用_那个服务退出后遗留标记被覆盖(self):
        first = Service(self.root / "tasks", self.root / "runs", launch.load_profile("dev"), port=8861)
        task_id = first.create({"task_type": "srs-authoring", "task_name": "被占用的任务"})["task_id"]
        folder = first.task(task_id).dir
        # 另一个活着的进程写的标记：模拟端口 8790 上的另一个服务。
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            (folder / occupancy.LOCK_NAME).write_text(json.dumps(
                {"port": 8790, "pid": other.pid, "started_at": "2026-09-24T10:00:00", "host": socket.gethostname()}), encoding="utf-8")
            second = Service(self.root / "tasks", self.root / "runs2", launch.load_profile("dev"), port=8862)
            rows = second.list_tasks()
            row = next(r for r in rows if r["task_id"] == task_id)
            self.assertEqual((row["status"], row["supported"], row["task_name"]), ("占用中", False, "被占用的任务"))
            self.assertEqual(row["occupied"]["port"], 8790)
            self.assertEqual(row["note"], "这个任务正被端口 8790 的服务占用，这里不能打开。")
            with self.assertRaises(ApiError) as caught:
                second.task(task_id)
            self.assertEqual((caught.exception.code, caught.exception.status), ("task_occupied", 409))
            self.assertEqual(json.loads((folder / occupancy.LOCK_NAME).read_text(encoding="utf-8"))["pid"], other.pid, "别人的标记不动")
            second.close()
            self.assertTrue((folder / occupancy.LOCK_NAME).exists(), "没有接手的任务，退出时不删别人的标记")
        finally:
            other.kill()
            other.wait()
        # 那个进程没了：标记成了遗留的，接手时覆盖。
        third = Service(self.root / "tasks", self.root / "runs3", launch.load_profile("dev"), port=8863)
        try:
            self.assertEqual(third.task(task_id).task_id, task_id)
            self.assertEqual(json.loads((folder / occupancy.LOCK_NAME).read_text(encoding="utf-8"))["port"], 8863)
        finally:
            third.close()
            first.tasks.clear()

    def test_另一台主机写的标记当作占用(self):
        folder = self.root / "t"
        folder.mkdir()
        (folder / occupancy.LOCK_NAME).write_text(json.dumps({"port": 9000, "pid": 1, "host": "另一台主机"}), encoding="utf-8")
        taken = occupancy.claim(folder, 8861)
        self.assertEqual(taken["host"], "另一台主机")
        self.assertIn("（主机 另一台主机）", occupancy.occupied_text(taken))


class RebaseSessionCwdTest(unittest.TestCase):
    def test_会话文件记的工作目录与本服务的任务目录不一致时改写第一行_原文件原样备份(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            mine = root / "tasks" / "TASK-A"
            mine.mkdir(parents=True)
            session = root / "s.jsonl"
            original = (json.dumps({"type": "session", "version": 3, "id": "S1", "cwd": "/别处/tasks/TASK-A"}, ensure_ascii=False) + "\n"
                        + json.dumps({"type": "message", "id": "m1"}) + "\n")
            session.write_text(original, encoding="utf-8")
            old, backup = rebase_session_cwd(session, mine)
            self.assertEqual(old, "/别处/tasks/TASK-A")
            self.assertEqual(backup.read_text(encoding="utf-8"), original)
            self.assertFalse(backup.name.endswith(".jsonl"), "备份不会被当成一条会话列出来")
            lines = session.read_text(encoding="utf-8").splitlines()
            self.assertEqual(json.loads(lines[0])["cwd"], str(mine.resolve()))
            self.assertEqual(json.loads(lines[0])["id"], "S1")
            self.assertEqual(lines[1], original.splitlines()[1], "第一行以外一个字不改")
            self.assertIsNone(rebase_session_cwd(session, mine), "已经一致时什么都不做")


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，建不了任务")
class AbsolutePathTest(unittest.TestCase):
    def test_任务目录里没有指向它自己绝对路径的东西(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            service = Service(root / "tasks", root / "runs", launch.load_profile("dev"), port=8861)
            try:
                task_id = service.create({"task_type": "srs-authoring", "task_name": "路径盘点"})["task_id"]
                task_dir = service.task(task_id).dir
            finally:
                service.close()
            needles = [str(task_dir), str(task_dir.resolve()), str(root)]
            conn = sqlite3.connect(task_dir / "task.sqlite")
            dump = "\n".join(conn.iterdump())
            conn.close()
            self.assertFalse([n for n in needles if n in dump], "任务库里出现了绝对路径")
            for path in task_dir.rglob("*"):
                if path.is_file() and path.suffix not in (".sqlite", ".sqlite-wal", ".sqlite-shm"):
                    text = path.read_bytes().decode("utf-8", errors="ignore")
                    self.assertFalse([n for n in needles if n in text], f"{path.relative_to(task_dir)} 里出现了绝对路径")


if __name__ == "__main__":
    unittest.main()
