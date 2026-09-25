"""假模型端点：一个按脚本回固定内容、与 OpenAI 聊天接口兼容的本地 HTTP 服务，只用 Python 标准库。

它给集成测试用：pi 以为自己在请求一个模型，其实每次拿到的回答都是测试事先写好的，
于是门禁拒绝、用户直接写入这类机制可以被确定性地测，不受真模型的随机性影响。

它实现 `POST /v1/chat/completions`，流式（stream 为真，按 SSE 逐块发）与非流式都支持，
能回一段文字、一个或几个工具调用、故意延迟若干秒再回，或者回一个错误状态码。
每个请求体原样追加进一份 jsonl 请求记录，测试据此断言「模型看到了什么」。

每个测试起自己的实例，端口由操作系统随机分配（绑 0 号端口），不与别的测试共用：
两个实验共用一个假端点会互相覆盖脚本，实测时吃过这个亏。

脚本的格式见同目录 README.md；简单说是一个 dict，也可以直接是一个列表（等于只有 sequence）：

    {
      "rules":    [{"when": {...条件...}, "reply": {...回答...}, "max_uses": 1}],
      "sequence": [{...回答...}, {...回答...}],
      "default":  {...回答...}
    }

每来一个请求，先按先后试 rules，第一条条件全部满足、且没有用完次数的规则给出回答；
都不满足时从 sequence 里取下一条；sequence 也用完了就回 default（没写就回一句「好的。」）。
"""

from __future__ import annotations

import copy
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

#: 脚本用完之后的兜底回答。
DEFAULT_REPLY = {"text": "好的。"}

