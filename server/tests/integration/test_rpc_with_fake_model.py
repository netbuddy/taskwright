"""RPC 集成测试：真实的 pi 进程，经 RPC 驱动，模型换成按脚本回话的假端点。

每个测试从一个刚创建好的任务开始（任务由用户在界面上创建：试验台经产品的 create_task 建目录、写任务记录），
起自己的假端点（随机端口）与自己的 pi 进程，跑完只对库里的事实、pi 的事件流、
会话文件与假端点记下的请求体做断言，不看对话是否按脚本走。怎样新写一个测试见 server/taskwright_server/fake_model/README.md。

本机没有 pi 或 node 时整组跳过。单跑一个测试：

    python3 -m pytest server/tests/integration -q -k 闲聊
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import check_db
from taskwright_server import create_task as create_task_module
from tests.integration.rig import (DEFINITION_PATH, TASK_OP_ID, Rig, call,
                                               message_texts, tool_results)

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"

SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "买家可以在收货后七天内申请退货。"}

USE_CASE = {"用例名称": "提交退货申请", "用例功能": "买家对已收货的订单提交退货申请。",
            "参与者": ["买家"], "基本流程": ["买家打开订单", "买家填写退货原因", "系统记下申请"]}

NFR = {"类别": "性能", "句式类型": "普遍型", "需求语句": "系统应当在两秒内返回退货申请的受理结果。"}


TASK_STATUS = "taskwright-task-status"


def customs_of(entries: list[dict], custom_type: str) -> list[dict]:
    return [e for e in entries if e.get("type") == "custom_message" and e.get("customType") == custom_type]


def text_of(entry: dict) -> str:
    content = entry.get("content")
    return content if isinstance(content, str) else "".join(p.get("text", "") for p in (content or []))


def reply(text: str) -> dict:
    """假端点脚本里的一次「回复」工具调用。2026-09-21 起执行者对用户说话一律经「回复」工具，
    不经它就停下会被兜底扩展追加一句话要它重说，所以脚本里的每次说话都写成这个调用。"""
    return {"tool_calls": [call("reply", {"informs": [], "act": None, "text": text})]}


def add(collection: str, fields: dict) -> dict:
    return {"op": "add", "collection": collection, "fields": fields, "sources": [SOURCE]}


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class RpcWithFakeModelTests(unittest.TestCase):

    def test_创建任务_经命令行入口_第二次拒绝(self):
        """任务由用户在界面上创建：后端建目录、放起始文件、经 agent 的命令行入口写任务记录，发起方 user。"""
        root = Path(tempfile.mkdtemp(prefix="taskwright-it-create-"))
        try:
            target = root / "task"
            result = create_task_module.create_task(target, name="退货规格", tag="售后", op_id="ui-op-c1")
            self.assertTrue(result["ok"])
            self.assertEqual((result["task_id"], result["task_name"], result["domain_tag"], result["event_seq"]),
                             ("TASK-001", "退货规格", "售后", 1))
            self.assertTrue((target / ".pi" / "settings.json").is_file())
            self.assertTrue((target / DEFINITION_PATH).is_file())
            import sqlite3
            conn = sqlite3.connect(f"file:{target / 'task.sqlite'}?mode=ro", uri=True)
            tasks = conn.execute("SELECT task_id, task_name, domain_tag, session_id, call_id FROM task").fetchall()
            events = conn.execute("SELECT seq, name, call_id, actor FROM event").fetchall()
            conn.close()
            self.assertEqual(tasks, [("TASK-001", "退货规格", "售后", "", "ui-op-c1")])
            self.assertEqual(events, [(1, "TASK_CREATED", "ui-op-c1", "user")])
            # 第二次：后端先拦（目录不是空的）；绕过后端直接调命令行入口，核心函数按一库一任务拒绝。
            with self.assertRaises(create_task_module.CreateTaskError) as caught:
                create_task_module.create_task(target, op_id="ui-op-c2")
            self.assertIn("已经存在而且不是空的", str(caught.exception))
            done = subprocess.run(["node", str(create_task_module.CLI), "--dir", str(target), "--definition",
                                   DEFINITION_PATH, "--op-id", "ui-op-c3"], capture_output=True, text=True)
            self.assertEqual(done.returncode, 1)
            reply = json.loads(done.stdout.strip().splitlines()[-1])
            self.assertFalse(reply["ok"])
            self.assertIn("这个任务目录的库里已经有任务了：任务编号是 TASK-001，任务名是「退货规格」", reply["error"])
            conn = sqlite3.connect(f"file:{target / 'task.sqlite'}?mode=ro", uri=True)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM task").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM event").fetchone()[0], 1)
            conn.close()
            # 写任务记录失败时整个创建失败，目录清掉：用一个不存在的任务类型之外的办法——把 node 入口的参数弄错不好造，
            # 这里用任务定义写坏的模板造一次失败。
            broken_root = root / "broken-template"
            shutil.copytree(create_task_module.new_workspace.FIXTURE_DIR / "srs-authoring", broken_root / "srs-authoring")
            (broken_root / "srs-authoring" / DEFINITION_PATH).write_text("{}", encoding="utf-8")
            saved = create_task_module.new_workspace.FIXTURE_DIR
            create_task_module.new_workspace.FIXTURE_DIR = broken_root
            try:
                with self.assertRaises(create_task_module.CreateTaskError) as caught:
                    create_task_module.create_task(root / "bad", op_id="ui-op-c4")
            finally:
                create_task_module.new_workspace.FIXTURE_DIR = saved
            self.assertIn("任务记录没有写成", str(caught.exception))
            self.assertFalse((root / "bad").exists(), "失败时这次建出来的目录要清掉")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_保存修订成功_一次新增两个条目(self):
        script = [
            {"tool_calls": [call("save_revision", {"operations": [add("功能用例", USE_CASE), add("非功能需求", NFR)]},
                                 "call-save-1")]},
            reply("两个条目都存好了。"),
        ]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            results = [r for r in tool_results(rig.say("把材料整理成需求规格说明。")) if r["工具"] != "reply"]
            items = rig.rows("SELECT item_id, collection, added_in_revision, deleted_in_revision, event_seq FROM item "
                             "ORDER BY item_id")
            contents = rig.rows("SELECT item_id, revision_no, fields FROM item_version ORDER BY item_id")
            sources = rig.rows("SELECT item_id, revision_no, kind, locator, excerpt FROM item_source ORDER BY item_id")
            revisions = rig.rows("SELECT revision_no, call_id, event_seq FROM revision")
            events = rig.rows("SELECT seq, name, call_id, actor FROM event ORDER BY seq")
            checks = check_db.check(rig.workspace)

        self.assertEqual([(r["工具"], r["被拒"]) for r in results], [("save_revision", False)])
        self.assertEqual([(i["item_id"], i["collection"], i["added_in_revision"], i["deleted_in_revision"])
                          for i in items],
                         [("NFR-001", "非功能需求", 1, None), ("UC-001", "功能用例", 1, None)])
        self.assertEqual([(v["item_id"], v["revision_no"]) for v in contents],
                         [("NFR-001", 1), ("UC-001", 1)])
        self.assertEqual(json.loads(contents[1]["fields"])["用例名称"], "提交退货申请")
        self.assertEqual([(s["item_id"], s["revision_no"], s["kind"], s["locator"]) for s in sources],
                         [("NFR-001", 1, "文档原文", "inputs/材料.md"), ("UC-001", 1, "文档原文", "inputs/材料.md")])
        self.assertEqual([(r["revision_no"], r["call_id"]) for r in revisions], [(1, "call-save-1")])
        # 对话理解另记一条 USER_INTENT_RECORDED（执行者这一轮写的理解），它不是交付物的改动，单独核对。
        dialogue = ("USER_INTENT_RECORDED", "USER_INTENT_INVALID", "EXECUTOR_ACTS_RECORDED")
        self.assertEqual([(e["name"], e["call_id"], e["actor"]) for e in events if e["name"] not in dialogue],
                         [("TASK_CREATED", TASK_OP_ID, "user"), ("REVISION_SAVED", "call-save-1", "executor")])
        self.assertEqual([e["name"] for e in events if e["name"] in dialogue], ["USER_INTENT_RECORDED"])
        saved = next(e["seq"] for e in events if e["name"] == "REVISION_SAVED")
        self.assertEqual(revisions[0]["event_seq"], saved)
        self.assertTrue(all(i["event_seq"] == saved for i in items))
        failed = [c for c in checks if not c["通过"]]
        self.assertEqual(failed, [], f"check_db 有不通过的项：{failed}")

    def test_保存修订被拒_理由回到模型_改正后成功(self):
        broken = {k: v for k, v in USE_CASE.items() if k != "基本流程"}
        script = [
            {"tool_calls": [call("save_revision", {"operations": [add("功能用例", broken)]}, "call-save-bad")]},
            {"tool_calls": [call("save_revision", {"operations": [add("功能用例", USE_CASE)]}, "call-save-good")]},
            reply("补上基本流程之后存好了。"),
        ]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            results = [r for r in tool_results(rig.say("把材料整理成需求规格说明。")) if r["工具"] != "reply"]
            revisions = rig.rows("SELECT revision_no, call_id FROM revision")
            items = rig.rows("SELECT item_id FROM item")
            events = rig.rows("SELECT name, call_id FROM event ORDER BY seq")
            requests = rig.requests()

        self.assertEqual([(r["调用编号"], r["被拒"]) for r in results],
                         [("call-save-bad", True), ("call-save-good", False)])
        reason = results[0]["文字"]
        self.assertIn("必填字段「基本流程」没有填", reason)
        # 被拒的那次在库里什么都没留下：没有修订、没有事件用它的调用编号。
        self.assertEqual(revisions, [{"revision_no": 1, "call_id": "call-save-good"}])
        self.assertEqual(items, [{"item_id": "UC-001"}])
        self.assertNotIn("call-save-bad", [e["call_id"] for e in events])
        # 拒绝理由回到了模型：被拒之后的那个请求里，最后一条消息是工具结果，文字就是这段理由。
        role, text = message_texts(requests[1])[-1]
        self.assertEqual(role, "tool")
        self.assertIn("必填字段「基本流程」没有填", text)

    def test_用户直接写入_不经模型(self):
        script = [
            {"tool_calls": [call("save_revision", {"operations": [add("功能用例", USE_CASE)]}, "call-save-1")]},
            reply("存好了一个用例。"),
        ]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            rig.say("把材料整理成需求规格说明。")
            before = len(rig.requests())
            command = {"op_id": "ui-op-1", "kind": "edit_fields", "targets": [{"item_id": "UC-001", "base_revision": 1}],
                       "fields": {"用例名称": "买家提交退货申请"}}
            rig.session.request("prompt", message="/tw-user " + json.dumps(command, ensure_ascii=False))
            result = json.loads(rig.wait_status("taskwright-user-result", 1)[-1])
            contents = rig.rows("SELECT revision_no, fields, event_seq FROM item_version "
                                "WHERE item_id = 'UC-001' ORDER BY revision_no")
            revisions = rig.rows("SELECT revision_no, call_id FROM revision ORDER BY revision_no")
            saved_event, confirmed_event = rig.rows("SELECT seq, name, call_id, actor, payload FROM event ORDER BY seq DESC LIMIT 2")[::-1]
            judged = rig.rows("SELECT j.basis, ji.item_id, ji.revision_no, ji.attitude FROM judgement_item ji "
                              "JOIN judgement j ON j.judgement_id = ji.judgement_id")
            customs = [e for e in rig.session_entries()
                       if e.get("type") == "custom_message" and e.get("customType") == "taskwright-user-edit"]
            after = len(rig.requests())
            raw = rig.raw_events()
            checks = check_db.check(rig.workspace)

        self.assertTrue(result["ok"], result)
        self.assertEqual([v["revision_no"] for v in contents], [1, 2])
        self.assertEqual(json.loads(contents[1]["fields"])["用例名称"], "买家提交退货申请")
        self.assertEqual(revisions[-1], {"revision_no": 2, "call_id": "ui-op-1"})
        self.assertEqual((saved_event["name"], saved_event["call_id"], saved_event["actor"]),
                         ("REVISION_SAVED", "ui-op-1", "user"))
        self.assertEqual(contents[1]["event_seq"], saved_event["seq"])
        # 改字段随修订在同一个事务里自动登记确认：紧跟一条确认事件（依据 ui_edit），明细是改出来的修订 2、接受。
        self.assertEqual((confirmed_event["seq"], confirmed_event["name"], confirmed_event["call_id"], confirmed_event["actor"]),
                         (saved_event["seq"] + 1, "CONFIRMATION_RECORDED", "ui-op-1", "user"))
        self.assertEqual(json.loads(confirmed_event["payload"]),
                         {"items": [{"item_id": "UC-001", "revision_no": 2, "accepted": True}], "basis": "ui_edit"})
        self.assertEqual([(json.loads(j["basis"])[0]["依据"], j["item_id"], j["revision_no"], j["attitude"]) for j in judged],
                         [("界面修改", "UC-001", 2, "接受")])
        self.assertEqual(result["event_seqs"], [saved_event["seq"], confirmed_event["seq"]])
        # 会话里多了一条自定义消息，文字里有操作编号。
        self.assertEqual(len(customs), 1)
        content = customs[0].get("content")
        text = content if isinstance(content, str) else "".join(p.get("text", "") for p in content)
        self.assertIn("用户改了 UC-001 的「用例名称」，产生修订 2，UC-001 现在是修订 2", text)
        self.assertEqual(customs[0]["details"]["op_id"], "ui-op-1")
        # 不经模型：命令前后假端点没有多收到请求，第一次运行结束之后也没有再出现 agent_start。
        self.assertEqual(after, before)
        starts = [i for i, e in enumerate(raw) if e.get("type") == "agent_start"]
        self.assertEqual(len(starts), 1)
        failed = [c for c in checks if not c["通过"]]
        self.assertEqual(failed, [], f"check_db 有不通过的项：{failed}")

    def test_闲聊不写库(self):
        """任务已经存在；闲聊之后交付物没有写，事件表只多了一行执行者对这句话的理解，除了「回复」没有任何工具执行。"""
        script = [reply("今天确实降温了，出门记得多穿一件。")]
        with Rig(script) as rig:
            before = rig.rows("SELECT seq FROM event ORDER BY seq")
            events = rig.say("今天降温了。")
            after = rig.rows("SELECT seq, name, actor FROM event ORDER BY seq")
            requests = rig.requests()

        self.assertEqual([(r["工具"], r["被拒"]) for r in tool_results(events)], [("reply", False)])
        self.assertEqual(len(requests), 1)
        self.assertEqual(before, [{"seq": 1}])
        self.assertEqual(after, [{"seq": 1, "name": "TASK_CREATED", "actor": "user"},
                                 {"seq": 2, "name": "USER_INTENT_RECORDED", "actor": "executor"}])

    def test_打开会话时追加任务现状消息_续接只追加变化(self):
        """新会话：用户第一句话之前会话里有一条任务现状消息，第一次模型请求带着它。
        续接同一条会话：期间没有变化就不追加；期间库里有变化，追加一条「上次之后的变化」。"""
        script = [
            {"tool_calls": [call("save_revision", {"operations": [add("功能用例", USE_CASE)]}, "call-save-1")]},
            reply("存好了。"),
            reply("好的。"),
            reply("看到了。"),
        ]
        with Rig(script) as rig:
            notes_at_open = list(rig.session.system_notes)
            rig.say("把材料整理成需求规格说明。")
            first_request = message_texts(rig.requests()[0])
            entries = rig.session_entries()
            # 续接，期间没有变化：不追加。
            rig.restart(resume=True)
            rig.say("我回来了。")
            after_quiet = customs_of(rig.session_entries(), TASK_STATUS)
            # 用户在界面上直接改了 UC-001（正式的 /tw-user 命令），然后再续接一次。
            command = {"op_id": "ui-op-9", "kind": "edit_fields", "targets": [{"item_id": "UC-001", "base_revision": 1}],
                       "fields": {"用例名称": "买家提交退货申请"}}
            rig.session.request("prompt", message="/tw-user " + json.dumps(command, ensure_ascii=False))
            rig.wait_status("taskwright-user-result", 1)
            # 旁路再写一次（不经这条会话，模拟用户在别处改了条目），才算「上次这条会话结束之后」的变化。
            import time
            time.sleep(0.05)
            subprocess.run(["node", "--input-type=module", "-e",
                            "import { saveRevision } from './agent/src/lib/save_revision.ts';"
                            f"saveRevision({{workspaceDir: {json.dumps(str(rig.workspace))}, sessionId: 'other', callId: 'ui-op-10', actor: 'user'}},"
                            "{operations: [{op: 'add', collection: '约束', fields: {类别: '时限', 句式类型: '普遍型', 需求语句: '系统应当在两秒内受理。'},"
                            " sources: [{kind: '执行者补充', locator: '执行者补充', excerpt: '测试'}]}]});"],
                           cwd=str(Path(create_task_module.REPO_ROOT)), check=True, capture_output=True, text=True)
            rig.restart(resume=True)
            rig.say("再看看。")
            final = rig.session_entries()

        # 新会话：打开时会话类就收到了系统说明事件，是任务现状。
        self.assertEqual([n["custom_type"] for n in notes_at_open], [TASK_STATUS])
        self.assertIn("的任务状况：由扩展写入", notes_at_open[0]["text"])
        self.assertIn("交付物还没有任何条目", notes_at_open[0]["text"])
        # 会话文件里它在用户第一句话前面。
        kinds = [(e["type"], e.get("customType") or (e.get("message") or {}).get("role")) for e in entries
                 if e["type"] in ("message", "custom_message")]
        self.assertEqual(kinds[0], ("custom_message", TASK_STATUS))
        self.assertEqual(kinds[1], ("message", "user"))
        # 第一次模型请求里它以用户角色出现，在用户那句话之前。
        users = [text for role, text in first_request if role == "user"]
        self.assertIn("的任务状况：由扩展写入", users[0])
        self.assertEqual(users[1], "把材料整理成需求规格说明。")
        # 第一次续接：没有变化，没有多出现状消息。
        self.assertEqual(len(after_quiet), 1)
        # 第二次续接：追加一条变化，只报会话之外那次写入（界面上的 ui-op-9 在这条会话里已经有通知）。
        statuses = customs_of(final, TASK_STATUS)
        self.assertEqual(len(statuses), 2)
        change = text_of(statuses[1])
        self.assertIn("看到的、上次之后交付物的变化", change)
        self.assertIn("新增 1 个条目（CON-001）", change)
        self.assertEqual(statuses[1]["details"]["kind"], "变化")


if __name__ == "__main__":
    unittest.main()
