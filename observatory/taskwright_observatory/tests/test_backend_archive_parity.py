"""两版后端写的归档，观测台读出来一样。

任务服务有 Python 版（server/taskwright_server/service）与 TypeScript 版（backend/）两份实现，都按 observatory/archive-format.md
写归档。这里各起一个后端（配各自的假模型端点，同一份脚本），建一个任务、打开会话、说一句话（先写理解、保存一次修订、再回复），
停掉后端让归档写完整，然后把两边的归档目录与任务目录分别交给观测台的 Index，比较会话列表与会话详情。

比较之前把随运行变化的东西换成占位写法：会话编号、会话条目编号、任务编号、调用编号之外的随机编号（界面操作编号）、时刻、耗时、临时目录。
原始事件流里后端命令的回应与 pi 自己的事件交错的先后取决于时序，所以记归档行号的字段不比具体行号。
本机没有 pi 或 node 时跳过。跑法：python3 -m pytest observatory -q -k parity
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from taskwright_observatory.api import Index

ROOT = Path(__file__).resolve().parents[3]
NODE = shutil.which("node")
INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```'
SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "买家可以申请退货。"}
UC = {"用例名称": "提交退货申请", "用例功能": "买家提交退货申请。", "参与者": ["买家"], "基本流程": ["买家打开订单", "系统记下申请"]}
SCRIPT = [
    {"text": INTENT, "tool_calls": [{"name": "save_revision", "arguments": {"operations": [
        {"op": "add", "collection": "功能用例", "fields": UC, "sources": [SOURCE]}]}}]},
    {"tool_calls": [{"name": "reply", "arguments": {"informs": [], "act": None, "text": "存好了。"}}]},
]
DROPPED_ENV = ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "LANGFUSE_PUBLIC_KEY",
               "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT", "PI_CODING_AGENT_DIR", "TASKWRIGHT_TASKS_ROOT")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def call(base: str, method: str, path: str, body=None, raw: bytes | None = None, headers: dict | None = None) -> dict:
    data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers or {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read() or b"{}")


def run_backend(kind: str, root: Path) -> tuple[Path, Path]:
    """起一个后端与它的假模型端点，跑完那一段对话，停掉，返回（归档目录, 任务目录）。"""
    from taskwright_server.fake_model import FakeModel, write_agent_dir
    tasks, runs = root / "tasks", root / "runs"
    tasks.mkdir(parents=True)
    runs.mkdir()
    fake = FakeModel(SCRIPT, root / "fake.jsonl").start(0)
    agent = write_agent_dir(root / "pi-agent", fake.base_url)
    env = {k: v for k, v in os.environ.items() if k not in DROPPED_ENV}
    env.update(PI_CODING_AGENT_DIR=str(agent), TASKWRIGHT_LOG_DIR=str(root / "logs"),
               PYTHONPATH=os.pathsep.join([str(ROOT / "server"), str(ROOT / "observatory")]))
    port = free_port()
    args = ["--tasks", str(tasks), "--runs", str(runs), "--port", str(port), "--host", "127.0.0.1", "--profile", "fake"]
    command = ([sys.executable, "-m", "taskwright_server.service", *args] if kind == "python"
               else [NODE, str(ROOT / "backend" / "src" / "main.mts"), *args])
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(150):
            try:
                call(base, "GET", "/api/v1/task-types")
                break
            except OSError:
                time.sleep(0.2)
        task = call(base, "POST", "/api/v1/tasks", {"task_type": "srs-authoring", "task_name": "对照任务"})["task_id"]
        material = f'--B\r\nContent-Disposition: form-data; name="file"; filename="材料.md"\r\n\r\n{SOURCE["excerpt"]}\r\n--B--\r\n'.encode("utf-8")
        call(base, "POST", f"/api/v1/tasks/{task}/materials", raw=material, headers={"Content-Type": "multipart/form-data; boundary=B"})
        # 用事件流等这一句话做完：不能反复读整份数据来等，那样每读一次都会让后端向 pi 取一次会话条目，归档里多出几行回应。
        events = urllib.request.urlopen(f"{base}/api/v1/tasks/{task}/events", timeout=60)
        session = call(base, "POST", f"/api/v1/tasks/{task}/sessions")["session_id"]
        call(base, "POST", f"/api/v1/tasks/{task}/messages?session={session}", {"text": "整理一下", "client_id": "c-1"})
        for raw in events:
            if raw.decode("utf-8").strip() == "event: work_ended":
                break
        events.close()
        time.sleep(0.5)
    finally:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
        fake.stop()
    return runs / task, tasks


ENTRY_KEYS = {"message_id", "entry_id", "id", "parentId", "会话条目编号", "条目编号", "user_entry"}


class Normalizer:
    def __init__(self, root: Path):
        self.root = str(root.resolve())
        self.maps: dict[str, dict[str, str]] = {}
        self.entries: set[str] = set()

    def label(self, kind: str, value: str) -> str:
        table = self.maps.setdefault(kind, {})
        return table.setdefault(value, f"<{kind}{len(table) + 1}>")

    def collect(self, value, key: str = "") -> None:
        if isinstance(value, str) and key in ENTRY_KEYS and re.fullmatch(r"[0-9a-f]{8}", value):
            self.entries.add(value)
        elif isinstance(value, list):
            for v in value:
                self.collect(v, key)
        elif isinstance(value, dict):
            for k, v in value.items():
                self.collect(v, k)

    def text(self, value: str) -> str:
        out = value.replace(self.root, "<目录>")
        out = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", lambda m: self.label("会话", m.group()), out)
        out = re.sub(r"TASK-\d{8}-[0-9A-F]{4}", lambda m: self.label("任务", m.group()), out)
        out = re.sub(r"ui-op-[0-9a-f]{12}", lambda m: self.label("操作", m.group()), out)
        out = re.sub(r"(?<![0-9A-Za-z])[0-9a-f]{8}(?![0-9A-Za-z])", lambda m: self.label("条目", m.group()) if m.group() in self.entries else m.group(), out)
        out = re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z", "<时刻>", out)
        out = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?", "<时刻>", out)
        out = re.sub(r"(?<![0-9])\d{2}:\d{2}:\d{2}(?![0-9])", "<时分秒>", out)
        out = re.sub(r"\d{8}-\d{6}", "<时刻>", out)
        out = re.sub(r"(?<![0-9])1\d{12}(?![0-9])", "<时刻数>", out)
        return out

    def value(self, value, key: str = ""):
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, (int, float)):
            if "耗时" in key or key.endswith("行号") or key in ("开始时刻", "结束时刻", "启动时刻", "收到时刻", "pid"):
                return f"<{key}>"
            return "<时刻数>" if 1e9 < value < 3e12 else value
        if isinstance(value, list):
            return [self.value(v, key) for v in value]
        if isinstance(value, dict):
            return {self.text(k): self.value(v, k) for k, v in sorted(value.items())}
        return value


def observatory_view(archive: Path, tasks: Path, root: Path):
    index = Index(archive, tasks)
    view = {"会话列表": index.session_list(),
            "会话详情": [index.session_detail(s["会话编号"]) for s in index.sessions if s["会话编号"]]}
    view = json.loads(json.dumps(view, ensure_ascii=False, default=str))
    normalizer = Normalizer(root)
    normalizer.collect(view)
    return normalizer.value(view)


@unittest.skipUnless(shutil.which("pi") and NODE, "本机找不到 pi 或 node，跑不了两版后端的对照")
class BackendArchiveParityTest(unittest.TestCase):
    def test_两版后端写的归档_观测台读出的会话列表与会话详情一样(self):
        temp = Path(tempfile.mkdtemp(prefix="taskwright-parity-"))
        try:
            views = {}
            for kind in ("python", "typescript"):
                archive, tasks = run_backend(kind, temp / kind)
                views[kind] = observatory_view(archive, tasks, temp / kind)
            python, typescript = views["python"], views["typescript"]
            self.assertTrue(python["会话详情"], "Python 版的归档里读出了会话")
            self.assertEqual(python["会话列表"], typescript["会话列表"])
            self.assertEqual(python["会话详情"], typescript["会话详情"])
        finally:
            shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
