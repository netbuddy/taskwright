"""已读即确认与「完成任务」的 RPC 集成测试：真实的 pi 进程，执行者换成按脚本回话的假端点。

测三件事：
1. 登记用户确认工具已经退役：执行者调用它，pi 回「工具不存在」，库里不多任何确认标记；
2. 用户打开条目详情（正式的 /tw-user 命令，kind 为 mark_viewed）就在条目当前修订上记为已读，事件是 ITEM_VIEWED；
   同一条目同一修订再打开一次不再写；
3. 完成任务在还有未读、待评审的条目时被拒，拒绝文字写「还有 N 条你从没看过：……」与「……还没评审」；
   用户打开看过、在界面上发起评审（假端点替评审者回「没有发现」）之后，任务变为已完成。

断言只看事实：事件流、状态栏回传与 task.sqlite 里的行。
"""

from __future__ import annotations

import json
import shutil
import time
import unittest

from tests.integration.rig import Rig, call, tool_results

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"

SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "读者凭借书证在自助机上借书。"}


def use_case(name: str, step: str) -> dict:
    return {"op": "add", "collection": "功能用例", "sources": [SOURCE],
            "fields": {"用例名称": name, "用例功能": f"读者{name}。", "参与者": ["读者"], "基本流程": [step, "系统记下结果"]}}


def reply_call(text: str, call_id: str, act=None) -> dict:
    return call("reply", {"informs": [], "act": act, "text": text}, call_id)


def save_two(call_id: str = "call-save") -> dict:
    return {"tool_calls": [call("save_revision", {"operations": [
        use_case("借书", "读者在自助机上刷借书证"), use_case("还书", "读者把书放进还书口")]}, call_id)]}


def open_detail(rig: Rig, op_id: str, item_id: str, revision: int, count: int) -> dict:
    """用户在界面上打开条目详情：后端发的正是这条 /tw-user 命令。返回状态栏回传的结果。"""
    command = {"op_id": op_id, "kind": "mark_viewed", "targets": [{"item_id": item_id, "base_revision": revision}]}
    rig.session.request("prompt", message="/tw-user " + json.dumps(command, ensure_ascii=False))
    return json.loads(rig.wait_status("taskwright-user-result", count)[-1])


#: 假端点替评审者回答的规则：请求里带评审者的系统提示就回一个没有发现的结果，不占执行者的 sequence。
REVIEWER_PASSES = {"when": {"any_contains": "你是评审者"}, "reply": {"text": json.dumps({"发现": []}, ensure_ascii=False)}}


def request_review(rig: Rig, op_id: str, count: int, targets=None) -> dict:
    """用户在界面上点「评审」：后端发的正是这条 /tw-user 命令。返回状态栏回传的结果（核对通过就回，不等评审跑完）。"""
    command = {"op_id": op_id, "kind": "request_review", "targets": targets or []}
    rig.session.request("prompt", message="/tw-user " + json.dumps(command, ensure_ascii=False))
    return json.loads(rig.wait_status("taskwright-user-result", count)[-1])


