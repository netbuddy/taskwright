"""任务服务的单元测试：事件拼装取「当时那一版」、整份数据的一致时刻、Last-Event-ID 补发与 resync、
斜杠改写、错误形状、对话记录的拼法、文档渲染的标注。不起 pi，也不起 HTTP 服务。
夹具库与 test_current_format 一样，由 agent 里真实的核心函数写出。"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from taskwright_server.service import conversation, library, render
from taskwright_server.service.app import rewrite_slash, with_attachments, words_locator
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
        self.assertEqual((first["item_id"], first["revision_after"], first["fields"]["名称"], first["title"]),
                         ("UC-001", 1, "申请退款", "申请退款"), "第 2 号事件里的 UC-001 是它在修订 1 的内容，不是现在修订 2 的内容")
        self.assertNotIn("version_after", first, "修订统一之后不再带旧键名")
        self.assertEqual(first["sources"][0]["supports"], [{"field": "名称", "index": None}, {"field": "步骤", "index": 0}])
        deleted = events[3][1]["operations"][0]
        self.assertEqual((deleted["op"], deleted["item_id"], deleted["revision_before"], deleted["revision_after"], deleted["fields"], deleted["sources"]),
                         ("delete", "UC-002", 2, None, None, []))
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
        rows = [(5, "CONFIRMATION_RECORDED", {"items": [{"item_id": "UC-001", "revision_no": 2, "accepted": True}], "basis": "user_words"}),
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
        self.assertEqual(events[0][1]["items"], [{"item_id": "UC-001", "revision_no": 2, "accepted": True}], "确认事件的条目原样带修订号，不加旧键名")
        done = events[1][1]
        self.assertEqual((done["status_before"], done["status_after"], done["actor"]), ("进行中", "已完成", "executor"))

    def test_评审的四种事件拼成库事件_发现带规则编号与级别_整份数据里也有(self):
        # 在夹具库的副本上补一次界面发起的评审：两条进度、一条评审记录（带两条发现）、一条评审未完成、一条结束。只测拼装。
        import json
        import sqlite3
        ws = Path(self.tmp.name) / "ws-reviewed"
        shutil.copytree(self.ws, ws)
        conn = sqlite3.connect(ws / "task.sqlite")
        task_id = conn.execute("SELECT task_id FROM task").fetchone()[0]
        findings = [{"rule_id": "D-R1", "level": "必选", "field": "步骤", "index": 1, "problem": "没有主语", "suggestion": "写明谁做"},
                    {"rule_id": "D-R2", "level": "可选", "field": "名称", "index": None, "problem": "举了例子", "suggestion": None}]
        rows = [(5, "REVIEW_PROGRESS", {"op_id": "ui-op-r", "done": 0, "total": 1, "current": ["UC-001"], "item_id": None}),
                (6, "REVIEW_RECORDED", {"item_id": "UC-001", "revision_no": 2, "verdict": "不合规", "reason": "问题 1 处，建议 1 条。", "findings": findings}),
                (7, "REVIEW_UNFINISHED", {"item_id": "UC-001", "revision_no": 2, "reason": "超过 60 秒没有评完"}),
                (8, "REVIEW_PROGRESS", {"op_id": "ui-op-r", "done": 1, "total": 1, "current": [], "item_id": "UC-001"}),
                (9, "REVIEW_FINISHED", {"op_id": "ui-op-r", "total": 1, "passed": 0, "failed": 1, "unfinished": 0,
                                        "results": [{"item_id": "UC-001", "revision_no": 2, "status": "不合规"}], "error": None})]
        for seq, name, payload in rows:
            conn.execute("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (?, ?, 's', 'ui-op-r', ?, ?, 'user', '2026-09-24 10:00:00')",
                         (seq, task_id, name, json.dumps(payload, ensure_ascii=False)))
        review_id = conn.execute("INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at) "
                                 "VALUES (?, 'UC-001', 2, '不合规', '问题 1 处，建议 1 条。', 'x', 'x', 'ui-op-r', 6, '2026-09-24 10:00:00')", (task_id,)).lastrowid
        for i, f in enumerate(findings):
            conn.execute("INSERT INTO review_finding (review_id, task_id, ordinal, field, item_index, problem, suggestion, rule_id, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         (review_id, task_id, i + 1, f["field"], f["index"], f["problem"], f["suggestion"], f["rule_id"], f["level"]))
        conn.commit()
        conn.close()
        events, _ = library.library_events(ws, 4)
        self.assertEqual([n for n, _ in events], ["review_progress", "review_recorded", "review_unfinished", "review_progress", "review_finished"])
        progress, recorded, unfinished, _, finished = [d for _, d in events]
        self.assertEqual((progress["op_id"], progress["done"], progress["total"], progress["current"]), ("ui-op-r", 0, 1, ["UC-001"]))
        self.assertEqual((recorded["verdict"], recorded["op_id"], recorded["findings"]), ("不合规", "ui-op-r", findings))
        self.assertEqual(unfinished["reason"], "超过 60 秒没有评完")
        self.assertEqual((finished["passed"], finished["failed"], finished["unfinished"]), (0, 1, 0))
        self.assertIsNotNone(finished["completion"], "完成条件附在这一批的最后一条上")
        _, task = library.task_snapshot(ws)
        item = next(i for i in task["items"] if i["item_id"] == "UC-001")
        self.assertEqual(item["reviews"][0]["findings"], findings)

    def test_任务定义视图带上各集合要不要评审与生效的规则清单(self):
        import json
        ws = Path(self.tmp.name) / "ws-rules"
        (ws / "docs" / "review-rules").mkdir(parents=True)
        (ws / "docs" / "review-rules" / "demo.json").write_text(json.dumps([
            {"编号": "D-R1", "级别": "必选", "条文": "甲", "反例": "乙", "正例": "丙"},
            {"编号": "D-R2", "级别": "可选", "条文": "丁", "反例": "戊", "正例": "己"},
            {"编号": "D-R3", "级别": "可选", "条文": "庚", "反例": "辛", "正例": "壬"}], ensure_ascii=False), encoding="utf-8")
        raw = {"交付物": {"条目集合": [{"名称": "用例", "评审规矩": {"规则文件": "docs/review-rules/demo.json", "关闭": ["D-R3"], "升为必选": ["D-R2"]}},
                                     {"名称": "问题"}]}}
        parsed = {"集合": [{"名称": "用例", "编号前缀": "UC", "字段": []}, {"名称": "问题", "编号前缀": "TBD", "字段": []}],
                  "完成条件": {"用例": ["每个条目评审通过"], "问题": ["没有状态为未解决的条目"]}}
        view = library.definition_view(parsed, json.dumps(raw, ensure_ascii=False), ws)
        uc, tbd = view["collections"]
        self.assertTrue(uc["needs_review"])
        self.assertEqual([(r["id"], r["level"]) for r in uc["review_rules"]], [("D-R1", "必选"), ("D-R2", "必选")])
        self.assertEqual(uc["review_rules"][0], {"id": "D-R1", "level": "必选", "text": "甲", "counter_example": "乙", "example": "丙"})
        self.assertEqual((tbd["needs_review"], tbd["review_rules"]), (False, None))

    def test_旧库的评审发现表没有规则编号两列时读作空(self):
        import sqlite3
        ws = Path(self.tmp.name) / "ws-old-findings"
        shutil.copytree(self.ws, ws)
        conn = sqlite3.connect(ws / "task.sqlite")
        conn.execute("DROP TABLE review_finding")
        conn.execute("CREATE TABLE review_finding (review_id INTEGER NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, field TEXT NOT NULL, "
                     "item_index INTEGER, problem TEXT NOT NULL, suggestion TEXT, PRIMARY KEY (review_id, ordinal))")
        conn.execute("INSERT INTO review_finding VALUES (1, 't', 1, '步骤', NULL, '没有主语', NULL)")
        conn.commit()
        conn.row_factory = sqlite3.Row
        found = library.read_findings(conn, "t")
        conn.close()
        self.assertEqual(found, {1: [{"rule_id": None, "level": None, "field": "步骤", "index": None, "problem": "没有主语", "suggestion": None}]})

    def test_评审批次_保留_规则开关三类事件与整份数据_导出写用户保留(self):
        # 在夹具库的副本上补：一次评审（UC-001 修订 2 不合规）、批次摘要、一次保留、一次规则开关。只测拼装与导出。
        import json
        import sqlite3
        ws = Path(self.tmp.name) / "ws-lifecycle"
        shutil.copytree(self.ws, ws)
        subprocess_node_write(ws)       # 让写入一侧打开一次，补上新列与新表
        conn = sqlite3.connect(ws / "task.sqlite")
        task_id = conn.execute("SELECT task_id FROM task").fetchone()[0]
        batch = {"batch_id": "ui-op-b", "started_by": "user", "scope": "pending", "items": [{"item_id": "UC-001", "revision_no": 2}],
                 "forced": [], "total": 1, "passed": 0, "failed": 1, "unfinished": 0, "problems": 1, "advice": 0}
        rows = [(5, "REVIEW_RECORDED", "ui-op-b", {"item_id": "UC-001", "revision_no": 2, "verdict": "不合规", "reason": "r", "findings": []}),
                (6, "REVIEW_BATCH", "ui-op-b", batch),
                (7, "REVIEW_WAIVED", "ui-op-w", {"items": [{"item_id": "UC-001", "revision_no": 2}], "reason": "材料原话如此", "source": "panel"}),
                (8, "REVIEW_RULES_CHANGED", "ui-op-s", {"collection": "用例", "off": ["D-R2"], "promote": [], "before": {"off": [], "promote": []}})]
        for seq, name, call, payload in rows:
            conn.execute("INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (?, ?, 's', ?, ?, ?, 'user', '2026-09-24 10:00:00')",
                         (seq, task_id, call, name, json.dumps(payload, ensure_ascii=False)))
        conn.execute("INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at, batch_id, rules_hash, forced) "
                     "VALUES (?, 'UC-001', 2, '不合规', 'r', 'x', 'x', 'ui-op-b', 5, '2026-09-24 10:00:00', 'ui-op-b', 'abc', 0)", (task_id,))
        conn.execute("INSERT INTO review_waiver (task_id, item_id, revision_no, reason, source, op_id, event_seq, created_at) "
                     "VALUES (?, 'UC-001', 2, '材料原话如此', 'panel', 'ui-op-w', 7, '2026-09-24 10:01:00')", (task_id,))
        conn.commit()
        conn.close()
        events, _ = library.library_events(ws, 4)
        self.assertEqual([n for n, _ in events], ["review_recorded", "review_batch", "review_waived", "review_rules_changed"])
        b = events[1][1]
        self.assertEqual((b["no"], b["batch_id"], b["started_by"], b["total"], b["failed"], b["problems"]), (1, "ui-op-b", "user", 1, 1, 1))
        self.assertEqual((events[2][1]["reason"], events[2][1]["source"], events[2][1]["op_id"]), ("材料原话如此", "panel", "ui-op-w"))
        self.assertEqual((events[3][1]["collection"], events[3][1]["off"]), ("用例", ["D-R2"]))
        _, task = library.task_snapshot(ws)
        uc1 = next(i for i in task["items"] if i["item_id"] == "UC-001")
        self.assertEqual(uc1["reviews"][0]["batch_id"], "ui-op-b")
        self.assertEqual(uc1["waivers"], [{"revision_no": 2, "reason": "材料原话如此", "source": "panel", "at": uc1["waivers"][0]["at"], "revoked": False}])
        self.assertEqual([b["no"] for b in task["review_batches"]], [1])
        conn = library.open_ro(ws)
        try:
            lib = library.Library(library.read_all(conn))
        finally:
            conn.close()
        self.assertEqual(render.review_state(lib, "UC-001", 2), "评审不通过，用户保留（理由：材料原话如此）")

    def test_规则指纹与agent同一个算法_全部规则带开关状态(self):
        import json
        import subprocess
        spec_off, spec_promote = ["D-R2"], ["D-R3"]
        text = json.dumps([{"编号": "D-R1", "级别": "必选", "条文": "甲", "反例": "乙", "正例": "丙"}], ensure_ascii=False)
        script = ("import('" + str(library.REPO_ROOT / "agent" / "src" / "lib" / "review_state.ts") + "').then((m) => "
                  "process.stdout.write(m.rulesHashText(process.argv[1], { off: JSON.parse(process.argv[2]), promote: JSON.parse(process.argv[3]) })))")
        out = subprocess.run(["node", "--input-type=module", "-e", script, text, json.dumps(spec_off), json.dumps(spec_promote)],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(library.rules_hash_text(text, spec_off, spec_promote), out)
        ws = Path(self.tmp.name) / "ws-all-rules"
        (ws / "docs").mkdir(parents=True)
        (ws / "docs" / "r.json").write_text(json.dumps([
            {"编号": "A", "级别": "必选", "条文": "", "反例": "", "正例": ""}, {"编号": "B", "级别": "可选", "条文": "", "反例": "", "正例": ""},
            {"编号": "C", "级别": "可选", "条文": "", "反例": "", "正例": ""}, {"编号": "D", "级别": "可选", "条文": "", "反例": "", "正例": ""}]), encoding="utf-8")
        states = [r["state"] for r in library.all_rules(ws, {"规则文件": "docs/r.json", "关闭": ["B"], "升为必选": ["C"]})]
        self.assertEqual(states, ["required", "off", "promoted", "optional"])

    def test_整份数据的序号与各表同一时刻_删掉的条目不在里面(self):
        seq, task = library.task_snapshot(self.ws)
        self.assertEqual(seq, 4)
        self.assertEqual([i["item_id"] for i in task["items"]], ["UC-001", "TBD-001"])
        uc = task["items"][0]
        self.assertEqual((uc["revision_no"], uc["revisions"], uc["revision_by"], uc["reviews"], uc["confirmations"], uc["confirmation_stale"]),
                         (2, [1, 2], "executor", [], [], False))
        self.assertFalse({"version_no", "version_by", "version_at", "version_count"} & set(uc), "修订统一之后不再带旧键名")
        self.assertEqual(task["definition"]["collections"][0]["fields"][0], {"name": "名称", "type": "文本", "required": True, "values": None})
        comp = task["completion"]
        self.assertEqual(set(comp), {"all_met", "unmet_count", "brief", "conditions", "hints"})
        self.assertEqual(comp["hints"], [], "这个任务没有领域说明集合，没有提示")
        first = comp["conditions"][0]
        self.assertEqual(set(first), {"collection", "name", "met", "state", "done", "total", "missing", "note"})

    def test_修订日志最新在前_每项列出碰到的条目与改了哪些字段(self):
        log = library.revision_log(self.ws)
        self.assertEqual([r["revision_no"] for r in log], [3, 2, 1])
        self.assertEqual([(op["op"], op["item_id"], op["revision_before"], op["revision_after"]) for op in log[0]["operations"]],
                         [("delete", "UC-002", 2, None)])
        self.assertEqual(log[0]["operations"][0]["title"], "撤销申请", "删除的条目标题取删除前的内容")
        second = {op["item_id"]: op for op in log[1]["operations"]}
        self.assertEqual((second["UC-001"]["op"], second["UC-001"]["fields_changed"]), ("update", ["名称"]))
        self.assertEqual((second["UC-002"]["op"], second["UC-002"]["fields_changed"]), ("add", []), "新增不列字段")
        self.assertEqual((log[2]["by"], log[2]["undo_of_revision"]), ("executor", None))
        self.assertTrue(log[2]["call_id"] and log[2]["session_id"])

    def test_用户直接操作的修订写成一句操作名(self):
        from taskwright_server.service.app import user_action_text
        edit = {"operations": [{"op": "update", "item_id": "UC-002", "fields_changed": ["基本流程", "前置条件"]}], "undo_of_revision": None}
        self.assertEqual(user_action_text("edit_fields", edit), "你改了 UC-002 的「基本流程」「前置条件」")
        self.assertEqual(user_action_text("keep_pending", {"operations": [{"op": "update", "item_id": "TBD-003", "fields_changed": ["状态"]}]}),
                         "你把 TBD-003 标为先不管")
        self.assertEqual(user_action_text("delete_item", {"operations": [{"op": "delete", "item_id": "UC-004", "fields_changed": []}]}), "你删除了 UC-004")
        self.assertEqual(user_action_text(None, {"operations": [], "undo_of_revision": 4}), "你撤销了修订 4")
        self.assertEqual(user_action_text(None, {"operations": [{"op": "update", "item_id": "UC-001", "fields_changed": ["名称"]}]}),
                         "你改了 UC-001 的「名称」", "会话记录里找不到操作种类时按修订里的操作写")

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

    def test_文档按修订整体导出_如实标注确认与评审(self):
        (self.ws / "docs" / "templates").mkdir(parents=True, exist_ok=True)
        (self.ws / "docs" / "templates" / "demo.md").write_text(
            "按修订 {{文档修订号}} 生成。\n"
            "{{#每个 用例}}- {{编号}} {{名称}}［修订 {{修订号}} · {{确认状态}} · {{评审状态}}］步骤：{{步骤}}\n{{/每个}}"
            "{{#没有 待定事项}}没有待定事项。\n{{/没有}}", encoding="utf-8")
        conn = library.open_ro(self.ws)
        try:
            lib = library.Library(library.read_all(conn))
        finally:
            conn.close()
        # 缺省是最新修订（修订 3）：UC-002 在修订 3 删了，不在里面；UC-001 的内容来自修订 2。
        latest = render.render(self.ws, lib)
        self.assertEqual(latest, "按修订 3 生成。\n- UC-001 买家申请退款［修订 2 · 未确认 · 未评审］步骤：1. 提交申请；2. 系统受理\n")
        # 修订 1：UC-001 是那时的内容。
        first = render.render(self.ws, lib, 1)
        self.assertEqual(first, "按修订 1 生成。\n- UC-001 申请退款［修订 1 · 未确认 · 未评审］步骤：1. 提交申请；2. 系统受理\n")
        # 修订 2 只列 UC-002：筛掉的条目不出现，待定事项一个都没选中。
        only = render.render(self.ws, lib, 2, ["UC-002"])
        self.assertIn("- UC-002 撤销申请［修订 2 · 未确认 · 未评审］", only)
        self.assertNotIn("UC-001", only)
        self.assertIn("没有待定事项。", only)
        with self.assertRaises(ApiError) as too_new:
            render.render(self.ws, lib, 9)
        self.assertIn("还没有修订 9，最新是修订 3", too_new.exception.message)
        with self.assertRaises(ApiError) as gone:
            render.render(self.ws, lib, 3, ["UC-002"])
        self.assertIn("修订 3 时交付物里没有这些条目：UC-002", gone.exception.message)

    def test_文档导出_用户看过旧修订之后助手又改过_确认状态如实写最后看过的修订(self):
        (self.ws / "docs" / "templates").mkdir(parents=True, exist_ok=True)
        (self.ws / "docs" / "templates" / "demo.md").write_text(
            "{{#每个 用例}}- {{编号}}［修订 {{修订号}} · {{确认状态}}］\n{{/每个}}", encoding="utf-8")
        conn = library.open_ro(self.ws)
        try:
            data = library.read_all(conn)
        finally:
            conn.close()
        # 用户在修订 1 打开看过 UC-001；助手在修订 2 改了它（夹具里 call-r2 是执行者的调用）。
        data["confirmations"].append({"item_id": "UC-001", "revision_no": 1, "attitude": "接受", "created_at": "2026-09-23T10:00:00.000",
                                      "basis": '[{"依据": "已读"}]', "call_id": "ui-op-9", "judgement_id": 99})
        lib = library.Library(data)
        self.assertEqual(render.render(self.ws, lib), "- UC-001［修订 2 · 用户最后看过修订 1，之后由助手改为修订 2］\n")
        # 导出修订 1 时，看过的正是这次修订，照旧写依据。
        self.assertEqual(render.render(self.ws, lib, 1), "- UC-001［修订 1 · 已确认（已读）］\n")
        # 整份数据里，看过旧修订的条目仍算已读（不因后来的修订翻回未读），依据取最后一次接受的。
        uc = next(i for i in lib.task_view()["items"] if i["item_id"] == "UC-001")
        self.assertEqual((uc["viewed"], uc["confirmation_basis"], uc["confirmation_stale"]), (True, "viewed", True))

    def test_文档请求的写法(self):
        self.assertEqual(render.document_request({}), (None, None))
        self.assertEqual(render.document_request({"revision_no": 2, "items": ["UC-001"]}), (2, ["UC-001"]))
        # 旧前端的 selection 已不再认：按没写条目筛选处理，也就是那次修订时的全部条目。
        self.assertEqual(render.document_request({"selection": [{"item_id": "UC-001", "version_no": 1}]}), (None, None))
        with self.assertRaises(ApiError):
            render.document_request({"revision_no": 0})


class WordsLocatorTest(unittest.TestCase):
    """文档里「用户的话」的出处：库里是「会话编号#消息编号」，印进文档的是读者看得懂的说法。"""

    def fake_task(self, name):
        def msg(eid, parent, role, text):
            return {"type": "message", "id": eid, "parentId": parent, "timestamp": "2026-09-22T10:00:00Z",
                    "message": {"role": role, "content": [{"type": "text", "text": text}]}}
        entries = [{"type": "session", "id": "S1", "timestamp": "2026-09-22T10:00:00Z"},
                   msg("u1", None, "user", "请整理材料"), msg("a1", "u1", "assistant", "好的"),
                   msg("u2", "a1", "user", "罚款在服务台缴纳"), msg("a2", "u2", "assistant", "记下了")]

        class Executor:
            def entries(self, session_id):
                return entries if session_id == "S1" else []

            def list_sessions(self):
                return [{"session_id": "S1", "name": name}]

        class Task:
            executor = Executor()

            def definition(self):
                return {}
        return Task()

    def test_换算成会话名称与用户的第几句话(self):
        locate = words_locator(self.fake_task("整理需求"))
        self.assertEqual(locate("S1#u2"), "会话「整理需求」里用户的第 2 句话")
        self.assertEqual(words_locator(self.fake_task(None))("S1#u1"), "对话里用户的第 1 句话")
        self.assertIsNone(locate("S1#不存在"))
        self.assertIsNone(locate("S9#u1"))
        self.assertIsNone(locate("没有井号"))

    def test_渲染不把内部编号印进文档(self):
        class Lib:
            def sources_of(self, item_id, version_no):
                return [{"kind": "用户的话", "locator": "S1#u2", "excerpt": "罚款在服务台缴纳"},
                        {"kind": "文档原文", "locator": "inputs/a.md", "excerpt": "原文"}]
        self.assertEqual(render.sources_text(Lib(), "UC-001", 1, words_locator(self.fake_task("整理需求"))),
                         "用户的话，出处 会话「整理需求」里用户的第 2 句话（「罚款在服务台缴纳」）；文档原文，出处 inputs/a.md（「原文」）")
        self.assertEqual(render.sources_text(Lib(), "UC-001", 1),
                         "用户的话，出处 对话里用户说的话（「罚款在服务台缴纳」）；文档原文，出处 inputs/a.md（「原文」）")


