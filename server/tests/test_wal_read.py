"""读取一侧在 WAL 模式下的只读打开：能读到只在 -wal 文件里的最新数据；任务目录不可写时也能读。

夹具库由 agent 里真实的核心函数写出（与 test_current_format 共用同一个 node 脚本），写出来就是 WAL 模式。
测试里另开的写连接只用来模拟「写入者提交了、连接还开着」的时刻，不是产品代码的写入路径。
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import taskdb
from tests.test_current_format import make_workspace


def revision_count(db_path: Path) -> int:
    conn = taskdb.open_readonly(db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM revision").fetchone()[0]
    finally:
        conn.close()


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，写不出夹具库")
class WalReadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = make_workspace(Path(self.tmp.name), "ws", with_db=True)
        self.db = self.workspace / taskdb.DB_NAME

    def tearDown(self):
        os.chmod(self.workspace, 0o755)
        self.tmp.cleanup()

    def test_tool_written_database_is_wal(self):
        conn = sqlite3.connect(self.db)
        self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        conn.close()

    def test_reads_latest_data_that_is_only_in_the_wal_file(self):
        before = revision_count(self.db)
        writer = sqlite3.connect(self.db, isolation_level=None)
        writer.execute("PRAGMA wal_autocheckpoint = 0")   # 不让改动合并回库文件，只留在 -wal 里
        writer.execute("INSERT INTO revision SELECT task_id, revision_no + 100, session_id, call_id, event_seq, "
                       "created_at, summary FROM revision LIMIT 1")
        try:
            self.assertTrue(Path(f"{self.db}-wal").exists())
            self.assertEqual(revision_count(self.db), before + 1)
        finally:
            writer.close()

    @unittest.skipIf(os.geteuid() == 0, "root 不受目录权限限制，这个测试没有意义")
    def test_unwritable_directory_without_side_files_still_readable(self):
        for suffix in ("-wal", "-shm"):
            Path(f"{self.db}{suffix}").unlink(missing_ok=True)
        expected = revision_count(self.db)
        for suffix in ("-wal", "-shm"):                   # 上一行的只读打开会自己建出这两个文件，先删掉
            Path(f"{self.db}{suffix}").unlink(missing_ok=True)
        os.chmod(self.workspace, 0o555)
        self.assertEqual(revision_count(self.db), expected)


if __name__ == "__main__":
    unittest.main()
