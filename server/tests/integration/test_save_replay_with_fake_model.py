"""保存修订按调用编号判重的集成测试：假模型端点、真实的 pi 进程加载 agent 扩展。

假模型连着两轮发出同一个调用编号的「保存修订」（模仿模型重试或 pi 重发），库里只形成一次修订，
第二次的工具结果是第一次的结果文字加一句「之前已经保存过」。本机没有 pi 或 node 时整组跳过。
单跑：python3 -m pytest server/tests/integration -q -k 判重
"""

from __future__ import annotations

import shutil
import unittest

from tests.integration.rig import Rig, call, tool_results

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"
SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "买家可以申请退货。"}
UC = {"用例名称": "提交退货申请", "用例功能": "买家提交退货申请。", "参与者": ["买家"], "基本流程": ["买家打开订单", "系统记下申请"]}
SAVE = {"operations": [{"op": "add", "collection": "功能用例", "fields": UC, "sources": [SOURCE]}]}


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class SaveReplayWithFakeModelTests(unittest.TestCase):
    def test_判重_同一调用编号的保存修订第二次不写入_交回第一次的结果(self):
        script = [
            {"tool_calls": [call("save_revision", SAVE, "call-replayed")]},
            {"tool_calls": [call("save_revision", SAVE, "call-replayed")]},
            {"tool_calls": [call("reply", {"informs": [], "act": None, "text": "存好了。"}, "call-reply")]},
        ]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            events = rig.say("把材料整理成用例。")
            revisions = rig.rows("SELECT revision_no, call_id FROM revision")
            items = rig.rows("SELECT item_id FROM item")
            saved_events = rig.rows("SELECT seq FROM event WHERE name = 'REVISION_SAVED'")

        results = [r for r in tool_results(events) if r["工具"] == "save_revision"]
        self.assertEqual([r["被拒"] for r in results], [False, False])
        self.assertEqual(results[1]["文字"], results[0]["文字"] + "\n这次调用之前已经保存过，没有重复写入。")
        self.assertEqual(revisions, [{"revision_no": 1, "call_id": "call-replayed"}])
        self.assertEqual(items, [{"item_id": "UC-001"}])
        self.assertEqual(len(saved_events), 1)