def wait_review_finished(rig: Rig, op_id: str, timeout: float = 20.0) -> dict:
    """等这批评审记下 REVIEW_FINISHED，返回它的 payload。"""
    end = time.time() + timeout
    while time.time() < end:
        rows = rig.rows("SELECT payload FROM event WHERE name = 'REVIEW_FINISHED' AND call_id = ?", op_id)
        if rows:
            return json.loads(rows[0]["payload"])
        time.sleep(0.05)
    raise TimeoutError(f"等了 {timeout:.0f} 秒，评审 {op_id} 还没有记下 REVIEW_FINISHED。")


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class ConfirmAndCompleteTests(unittest.TestCase):

    def test_登记用户确认工具已退役_调用它得到工具不存在(self):
        script = [
            save_two(),
            {"tool_calls": [call("record_confirmation", {"items": [{"item_id": "UC-001", "revision_no": 1}]}, "call-retired")]},
            {"tool_calls": [reply_call("我整理了两个用例，你打开看一眼就行。", "call-done")]},
        ]
        with Rig(script) as rig:
            events = rig.say("把材料整理成需求规格说明。")
            marks = rig.rows("SELECT * FROM judgement")
            calls = rig.rows("SELECT * FROM model_call")

        results = {r["调用编号"]: r for r in tool_results(events)}
        self.assertTrue(results["call-retired"]["被拒"])
        self.assertEqual(results["call-retired"]["文字"], "Tool record_confirmation not found")
        self.assertEqual(marks, [])
        self.assertEqual(calls, [])

    def test_打开详情记为已读_幂等_不追加会话说明(self):
        script = [save_two(), {"tool_calls": [reply_call("整理好了两个用例。", "call-done")]}]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            rig.say("把材料整理成需求规格说明。")
            before = len(rig.requests())
            first = open_detail(rig, "ui-op-v1", "UC-001", 1, 1)
            again = open_detail(rig, "ui-op-v2", "UC-001", 1, 2)
            viewed = rig.rows("SELECT name, actor, call_id, payload FROM event WHERE name = 'ITEM_VIEWED'")
            marks = rig.rows("SELECT j.basis, ji.item_id, ji.revision_no, ji.attitude FROM judgement_item ji "
                             "JOIN judgement j ON j.judgement_id = ji.judgement_id")
            customs = [e for e in rig.session_entries()
                       if e.get("type") == "custom_message" and e.get("customType") == "taskwright-user-edit"]
            after = len(rig.requests())

        self.assertTrue(first["ok"], first)
        self.assertEqual(len(first["event_seqs"]), 1)
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["event_seqs"], [], "同一条目同一修订再打开一次不再写")
        self.assertEqual([(v["name"], v["actor"], v["call_id"]) for v in viewed], [("ITEM_VIEWED", "user", "ui-op-v1")])
        self.assertEqual(json.loads(viewed[0]["payload"]), {"items": [{"item_id": "UC-001", "revision_no": 1}], "basis": "viewed"})
        self.assertEqual([(json.loads(m["basis"]), m["item_id"], m["revision_no"], m["attitude"]) for m in marks],
                         [([{"依据": "已读", "操作编号": "ui-op-v1"}], "UC-001", 1, "接受")])
        self.assertEqual(customs, [], "打开详情写已读不往会话里追加说明")
        self.assertEqual(after, before, "写已读不引出模型请求")

    def test_还有未读与待评审时完成被拒_看过并评审之后任务变为已完成(self):
        script = {"rules": [REVIEWER_PASSES], "sequence": [
            save_two(),
            {"tool_calls": [call("complete_task", {}, "call-complete-early")]},
            {"tool_calls": [reply_call("还有两条你没看过，也还没评审。", "call-ask")]},
            {"tool_calls": [call("complete_task", {}, "call-complete")]},
            {"tool_calls": [reply_call("任务已经完成。", "call-done")]},
        ]}
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            first = rig.say("把材料整理成需求规格说明，整理完就结束任务。")
            status_between = rig.rows("SELECT status FROM task")[0]["status"]
            open_detail(rig, "ui-op-a", "UC-001", 1, 1)
            open_detail(rig, "ui-op-b", "UC-002", 1, 2)
            accepted = request_review(rig, "ui-op-review", 3)
            finished = wait_review_finished(rig, "ui-op-review")
            second = rig.say("都看过了，完成吧。")
            task = rig.rows("SELECT status, ended_at FROM task")[0]
            completed = rig.rows("SELECT * FROM event WHERE name = 'TASK_COMPLETED'")

        early = {r["调用编号"]: r for r in tool_results(first)}["call-complete-early"]
        self.assertTrue(early["被拒"])
        self.assertIn("还有 2 条你从没看过：UC-001「借书」、UC-002「还书」。", early["文字"])
        self.assertIn("UC-001、UC-002 还没评审。", early["文字"])
        self.assertEqual(status_between, "进行中")

        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(accepted["results"], [{"item_id": "UC-001", "revision_no": 1}, {"item_id": "UC-002", "revision_no": 1}])
        self.assertEqual((finished["total"], finished["passed"], finished["failed"], finished["unfinished"]), (2, 2, 0, 0))

        done = {r["调用编号"]: r for r in tool_results(second)}["call-complete"]
        self.assertFalse(done["被拒"], done["文字"])
        self.assertEqual(task["status"], "已完成")
        self.assertIsNotNone(task["ended_at"])
        payload = json.loads(completed[0]["payload"])
        self.assertEqual(payload, {"status_before": "进行中", "status_after": "已完成"})


if __name__ == "__main__":
    unittest.main()
