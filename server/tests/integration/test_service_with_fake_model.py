"""任务服务的集成测试：进程内的服务、假模型端点、真实的 pi 进程，经 HTTP 与 SSE 像前端那样调用。

本机没有 pi 或 node 时整组跳过。单跑一个：python3 -m pytest server/tests/integration -q -k 服务
"""

from __future__ import annotations

import shutil
import time
import unittest

from tests.integration.rig import call
from tests.integration.service_rig import ServiceRig

NEEDS = "本机找不到 pi 或 node，跑不了集成测试"
SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "买家可以申请退货。"}
UC = {"用例名称": "提交退货申请", "用例功能": "买家提交退货申请。", "参与者": ["买家"], "基本流程": ["买家打开订单", "系统记下申请"]}


def reply(text: str, delay: float = 0) -> dict:
    one = {"tool_calls": [call("reply", {"informs": [], "act": None, "text": text})]}
    if delay:
        one["delay"] = delay
    return one


def save_uc(delay: float = 0) -> dict:
    one = {"tool_calls": [call("save_revision", {"operations": [{"op": "add", "collection": "功能用例", "fields": UC, "sources": [SOURCE]}]})]}
    if delay:
        one["delay"] = delay
    return one


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), NEEDS)
class ServiceTests(unittest.TestCase):

    def test_服务_打开会话收到系统说明_说话收到带编号的用户消息与回复(self):
        with ServiceRig([save_uc(), reply("存好了。")]) as rig:
            tid = rig.new_task()
            stream = rig.stream(tid)
            status, body = rig.call("POST", f"/tasks/{tid}/sessions")
            self.assertEqual(status, 200)
            sid = body["session_id"]
            note = stream.wait(lambda e: e["event"] == "system_note")
            self.assertIn("的任务状况：由扩展写入", note["data"]["text"])
            self.assertEqual(note["data"]["session_id"], sid)
            self.assertTrue(note["data"]["message_id"])
            status, snap = rig.call("GET", f"/tasks/{tid}/snapshot?session={sid}")
            self.assertEqual((status, snap["seq"], snap["executor"]["state"]), (200, 1, "idle"))
            self.assertEqual([m["type"] for m in snap["conversation"]["messages"]], ["system_note"])
            status, sent = rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {"text": "/整理一下", "client_id": "c-1"})
            self.assertEqual(sent, {"ok": True, "client_id": "c-1", "queued": False})
            user = stream.wait(lambda e: e["event"] == "user_message")["data"]
            self.assertTrue(user["message_id"])
            self.assertEqual((user["text"], user["client_id"], user["origin"]), ("/整理一下", "c-1", "typed"))
            answer = stream.wait(lambda e: e["event"] == "assistant_reply")["data"]
            self.assertEqual((answer["text"], answer["via_reply_tool"]), ("存好了。", True))
            self.assertTrue(answer["message_id"])
            changed = stream.wait(lambda e: e["event"] == "deliverable_changed")
            self.assertEqual((changed["id"], changed["data"]["actor"], changed["data"]["op_id"]), (2, "executor", None))
            self.assertEqual(changed["data"]["operations"][0]["fields"]["用例名称"], "提交退货申请")
            self.assertIsNotNone(changed["data"]["completion"])
            ended = stream.wait(lambda e: e["event"] == "work_ended")["data"]
            self.assertEqual(ended["outcome"], "replied")
            # 工作结束时推过程摘要：工作编号与 work_ended 相同，两步（保存修订、回复），阶段按同一套写法。
            summary = stream.wait(lambda e: e["event"] == "work_summary")["data"]
            self.assertEqual((summary["work_id"], summary["step_count"]), (ended["work_id"], 2))
            self.assertEqual([x["text"] for x in summary["stages"]],
                             ["写好并保存了第 1 次修订：新增功能用例 1 个（UC-001）", "组织并发出了回复"])
            # 刷新：整份数据里的对话与事件流一致，斜杠改写过的话照原样显示；过程摘要从会话文件重算，插在回复之前。
            _, snap = rig.call("GET", f"/tasks/{tid}/snapshot?session={sid}")
            texts = [(m["type"], m.get("text")) for m in snap["conversation"]["messages"]]
            self.assertEqual(texts[1:], [("user_message", "/整理一下"), ("work_summary", None), ("assistant_reply", "存好了。")])
            rebuilt = snap["conversation"]["messages"][2]
            self.assertEqual((rebuilt["step_count"], [x["text"] for x in rebuilt["stages"]]), (2, [x["text"] for x in summary["stages"]]))
            self.assertEqual(snap["conversation"]["messages"][3]["work_id"], rebuilt["work_id"])
            self.assertEqual(snap["seq"], 2)

    def test_服务_直接操作先收到库事件_版本过期返回stale_version_预览标注未确认(self):
        with ServiceRig([save_uc(), reply("存好了。")]) as rig:
            tid = rig.new_task()
            stream = rig.stream(tid)
            sid = rig.call("POST", f"/tasks/{tid}/sessions")[1]["session_id"]
            rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {"text": "整理一下", "client_id": "c-1"})
            stream.wait(lambda e: e["event"] == "work_ended")
            status, ok = rig.call("POST", f"/tasks/{tid}/actions?session={sid}", {
                "client_id": "a-1", "kind": "edit_fields", "targets": [{"item_id": "UC-001", "base_version": 1}],
                "fields": {"用例名称": "买家提交退货申请"}})
            self.assertEqual(status, 200)
            self.assertEqual(set(ok), {"ok", "client_id", "op_id"})
            changed = stream.wait(lambda e: e["event"] == "deliverable_changed" and e["data"]["actor"] == "user")["data"]
            self.assertEqual(changed["op_id"], ok["op_id"])
            self.assertEqual(changed["operations"][0]["version_after"], 2)
            noted = stream.wait(lambda e: e["event"] == "ui_action_noted")["data"]
            self.assertEqual(noted["op_id"], ok["op_id"])
            status, stale = rig.call("POST", f"/tasks/{tid}/actions?session={sid}", {
                "client_id": "a-2", "kind": "edit_fields", "targets": [{"item_id": "UC-001", "base_version": 1}], "fields": {"用例名称": "晚了"}})
            self.assertEqual((status, stale["error"]["code"]), (409, "stale_version"))
            self.assertEqual(stale["error"]["data"]["items"][0]["current_version"], 2)
            status, confirm = rig.call("POST", f"/tasks/{tid}/actions?session={sid}", {
                "client_id": "a-3", "kind": "confirm", "targets": [{"item_id": "UC-001", "base_version": 2}]})
            self.assertEqual(status, 200)
            recorded = stream.wait(lambda e: e["event"] == "confirmation_recorded")["data"]
            self.assertEqual(recorded["items"], [{"item_id": "UC-001", "version_no": 2, "accepted": True}])
            status, preview = rig.call("POST", f"/tasks/{tid}/documents/preview",
                                       {"selection": [{"item_id": "UC-001", "version_no": 1}, {"item_id": "UC-001", "version_no": 2}]})
            self.assertEqual(status, 200)
            self.assertIn("［第 1 版；未评审；未经用户确认］", preview["text"])
            self.assertIn("［第 2 版；未评审；用户已确认］", preview["text"])

    def test_服务_执行者运行中另一条会话返回session_busy(self):
        with ServiceRig([reply("慢慢说完。", delay=4), reply("好。")]) as rig:
            tid = rig.new_task()
            stream = rig.stream(tid)
            first = rig.call("POST", f"/tasks/{tid}/sessions")[1]["session_id"]
            rig.call("POST", f"/tasks/{tid}/messages?session={first}", {"text": "说一句", "client_id": "c-1"})
            stream.wait(lambda e: e["event"] == "work_started")
            # 执行者在第一条会话里工作：新建会话、对「另一条会话」说话都被拒。
            status, busy = rig.call("POST", f"/tasks/{tid}/sessions")
            self.assertEqual((status, busy["error"]["code"]), (409, "session_busy"))
            self.assertEqual(busy["error"]["data"]["active_session"], first)
            status, busy = rig.call("POST", f"/tasks/{tid}/messages?session=01a0c000-0000-7000-8000-000000000000", {"text": "插一句"})
            self.assertEqual((status, busy["error"]["code"]), (409, "session_busy"))
            # 同一条会话里说话照常排在后面。
            status, queued = rig.call("POST", f"/tasks/{tid}/messages?session={first}", {"text": "再说一句", "client_id": "c-2"})
            self.assertEqual((status, queued["queued"]), (200, True))
            waiting = stream.wait(lambda e: e["event"] == "user_message" and e["data"]["client_id"] == "c-2")["data"]
            self.assertEqual((waiting["queued"], waiting["message_id"]), (True, None))
            merged = stream.wait(lambda e: e["event"] == "user_message" and e["data"]["client_id"] == "c-2" and not e["data"]["queued"], 30)
            self.assertTrue(merged["data"]["message_id"])

    def test_服务_断线用LastEventID重连补到缺的事件_差距太大发resync(self):
        with ServiceRig([save_uc(), reply("存好了。")]) as rig:
            tid = rig.new_task()
            stream = rig.stream(tid)
            sid = rig.call("POST", f"/tasks/{tid}/sessions")[1]["session_id"]
            rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {"text": "整理一下"})
            stream.wait(lambda e: e["event"] == "work_ended")
            stream.close()
            rig.call("POST", f"/tasks/{tid}/actions?session={sid}", {
                "kind": "edit_fields", "targets": [{"item_id": "UC-001", "base_version": 1}], "fields": {"用例名称": "断线时改的"}})
            # 断线前最后收到的库事件是 1 号（创建任务之后没有收到任何库事件的也算），重连补发 2、3 号。
            again = rig.stream(tid, last_event_id=1)
            seqs = [again.wait(lambda e: e.get("id") == n)["id"] for n in (2, 3)]
            self.assertEqual(seqs, [2, 3])
            time.sleep(0.5)
            self.assertEqual([e["id"] for e in again.events if "id" in e], [2, 3], "补发的每一条只发一次")
            import taskwright_server.service.hub as hub_module
            saved, hub_module.REPLAY_WINDOW = hub_module.REPLAY_WINDOW, 1
            try:
                far = rig.stream(tid, last_event_id=0)
                self.assertEqual(far.wait(lambda e: e["event"] == "resync")["data"], {"reason": "gap_too_large"})
            finally:
                hub_module.REPLAY_WINDOW = saved

    def test_服务_卡片点击用card写法_选项文字按回复里的选项查回(self):
        # 请选择要挂在条目上，所以先存一个用例，再就它出一张请选择卡片。
        choose = {"tool_calls": [call("reply", {"informs": [], "text": "逾期的读者能不能续借？", "act": {
            "kind": "choose", "text": "逾期的读者能不能续借？", "items": [{"item_id": "UC-001", "version_no": 1}],
            "options": [{"key": "allow", "text": "允许续借"}, {"key": "deny", "text": "不允许续借"}]}})]}
        with ServiceRig([save_uc(), choose, reply("记下了。")]) as rig:
            tid = rig.new_task()
            stream = rig.stream(tid)
            sid = rig.call("POST", f"/tasks/{tid}/sessions")[1]["session_id"]
            rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {"text": "问我吧", "client_id": "c-1"})
            asked = stream.wait(lambda e: e["event"] == "assistant_reply")["data"]
            self.assertEqual(asked["act"]["kind"], "choose", "请选择卡片要被回复工具接受")
            stream.wait(lambda e: e["event"] == "work_ended")
            status, _ = rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {
                "text": "我选：不允许续借", "client_id": "k-1", "origin": "card_choice",
                "card": {"reply_message_id": asked["message_id"], "kind": "choose", "choice": "deny"}})
            self.assertEqual(status, 200)
            user = stream.wait(lambda e: e["event"] == "user_message" and e["data"]["client_id"] == "k-1")["data"]
            self.assertEqual((user["annotation"]["option_key"], user["annotation"]["option_text"]), ("deny", "不允许续借"))
            first_end = stream.of("work_ended")[0]
            stream.wait(lambda e: e["event"] == "work_ended" and e is not first_end)
            _, snap = rig.call("GET", f"/tasks/{tid}/snapshot?session={sid}")
            card = [m for m in snap["conversation"]["messages"] if m["type"] == "user_message"][-1]
            self.assertEqual((card["origin"], card["annotation"]["option_text"]), ("card_choice", "不允许续借"))

    def test_服务_pi退出后打开会话按需续接_卡片点击合成card_choice(self):
        with ServiceRig([reply("请选一个。"), reply("好，就按退货流程来。")]) as rig:
            tid = rig.new_task()
            stream = rig.stream(tid)
            sid = rig.call("POST", f"/tasks/{tid}/sessions")[1]["session_id"]
            rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {"text": "先整理哪部分？"})
            answer = stream.wait(lambda e: e["event"] == "assistant_reply")["data"]
            stream.wait(lambda e: e["event"] == "work_ended")
            rig.service.task(tid).executor.close()
            stream.wait(lambda e: e["event"] == "executor_state" and e["data"]["state"] == "exited")
            # 打开这条会话（整份数据带 session）时按需启动 pi 并续接它。
            status, snap = rig.call("GET", f"/tasks/{tid}/snapshot?session={sid}")
            self.assertEqual((status, snap["executor"]["state"], snap["executor"]["active_session"]), (200, "idle", sid))
            self.assertEqual([m["type"] for m in snap["conversation"]["messages"]], ["system_note", "user_message", "work_summary", "assistant_reply"])
            states = [e["data"]["state"] for e in stream.of("executor_state")]
            self.assertEqual(states[-2:], ["starting", "idle"])
            # 卡片上的选项走 messages，origin 为 card_choice：事件与刷新后的整份数据里都合成一条带标注的用户消息。
            status, sent = rig.call("POST", f"/tasks/{tid}/messages?session={sid}", {
                "text": "我选：先做退货流程", "client_id": "k-1", "origin": "card_choice",
                "annotation": {"reply_message_id": answer["message_id"], "option_key": "a", "option_text": "先做退货流程"}})
            self.assertEqual(status, 200)
            user = stream.wait(lambda e: e["event"] == "user_message" and e["data"]["client_id"] == "k-1")["data"]
            self.assertEqual((user["origin"], user["annotation"]["option_key"], user["annotation"]["reply_message_id"]),
                             ("card_choice", "a", answer["message_id"]))
            first_end = stream.of("work_ended")[0]
            stream.wait(lambda e: e["event"] == "work_ended" and e is not first_end)
            _, snap = rig.call("GET", f"/tasks/{tid}/snapshot?session={sid}")
            card = [m for m in snap["conversation"]["messages"] if m["type"] == "user_message"][-1]
            self.assertEqual((card["origin"], card["text"], card["annotation"]["option_text"]), ("card_choice", "我选：先做退货流程", "先做退货流程"))


if __name__ == "__main__":
    unittest.main()
