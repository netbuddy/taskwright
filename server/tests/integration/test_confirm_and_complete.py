"""「登记用户确认」与「完成任务」的 RPC 集成测试：真实的 pi 进程，执行者与确认判读者都换成按脚本回话的假端点。

测两件事：
1. 用户在对话里说「这两条可以」之后，执行者调用登记用户确认，判读者判为接受，库里记下判读、逐条明细与模型调用，
   事件的依据是用户的话；
2. 完成任务在完成条件没满足时被拒、逐条列出缺什么；满足之后（评审一条由开发期开关视为满足）任务变为已完成。

判读者的请求靠系统提示里的「你是确认判读者」认出来；它要引用用户原话的会话条目编号，这个编号在请求里才有，
所以用 reply_from 现算回答。断言只看事实：事件流与 task.sqlite 里的行。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import unittest
from unittest import mock

from tests.integration.rig import Rig, call, tool_results

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"

JUDGE_MARK = "你是确认判读者"
AGREE = "这两条可以。"

SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "读者凭借书证在自助机上借书。"}


def use_case(name: str, step: str) -> dict:
    return {"op": "add", "collection": "功能用例", "sources": [SOURCE],
            "fields": {"用例名称": name, "用例功能": f"读者{name}。", "参与者": ["读者"], "基本流程": [step, "系统记下结果"]}}


def reply_call(text: str, call_id: str, act=None) -> dict:
    return call("reply", {"informs": [], "act": act, "text": text}, call_id)


def judge_accepting_all(body: dict) -> dict:
    """判读者：把提示里列出的每个条目都判为接受，依据是「这两条可以。」那句原话。"""
    prompt = "\n".join(m.get("content") if isinstance(m.get("content"), str)
                       else "".join(p.get("text", "") for p in m.get("content") or []) for m in body["messages"])
    message_id = re.search(r"编号 (\S+)（在 [^）]+ 的这一版产生之后说的）：" + re.escape(AGREE), prompt).group(1)
    verdicts = [{"条目": item, "版本": 1, "态度": "接受", "依据": [{"消息": message_id, "摘录": "这两条可以"}],
                 "说明": "用户点名说这两条可以。"} for item in ("UC-001", "UC-002")]
    return {"text": json.dumps({"判读": verdicts}, ensure_ascii=False)}


def judge_rule() -> dict:
    return {"when": {"any_contains": JUDGE_MARK}, "reply_from": judge_accepting_all}


def save_two(call_id: str = "call-save") -> dict:
    return {"tool_calls": [call("save_revision", {"operations": [
        use_case("借书", "读者在自助机上刷借书证"), use_case("还书", "读者把书放进还书口")]}, call_id)]}


CONFIRM_ACT = {"kind": "confirm", "text": "请确认 UC-001 与 UC-002 的第 1 版。",
               "items": [{"item_id": "UC-001", "version_no": 1}, {"item_id": "UC-002", "version_no": 1}]}


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class ConfirmAndCompleteTests(unittest.TestCase):

    def test_对话里说这两条可以之后执行者登记确认(self):
        script = {"rules": [judge_rule()], "sequence": [
            save_two(),
            {"tool_calls": [reply_call("我整理了两个用例，请确认。", "call-ask", CONFIRM_ACT)]},
            {"tool_calls": [call("record_confirmation", {"items": [
                {"item_id": "UC-001", "version_no": 1}, {"item_id": "UC-002", "version_no": 1}]}, "call-confirm")]},
            {"tool_calls": [reply_call("好的，这两条已经登记为你确认了。", "call-done")]},
        ]}
        with Rig(script) as rig:
            rig.say("把材料整理成需求规格说明。")
            events = rig.say(AGREE)
            judgements = rig.rows("SELECT * FROM judgement")
            details = rig.rows("SELECT item_id, version_no, attitude FROM judgement_item ORDER BY item_id")
            calls = rig.rows("SELECT * FROM model_call")
            event = rig.rows("SELECT * FROM event WHERE name = 'CONFIRMATION_RECORDED'")
            judge_requests = [r for r in rig.requests() if JUDGE_MARK in json.dumps(r, ensure_ascii=False)]

        results = {r["调用编号"]: r for r in tool_results(events)}
        self.assertFalse(results["call-confirm"]["被拒"], results["call-confirm"]["文字"])
        self.assertIn("判读者判定用户接受了", results["call-confirm"]["文字"])
        self.assertEqual(len(judge_requests), 1)
        # 判读者看到的是干净上下文：没有工具定义，只有系统提示与一条用户消息。
        self.assertFalse(judge_requests[0].get("tools"))
        self.assertEqual(len(judgements), 1)
        self.assertEqual(judgements[0]["call_id"], "call-confirm")
        self.assertEqual(details, [{"item_id": "UC-001", "version_no": 1, "attitude": "接受"},
                                   {"item_id": "UC-002", "version_no": 1, "attitude": "接受"}])
        self.assertEqual([(c["role"], c["outcome"], c["judgement_id"], c["tool_call_id"]) for c in calls],
                         [("判读者", "采用", judgements[0]["judgement_id"], "call-confirm")])
        self.assertIn(AGREE, calls[0]["prompt"])
        payload = json.loads(event[0]["payload"])
        self.assertEqual(payload["basis"], "user_words")
        self.assertEqual(event[0]["actor"], "executor")

    def test_完成任务条件不满足时被拒_满足后任务变为已完成(self):
        script = {"rules": [judge_rule()], "sequence": [
            save_two(),
            {"tool_calls": [call("complete_task", {}, "call-complete-early")]},
            {"tool_calls": [reply_call("还有两条没有确认，请确认。", "call-ask", CONFIRM_ACT)]},
            {"tool_calls": [call("record_confirmation", {"items": [
                {"item_id": "UC-001", "version_no": 1}, {"item_id": "UC-002", "version_no": 1}]}, "call-confirm")]},
            {"tool_calls": [call("complete_task", {}, "call-complete")]},
            {"tool_calls": [reply_call("任务已经完成。", "call-done")]},
        ]}
        with mock.patch.dict(os.environ, {"TASKWRIGHT_DEV_REVIEW_AS_MET": "1"}):
            with Rig(script) as rig:
                first = rig.say("把材料整理成需求规格说明，整理完就结束任务。")
                status_between = rig.rows("SELECT status FROM task")[0]["status"]
                second = rig.say(AGREE)
                task = rig.rows("SELECT status, ended_at FROM task")[0]
                completed = rig.rows("SELECT * FROM event WHERE name = 'TASK_COMPLETED'")

        early = {r["调用编号"]: r for r in tool_results(first)}["call-complete-early"]
        self.assertTrue(early["被拒"])
        self.assertIn("完成条件还有", early["文字"])
        self.assertIn("UC-001", early["文字"])
        self.assertIn("用户确认", early["文字"])
        self.assertEqual(status_between, "进行中")

        done = {r["调用编号"]: r for r in tool_results(second)}["call-complete"]
        self.assertFalse(done["被拒"], done["文字"])
        self.assertIn("开发期开关", done["文字"])
        self.assertEqual(task["status"], "已完成")
        self.assertIsNotNone(task["ended_at"])
        payload = json.loads(completed[0]["payload"])
        self.assertEqual((payload["status_before"], payload["status_after"]), ("进行中", "已完成"))
        # 另两个集合没有条目，评审一条本来就满足，只有功能用例这一条是开关视为满足的。
        self.assertEqual(payload["waived"], ["「功能用例」每个条目评审通过"])


if __name__ == "__main__":
    unittest.main()
