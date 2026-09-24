"""假模型端点自己的测试：不起 pi，直接用 HTTP 请求它，核对脚本的几种用法都按说明工作。"""

from __future__ import annotations

import json
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from taskwright_server.fake_model import FakeModel, write_agent_dir


def post(fake: FakeModel, body: dict) -> tuple[int, str]:
    request = urllib.request.Request(f"{fake.base_url}/chat/completions", json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


def stream_chunks(text: str) -> list[dict]:
    return [json.loads(line[6:]) for line in text.splitlines()
            if line.startswith("data: ") and line != "data: [DONE]"]


def user(text: str) -> dict:
    return {"model": "fake-model", "messages": [{"role": "user", "content": text}]}


class FakeModelTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = Path(self.tmp.name) / "requests.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_非流式_文字与兜底(self):
        with FakeModel([{"text": "第一句。"}], self.log) as fake:
            status, body = post(fake, user("你好"))
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["choices"][0]["message"]["content"], "第一句。")
            _, body = post(fake, user("还在吗"))
            self.assertEqual(json.loads(body)["choices"][0]["message"]["content"], "好的。")

    def test_流式_同一轮两个工具调用(self):
        reply = {"tool_calls": [{"name": "read", "arguments": {"path": "a.md"}},
                                {"name": "ls", "arguments": {"path": "inputs"}, "id": "call-ls"}]}
        with FakeModel([reply], self.log) as fake:
            status, body = post(fake, {**user("读一下"), "stream": True})
        self.assertEqual(status, 200)
        chunks = stream_chunks(body)
        calls = [c["choices"][0]["delta"]["tool_calls"][0] for c in chunks
                 if c["choices"] and "tool_calls" in c["choices"][0]["delta"]]
        self.assertEqual([(c["index"], c["id"], c["function"]["name"]) for c in calls],
                         [(0, "call_fake_1_0", "read"), (1, "call-ls", "ls")])
        self.assertEqual(json.loads(calls[0]["function"]["arguments"]), {"path": "a.md"})
        finishes = [c["choices"][0]["finish_reason"] for c in chunks if c["choices"] and c["choices"][0]["finish_reason"]]
        self.assertEqual(finishes, ["tool_calls"])
        self.assertTrue(body.rstrip().endswith("data: [DONE]"))

    def test_按条件的规则优先_用完次数就不再用(self):
        script = {"rules": [{"when": {"last_role": "tool", "last_contains": "被拒"}, "reply": {"text": "我改一下。"},
                             "max_uses": 1}],
                  "sequence": [{"text": "按次序的第一条。"}], "default": {"text": "兜底。"}}
        tool_message = {"model": "fake-model", "messages": [{"role": "tool", "content": "调用被拒：缺字段"}]}
        with FakeModel(script, self.log) as fake:
            texts = [json.loads(post(fake, body)[1])["choices"][0]["message"]["content"]
                     for body in (tool_message, tool_message, user("好"))]
        self.assertEqual(texts, ["我改一下。", "按次序的第一条。", "兜底。"])

    def test_第几次请求的条件(self):
        script = {"rules": [{"when": {"request_no": 2}, "reply": {"text": "第二次。"}}], "default": {"text": "别的。"}}
        with FakeModel(script, self.log) as fake:
            texts = [json.loads(post(fake, user("x"))[1])["choices"][0]["message"]["content"] for _ in range(3)]
        self.assertEqual(texts, ["别的。", "第二次。", "别的。"])

    def test_错误状态码(self):
        with FakeModel([{"status": 503, "error_body": "暂时不可用"}, {"text": "恢复了。"}], self.log) as fake:
            status, body = post(fake, user("x"))
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["error"]["message"], "暂时不可用")
            self.assertEqual(post(fake, user("x"))[0], 200)

    def test_错误应答关闭连接_同一条连接上的下一次请求不会卡住(self):
        """错误应答带 Connection: close 并真的关掉连接。不关时，客户端复用这条连接发下一次请求要先等它失败再重连，
        pi 的第二次自动重试因此多出约 2 秒（观测台真实数据验证时查到的）。这里用同一条 HTTP/1.1 连接连发两次。"""
        import http.client
        body = json.dumps(user("x")).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        with FakeModel([{"status": 500, "error_body": "坏了"}, {"status": 500, "error_body": "又坏了"}], self.log) as fake:
            host, port = fake.base_url.split("//")[1].split("/")[0].split(":")
            conn = http.client.HTTPConnection(host, int(port), timeout=10)
            conn.request("POST", "/v1/chat/completions", body, headers)
            first = conn.getresponse()
            first.read()
            self.assertEqual(first.status, 500)
            self.assertEqual(first.getheader("Connection"), "close")
            started = time.monotonic()
            conn.request("POST", "/v1/chat/completions", body, headers)   # http.client 见到 close 会自己重连
            second = conn.getresponse()
            second.read()
            self.assertEqual(second.status, 500)
            self.assertLess(time.monotonic() - started, 1.0)
            conn.close()

    def test_故意延迟(self):
        with FakeModel([{"text": "慢。", "delay": 0.6}], self.log) as fake:
            started = time.time()
            post(fake, user("x"))
            self.assertGreaterEqual(time.time() - started, 0.6)

    def test_请求体原样记下(self):
        body = {**user("原样记下这句话"), "stream": False, "tools": [{"type": "function", "function": {"name": "ls"}}]}
        with FakeModel([{"text": "好。"}], self.log) as fake:
            post(fake, body)
            [entry] = fake.requests()
        self.assertEqual(entry["序号"], 1)
        self.assertEqual(entry["请求体"], body)
        self.assertEqual(entry["回答"], {"text": "好。"})
        self.assertEqual(entry["按哪一条给的"], "sequence 的下一条")

    def test_每个实例各用各的随机端口(self):
        with FakeModel([{"text": "甲"}], self.log) as a, FakeModel([{"text": "乙"}]) as b:
            self.assertNotEqual(a.port, b.port)
            self.assertEqual(json.loads(post(b, user("x"))[1])["choices"][0]["message"]["content"], "乙")
            self.assertEqual(json.loads(post(a, user("x"))[1])["choices"][0]["message"]["content"], "甲")

    def test_pi_配置目录只登记假端点(self):
        folder = write_agent_dir(Path(self.tmp.name) / "agent", "http://127.0.0.1:1/v1")
        models = json.loads((folder / "models.json").read_text(encoding="utf-8"))
        self.assertEqual(list(models["providers"]), ["fake"])
        self.assertEqual(models["providers"]["fake"]["baseUrl"], "http://127.0.0.1:1/v1")


if __name__ == "__main__":
    unittest.main()
