"""终端对话客户端 chat.py 显示「回复」与「保存修订」时，调的是 agent 里那一份排版函数（经 cli/render.mts）。

这里不起 pi，只把与真实事件同形状的工具结果交给客户端的显示代码，核对打印出来的几行。
"""

from __future__ import annotations

import shutil

import pytest

from taskwright_server import chat

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="本机没有 node，调不动 agent 的排版函数")


def _end(tool: str, is_error: bool, text: str, details=None) -> dict:
    return {"type": "tool_execution_end", "toolCallId": "c1", "toolName": tool, "isError": is_error,
            "result": {"content": [{"type": "text", "text": text}], "details": details}}


def test_reply_uses_shared_formatter(capsys):
    reply = {"informs": ["我新增了 UC-001。"],
             "act": {"kind": "confirm", "text": "请确认 UC-001（修订 1）。", "items": [{"item_id": "UC-001", "revision_no": 1}]},
             "text": "请确认。"}
    printer = chat.Printer()
    printer.handle({"type": "tool_execution_start", "toolCallId": "c1", "args": reply})
    printer.handle(_end("reply", False, "回复已送达", {"delivered": True, "reply": reply}))
    assert capsys.readouterr().out.splitlines() == [
        "助手（经回复工具）：", "  告知：", "    · 我新增了 UC-001。",
        "  【请确认】请确认 UC-001（修订 1）。", "      条目 UC-001（修订 1）", "  成文的话：", "    请确认。",
    ]


def test_rejected_reply_and_save(capsys):
    printer = chat.Printer()
    printer.handle(_end("reply", True, "这次回复的形式不对，没有送达。\n- 缺 text"))
    printer.handle(_end("save_revision", True, "这次「保存修订」什么都没有写入。\n- 操作 1 缺来源"))
    assert capsys.readouterr().out.splitlines() == [
        "  回复被拒绝，没有送达。拒绝的原因是：", "    这次回复的形式不对，没有送达。", "    - 缺 text",
        "  保存修订被拒绝，什么都没有写入。拒绝的原因是：", "    这次「保存修订」什么都没有写入。", "    - 操作 1 缺来源",
    ]


def test_saved_revision_without_workspace_lists_ids(capsys):
    details = {"task_id": "TASK-001", "revision_no": 2, "event_seq": 3, "operations": [
        {"op": "update", "item": "UC-001", "collection": "用例", "from_revision": 1, "to_revision": 2},
        {"op": "delete", "item": "UC-002", "collection": "用例", "from_revision": 1, "to_revision": None}]}
    chat.Printer().handle(_end("save_revision", False, "已保存", details))
    assert capsys.readouterr().out.splitlines() == [
        "  已保存为任务 TASK-001 的修订 2，一共 2 个操作（事件序号 3）：",
        "    修改 UC-001，修订 1 → 修订 2", "    删除 UC-002（删除前在修订 1）",
    ]


class _StubSession:
    """只有开场用得到的几样：启动、命令行、归档路径、状态、系统说明。"""

    def __init__(self):
        self.command = ["pi"]
        self.archive_path = None
        self.system_notes = []

    def start(self):
        self.system_notes.append({"custom_type": "taskwright-task-status", "text": "【任务现状：由扩展在打开这条会话时写入，不是用户打的字】任务「示例」。"})

    def get_state(self):
        return {"sessionFile": "session.jsonl", "sessionId": ""}


def test_start_prints_task_status_note_after_help(capsys):
    client = chat.Chat.__new__(chat.Chat)
    client.workspace = "任务目录"
    client.profile = {"extensions": []}
    client.settings = {"environment": "", "base_url": "", "project_id": ""}
    client.session = _StubSession()
    client.notes_shown = 0
    client.start()
    out = capsys.readouterr().out.splitlines()
    at = out.index("[taskwright-task-status]")
    assert out[at + 1] == "【任务现状：由扩展在打开这条会话时写入，不是用户打的字】任务「示例」。"
    assert at > out.index("  /quit     退出"), "任务现状打在命令说明之后，紧挨着第一句话的输入提示"
