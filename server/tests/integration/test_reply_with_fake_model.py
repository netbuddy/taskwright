"""「回复」工具与 agent_end 兜底的 RPC 集成测试：真实的 pi 进程，模型换成按脚本回话的假端点。

测的是四件事：合格的回复之后 pi 不再请求模型；同一轮混入别的工具调用时回复被拒、模型单独重发后通过；
模型直接输出正文时兜底扩展追加一句话、模型第二次经回复说话；连续兜底两次仍不合格就不再追加。
另外核对「请确认」按真实的库核对条目与修订号。断言只看事实：事件流、会话文件、假端点记下的请求体。
"""

from __future__ import annotations

import json
import shutil
import unittest

from tests.integration.rig import Rig, call, message_texts, tool_results

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"

FALLBACK_TEXT = "请用 reply 工具把要对用户说的话发出来"
FALLBACK_STATUS = "taskwright-reply-fallback"

SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "买家可以在收货后七天内申请退货。"}
USE_CASE = {"用例名称": "提交退货申请", "用例功能": "买家对已收货的订单提交退货申请。",
            "参与者": ["买家"], "基本流程": ["买家打开订单", "买家填写退货原因", "系统记下申请"]}


def reply_call(text: str, act=None, informs=None, call_id: str | None = None) -> dict:
    return call("reply", {"informs": informs or [], "act": act, "text": text}, call_id)


def types(events: list[dict]) -> list[str]:
    return [e.get("type") for e in events]


