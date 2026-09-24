"""集成测试的试验台：一个任务目录、一个自己的假端点、一个经 RPC 驱动的真实 pi 进程。

2026-09-21 起一库一任务、任务由用户在界面上创建：试验台缺省先用产品的 create_task.create_task 建好任务
（放起始文件、经 agent 的命令行入口写任务记录，操作编号固定为 TASK_OP_ID），再启动 pi；
create_task=False 时只放起始文件、不写任务记录。

每个测试用 `with Rig(script) as rig:` 起一整套，出了 with 块就停掉 pi 与假端点、删掉临时目录。
起 pi 走的是产品自己的会话类 PiSession 与启动配置函数，只把启动配置里三处换掉：

- 模型换成假端点（pi 的配置目录经 PI_CODING_AGENT_DIR 指到临时目录，里面只登记假端点）；
- 不加载 Langfuse 插件（测试不往观测服务写数据），并把 Langfuse 相关的环境变量从子进程里拿掉；
- 需要时多加载测试专用扩展（现在没有：用户直接写入用的是 agent 里正式的 /tw-user 命令）。

断言只看事实：task.sqlite 里的行、pi 的事件流、会话文件、假端点记下的请求体。
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path

from taskwright_server import create_task as create_task_module
from taskwright_server import launch, new_workspace
from taskwright_server.fake_model import ENV_AGENT_DIR, MODEL_ARG, FakeModel, write_agent_dir
from taskwright_server.pi_session import PiSession

HERE = Path(__file__).resolve().parent

#: 任务目录的起始文件：代码仓里唯一的一份「软件需求规格说明编制」起始文件副本，与 create_task、new_workspace 共用。
START_FILES = new_workspace.FIXTURE_DIR / "srs-authoring"

#: 任务定义在任务目录里的相对路径。
DEFINITION_PATH = "docs/task-definitions/srs-authoring.json"

#: 试验台建任务时用的操作编号。事件表第 1 行（TASK_CREATED）的调用编号就是它，发起方是 user。
TASK_OP_ID = "ui-op-it-create"


#: 起 pi 时从子进程环境里拿掉的变量：不加载 Langfuse，也不让本机设的运行目录混进来。
DROPPED_ENV = ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "LANGFUSE_PUBLIC_KEY",
               "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT", ENV_AGENT_DIR)

#: 一句话从发出到 agent_settled 最多等多久（秒）。假端点回得很快，超过这个时间就是卡住了。
SETTLE_TIMEOUT = 60.0


def profile_for_tests(extra_extensions: tuple[str, ...] = ()) -> dict:
    """在开发用启动配置的基础上，换成假端点的模型，去掉 Langfuse 插件，按需加测试专用扩展。"""
    profile = copy.deepcopy(launch.load_profile("dev"))
    profile["model"] = MODEL_ARG
    profile["extensions"] = [e for e in profile["extensions"] if e.get("source") == "repo"]
    for path in extra_extensions:
        profile["extensions"].append({"name": f"测试专用扩展 {Path(path).name}", "source": "repo", "path": path})
    profile["env_passthrough"] = []
    profile.pop("langfuse", None)
    return profile


class Rig:
    def __init__(self, script, extra_extensions: tuple[str, ...] = (), label: str = "it", create_task: bool = True):
        self.script = script
        self.extra_extensions = extra_extensions
        self.label = label
        # 用 mkdtemp 而不用 TemporaryDirectory：后者在对象被回收时自己删目录，设了 TASKWRIGHT_IT_KEEP 也留不住。
        self.root = Path(tempfile.mkdtemp(prefix="taskwright-it-"))
        if create_task:
            self.task = create_task_module.create_task(self.root / "ws", op_id=TASK_OP_ID)
            self.workspace = Path(self.task["任务目录"])
        else:
            self.task = None
            self.workspace = new_workspace.create(self.root / "ws", START_FILES)
        self.fake = FakeModel(script, self.root / "fake_requests.jsonl")
        self.session: PiSession | None = None

    # ───────────── 启停 ─────────────

    def _with_test_env(self, action):
        """在测试用的环境变量下做一件事（起 pi 或重启 pi）：拿掉 Langfuse 等变量，pi 的配置目录指到假端点。"""
        saved = dict(os.environ)
        try:
            for name in DROPPED_ENV:
                os.environ.pop(name, None)
            os.environ[ENV_AGENT_DIR] = str(self.agent_dir)
            return action()
        finally:
            os.environ.clear()
            os.environ.update(saved)

    def restart(self, resume: bool = True):
        """重启 pi；resume 为真时接回原来这条会话（续接）。"""
        return self._with_test_env(lambda: self.session.restart(resume=resume))

    def __enter__(self) -> "Rig":
        try:
            self.fake.start()
            self.agent_dir = write_agent_dir(self.root / "pi-agent", self.fake.base_url)

            def start():
                self.session = PiSession(profile_for_tests(self.extra_extensions), self.workspace,
                                         self.root / "runs", self.label)
                self.session.start()
            self._with_test_env(start)
            if not self.session.alive():
                raise RuntimeError(f"pi 没有起来：{self.session.stderr_text}")
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *exc) -> None:
        try:
            if self.session is not None:
                self.session.close()
        finally:
            self.fake.stop()
            if os.environ.get("TASKWRIGHT_IT_KEEP"):
                print(f"\n集成测试的临时目录保留在 {self.root}")
            else:
                shutil.rmtree(self.root, ignore_errors=True)

    # ───────────── 驱动 ─────────────

    def say(self, text: str) -> list[dict]:
        """经 RPC 发一句话，收齐这句话的全部事件（直到 agent_settled）并返回。"""
        started = time.time()
        events = []
        for event in self.session.send(text):
            events.append(event)
            if time.time() - started > SETTLE_TIMEOUT:
                raise TimeoutError(f"一句话跑了 {SETTLE_TIMEOUT:.0f} 秒还没有结束。")
        return events

    def raw_events(self) -> list[dict]:
        """原始事件流归档里的全部事件（包括会话类自己消化掉、不交给调用方的界面请求与回应）。"""
        path = self.session.archive_path
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def status_values(self, key: str) -> list[str]:
        """扩展经状态栏报出的某个键的全部取值，按先后排。"""
        return [e.get("statusText") for e in self.raw_events()
                if e.get("type") == "extension_ui_request" and e.get("method") == "setStatus"
                and e.get("statusKey") == key]

    def wait_status(self, key: str, count: int, timeout: float = 15.0) -> list[str]:
        """等某个状态键至少报出 count 次。"""
        end = time.time() + timeout
        while time.time() < end:
            values = self.status_values(key)
            if len(values) >= count:
                return values
            time.sleep(0.05)
        raise TimeoutError(f"等状态键 {key} 报出第 {count} 次，等了 {timeout:.0f} 秒没有等到。")

    # ───────────── 读事实 ─────────────

    @property
    def db_path(self) -> Path:
        return self.workspace / "task.sqlite"

    def rows(self, sql: str, *args) -> list[dict]:
        """以只读方式查库。"""
        conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in conn.execute(sql, args)]
        finally:
            conn.close()

    def session_entries(self) -> list[dict]:
        """pi 的会话文件里的全部条目。"""
        files = sorted((self.root / "runs" / "pi-sessions" / self.label).glob("*.jsonl"))
        if not files:
            return []
        return [json.loads(line) for line in files[-1].read_text(encoding="utf-8").splitlines() if line.strip()]

    def requests(self) -> list[dict]:
        """假端点记下的请求。"""
        return self.fake.requests()


def tool_results(events: list[dict]) -> list[dict]:
    """一串事件里的工具执行结果：每项是 {"工具", "调用编号", "被拒", "文字"}。"""
    out = []
    for e in events:
        if e.get("type") != "tool_execution_end":
            continue
        result = e.get("result") or {}
        text = "".join(p.get("text", "") for p in (result.get("content") or []) if isinstance(p, dict))
        out.append({"工具": e.get("toolName"), "调用编号": e.get("toolCallId"),
                    "被拒": bool(e.get("isError")), "文字": text})
    return out


def message_texts(request: dict) -> list[tuple[str, str]]:
    """一个请求体里每条消息的（角色, 文字）。"""
    out = []
    for m in request["请求体"].get("messages") or []:
        content = m.get("content")
        text = content if isinstance(content, str) else "".join(
            p.get("text", "") for p in (content or []) if isinstance(p, dict))
        out.append((m.get("role"), text))
    return out


def call(name: str, arguments: dict, call_id: str | None = None) -> dict:
    """假端点脚本里的一个工具调用。"""
    one = {"name": name, "arguments": arguments}
    if call_id:
        one["id"] = call_id
    return one

