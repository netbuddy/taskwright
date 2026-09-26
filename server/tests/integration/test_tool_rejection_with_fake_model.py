"""工具拒绝入库的集成测试：假模型端点、真实的 pi 进程加载 agent 扩展。

被工具拒绝的调用在 tool_rejection 表里记一行（工具名、调用编号、工作编号、事实与指引两层），通过的调用不记；
理解门禁的拒绝记 gate。本机没有 pi 或 node 时整组跳过。单跑：python3 -m pytest server/tests/integration -q -k 拒绝入库
"""

from __future__ import annotations

import json
import shutil
import unittest

from tests.integration.rig import Rig, call, tool_results

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"
SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "买家可以申请退货。"}
UC = {"用例名称": "提交退货申请", "用例功能": "买家提交退货申请。", "参与者": ["买家"], "基本流程": ["买家打开订单", "系统记下申请"]}


def save(collection: str, call_id: str) -> dict:
    return call("save_revision", {"operations": [{"op": "add", "collection": collection, "fields": UC, "sources": [SOURCE]}]}, call_id)


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class ToolRejectionWithFakeModelTests(unittest.TestCase):
    def test_拒绝入库_被拒的保存修订与回复各记一行_通过的不记(self):
        script = [
            {"tool_calls": [save("没有这个集合", "call-bad")]},
            {"tool_calls": [save("功能用例", "call-good")]},
            {"tool_calls": [call("reply", {"informs": [], "act": None}, "call-reply-bad")]},
            {"tool_calls": [call("reply", {"informs": [], "act": None, "text": "存好了。"}, "call-reply-good")]},
        ]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            events = rig.say("把材料整理成用例。")
            rows = rig.rows("SELECT * FROM tool_rejection ORDER BY rejection_id")
            entries = rig.session_entries()
            sessions = rig.rows("SELECT DISTINCT session_id FROM event WHERE name = 'REVISION_SAVED'")

        self.assertEqual([(r["调用编号"], r["被拒"]) for r in tool_results(events)],
                         [("call-bad", True), ("call-good", False), ("call-reply-bad", True), ("call-reply-good", False)])
        self.assertEqual([(r["tool_name"], r["call_id"], r["reason_kind"]) for r in rows],
                         [("save_revision", "call-bad", "input"), ("reply", "call-reply-bad", "input")])
        user_entry = next(e["id"] for e in entries if e.get("type") == "message" and e["message"].get("role") == "user")
        self.assertEqual({r["work_id"] for r in rows}, {f"w-{user_entry}"})
        self.assertEqual({r["session_id"] for r in rows}, {sessions[0]["session_id"]})
        self.assertIn("没有名叫「没有这个集合」的集合", rows[0]["fact"])
        self.assertIn("可用的集合是", rows[0]["guidance"])
        self.assertEqual(json.loads(rows[0]["input_excerpt"])["operations"][0]["collection"], "没有这个集合")
        self.assertIn("缺少 text", rows[1]["fact"])

    def test_拒绝入库_没写理解被门禁拒绝记gate(self):
        script = [
            {"tool_calls": [save("功能用例", "call-no-intent")]},
            {"text": "```json\n" + json.dumps({"acts": [{"function": "request", "confidence": "high", "summary": "整理"}]}, ensure_ascii=False)
                     + "\n```", "tool_calls": [call("reply", {"informs": [], "act": None, "text": "好。"}, "call-reply")]},
        ]
        with Rig(script, material=SOURCE["excerpt"], auto_intent=False) as rig:
            rig.say("把材料整理成用例。")
            rows = rig.rows("SELECT tool_name, call_id, reason_kind, fact, guidance FROM tool_rejection")

        self.assertEqual([(r["tool_name"], r["call_id"], r["reason_kind"]) for r in rows], [("save_revision", "call-no-intent", "gate")])
        self.assertIn("这一轮还没有写理解", rows[0]["fact"])
        self.assertIn("写完接着调用 save_revision", rows[0]["guidance"])

    def test_拒绝入库_给建议值的依据摘录对不上材料_整条回复被拒_改对后送达(self):
        suggest = lambda excerpt: {"informs": [], "text": "建议如上。", "act": {
            "kind": "suggest", "text": "退货建议写成买家可以申请。", "value": "买家可以申请退货", "scope": "general",
            "basis": [{"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": excerpt}]}}
        script = [
            {"tool_calls": [call("reply", suggest("买家随时可以申请退货。"), "call-suggest-bad")]},
            {"tool_calls": [call("reply", suggest("买家可以申请退货。"), "call-suggest-good")]},
        ]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            events = rig.say("退货怎么写？")
            rows = rig.rows("SELECT call_id, fact, guidance FROM tool_rejection")

        results = [(r["调用编号"], r["被拒"]) for r in tool_results(events)]
        self.assertEqual(results, [("call-suggest-bad", True), ("call-suggest-good", False)])
        self.assertEqual([r["call_id"] for r in rows], ["call-suggest-bad"])
        self.assertIn("act.basis 的第 1 条的摘录「买家随时可以申请退货。」在 材料.md 里找不到", rows[0]["fact"])
        self.assertIn("摘录必须与材料原文逐字一致", rows[0]["guidance"])

