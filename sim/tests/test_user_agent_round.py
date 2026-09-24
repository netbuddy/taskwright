"""用户 agent 一轮：假模型端点驱动用户 agent 的 pi，两个工具经 HTTP 打一个按接口字段做的假后端。

假模型的脚本：第一次请求调 look，第二次调 respond（说一句话）；第二轮：look、look(UC-001)、respond(点「这几条都看过了」)。
断言假后端收到的请求：带会话编号的整份数据读取、messages 的话、细看条目时写已读的 actions（不带通知），
以及点「这几条都看过了」的 actions（mark_viewed，带 notify_executor 与 targets）。
本机没有 pi 或 node 时跳过。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from taskwright_server.fake_model import ENV_AGENT_DIR, MODEL_ARG, FakeModel, write_agent_dir
from sim.launch_user import user_agent_session

PERSONA = {"名字": "测试用户", "人设": "说话很短。", "目标": "拿到一份需求说明。", "材料": ["a.md"], "材料说明": "一份需求。",
           "隐藏事实": [{"事实": "周末不算。", "关键词": ["周末"]}], "接受底线": [{"说法": "都要写到。", "判据": {}}]}

SNAPSHOT = {
    "ok": True, "seq": 2, "executor": {"state": "idle", "text": "", "active_session": "S1"}, "current_work": None,
    "task": {"definition": {"collections": [{"name": "功能用例", "fields": [{"name": "用例名称"}, {"name": "基本流程"}]}]},
             "items": [{"item_id": "UC-001", "collection": "功能用例", "title": "提交退货", "revision_no": 1,
                        "fields": {"用例名称": "提交退货", "基本流程": ["填表", "提交"]}, "confirmations": []}]},
    "conversation": {"messages": [
        {"type": "system_note", "message_id": "s1", "text": "任务现状：还没有条目。"},
        {"type": "assistant_reply", "message_id": "a1", "text": "整理好了一个用例。", "informs": [],
         "act": {"kind": "confirm", "text": "请确认 UC-001", "items": [{"item_id": "UC-001", "revision_no": 1}]}}]},
}


class FakeBackend:
    def __init__(self):
        self.requests: list[dict] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, body):
                data = json.dumps(body, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                url = urlparse(self.path)
                outer.requests.append({"method": "GET", "path": url.path, "query": parse_qs(url.query)})
                self.reply(SNAPSHOT)

            def do_POST(self):
                url = urlparse(self.path)
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                outer.requests.append({"method": "POST", "path": url.path, "query": parse_qs(url.query), "body": body})
                self.reply({"ok": True, "client_id": body.get("client_id"), "queued": False, "op_id": "ui-op-x"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/api/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def call(name, args):
    return {"name": name, "arguments": args}


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class UserAgentRoundTest(unittest.TestCase):
    def test_看界面再回应_说话走messages_细看条目记已读_点看过了走actions(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-sim-it-"))
        backend = FakeBackend()
        fake = FakeModel([
            {"tool_calls": [call("look", {})]},
            {"tool_calls": [call("respond", {"text": "先把审批写清楚"})]},
            {"tool_calls": [call("look", {})]},
            {"tool_calls": [call("look", {"item_id": "UC-001"})]},
            {"tool_calls": [call("respond", {"click": "这几条都看过了"})]},
        ], root / "fake.jsonl")
        fake.start()
        saved = dict(os.environ)
        ua = None
        try:
            for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                os.environ.pop(name, None)
            os.environ[ENV_AGENT_DIR] = str(write_agent_dir(root / "agent", fake.base_url))
            os.environ.update({"TASKWRIGHT_SIM_BACKEND": backend.base, "TASKWRIGHT_SIM_TASK": "TASK-X", "TASKWRIGHT_SIM_SESSION": "S1"})
            ua = user_agent_session(PERSONA, root)
            ua.profile["model"] = MODEL_ARG
            ua.profile.pop("thinking", None)
            ua.profile["extensions"] = [e for e in ua.profile["extensions"] if e.get("source") == "repo"]
            ua.start()
            first = list(ua.send("开始，先把你想做的事告诉助手"))
            second = list(ua.send("执行者停下了，看一下界面再回应"))
        finally:
            if ua is not None:
                ua.close()
            fake.stop()
            backend.server.shutdown()
            os.environ.clear()
            os.environ.update(saved)
        ends = [e for e in first + second if e.get("type") == "tool_execution_end"]
        self.assertEqual([(e["toolName"], e.get("isError")) for e in ends],
                         [("look", False), ("respond", False), ("look", False), ("look", False), ("respond", False)])
        seen = "".join(p.get("text", "") for p in ends[0]["result"]["content"])
        self.assertIn("系统说明：任务现状：还没有条目。", seen)
        self.assertIn("可以点：这几条都看过了／不对", seen)
        self.assertIn("功能用例 1 个：UC-001「提交退货」", seen)
        detail = "".join(p.get("text", "") for p in ends[3]["result"]["content"])
        self.assertIn("基本流程：1. 填表；2. 提交", detail)
        posts = [r for r in backend.requests if r["method"] == "POST"]
        self.assertEqual(posts[0]["path"], "/api/v1/tasks/TASK-X/messages")
        self.assertEqual(posts[0]["query"]["session"], ["S1"])
        self.assertEqual(posts[0]["body"]["text"], "先把审批写清楚")
        # 细看 UC-001 等于打开它的详情：写已读，不通知执行者。
        self.assertEqual(posts[1]["path"], "/api/v1/tasks/TASK-X/actions")
        self.assertEqual({k: posts[1]["body"].get(k) for k in ("kind", "notify_executor", "targets")},
                         {"kind": "mark_viewed", "notify_executor": None, "targets": [{"item_id": "UC-001", "base_revision": 1}]})
        self.assertEqual(posts[2]["path"], "/api/v1/tasks/TASK-X/actions")
        self.assertEqual({k: posts[2]["body"][k] for k in ("kind", "notify_executor", "targets")},
                         {"kind": "mark_viewed", "notify_executor": True, "targets": [{"item_id": "UC-001", "base_revision": 1}]})
        gets = [r for r in backend.requests if r["method"] == "GET"]
        self.assertTrue(all(r["path"] == "/api/v1/tasks/TASK-X/snapshot" and r["query"]["session"] == ["S1"] for r in gets))
        # respond 合格即结束用户 agent 的这一次运行：每次运行里模型请求的次数就是工具调用的次数。
        self.assertEqual(len(fake.requests()), 5)
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