class EditLocatorTest(unittest.TestCase):
    """文档里「用户直接修改」的出处：库里是界面操作编号，印进文档的是「用户在界面上的第 N 次修改（时刻）」。"""

    class Lib:
        def __init__(self):
            edit = lambda op, seq: {"种类": "用户直接修改", "出处": op, "摘录": "新值", "事件序号": seq}
            self.data = {
                "sources": {("UC-001", 2): [edit("ui-op-b", 7)], ("UC-001", 3): [edit("ui-op-b", 7), edit("ui-op-c", 9)],
                            ("UC-002", 2): [edit("ui-op-a", 5)],
                            ("UC-002", 1): [{"种类": "文档原文", "出处": "inputs/a.md", "摘录": "原文", "事件序号": 2}]},
                "event_meta": {5: {"at": "2026-09-22T17:55:20.939"}, 7: {"at": "2026-09-22T18:01:02.000"}, 9: {"at": ""}},
            }

        def sources_of(self, item_id, version_no):
            from taskwright_server.service.library import source_view
            return [source_view(one) for one in self.data["sources"].get((item_id, version_no), [])]

    def test_按写入先后编号并带上时刻(self):
        locate = render.edit_locator(self.Lib())
        self.assertEqual(locate("ui-op-a"), "用户在界面上的第 1 次修改（2026-09-22 17:55）")
        self.assertEqual(locate("ui-op-b"), "用户在界面上的第 2 次修改（2026-09-22 18:01）", "沿用到后一版的同一个来源不重复计数")
        self.assertEqual(locate("ui-op-c"), "用户在界面上的第 3 次修改", "没有时刻就不写括号")
        self.assertIsNone(locate("ui-op-zzz"))

    def test_渲染不把操作编号印进文档(self):
        lib = self.Lib()
        self.assertEqual(render.sources_text(lib, "UC-002", 2, None, render.edit_locator(lib)),
                         "用户直接修改，出处 用户在界面上的第 1 次修改（2026-09-22 17:55）（「新值」）")
        self.assertEqual(render.sources_text(lib, "UC-002", 2), "用户直接修改，出处 用户在界面上的修改（「新值」）")