#: 自动补的理解：auto_intent 为真时，用户说话之后的第一个回答要是只有工具调用、没有文字，就在前面补上这一段。
#: 执行者每轮要在文字输出里写一份理解（agent/prompts/schemas/user_intent.schema.json），保存修订、完成任务、回复在没有理解时拒绝；
#: 早先写好的脚本只写了工具调用，补上这一段它们照旧能跑。要测「没写理解被拒」的测试把 auto_intent 关掉。
AUTO_INTENT_TEXT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```'

#: 假端点对外报的模型名。pi 那一侧的 models.json 里写的模型编号要与它一致，见 agent_config.py。
MODEL_ID = "fake-model"


def message_text(message: dict) -> str:
    """一条消息的文字：content 可能是字符串，也可能是若干段的列表。"""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def matches(when: dict, request_no: int, body: dict) -> bool:
    """一条规则的条件是否全部满足。条件都是关于这个请求的事实，没写的条件不管。

    request_no   这是第几个请求，从 1 起。
    last_role    请求里最后一条消息的角色，例如 user、tool。
    last_contains 请求里最后一条消息的文字包含这段文字。
    any_contains 请求里任意一条消息的文字包含这段文字。
    """
    messages = body.get("messages") or []
    last = messages[-1] if messages else {}
    if "request_no" in when and when["request_no"] != request_no:
        return False
    if "last_role" in when and last.get("role") != when["last_role"]:
        return False
    if "last_contains" in when and when["last_contains"] not in message_text(last):
        return False
    if "any_contains" in when and not any(when["any_contains"] in message_text(m) for m in messages):
        return False
    return True


class FakeModel:
    """一个假端点实例。用法：

        fake = FakeModel(script, log_path).start()
        ... 让 pi 去请求 fake.base_url ...
        fake.stop()
    """

    def __init__(self, script=None, log_path: Path | str | None = None, host: str = "127.0.0.1", auto_intent: bool = False):
        self.host = host
        self.auto_intent = auto_intent
        self.log_path = Path(log_path) if log_path else None
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.request_count = 0
        self.set_script(script or [])

    # ───────────── 脚本 ─────────────

    def set_script(self, script) -> None:
        """换一份脚本，已经数过的请求次数不清零。"""
        if isinstance(script, list):
            script = {"sequence": script}
        with self._lock:
            self._rules = [dict(r, used=0) for r in copy.deepcopy(script.get("rules") or [])]
            self._sequence = list(copy.deepcopy(script.get("sequence") or []))
            self._default = copy.deepcopy(script.get("default") or DEFAULT_REPLY)

    def _pick(self, request_no: int, body: dict) -> tuple[dict, str]:
        """给这个请求挑回答，返回（回答, 按哪一条给的说明）。"""
        with self._lock:
            for index, rule in enumerate(self._rules):
                limit = rule.get("max_uses")
                if limit is not None and rule["used"] >= limit:
                    continue
                if matches(rule.get("when") or {}, request_no, body):
                    rule["used"] += 1
                    if callable(rule.get("reply_from")):
                        # 只在 Python 里直接用时可写：回答要引用请求里才有的东西（例如会话条目编号）时，由函数现算。
                        return rule["reply_from"](body), f"rules 第 {index + 1} 条（按请求现算）"
                    return copy.deepcopy(rule["reply"]), f"rules 第 {index + 1} 条"
            if self._sequence:
                return self._sequence.pop(0), "sequence 的下一条"
            return copy.deepcopy(self._default), "default"

    # ───────────── 启停 ─────────────

    def start(self, port: int = 0) -> "FakeModel":
        """起服务。port 为 0 时由操作系统挑一个空闲端口。"""
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):   # 不往标准错误打访问日志
                pass

            def do_GET(self):
                if self.path.rstrip("/").endswith("/models"):
                    fake._send_json(self, 200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]})
                else:
                    fake._send_json(self, 404, {"error": {"message": f"假端点没有 {self.path} 这个地址"}})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                if not self.path.rstrip("/").endswith("/chat/completions"):
                    fake._send_json(self, 404, {"error": {"message": f"假端点没有 {self.path} 这个地址"}})
                    return
                fake._handle_completion(self, raw)

        self._server = ThreadingHTTPServer((self.host, port), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self):
        return self.start() if self._server is None else self

    def __exit__(self, *exc):
        self.stop()

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("假端点还没有启动。")
        return self._server.server_address[1]

    @property
    def base_url(self) -> str:
        """给 pi 的 models.json 里 baseUrl 一项用的地址。"""
        return f"http://{self.host}:{self.port}/v1"

    # ───────────── 请求记录 ─────────────

    def requests(self) -> list[dict]:
        """读回请求记录，每项是 {"序号", "时刻", "请求体", "回答", "按哪一条给的"}。"""
        if self.log_path is None or not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _record(self, entry: dict) -> None:
        if self.log_path is None:
            return
        with self._lock:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # ───────────── 回答 ─────────────

    def _handle_completion(self, handler: BaseHTTPRequestHandler, raw: bytes) -> None:
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {"无法解析的请求体": raw.decode("utf-8", "replace")}
        with self._lock:
            self.request_count += 1
            request_no = self.request_count
        reply, why = self._pick(request_no, body)
        reply = self._with_intent(reply, body)
        self._record({"序号": request_no, "时刻": round(time.time(), 3), "请求体": body,
                      "回答": reply, "按哪一条给的": why})
        if reply.get("delay"):
            time.sleep(float(reply["delay"]))
        status = int(reply.get("status", 200))
        if status != 200:
            # 错误应答后关闭连接：不关的话客户端会在下一次请求时复用这条旧连接，要先等它失败再重连，
            # 多出约 2 秒，观测台上会画成那一轮平白多花了 2 秒（实测查清）。
            self._send_json(handler, status, {"error": {"message": reply.get("error_body", f"假端点按脚本回 {status}"),
                                                        "type": "fake_error"}}, close=True)
            return
        calls = [{"id": call.get("id") or f"call_fake_{request_no}_{i}", "type": "function",
                  "function": {"name": call["name"],
                               "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False)}}
                 for i, call in enumerate(reply.get("tool_calls") or [])]
        text = reply.get("text") or ""
        finish = "tool_calls" if calls else "stop"
        if body.get("stream"):
            self._send_stream(handler, request_no, text, calls, finish)
        else:
            message = {"role": "assistant", "content": text or None}
            if calls:
                message["tool_calls"] = calls
            self._send_json(handler, 200, {
                "id": f"chatcmpl-fake-{request_no}", "object": "chat.completion", "created": int(time.time()),
                "model": MODEL_ID, "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

    def _with_intent(self, reply: dict, body: dict) -> dict:
        """auto_intent 为真、这个请求的最后一条消息是用户的角色、回答只有工具调用没有文字时，在前面补一段理解。"""
        messages = body.get("messages") or []
        last = messages[-1] if messages else {}
        # 兜底那句提醒之后也补：那一轮要是还没有理解，扩展就记下这一份；已经有了，扩展不再记，多写的一段无害。
        if not self.auto_intent or last.get("role") != "user" or not reply.get("tool_calls") or reply.get("text"):
            return reply
        return {**reply, "text": AUTO_INTENT_TEXT}

    @staticmethod
    def _send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict, close: bool = False) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(data)))
        if close:
            handler.send_header("Connection", "close")
            handler.close_connection = True
        handler.end_headers()
        handler.wfile.write(data)

    @staticmethod
    def _send_stream(handler: BaseHTTPRequestHandler, request_no: int, text: str, calls: list[dict],
                     finish: str) -> None:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Connection", "close")
        handler.end_headers()
        base = {"id": f"chatcmpl-fake-{request_no}", "object": "chat.completion.chunk",
                "created": int(time.time()), "model": MODEL_ID}

        def chunk(delta: dict, finish_reason=None) -> dict:
            return {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}

        pieces = [chunk({"role": "assistant", "content": ""})]
        if text:
            pieces.append(chunk({"content": text}))
        for i, call in enumerate(calls):
            pieces.append(chunk({"tool_calls": [{"index": i, **call}]}))
        pieces.append(chunk({}, finish))
        pieces.append({**base, "choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        for piece in pieces:
            handler.wfile.write(f"data: {json.dumps(piece, ensure_ascii=False)}\n\n".encode("utf-8"))
            handler.wfile.flush()
        handler.wfile.write(b"data: [DONE]\n\n")
        handler.wfile.flush()
        handler.close_connection = True