def tool_end(events: list[dict], call_id: str) -> dict:
    return next(e for e in events if e.get("type") == "tool_execution_end" and e.get("toolCallId") == call_id)


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class ReplyWithFakeModelTests(unittest.TestCase):

    def test_合格的回复之后不再请求模型(self):
        act = {"kind": "ask", "text": "退款由谁审批？", "scope": "general"}  # 库里还没有条目，所以写 scope
        script = [{"tool_calls": [reply_call("材料我看过了。退款由谁审批？", act, ["材料我看过了。"], "call-reply")]}]
        with Rig(script) as rig:
            events = rig.say("帮我看看材料。")
            requests = rig.requests()
            entries = rig.session_entries()

        self.assertEqual(len(requests), 1)
        end = tool_end(events, "call-reply")
        self.assertFalse(end.get("isError"))
        result = end["result"]
        self.assertIs(result.get("terminate"), True)
        details = result["details"]
        self.assertIs(details["delivered"], True)
        # 回复把告知与向用户要的回应记进对话行为表：event_seq 是那条 EXECUTOR_ACTS_RECORDED 事件的序号，编号写在 acts 里。
        self.assertIsNotNone(details["event_seq"])
        self.assertEqual([(a["act_id"], a["function"], a["expects_response"]) for a in details["acts"]],
                         [("r1-2", "inform", False), ("r1-3", "ask", True)])
        # 告知在送达的回复里整理成 { text, items }；这里模型写的是旧写法的一句纯文字，没有 items。
        self.assertEqual(details["reply"], {"informs": [{"text": "材料我看过了。"}], "act": act, "text": "材料我看过了。退款由谁审批？"})
        # message_id 就是会话文件里带这次调用的那条助手消息的条目编号。
        holder = next(e for e in entries if e.get("type") == "message" and e["message"].get("role") == "assistant"
                      and any(p.get("id") == "call-reply" for p in e["message"].get("content") or []))
        self.assertEqual(details["message_id"], holder["id"])
        # 这一句话只有一轮：turn_end 之后直接是 agent_end，没有第二个 turn_start。
        self.assertEqual(types(events).count("turn_start"), 1)

    def test_混入别的工具调用被拒_单独重发后通过(self):
        script = [
            {"tool_calls": [call("ls", {"path": "docs"}, "call-ls"), reply_call("我看了目录。", call_id="call-reply-1")]},
            {"tool_calls": [reply_call("我看了目录，里面有任务定义与领域规矩。", call_id="call-reply-2")]},
        ]
        with Rig(script) as rig:
            events = rig.say("目录里有什么？")
            requests = rig.requests()

        results = {r["调用编号"]: r for r in tool_results(events)}
        self.assertFalse(results["call-ls"]["被拒"])
        self.assertTrue(results["call-reply-1"]["被拒"])
        self.assertIn("回复必须单独调用，不能与其他工具同一轮", results["call-reply-1"]["文字"])
        self.assertIn("ls", results["call-reply-1"]["文字"])
        self.assertFalse(results["call-reply-2"]["被拒"])
        self.assertIs(tool_end(events, "call-reply-2")["result"].get("terminate"), True)
        # 被拒之后正好再请求了一次模型，拒绝理由在那个请求里交还给了模型。
        self.assertEqual(len(requests), 2)
        tool_texts = [text for role, text in message_texts(requests[1]) if role == "tool"]
        self.assertTrue(any("回复必须单独调用" in text for text in tool_texts))

    def test_直接输出正文时兜底_第二次经回复说话(self):
        script = [
            {"text": "材料里一共有三个流程。"},
            {"tool_calls": [reply_call("材料里一共有三个流程。", call_id="call-reply")]},
        ]
        with Rig(script) as rig:
            events = rig.say("材料里有几个流程？")
            requests = rig.requests()
            statuses = [json.loads(s) for s in rig.status_values(FALLBACK_STATUS)]
            raw = [e.get("type") for e in rig.raw_events()]

        self.assertEqual(len(requests), 2)
        role, text = message_texts(requests[1])[-1]
        self.assertEqual((role, text), ("user", FALLBACK_TEXT))
        self.assertFalse(tool_end(events, "call-reply").get("isError"))
        self.assertEqual([s["已兜底次数"] for s in statuses], [1, 1])
        self.assertIn("已追加", statuses[0]["结果"])
        self.assertIn("兜底之后执行者经回复工具说了话", statuses[1]["结果"])
        # 兜底续跑发生在同一句话里：两次低层运行（两个 agent_end），只有最后一个 agent_settled。
        self.assertEqual(raw.count("agent_end"), 2)
        self.assertEqual(raw.count("agent_settled"), 1)
        self.assertLess(max(i for i, t in enumerate(raw) if t == "agent_end"), raw.index("agent_settled"))

    def test_连续兜底两次仍不合格就不再追加(self):
        script = {"default": {"text": "我直接说话。"}}
        with Rig(script) as rig:
            rig.say("你好。")
            requests = rig.requests()
            statuses = [json.loads(s) for s in rig.status_values(FALLBACK_STATUS)]

        self.assertEqual(len(requests), 3)
        self.assertEqual([m for m in message_texts(requests[2]) if m == ("user", FALLBACK_TEXT)],
                         [("user", FALLBACK_TEXT)] * 2)
        self.assertEqual([s["已兜底次数"] for s in statuses], [1, 2, 2])
        self.assertIn("不再追加", statuses[-1]["结果"])

    def test_请确认按库核对条目与修订号(self):
        confirm = lambda item, revision: {"kind": "confirm", "text": f"请确认 {item}（修订 {revision}）。",
                                          "items": [{"item_id": item, "revision_no": revision}]}
        script = [
            {"tool_calls": [call("save_revision", {"operations": [
                {"op": "add", "collection": "功能用例", "fields": USE_CASE, "sources": [SOURCE]}]}, "call-save")]},
            {"tool_calls": [reply_call("请确认。", confirm("UC-001", 2), call_id="call-bad-version")]},
            {"tool_calls": [reply_call("请确认。", confirm("UC-009", 1), call_id="call-bad-item")]},
            {"tool_calls": [reply_call("我存了一个用例，请确认。", confirm("UC-001", 1), call_id="call-good")]},
        ]
        with Rig(script, material=SOURCE["excerpt"]) as rig:
            events = rig.say("把材料整理成需求规格说明。")

        results = {r["调用编号"]: r for r in tool_results(events)}
        self.assertFalse(results["call-save"]["被拒"])
        self.assertIn("条目 UC-001 现在不是修订 2", results["call-bad-version"]["文字"])
        self.assertIn("库里没有条目 UC-009", results["call-bad-item"]["文字"])
        self.assertFalse(results["call-good"]["被拒"])
        self.assertEqual(tool_end(events, "call-good")["result"]["details"]["reply"]["act"]["items"],
                         [{"item_id": "UC-001", "revision_no": 1}])


if __name__ == "__main__":
    unittest.main()