class PureUnitTest(unittest.TestCase):
    def test_斜杠改写与附件模板(self):
        self.assertEqual(rewrite_slash("/tw-user {}"), "用户说：/tw-user {}")
        self.assertEqual(rewrite_slash("整理一下"), "整理一下")
        self.assertEqual(conversation.display_text("用户说：/tw-user {}"), "/tw-user {}")
        self.assertEqual(conversation.display_text("用户说：你好"), "用户说：你好", "只有斜杠改写过的才去掉前缀")
        self.assertEqual(with_attachments("看看", ["inputs/a.md", "inputs/b.md"]), "看看\n（我上传了材料：inputs/a.md、inputs/b.md）")
        self.assertEqual(with_attachments("看看", ["inputs/a.docx"]),
                         "看看\n（我上传了材料：inputs/a.docx；其中 Word 文件请读同名的 .txt（inputs/a.docx.txt），引用时出处写 Word 文件加段落号）")

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
        error = ApiError("session_busy", "助手正在另一条会话里工作。", {"active_session": "s1"})
        self.assertEqual(error.status, 409)
        self.assertEqual(error.body(), {"ok": False, "error": {"code": "session_busy", "message": "助手正在另一条会话里工作。",
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
                          "写好并保存了修订 1：新增功能用例 1 个（UC-001）", "组织并发出了回复"])
        self.assertEqual(out[2]["work_id"], "w-u1", "回复的 work_id 补成这次工作的编号，前端据此放改动块")
        self.assertEqual((out[4]["work_id"], out[4]["step_count"], out[4]["stages"][0]["text"]), ("w-u2", 1, "看了目录"))
        self.assertNotIn("reasons", first["stages"][1], "结果正文里取不到原因时照旧写固定的一句，不带 reasons")

    def test_过程摘要_保存修订被拒附上原因_多于一条时写还有几条(self):
        def msg(i, parent, role, content):
            return {"type": "message", "id": i, "parentId": parent, "timestamp": "2026-09-22T01:00:00.000Z", "message": {"role": role, "content": content}}
        def rejected(i, parent, cid, text):
            return {"type": "message", "id": i, "parentId": parent, "timestamp": "2026-09-22T01:00:01.000Z",
                    "message": {"role": "toolResult", "toolCallId": cid, "isError": True, "details": {}, "content": [{"type": "text", "text": text}]}}
        two = ("这次「保存修订」什么都没有写入，因为有 2 个操作不对：\n"
               "- 操作 1（新增，集合「功能用例」）：第 1 条来源的摘录「借书」在 inputs/甲.md 里找不到。\n"
               "- 操作 2（修改，条目 UC-001）：这个条目已经被用户改到修订 3。\n  它现在的内容：……\n"
               "请把这些地方改正之后，把整批操作重新提交一次。")
        one = ("这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n"
               "- 操作 1（新增，集合「问题」）：字段「关联条目」是条目引用类型，第 1 个编号 \"UC-006\" 指向的条目在这个任务里不存在。\n"
               "请把这些地方改正之后，把整批操作重新提交一次。")
        entries = [
            {"type": "session", "id": "h"},
            msg("u1", None, "user", "整理材料"),
            msg("a1", "u1", "assistant", [{"type": "toolCall", "id": "c1", "name": "save_revision", "arguments": {}}]),
            rejected("r1", "a1", "c1", two),
            msg("a2", "r1", "assistant", [{"type": "toolCall", "id": "c2", "name": "save_revision", "arguments": {}}]),
            rejected("r2", "a2", "c2", one),
            msg("a3", "r2", "assistant", [{"type": "toolCall", "id": "c3", "name": "save_revision", "arguments": {}}]),
            rejected("r3", "a3", "c3", "Validation failed for tool \"save_revision\""),
        ]
        stages = conversation.messages(entries, "S", {})[1]["stages"]
        # 早先版本的正文（没有「怎么办」一行）：去掉「操作 N（……）：」标签，第一行当作事实。
        self.assertEqual(stages[0]["text"], "保存修订被拒：第 1 条来源的摘录「借书」在 inputs/甲.md 里找不到。（还有 1 条）")
        self.assertEqual(stages[0]["reasons"], ["第 1 条来源的摘录「借书」在 inputs/甲.md 里找不到。", "这个条目已经被用户改到修订 3。"])
        self.assertEqual(stages[1]["text"], "保存修订被拒：字段「关联条目」是条目引用类型，"
                                            "第 1 个编号 \"UC-006\" 指向的条目在这个任务里不存在。")
        self.assertEqual(len(stages[1]["reasons"]), 1)
        self.assertEqual(stages[2], {"text": "保存修订被拒，助手正在照原因改", "count": 1}, "不是保存修订自己的拒绝正文时照旧写固定的一句")

    def test_过程摘要_拒绝原因分两层_摘要与展开只用事实(self):
        from taskwright_server.service import work_summary
        text = ("这次「保存修订」什么都没有写入，因为有 2 个操作不对：\n"
                "- 操作 1（修改，条目 TBD-001）：助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。\n"
                "  怎么办：用户的回答要写进它牵涉的条目（关联条目里列的那些），改完再问用户这个问题是否已解决。\n"
                "- 操作 2（修改，条目 UC-001）：UC-001 已经被用户改到修订 3，助手看到的还是修订 2。\n"
                "  怎么办：请先读最新内容再改。它在修订 3 的内容是：{\"名称\":\"借书\"}。\n"
                "请把这些地方改正之后，把整批操作重新提交一次。")
        parts = work_summary.rejection_parts({}, text)
        self.assertEqual(parts[0], {"fact": "助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。",
                                    "guidance": "用户的回答要写进它牵涉的条目（关联条目里列的那些），改完再问用户这个问题是否已解决。"})
        self.assertEqual(work_summary.step_text("save_revision", {}, True, True, {"reasons": parts}, {}),
                         "保存修订被拒：助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。（还有 1 条）")
        self.assertEqual(work_summary.rejection_reasons({}, text),
                         ["助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。", "UC-001 已经被用户改到修订 3，助手看到的还是修订 2。"])
        self.assertTrue(all("怎么办" not in one and "关联条目里列的" not in one for one in work_summary.rejection_reasons({}, text)))

    def test_过程摘要_请求评审写评审了几个条目几个不合规(self):
        from taskwright_server.service import work_summary
        details = {"results": [{"item_id": "UC-001", "status": "合规"}, {"item_id": "UC-002", "status": "不合规"},
                               {"item_id": "UC-003", "status": "评审未完成"}]}
        self.assertEqual(work_summary.step_text("request_review", {}, True, False, details, {}), "评审了 3 个条目，1 个不合规")
        self.assertEqual(work_summary.step_text("request_review", {}, False, False, None, {}), "正在请评审者评审")
        self.assertEqual(work_summary.step_text("request_review", {}, True, True, None, {}), "请评审者评审没有做成")


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


class OldFormatListTest(unittest.TestCase):
    def test_修订统一之前建的任务照样列出_标明不支持且打不开(self):
        import sqlite3
        from taskwright_server.service.app import Service
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old = root / "tasks" / "TASK-OLD"
            old.mkdir(parents=True)
            conn = sqlite3.connect(old / "task.sqlite")
            conn.execute("CREATE TABLE task (task_id TEXT)")
            conn.execute("INSERT INTO task VALUES ('TASK-OLD')")
            conn.execute("CREATE TABLE item_version (task_id TEXT, item_id TEXT, version_no INTEGER, revision_no INTEGER)")
            conn.commit()
            conn.close()
            service = Service(root / "tasks", root / "runs", {})
            rows = service.list_tasks()
            self.assertEqual([(r["task_id"], r["status"], r["supported"]) for r in rows], [("TASK-OLD", "旧格式", False)])
            self.assertEqual(rows[0]["note"], library.OLD_FORMAT_TEXT)
            with self.assertRaises(ApiError) as missing:
                service.task("TASK-OLD")
            self.assertEqual(missing.exception.code, "not_found")


class LiveWorkIdTest(unittest.TestCase):
    """用户消息的 message_end 到达时，按「上次取到的位置之后」找不到这条消息的会话条目有两种情形：前一条界面操作说明
    取条目时已把它一并取走（游标越过了它），或它还没写进会话记录（卡片点击、界面操作之后的那句话写入更晚）。执行者看护
    要到全部条目里、上一次认过的用户消息之后去找，必要时隔一会儿重取，把实时工作编号定成「w-条目编号」，与刷新后
    从会话文件算出的一致；不认回更早说过的同一句话。"""

    def make(self, appear_after: int, cursor: str):
        from taskwright_server.service import executor as executor_module

        class Hub:
            def __init__(self):
                self.events = []

            def emit(self, name, data):
                self.events.append((name, data))

            def trigger(self):
                pass

        old = {"type": "message", "id": "u-old", "message": {"role": "user", "content": [{"type": "text", "text": "好"}]}}
        note = {"type": "custom_message", "id": "n-1", "customType": "taskwright-user-edit"}
        new = {"type": "message", "id": "u-new", "message": {"role": "user", "content": [{"type": "text", "text": "好"}]}}

        class Pi:
            calls = 0

            def request(self, command, **kwargs):
                if command != "get_entries":
                    return {}
                Pi.calls += 1
                entries = [old, note, new] if Pi.calls > appear_after else [old, note]
                since = kwargs.get("since")           # 与 pi 一样：带 since 时只给这个编号之后的条目
                if since:
                    ids = [e["id"] for e in entries]
                    entries = entries[ids.index(since) + 1:] if since in ids else []
                return {"entries": entries}

            def get_state(self):
                return {"sessionName": "已有名字"}

        hub = Hub()
        ex = executor_module.Executor("T", Path("/nonexistent"), Path("/nonexistent"), {}, hub)
        ex.active_session = "S"
        ex.named.add("S")
        ex.cursor = cursor
        ex.last_user_entry = "u-old"   # 上一次认过的那句话，文字恰好相同
        saved = executor_module.ENTRY_RETRY_DELAY
        executor_module.ENTRY_RETRY_DELAY = 0
        self.addCleanup(setattr, executor_module, "ENTRY_RETRY_DELAY", saved)
        pi = Pi()
        ex._handle(pi, {"type": "agent_start"})
        ex._handle(pi, {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "好"}]}})
        return ex, hub

    def check(self, ex, hub):
        said = [d for n, d in hub.events if n == "user_message"][0]
        self.assertEqual(said["message_id"], "u-new", "不认回更早说过的同一句话 u-old")
        self.assertEqual(ex.work["work_id"], "w-u-new")
        self.assertEqual([d for n, d in hub.events if n == "work_started"][0]["work_id"], "w-u-new")

    def test_游标已越过这句话时到全部条目里找(self):
        ex, hub = self.make(appear_after=0, cursor="u-new")
        self.check(ex, hub)

    def test_这句话晚写进会话时重取几次(self):
        ex, hub = self.make(appear_after=4, cursor="n-1")
        self.check(ex, hub)

    def test_一直找不到时不卡住_工作编号保持原样(self):
        ex, hub = self.make(appear_after=999, cursor="n-1")
        self.assertIsNone([d for n, d in hub.events if n == "user_message"][0]["message_id"])
        self.assertTrue(ex.work["work_id"].startswith("work-"))


