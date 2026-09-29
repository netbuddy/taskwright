"""用户 agent 一轮：假模型端点驱动用户 agent 的 pi，两个工具经 HTTP 打一个按接口字段做的假后端。
用户 agent 经 Node 驱动程序 sim/user_agent_driver.mts 启动（后端的会话类），假模型是后端的假端点 backend/fake_model/，以子进程运行。

假模型的脚本：第一次请求调 look，第二次调 respond（说一句话）；第二轮：look、look(UC-001)、respond(点「这几条都看过了」)。
断言假后端收到的请求：带会话编号的整份数据读取、messages 的话、细看条目时写已读的 actions（不带通知），
以及点「这几条都看过了」的 actions（mark_viewed，带 notify_executor 与 targets）。
另外核对驱动程序本身：标准输出上每一行都是 JSON（会话类打的日志改道到标准错误）；模拟用户起不来、驱动程序迟迟不报告启动完成时，
start 抛 UserAgentError，原因是给人看的一句话；启动超时的，驱动程序已经被停掉。
本机没有 pi 或 node 时跳过。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from sim.launch_user import DRIVER, REPO_ROOT, UserAgentError, UserAgentProcess, user_agent_session

#: pi 的配置目录由这个环境变量指定；假端点在这个目录里登记的模型写作「fake/fake-model」（backend/fake_model/agent_config.ts）。
ENV_AGENT_DIR = "PI_CODING_AGENT_DIR"
MODEL_ARG = "fake/fake-model"


class FakeModel:
    """后端的假模型端点（node backend/fake_model/main.mts），以子进程运行：按脚本回话，每个请求记一行进请求记录。"""

    def __init__(self, script: list, root: Path):
        self.root = Path(root)
        self.script = self.root / "fake-script.json"
        self.script.write_text(json.dumps(script, ensure_ascii=False), encoding="utf-8")
        self.log = self.root / "fake.jsonl"
        self.agent_dir = self.root / "agent"
        self.process: subprocess.Popen | None = None

    def start(self) -> None:
        self.process = subprocess.Popen(["node", "backend/fake_model/main.mts", "--script", str(self.script), "--log", str(self.log),
                                         "--agent-dir", str(self.agent_dir)], cwd=str(REPO_ROOT), stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True)
        end = time.time() + 30
        while time.time() < end:      # 第二行说配置目录写好了，这时端点已经在监听
            line = self.process.stdout.readline()
            if "pi 配置目录已写好" in line:
                return
            if not line and self.process.poll() is not None:
                break
        raise RuntimeError("假模型端点没有起来。")

    def requests(self) -> list[dict]:
        if not self.log.is_file():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines() if line.strip()]

    def stop(self) -> None:
        if self.process is not None:
            self.process.terminate()
            self.process.wait(10)

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
        ], root)
        fake.start()
        saved = dict(os.environ)
        ua = None
        try:
            for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                os.environ.pop(name, None)
            os.environ[ENV_AGENT_DIR] = str(fake.agent_dir)
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
        # 模拟用户的归档照旧在 user-agent/ 下：原始事件流、后端补记、收到时刻三份。
        archive = sorted(p.name for p in (root / "user-agent" / "pi-events").iterdir())
        self.assertEqual(len(archive), 3)
        self.assertRegex(archive[0], r"^user-agent-\d{8}-\d{6}\.backend\.jsonl$")
        shutil.rmtree(root, ignore_errors=True)


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class DriverTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="taskwright-sim-driver-"))
        self.saved = dict(os.environ)
        for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
            os.environ.pop(name, None)
        # 空的 pi 配置目录：不登记任何模型服务，这几例都不向模型发请求。
        (self.root / "agent").mkdir()
        os.environ[ENV_AGENT_DIR] = str(self.root / "agent")

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)
        shutil.rmtree(self.root, ignore_errors=True)

    def profile(self) -> dict:
        ua = user_agent_session(PERSONA, self.root)
        ua.profile["model"] = MODEL_ARG
        ua.profile.pop("thinking", None)
        ua.profile["extensions"] = [e for e in ua.profile["extensions"] if e.get("source") == "repo"]
        return ua.profile

    def test_标准输出上每一行都是JSON_会话类打的日志去了标准错误(self):
        # 续接一个记着别的工作目录的会话文件：会话类改写它的第一行，并用 console.log 打一行日志。
        session_file = self.root / "old.jsonl"
        session_file.write_text(json.dumps({"type": "session", "version": 3, "id": "old-session", "timestamp": "2026-09-28T00:00:00.000Z",
                                            "cwd": "/somewhere/else"}) + "\n", encoding="utf-8")
        commands = [{"cmd": "start", "profile": self.profile(), "cwd": str(self.root / "user-agent-cwd"), "runs": str(self.root / "user-agent"),
                     "label": "user-agent", "session_file": str(session_file)},
                    "这一行不是 JSON", {"cmd": "什么命令"}, {"cmd": "close"}]
        done = subprocess.run(["node", str(DRIVER)], cwd=str(REPO_ROOT), input="\n".join(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
                                                                                         for c in commands) + "\n",
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = done.stdout.splitlines()
        messages = [json.loads(line) for line in lines]      # 每一行都要能解析
        # 配置目录里没有登记模型，pi 可能在启动时就退出，所以第一条是 started 或 error 都行；这一例只看标准输出的形状。
        self.assertIn(messages[0]["type"], ("started", "error"), done.stdout)
        self.assertEqual([m["type"] for m in messages[1:]], ["error", "error", "closed"], done.stdout)
        self.assertEqual([m.get("stage") for m in messages[1:3]], ["input", "input"])
        self.assertIn("会话文件记的工作目录是 /somewhere/else", done.stderr)
        self.assertNotIn("会话文件记的工作目录", done.stdout)

    def test_模拟用户起不来_start报错写明原因(self):
        profile = self.profile()
        profile["executable"] = "no-such-pi-program-for-test"
        ua = UserAgentProcess(profile, self.root / "cwd", self.root / "user-agent")
        (self.root / "cwd").mkdir()
        with self.assertRaises(UserAgentError) as caught:
            ua.start()
        ua.close()
        self.assertIn("模拟用户启动没有成功：", str(caught.exception))
        self.assertIn("找不到助手的程序（pi）", str(caught.exception))

    def test_驱动程序迟迟不报告启动完成_按时限停掉并报错(self):
        silent = self.root / "silent.mjs"
        silent.write_text("process.stdin.resume();\n", encoding="utf-8")      # 读着标准输入，什么都不回

        drivers: list[subprocess.Popen] = []

        class Slow(UserAgentProcess):
            START_TIMEOUT = 1.0
            DRIVER = silent

            def _read_stdout(self, process):      # 记下 start 起的子进程，好核对超时之后它确实被停掉了
                drivers.append(process)
                super()._read_stdout(process)

        ua = Slow(self.profile(), self.root, self.root / "user-agent")
        started = time.time()
        try:
            with self.assertRaises(UserAgentError) as caught:
                ua.start()
            self.assertEqual(len(drivers), 1)
            try:
                drivers[0].wait(5)      # 应当已经停掉；留几秒余量，免得机器忙时偶发失败
            except subprocess.TimeoutExpired:
                self.fail("超时之后驱动程序还在运行，没有被停掉。")
            ua.close()
            self.assertLess(time.time() - started, 30)
            self.assertEqual(str(caught.exception), "模拟用户的驱动程序在 1 秒内没有报告启动完成，已经把它停掉。")
        finally:
            for process in drivers:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
