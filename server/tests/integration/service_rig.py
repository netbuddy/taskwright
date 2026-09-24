"""任务服务的集成测试台：一个进程内的任务服务、一个假模型端点、一个 SSE 事件收集器。

服务起在随机端口（绑 127.0.0.1，只给测试用）；pi 由服务按需启动，模型换成假端点，不加载 Langfuse 插件。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from taskwright_server.fake_model import ENV_AGENT_DIR, FakeModel, write_agent_dir
from taskwright_server.service.app import Service, serve
from tests.integration.rig import DROPPED_ENV, profile_for_tests, put_material


class EventStream:
    """在后台线程里读一条 SSE 连接，把事件收进列表：每项是 {"event", "id", "data"}。"""

    def __init__(self, url: str, last_event_id: int | None = None):
        headers = {"Accept": "text/event-stream"}
        if last_event_id is not None:
            headers["Last-Event-ID"] = str(last_event_id)
        self.response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120)
        self.events: list[dict] = []
        self.raw: list[str] = []
        self.lock = threading.RLock()      # wait() 的判断函数里可以再调用 of()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        current: dict = {}
        try:
            for raw in self.response:
                line = raw.decode("utf-8").rstrip("\n")
                self.raw.append(line)
                if not line:
                    if "event" in current:
                        with self.lock:
                            self.events.append(current)
                    current = {}
                elif line.startswith("event: "):
                    current["event"] = line[7:]
                elif line.startswith("id: "):
                    current["id"] = int(line[4:])
                elif line.startswith("data: "):
                    current["data"] = json.loads(line[6:])
        except Exception:
            pass

    def wait(self, pred, timeout: float = 30.0) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                for e in self.events:
                    if pred(e):
                        return e
            time.sleep(0.05)
        with self.lock:
            names = [e["event"] for e in self.events]
        raise TimeoutError(f"等了 {timeout:.0f} 秒没等到想要的事件；已收到：{names}")

    def of(self, name: str) -> list[dict]:
        with self.lock:
            return [e for e in self.events if e["event"] == name]

    def close(self) -> None:
        # 读线程正卡在读 socket 上，直接 close 会等到服务端下一次保活才返回；先把 socket 关断。
        try:
            self.response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            self.response.close()
        except Exception:
            pass


class ServiceRig:
    def __init__(self, script):
        self.root = Path(tempfile.mkdtemp(prefix="taskwright-svc-"))
        self.fake = FakeModel(script, self.root / "fake_requests.jsonl")
        self.streams: list[EventStream] = []

    def __enter__(self) -> "ServiceRig":
        self.fake.start()
        agent_dir = write_agent_dir(self.root / "pi-agent", self.fake.base_url)
        self.saved_env = dict(os.environ)
        for name in DROPPED_ENV:
            os.environ.pop(name, None)
        os.environ[ENV_AGENT_DIR] = str(agent_dir)
        self.service = Service(self.root / "tasks", self.root / "runs", profile_for_tests())
        self.server = serve(self.service, "127.0.0.1", 0)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/api/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc) -> None:
        for s in self.streams:
            s.close()
        self.server.shutdown()
        self.service.close()
        self.fake.stop()
        os.environ.clear()
        os.environ.update(self.saved_env)
        if os.environ.get("TASKWRIGHT_IT_KEEP"):
            print(f"\n任务服务测试的临时目录保留在 {self.root}")
        else:
            shutil.rmtree(self.root, ignore_errors=True)

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def stream(self, task_id: str, session: str | None = None, last_event_id: int | None = None) -> EventStream:
        query = f"?session={session}" if session else ""
        s = EventStream(f"{self.base}/tasks/{task_id}/events{query}", last_event_id)
        self.streams.append(s)
        return s

    def new_task(self, material: str | None = None) -> str:
        """建一个任务；给了 material 就在它的材料目录里放一份 inputs/材料.md（「文档原文」的摘录要逐字出自材料）。"""
        status, body = self.call("POST", "/tasks", {"task_type": "srs-authoring", "task_name": "测试任务", "domain_tag": "售后"})
        assert status == 200, body
        if material is not None:
            put_material(self.service.task(body["task_id"]).dir, material)
        return body["task_id"]
