"""评审门禁的 RPC 集成测试：真实的 pi 进程，执行者与评审者都换成按脚本回话的假端点。

测两件事：
1. 执行者调用请求评审工具（用户在对话里要求评审时）：工具已经登记，评审者拿到的是带编号的规则清单，
   发现引用必选规则时结论是不合规，库里的发现带规则编号与级别，工具结果写「不合规（问题 1 处，建议 0 条）」；
2. 用户在界面上发起评审：/tw-user 立即回报，评完之后会话里追加一条界面操作通知，正文是一句结论（逐条发现经查询任务状态取）。

断言只看事实：事件流、状态栏回传、会话文件与 task.sqlite 里的行。
"""

from __future__ import annotations

import json
import shutil
import time
import unittest

from tests.integration.rig import Rig, call, tool_results
from tests.integration.test_confirm_and_complete import NEEDS, SOURCE, reply_call, request_review, save_two, wait_review_finished

#: 评审者的一条发现：引用功能用例的必选规则 UC-R7（基本流程每一步写明谁做了什么）。
UC_R7 = {"规则": "UC-R7", "字段": "基本流程", "序号": 2, "问题": "第 2 步「系统记下结果」没有写明记下什么。", "建议": "写明系统记下的是哪一项借阅记录。"}
REVIEWER_FINDS = {"when": {"any_contains": "你是评审者"}, "reply": {"text": json.dumps({"发现": [UC_R7]}, ensure_ascii=False)}}


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class ReviewGateTests(unittest.TestCase):

    def test_执行者调用请求评审_发现带规则编号_必选规则的发现即不合规(self):
        script = {"rules": [REVIEWER_FINDS], "sequence": [
            save_two(),
            {"tool_calls": [call("request_review", {"items": [{"item_id": "UC-001", "revision_no": 1}]}, "call-review")]},
            {"tool_calls": [reply_call("UC-001 评审不通过，有一处问题。", "call-done")]},
        ]}
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            events = rig.say("把材料整理成需求规格说明，然后评审一下 UC-001。")
            findings = rig.rows("SELECT r.item_id, r.verdict, f.rule_id, f.level, f.field, f.item_index FROM review r "
                                "JOIN review_finding f ON f.review_id = r.review_id")
            prompts = [r for r in rig.requests() if "你是评审者" in json.dumps(r, ensure_ascii=False)]

        result = {r["调用编号"]: r for r in tool_results(events)}["call-review"]
        self.assertFalse(result["被拒"], result["文字"])
        self.assertIn("UC-001（修订 1）：不合规（问题 1 处，建议 0 条）。", result["文字"])
        self.assertIn("【问题 UC-R7】基本流程第 2 项", result["文字"])
        self.assertEqual(findings, [{"item_id": "UC-001", "verdict": "不合规", "rule_id": "UC-R7", "level": "必选", "field": "基本流程", "item_index": 1}])
        self.assertEqual(len(prompts), 1)
        self.assertIn("- UC-R7（必选）基本流程每一步写明谁做了什么", json.dumps(prompts[0], ensure_ascii=False))

    def test_界面发起评审_立即回报_评完往会话里追加结果(self):
        script = {"rules": [REVIEWER_FINDS], "sequence": [save_two(), {"tool_calls": [reply_call("整理好了两个用例。", "call-done")]}]}
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            rig.say("把材料整理成需求规格说明。")
            accepted = request_review(rig, "ui-op-review", 1)
            finished = wait_review_finished(rig, "ui-op-review")
            notes = []
            for _ in range(100):
                notes = [e for e in rig.session_entries() if e.get("type") == "custom_message"
                         and e.get("customType") == "taskwright-user-edit" and (e.get("details") or {}).get("kind") == "request_review"]
                if notes:
                    break
                time.sleep(0.05)
            progress = rig.rows("SELECT payload FROM event WHERE name = 'REVIEW_PROGRESS' ORDER BY seq")

        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual((finished["total"], finished["failed"]), (2, 2))
        self.assertEqual([json.loads(p["payload"])["done"] for p in progress], [0, 1, 2])
        self.assertEqual(len(notes), 1)
        text = notes[0]["content"] if isinstance(notes[0]["content"], str) else "".join(p.get("text", "") for p in notes[0]["content"])
        self.assertEqual(text, "界面操作（不是用户打的字）：用户在界面上发起的评审结束了。评审完成：0 条合规、2 条不合规（问题 2 处、建议 0 条）。"
                               "各条发现可以用查询任务状态查看。")


if __name__ == "__main__":
    unittest.main()