def subprocess_node_write(ws: Path) -> None:
    """用 agent 的写入一侧打开一次任务库（空事务），让旧库补上后来加的列与表。"""
    import subprocess
    schema = library.REPO_ROOT / "agent" / "src" / "lib" / "schema.ts"
    script = f"import('{schema}').then((m) => m.withTaskDatabase(process.argv[1], {{ createIfMissing: false }}, () => undefined))"
    subprocess.run(["node", "--input-type=module", "-e", script, str(ws)], check=True)


class InformShapeTests(unittest.TestCase):
    """回复里的告知交给前端时一律是 {"text", "items"?}：旧会话里的纯文字告知与新的带条目告知都认。"""

    def test_纯文字与带条目的告知都整理成对象_认不出的丢掉(self):
        self.assertEqual(conversation.normalize_informs([
            "旧的一句", {"text": "说到 UC-004", "items": [{"item_id": "UC-004", "revision_no": 2}]}, {"text": "没有条目", "items": []}, 3, {"items": []},
        ]), [{"text": "旧的一句"}, {"text": "说到 UC-004", "items": [{"item_id": "UC-004", "revision_no": 2}]}, {"text": "没有条目"}])
        self.assertEqual(conversation.normalize_informs(None), [])

    def test_从会话还原的回复_告知带条目(self):
        ts = "2026-09-25T01:00:00.000Z"
        informs = [{"text": "材料写明保留 3 天。", "items": [{"item_id": "UC-004", "revision_no": 2}]}, "我没有改动条目。"]
        entries = [
            {"type": "session", "id": "h"},
            {"type": "message", "id": "u1", "parentId": None, "timestamp": ts, "message": {"role": "user", "content": [{"type": "text", "text": "用户说：保留几天？"}]}},
            {"type": "message", "id": "a1", "parentId": "u1", "timestamp": ts, "message": {"role": "assistant", "content": [
                {"type": "toolCall", "id": "c1", "name": "reply", "arguments": {"informs": informs, "act": None, "text": "有，保留 3 天。"}}]}},
            {"type": "message", "id": "r1", "parentId": "a1", "timestamp": ts, "message": {"role": "toolResult", "toolCallId": "c1", "isError": False}},
        ]
        reply = [m for m in conversation.messages(entries, "S") if m["type"] == "assistant_reply"][0]
        self.assertEqual(reply["informs"], [{"text": "材料写明保留 3 天。", "items": [{"item_id": "UC-004", "revision_no": 2}]}, {"text": "我没有改动条目。"}])
