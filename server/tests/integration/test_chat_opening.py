"""终端客户端 chat.py 开场打印任务现状消息：真实的 pi 进程（模型换成假端点）打开会话时，扩展经状态栏键
taskwright-task-status 报来那条消息，客户端把它打印出来，与 pi 终端界面一样先写类型名再写正文；打过的不重复打。"""

from __future__ import annotations

import contextlib
import io
import unittest

from taskwright_server import chat
from tests.integration.rig import Rig


class ChatOpeningTests(unittest.TestCase):
    def test_开场打印任务现状消息_打过的不再打(self):
        with Rig([]) as rig:
            client = chat.Chat.__new__(chat.Chat)
            client.session = rig.session
            client.notes_shown = 0
            rig.session.get_state()   # 一次往返，确保启动时报来的状态栏请求已经读到
            first = io.StringIO()
            with contextlib.redirect_stdout(first):
                client.show_system_notes()
            again = io.StringIO()
            with contextlib.redirect_stdout(again):
                client.show_system_notes()
        lines = first.getvalue().splitlines()
        self.assertEqual(lines[0], "[taskwright-task-status]")
        self.assertRegex(lines[1], r"^【执行者开始这条会话时（\d\d:\d\d:\d\d）的任务状况：由扩展写入，不是用户打的字】任务「")
        self.assertIn("交付物还没有任何条目。", lines[1])
        self.assertEqual(again.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
