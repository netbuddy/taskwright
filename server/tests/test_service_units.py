"""任务服务的单元测试：事件拼装取「当时那一版」、整份数据的一致时刻、Last-Event-ID 补发与 resync、
斜杠改写、错误形状、对话记录的拼法、文档渲染的标注。不起 pi，也不起 HTTP 服务。
夹具库与 test_current_format 一样，由 agent 里真实的核心函数写出。"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from taskwright_server.service import conversation, library, render
from taskwright_server.service.app import rewrite_slash, with_attachments
from taskwright_server.service.errors import ApiError
from taskwright_server.service.hub import Hub
from tests.test_current_format import make_workspace


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，写不出夹具库")
class ServiceUnitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.ws = make_workspace(Path(cls.tmp.name), "ws", with_db=True)
        # 夹具库：第 1 次修订新增 UC-001（名称「申请退款」）与 TBD-001；第 2 次修订把 UC-001 改成「买家申请退款」、
        # 改 TBD-001、新增 UC-002；第 3 次修订删除 UC-002。事件 1 是创建任务，事件 2 到 4 是三次修订。

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_库事件取当时那一版的字段与来源_删除按删除认(self):
        events, top = library.library_events(self.ws, 0)
        self.assertEqual(top, 4)
        self.assertEqual([(n, d["seq"]) for n, d in events],
                         [("task_changed", 1), ("deliverable_changed", 2), ("deliverable_changed", 3), ("deliverable_changed", 4)])
        first = events[1][1]["operations"][0]
        self.assertEqual((first["item_id"], first["version_after"], first["fields"]["名称"], first["title"]),
                         ("UC-001", 1, "申请退款", "申请退款"), "第 2 号事件里的 UC-001 是当时的第 1 版，不是现在的第 2 版")
        self.assertEqual(first["sources"][0]["supports"], [{"field": "名称", "index": None}, {"field": "步骤", "index": 0}])
        deleted = events[3][1]["operations"][0]
        self.assertEqual((deleted["op"], deleted["item_id"], deleted["version_after"], deleted["fields"], deleted["sources"]),
                         ("delete", "UC-002", None, None, []))
        self.assertEqual(deleted["title"], "撤销申请", "删除的条目标题取删除前那一版")
        self.assertEqual(events[1][1]["actor"], "executor")
        self.assertIsNone(events[1][1]["completion"], "完成条件只附在这一批的最后一条上")
        self.assertIsNotNone(events[3][1]["completion"])
        later, _ = library.library_events(self.ws, 3)
        self.assertEqual([d["seq"] for _, d in later], [4])

    def test_任务完成的事件拼成task_changed_确认的依据原样带上(self):
        # 在夹具库的副本上补两行事件：一条对话里的确认（依据是用户的话），一条任务完成。只测拼装，不测写入。
        import json
        import sqlite3
        ws = Path(self.tmp.name) / "ws-completed"
        shutil.copytree(self.ws, ws)
        conn = sqlite3.connect(ws / "task.sqlite")
        task_id = conn.execute("SELECT task_id FROM task").fetchone()[0]
        rows = [(5, "CONFIRMATION_RECORDED", {"items": [{"item_id": "UC-001", "version_no": 2, "accepted": True}], "basis": "user_words"}),
                (6, "TASK_COMPLETED", {"status_before": "进行中", "status_after": "已完成", "waived": []})]
        for seq, name, payload in rows:
            conn.execute("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (?, ?, 's', ?, ?, ?, 'executor', '2026-09-21 10:00:00')",
                         (seq, task_id, f"call-{seq}", name, json.dumps(payload, ensure_ascii=False)))
        conn.execute("UPDATE task SET status = '已完成'")
        conn.commit()
        conn.close()
        events, _ = library.library_events(ws, 4)
        self.assertEqual([n for n, _ in events], ["confirmation_recorded", "task_changed"])
        self.assertEqual((events[0][1]["basis"], events[0][1]["op_id"]), ("user_words", None))
        done = events[1][1]
        self.assertEqual((done["status_before"], done["status_after"], done["actor"]), ("进行中", "已完成", "executor"))

    def test_整份数据的序号与各表同一时刻_删掉的条目不在里面(self):
        seq, task = library.task_snapshot(self.ws)
        self.assertEqual(seq, 4)
        self.assertEqual([i["item_id"] for i in task["items"]], ["UC-001", "TBD-001"])
        uc = task["items"][0]
        self.assertEqual((uc["version_no"], uc["version_count"], uc["version_by"], uc["reviews"], uc["confirmations"], uc["confirmation_stale"]),
                         (2, 2, "executor", [], [], False))
        self.assertEqual(task["definition"]["collections"][0]["fields"][0], {"name": "名称", "type": "文本", "required": True, "values": None})
        comp = task["completion"]
        self.assertEqual(set(comp), {"all_met", "unmet_count", "brief", "conditions"})
        first = comp["conditions"][0]
        self.assertEqual(set(first), {"collection", "name", "met", "state", "done", "total", "missing", "note"})

    def test_LastEventID补发与差距太大发resync(self):
        hub = Hub(self.ws)
        try:
            sub, replay = hub.subscribe(None, 2)
            self.assertEqual([(n, seq) for n, seq, _ in replay], [("deliverable_changed", 3), ("deliverable_changed", 4)])
            import taskwright_server.service.hub as hub_module
            saved, hub_module.REPLAY_WINDOW = hub_module.REPLAY_WINDOW, 1
            try:
                _, far = hub.subscribe(None, 0)
            finally:
                hub_module.REPLAY_WINDOW = saved
            self.assertEqual(far, [("resync", None, {"reason": "gap_too_large"})])
            _, none = hub.subscribe(None, None)
            self.assertEqual(none, [], "没带 Last-Event-ID 就不补发，前端接着读整份数据")
        finally:
            hub.close()

    def test_文档渲染如实标注评审与确认状态(self):
        (self.ws / "docs" / "templates").mkdir(parents=True, exist_ok=True)
        (self.ws / "docs" / "templates" / "demo.md").write_text(
            "{{#每个 用例}}- {{编号}} {{名称}}［第 {{内容版本号}} 版；{{评审状态}}；{{确认状态}}］步骤：{{步骤}}\n{{/每个}}"
            "{{#没有 待定事项}}没有待定事项。\n{{/没有}}", encoding="utf-8")
        conn = library.open_ro(self.ws)
        try:
            lib = library.Library(library.read_all(conn))
        finally:
            conn.close()
        text = render.render(self.ws, lib, [{"item_id": "UC-001", "version_no": 1}])
        self.assertEqual(text, "- UC-001 申请退款［第 1 版；未评审；未经用户确认］步骤：1. 提交申请；2. 系统受理\n没有待定事项。\n")
        with self.assertRaises(ApiError):
            render.render(self.ws, lib, [{"item_id": "UC-001", "version_no": 9}])


class PureUnitTest(unittest.TestCase):
    def test_斜杠改写与附件模板(self):
        self.assertEqual(rewrite_slash("/tw-user {}"), "用户说：/tw-user {}")
        self.assertEqual(rewrite_slash("整理一下"), "整理一下")
        self.assertEqual(conversation.display_text("用户说：/tw-user {}"), "/tw-user {}")
        self.assertEqual(conversation.display_text("用户说：你好"), "用户说：你好", "只有斜杠改写过的才去掉前缀")
        self.assertEqual(with_attachments("看看", ["inputs/a.md", "inputs/b.md"]), "看看\n（我上传了材料：inputs/a.md、inputs/b.md）")

    def test_任务类型与卡片标注的两种写法(self):
        from taskwright_server.service.app import card_annotation, task_types
        self.assertEqual(task_types(), [{"task_type": "srs-authoring", "name": "软件需求规格说明编制"}])
        # card 写法没有选项文字：按 reply_message_id 找到那条回复，从 act.options 里按键查回文字。
        entries = [{"type": "message", "id": "a1", "message": {"role": "assistant", "content": [
            {"type": "toolCall", "id": "c1", "name": "reply", "arguments": {"informs": [], "text": "选一个", "act": {
                "kind": "choose", "text": "选一个", "options": [{"key": "a", "text": "允许续借"}, {"key": "b", "text": "不允许续借"}]}}}]}}]
        self.assertEqual(card_annotation({"card": {"reply_message_id": "a1", "kind": "choose", "choice": "b"}}, entries),
                         {"reply_message_id": "a1", "option_key": "b", "option_text": "不允许续借", "card_kind": "choose"})
        # 查不到的（「不对」这类按钮、或回复不在条目里）用 choice 本身。
        self.assertEqual(card_annotation({"card": {"reply_message_id": "a1", "kind": "confirm", "choice": "不对"}}, entries)["option_text"], "不对")
        self.assertEqual(card_annotation({"card": {"reply_message_id": "zz", "kind": "choose", "choice": "b"}}, entries)["option_text"], "b")
        self.assertEqual(card_annotation({"annotation": {"reply_message_id": "a1", "option_key": "a"}})["option_key"], "a")

    def test_错误形状与状态码(self):
        error = ApiError("session_busy", "执行者正在另一条会话里工作。", {"active_session": "s1"})
        self.assertEqual(error.status, 409)
        self.assertEqual(error.body(), {"ok": False, "error": {"code": "session_busy", "message": "执行者正在另一条会话里工作。",
                                                               "data": {"active_session": "s1"}}})
        self.assertEqual([ApiError(c, "").status for c in ("bad_request", "rejected", "executor_starting", "too_large", "unsupported_type")],
                         [400, 422, 503, 413, 415])

    def test_对话记录_卡片点击合成_界面操作与系统说明_兜底回复(self):
        ts = "2026-09-22T01:00:00.000Z"
        entries = [
            {"type": "session", "id": "h"},
            {"type": "custom_message", "id": "s1", "parentId": None, "customType": "taskwright-task-status", "content": "【任务现状】", "timestamp": ts},
            {"type": "message", "id": "u1", "parentId": "s1", "timestamp": ts, "message": {"role": "user", "content": [{"type": "text", "text": "用户说：/hi"}]}},
            {"type": "message", "id": "a1", "parentId": "u1", "timestamp": ts, "message": {"role": "assistant", "content": [
                {"type": "toolCall", "id": "c1", "name": "reply", "arguments": {"informs": ["一"], "act": None, "text": "你好"}}]}},
            {"type": "message", "id": "r1", "parentId": "a1", "timestamp": ts, "message": {"role": "toolResult", "toolCallId": "c1", "isError": False}},
            {"type": "custom_message", "id": "k1", "parentId": "r1", "customType": "taskwright-ui-click", "content": "界面点击",
             "details": {"reply_entry": "a1", "option_key": "a", "option_text": "甲", "text": "我选：甲"}, "timestamp": ts},
            {"type": "message", "id": "u2", "parentId": "k1", "timestamp": ts, "message": {"role": "user", "content": [{"type": "text", "text": "我选：甲"}]}},
            {"type": "message", "id": "a2", "parentId": "u2", "timestamp": ts, "message": {"role": "assistant", "content": [{"type": "text", "text": "直接说的话"}]}},
            {"type": "custom_message", "id": "e1", "parentId": "a2", "customType": "taskwright-user-edit", "content": "界面操作",
             "details": {"op_id": "ui-op-1", "event_seqs": [7], "undoable": True, "kind": "edit_fields"}, "timestamp": ts},
            {"type": "message", "id": "x9", "parentId": "s1", "timestamp": ts, "message": {"role": "user", "content": "被放弃的分支"}},
        ]
        # 最后一个条目 x9 在另一条分支上：当前分支是从最后一个条目回溯的，这里先把它挪走，只看主分支。
        full = conversation.messages(entries[:-1], "S")
        # 过程摘要另有测试（test_过程摘要_…）；这里只看其余几种，u1 那次工作的摘要插在它的回复之前。
        self.assertEqual([m["message_id"] for m in full][:3], ["s1", "u1", "summary-u1"])
        messages = [m for m in full if m["type"] != "work_summary"]
        self.assertEqual([(m["type"], m["message_id"]) for m in messages],
                         [("system_note", "s1"), ("user_message", "u1"), ("assistant_reply", "a1"), ("user_message", "u2"),
                          ("assistant_reply", "a2"), ("ui_action_noted", "e1")])
        self.assertEqual(messages[1]["text"], "/hi")
        self.assertEqual((messages[3]["origin"], messages[3]["annotation"]["option_text"]), ("card_choice", "甲"))
        self.assertEqual((messages[4]["via_reply_tool"], messages[4]["text"]), (False, "直接说的话"))
        self.assertEqual((messages[5]["event_seq"], messages[5]["undoable"]), (7, True))
        page = conversation.page(messages, limit=2)
        self.assertEqual((page["has_earlier"], page["earliest_id"]), (True, "a2"))
        self.assertEqual(conversation.page(messages, before="u2", limit=100)["messages"][-1]["message_id"], "a1")
        other = conversation.messages(entries, "S")
        self.assertEqual([m["message_id"] for m in other], ["s1", "x9"], "只取当前分支")

    def test_过程摘要_相邻同类合并_用时与工作编号_没有回复的放在下一句话之前(self):
        def msg(i, parent, t, role, content):
            return {"type": "message", "id": i, "parentId": parent, "timestamp": f"2026-09-22T01:00:{t:02d}.000Z", "message": {"role": role, "content": content}}
        def call(cid, name, args):
            return {"type": "toolCall", "id": cid, "name": name, "arguments": args}
        def result(i, parent, t, cid, error=False, details=None):
            return {"type": "message", "id": i, "parentId": parent, "timestamp": f"2026-09-22T01:00:{t:02d}.000Z",
                    "message": {"role": "toolResult", "toolCallId": cid, "isError": error, "details": details or {}}}
        entries = [
            {"type": "session", "id": "h"},
            msg("u1", None, 0, "user", "整理材料"),
            msg("a1", "u1", 2, "assistant", [call("c1", "read", {"path": "/w/inputs/甲.md"}), call("c2", "read", {"path": "/w/inputs/乙.md"})]),
            result("r1", "a1", 3, "c1"), result("r2", "r1", 3, "c2"),
            msg("a2", "r2", 5, "assistant", [call("c3", "save_revision", {})]),
            result("r3", "a2", 6, "c3", error=True),
            msg("a3", "r3", 8, "assistant", [call("c4", "save_revision", {})]),
            result("r4", "a3", 9, "c4", details={"revision_no": 1, "operations": [{"op": "add", "collection": "功能用例", "item": "UC-001"}]}),
            msg("a4", "r4", 12, "assistant", [call("c5", "reply", {"informs": [], "act": None, "text": "好了"})]),
            result("r5", "a4", 12, "c5"),
            msg("u2", "r5", 20, "user", "再看看"),
            msg("a5", "u2", 22, "assistant", [call("c6", "ls", {"path": "/w/inputs"})]),
            result("r6", "a5", 23, "c6"),
        ]
        out = conversation.messages(entries, "S", {"材料目录": "inputs/"})
        self.assertEqual([(m["type"], m["message_id"]) for m in out],
                         [("user_message", "u1"), ("work_summary", "summary-u1"), ("assistant_reply", "a4"),
                          ("user_message", "u2"), ("work_summary", "summary-u2")])
        first = out[1]
        self.assertEqual((first["work_id"], first["step_count"], first["seconds"]), ("w-u1", 5, 12.0))
        self.assertEqual([s["text"] for s in first["stages"]],
                         ["读了材料《甲.md》、《乙.md》", "保存修订被拒，助手正在照原因改",
                          "写好并保存了第 1 次修订：新增功能用例 1 个（UC-001）", "组织并发出了回复"])
        self.assertEqual(out[2]["work_id"], "w-u1", "回复的 work_id 补成这次工作的编号，前端据此放改动块")
        self.assertEqual((out[4]["work_id"], out[4]["step_count"], out[4]["stages"][0]["text"]), ("w-u2", 1, "看了目录"))


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，建不了任务")
class MaterialsUnitTest(unittest.TestCase):
    def test_上传材料_只收文本_重名加序号_路径越界拒绝(self):
        from taskwright_server import launch
        from taskwright_server.service.app import Service
        with tempfile.TemporaryDirectory() as tmp:
            service = Service(Path(tmp) / "tasks", Path(tmp) / "runs", launch.load_profile("dev"))
            try:
                task_id = service.create({"task_type": "srs-authoring", "task_name": "材料测试"})["task_id"]
                t = service.task(task_id)
                self.assertEqual(service.upload(t, "需求.md", "甲".encode()), {"ok": True, "path": "inputs/需求.md"})
                self.assertEqual(service.upload(t, "需求.md", "乙".encode())["path"], "inputs/需求-2.md")
                for name, code in (("图.png", "unsupported_type"), ("a/b.md", "bad_request")):
                    with self.assertRaises(ApiError) as caught:
                        service.upload(t, name, b"x")
                    self.assertEqual(caught.exception.code, code)
                with self.assertRaises(ApiError) as caught:
                    service.upload(t, "大.txt", b"x" * (5 * 1024 * 1024 + 1))
                self.assertEqual(caught.exception.code, "too_large")
                self.assertEqual(service.material_path(t, "inputs/需求-2.md").read_text(encoding="utf-8"), "乙")
                for bad in ("inputs/../task.sqlite", "docs/task-definitions/srs-authoring.json", "/etc/passwd", ""):
                    with self.assertRaises(ApiError):
                        service.material_path(t, bad)
                listing = service.task_page(t)
                self.assertEqual([m["path"] for m in listing["materials"]], ["inputs/需求-2.md", "inputs/需求.md"])
                self.assertEqual((listing["task_name"], listing["sessions"]), ("材料测试", []))
            finally:
                service.close()
