"""对话理解的集成测试：假模型端点、真实的 pi 进程加载 agent 扩展，关掉假端点的自动补理解（auto_intent=False），
由脚本自己写执行者这一轮的理解。

几件事：一轮里先写理解、再调用工具的完整路径；理解写错被拒之后重写；先调工具、理解写在后面也认；
一轮结束时没有合格的理解记一条失败；卡片点击合成的那句话不需要理解。
本机没有 pi 或 node 时整组跳过。单跑：python3 -m pytest server/tests/integration -q -k 理解
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import unittest

from tests.integration.rig import Rig, call, tool_results
from tests.integration.service_rig import ServiceRig

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"
SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "买家可以申请退货。"}
UC = {"用例名称": "提交退货申请", "用例功能": "买家提交退货申请。", "参与者": ["买家"], "基本流程": ["买家打开订单", "系统记下申请"]}
GATE = "先按 schema 写下你对用户这句话的理解"


def understanding(*acts: dict) -> str:
    return "```json\n" + json.dumps({"acts": list(acts)}, ensure_ascii=False) + "\n```"


REQUEST = {"function": "request", "confidence": "high", "summary": "把材料整理成用例"}


def save_uc(call_id: str) -> dict:
    return call("save_revision", {"operations": [{"op": "add", "collection": "功能用例", "fields": UC, "sources": [SOURCE]}]}, call_id)


def reply(text: str, call_id: str | None = None, act: dict | None = None) -> dict:
    return call("reply", {"informs": [], "act": act, "text": text}, call_id)


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class IntentWithFakeModelTests(unittest.TestCase):
    def test_理解_一轮先写理解再调用工具_理解入表修订带编号回复记下执行者行为(self):
        script = [
            {"text": understanding(REQUEST), "tool_calls": [save_uc("call-save")]},
            {"tool_calls": [call("reply", {"informs": ["我新增了 UC-001。"], "text": "我新增了 UC-001。退款由谁审批？",
                                           "act": {"kind": "ask", "text": "退款由谁审批？", "scope": "general"}}, "call-reply")]},
        ]
        with Rig(script, material=SOURCE["excerpt"], auto_intent=False) as rig:
            events = rig.say("把材料整理成用例。")
            acts = rig.rows("SELECT act_id, speaker, function, origin, source_entry, expects_response FROM dialogue_act ORDER BY rowid")
            revisions = rig.rows("SELECT revision_no, intent_act_id FROM revision")
            names = [r["name"] for r in rig.rows("SELECT name FROM event ORDER BY seq")]
            entries = rig.session_entries()
            requests = rig.requests()

        self.assertEqual([(r["工具"], r["被拒"]) for r in tool_results(events)], [("save_revision", False), ("reply", False)])
        self.assertEqual(len(requests), 2, "理解与工具调用在同一次回应里，不多一次模型请求")
        user_entry = next(e["id"] for e in entries if e.get("type") == "message" and e["message"].get("role") == "user")
        self.assertEqual([(a["act_id"], a["speaker"], a["function"], a["origin"]) for a in acts],
                         [("r1-1", "user", "request", "understanding"), ("r1-2", "executor", "inform", "reply"),
                          ("r1-3", "executor", "ask", "reply")])
        self.assertEqual(acts[0]["source_entry"], user_entry)
        self.assertEqual([a["expects_response"] for a in acts], [0, 0, 1])
        self.assertEqual(revisions, [{"revision_no": 1, "intent_act_id": "r1-1"}])
        self.assertEqual(names, ["TASK_CREATED", "USER_INTENT_RECORDED", "REVISION_SAVED", "EXECUTOR_ACTS_RECORDED"])
        # 回复的返回里写着记下的编号，执行者下一轮据此填 responds_to。
        result = next(r for r in tool_results(events) if r["工具"] == "reply")
        self.assertIn("本轮记了 r1-2（告知：我新增了 UC-001。）、r1-3（提问：退款由谁审批？）", result["文字"])

    def test_理解_写错被拒_理由附解析失败原因_重写之后通过(self):
        script = [
            {"text": understanding({"function": "agree", "confidence": "high", "summary": "整理"}), "tool_calls": [save_uc("call-save-1")]},
            {"text": understanding(REQUEST), "tool_calls": [save_uc("call-save-2")]},
            {"tool_calls": [reply("存好了。", "call-reply")]},
        ]
        with Rig(script, material=SOURCE["excerpt"], auto_intent=False) as rig:
            events = rig.say("把材料整理成用例。")
            invalid = rig.rows("SELECT payload FROM event WHERE name = 'USER_INTENT_INVALID'")
            unmatched = rig.rows("SELECT payload FROM event WHERE name = 'STRUCTURED_OUTPUT_UNMATCHED'")
            missing = rig.rows("SELECT payload FROM event WHERE name = 'USER_INTENT_MISSING'")
            acts = rig.rows("SELECT act_id, function FROM dialogue_act WHERE speaker = 'user'")
            revisions = rig.rows("SELECT revision_no, call_id, intent_act_id FROM revision")

        results = {r["调用编号"]: r for r in tool_results(events)}
        self.assertTrue(results["call-save-1"]["被拒"])
        self.assertIn(GATE, results["call-save-1"]["文字"])
        self.assertIn('function 写的是 "agree"', results["call-save-1"]["文字"], "拒绝理由附上解析失败的原因")
        self.assertFalse(results["call-save-2"]["被拒"])
        self.assertFalse(results["call-reply"]["被拒"])
        # schema 不对的那一份不是无效记录，是没匹配上的片段（诊断，不算失败）；重写之后这一轮有了理解，不记失败。
        self.assertEqual(invalid, [])
        self.assertEqual(len(unmatched), 1)
        fragment = json.loads(unmatched[0]["payload"])["fragments"][0]
        self.assertEqual(fragment["nature"], "unmatched")
        self.assertIn('function 写的是 "agree"', " ".join(fragment["errors"]["user_intent"]))
        self.assertEqual(missing, [])
        self.assertEqual(acts, [{"act_id": "r1-1", "function": "request"}])
        self.assertEqual(revisions, [{"revision_no": 1, "call_id": "call-save-2", "intent_act_id": "r1-1"}])

    def test_理解_没写理解就调回复被拒_只有查看类工具不拦(self):
        script = [
            {"tool_calls": [call("get_task_status", {}, "call-status")]},
            {"tool_calls": [reply("没什么。", "call-reply-1")]},
            {"text": understanding({"function": "other", "confidence": "high", "summary": "寒暄"}), "tool_calls": [reply("没什么。", "call-reply-2")]},
        ]
        with Rig(script, auto_intent=False) as rig:
            events = rig.say("你好。")
        results = {r["调用编号"]: r for r in tool_results(events)}
        self.assertFalse(results["call-status"]["被拒"])
        self.assertTrue(results["call-reply-1"]["被拒"])
        self.assertIn(GATE, results["call-reply-1"]["文字"])
        self.assertFalse(results["call-reply-2"]["被拒"])

    def test_理解_第一步先读文件_理解写在后面的消息里_不记失败(self):
        script = [
            {"tool_calls": [call("get_task_status", {}, "call-status")]},
            {"text": "看过任务状态了。\n" + json.dumps({"acts": [REQUEST]}, ensure_ascii=False), "tool_calls": [save_uc("call-save")]},
            {"tool_calls": [reply("存好了。", "call-reply")]},
        ]
        with Rig(script, material=SOURCE["excerpt"], auto_intent=False) as rig:
            events = rig.say("把材料整理成用例。")
            names = [r["name"] for r in rig.rows("SELECT name FROM event ORDER BY seq")]
        results = {r["调用编号"]: r for r in tool_results(events)}
        self.assertFalse(results["call-save"]["被拒"])
        self.assertFalse(results["call-reply"]["被拒"])
        # 第一步只调工具、没写理解，不记任何对话事件；「回复」只有成文的话，没有告知与主行为，不记执行者行为。
        self.assertEqual(names, ["TASK_CREATED", "USER_INTENT_RECORDED", "REVISION_SAVED"])

    def test_理解_一轮结束时没有合格的理解_记一条失败(self):
        script = [
            {"text": '{"path": "inputs/材料.md"}', "tool_calls": [call("get_task_status", {}, "call-status")]},
            {"text": "好的。"},
            {"text": "好的。"},
            {"text": "好的。"},
        ]
        with Rig(script, auto_intent=False) as rig:
            rig.say("你好。")
            missing = rig.rows("SELECT payload FROM event WHERE name = 'USER_INTENT_MISSING'")
            unmatched = rig.rows("SELECT payload FROM event WHERE name = 'STRUCTURED_OUTPUT_UNMATCHED'")
        self.assertEqual(len(missing), 1, "兜底续跑两次之后才算这一轮结束，只记一次")
        payload = json.loads(missing[0]["payload"])
        self.assertEqual(payload["reason"], "这一轮结束时没有合格的理解")
        self.assertIn("缺少 acts", payload["nearest"][0])
        self.assertEqual(len(unmatched), 1)

    def test_理解_卡片点击合成的话不需要理解_按点击记一条告知回应那张卡片(self):
        choose = {"tool_calls": [call("reply", {"informs": [], "text": "逾期的读者能不能续借？", "act": {
            "kind": "choose", "text": "逾期的读者能不能续借？", "items": [{"item_id": "UC-001", "revision_no": 1}],
            "options": [{"key": "allow", "text": "允许续借"}, {"key": "deny", "text": "不允许续借"}]}})]}
        script = [{"text": understanding(REQUEST), "tool_calls": [save_uc("call-save")]}, choose,
                  {"tool_calls": [reply("记下了，逾期的读者不能续借。", "call-reply-after-click")]}]
        with ServiceRig(script, auto_intent=False) as rig:
            tid = rig.new_task(material=SOURCE["excerpt"])
            stream = rig.stream(tid)
            sid = rig.call("POST", f"/tasks/{tid}/sessions")[1]["session_id"]
            rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {"text": "整理一下，有不清楚的问我", "client_id": "c-1"})
            asked = stream.wait(lambda e: e["event"] == "assistant_reply")["data"]
            stream.wait(lambda e: e["event"] == "work_ended")
            status, _ = rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {
                "text": "我选：不允许续借", "client_id": "k-1", "origin": "card_choice",
                "card": {"reply_message_id": asked["message_id"], "kind": "choose", "choice": "deny"}})
            self.assertEqual(status, 200)
            second = stream.wait(lambda e: e["event"] == "assistant_reply" and e["data"]["message_id"] != asked["message_id"], 30)["data"]
            conn = sqlite3.connect(f"file:{rig.service.task(tid).dir / 'task.sqlite'}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            acts = [dict(r) for r in conn.execute("SELECT act_id, speaker, function, origin, responds_to, targets, summary FROM dialogue_act ORDER BY rowid")]
            invalid = conn.execute("SELECT COUNT(*) FROM event WHERE name = 'USER_INTENT_INVALID'").fetchone()[0]
            conn.close()

        self.assertEqual(second["text"], "记下了，逾期的读者不能续借。", "点击之后执行者没写理解，回复照样送达")
        self.assertEqual(invalid, 0)
        choose_act = next(a for a in acts if a["function"] == "choose")
        click = next(a for a in acts if a["origin"] == "ui")
        self.assertEqual((click["act_id"], click["speaker"], click["function"], click["responds_to"]),
                         ("r2-1", "user", "inform", choose_act["act_id"]))
        self.assertEqual(json.loads(click["targets"]), [{"item_id": "UC-001"}])
        self.assertIn("不允许续借", click["summary"])


if __name__ == "__main__":
    unittest.main()
