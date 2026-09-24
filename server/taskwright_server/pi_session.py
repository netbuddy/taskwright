"""会话类：启动 pi 的 RPC 模式，发话，读事件，判停，归档。

RPC 模式（remote procedure call mode，远程过程调用模式）是 pi 的一种运行方式：它不画界面，
改成按行收发 JSON——我们往它的标准输入写一行命令，它往标准输出写一行行事件。

这个类只做搬运与看护，不做判断：它不写任务数据库，不解读用户说的话，不评价模型的产出。

除了把 pi 的标准输出原样归档，它还在归档文件旁边写两份附带文件：

- 「后端补记」（同名，扩展名换成 `.backend.jsonl`）。里面放的是 pi 标准输出里根本没有、
  以前只打在终端上的那几件事：启动命令与扩展解析结果、这次实际激活的工具清单、
  每一轮开始时 pi 给的轮号与这次运行在 Langfuse 里那条运行记录的编号、
  后端往 pi 发过哪几条提示、自动应答过哪些界面请求、pi 的标准错误每一行、pi 退出时的退出码。
  没有这几样，事后就说不出「扩展到底加载了没有」「那次 pi 为什么没起来」「模型手上到底有哪几个工具」。
- 「收到时刻索引」（同名，扩展名换成 `.times.jsonl`）。归档文件的第 N 行，对应这个文件的第 N 行，
  记的是后端读到那一行的时刻。pi 的事件本身不带时刻，没有它就算不出一轮花了多久。
  原始事件流仍然保持 pi 输出的原样，一个字也不加。

用法：

    session = PiSession(profile, workspace, runs_dir)
    session.start()
    for event in session.send("把术语记成利益相关方"):
        ...          # 逐条拿到事件，自己挑怎么显示
    session.close()
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path

from taskwright_server import launch

#: 等一条命令的回应最多等这么久（秒）。超过就认为 pi 没反应。
RESPONSE_TIMEOUT = 60.0

#: 等 pi 进程退干净最多等这么久（秒）。
SHUTDOWN_TIMEOUT = 10.0

#: 需要我们回一个应答、否则 pi 会一直等下去的那几种界面请求。
DIALOG_METHODS = ("select", "confirm", "input", "editor")

#: 进程内那个只读小扩展往外报事实时用的两个状态栏键名。两边是一份约定：
#: 改这里要同时改 agent/src/hooks/report_to_backend.ts 里的同名常量。
ACTIVE_TOOLS_STATUS_KEY = "taskwright-active-tools"   # 这次实际激活的工具清单
TURN_STATUS_KEY = "taskwright-turn"                   # 每一轮开始时的轮号、时间戳与 Langfuse 运行记录编号

#: 打开会话时扩展追加的任务现状消息的类型名。与 agent/src/lib/task_status.ts 的 TASK_STATUS_CUSTOM_TYPE 是一份约定。
TASK_STATUS_CUSTOM_TYPE = "taskwright-task-status"

#: 会话类把扩展写进会话的自定义消息转成的事件类型。以后前端把它显示成一条系统说明。
SYSTEM_NOTE_EVENT = "system_note"

#: 扩展把启动时追加的任务现状消息报给后端用的状态栏键名。与 agent/src/hooks/task_status.ts 是一份约定。
#: 要它，是因为 pi 启动时先打开会话、后开始往标准输出写事件，那一刻追加的消息在事件流里没有 message_end。
TASK_STATUS_REPORT_KEY = "taskwright-task-status"


class PiExited(Exception):
    """pi 进程没了。附上它的标准错误原文，好让用户直接看到出了什么事。"""

    def __init__(self, returncode: int | None, stderr: str):
        self.returncode = returncode
        self.stderr = stderr
        tail = stderr.strip() or "（标准错误是空的，pi 什么也没说）"
        super().__init__(f"pi 进程已经退出，退出码 {returncode}。它的标准错误是：\n{tail}")


class PiSession:
    """一个 pi 子进程加它的一条会话。"""

    def __init__(self, profile: dict, workspace: Path, runs_dir: Path, label: str = "session"):
        self.profile = profile
        self.workspace = Path(workspace).resolve()
        self.runs_dir = Path(runs_dir).resolve()
        self.label = label
        self.process: subprocess.Popen | None = None
        self.command: list[str] = []
        #: 自动应答过的界面请求，每项是（方法名, 标题, 我们回了什么）。
        self.ui_requests: list[tuple[str, str, str]] = []
        #: 标准输出里出现过的、解析不成 JSON 的行，原样留着。
        self.bad_lines: list[str] = []
        #: 扩展写进会话的自定义消息转成的系统说明事件（例如打开会话时的任务现状消息），按先后排。
        #: send() 开头会清掉事件队列里上一句话的残留，所以另存一份在这里，打开会话后随时可取。
        self.system_notes: list[dict] = []
        self._events: queue.Queue = queue.Queue()
        self._responses: dict[str, queue.Queue] = {}
        self._stderr: list[str] = []
        self._write_lock = threading.Lock()
        self._counter = 0
        self._exited = threading.Event()
        self._archive = None
        self._archive_path: Path | None = None
        self._notes = None
        self._notes_path: Path | None = None
        self._times = None
        self._times_path: Path | None = None
        self._archived_lines = 0
        self._notes_lock = threading.Lock()
        self._exit_noted = False
        self._stderr_thread: threading.Thread | None = None

    # ───────────── 启动与关闭 ─────────────

    def start(self, session_file: Path | None = None) -> None:
        """启动 pi 子进程。给了 session_file 就让它接着那个会话文件往下跑。"""
        if self.process is not None and self.process.poll() is None:
            raise RuntimeError("这个会话的 pi 进程还在跑，不要重复启动。")
        session_dir = self.runs_dir / "pi-sessions" / self.label
        session_dir.mkdir(parents=True, exist_ok=True)
        events_dir = self.runs_dir / "pi-events"
        events_dir.mkdir(parents=True, exist_ok=True)
        self.command, env = launch.build_command(self.profile, self.workspace, session_dir, session_file)
        self._exit_noted = False
        self._archive_path = events_dir / f"{self.label}-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
        self._archive = self._archive_path.open("a", encoding="utf-8")
        self._notes_path = self._archive_path.with_suffix(".backend.jsonl")
        self._notes = self._notes_path.open("a", encoding="utf-8")
        self._times_path = self._archive_path.with_suffix(".times.jsonl")
        self._times = self._times_path.open("a", encoding="utf-8")
        self._archived_lines = 0
        self._exited.clear()
        self._events = queue.Queue()
        self._responses = {}
        self._stderr = []
        knowledge = launch.knowledge_snapshot(self.workspace, self.profile)
        self.process = subprocess.Popen(
            self.command, cwd=str(self.workspace), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self._note("启动", **launch.startup_record(self.profile, self.command),
                   任务目录=str(self.workspace),
                   接回的会话文件=str(session_file) if session_file else "",
                   是不是重启接回=session_file is not None,
                   归档文件=self._archive_path.name)
        threading.Thread(target=self._read_stdout, daemon=True).start()
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_thread.start()
        self._note("知识仓库摘要", **knowledge,
                   说明="启动 pi 之前那一刻，任务目录知识仓库与平台 skill 里每份文件的路径与内容摘要值；只记摘要值，不记内容。")
        self._note("上下文文件", **launch.context_file_candidates(self.command, self.workspace, env))
        self._note_loaded_skills()

    def _note_loaded_skills(self) -> None:
        """问 pi 这次实际加载了哪些 skill，记进后端补记。

        用的是 RPC 的 get_commands：它返回的命令里，来源是 skill 的那几项就是 pi 实际加载的 skill。
        pi 没有起来、或者这条命令没有回应时，如实记下取不到与原因，不让启动因此失败。
        """
        try:
            data = self.request("get_commands", timeout=30.0)
        except (PiExited, TimeoutError, RuntimeError) as error:
            self._note("已加载的 skill", 取得到吗=False, 为什么取不到=str(error), skill=[])
            return
        skills = [{"名字": str(c.get("name", "")).removeprefix("skill:"),
                   "描述": c.get("description", ""),
                   "文件": (c.get("sourceInfo") or {}).get("path", "")}
                  for c in data.get("commands") or [] if c.get("source") == "skill"]
        self._note("已加载的 skill", 取得到吗=True, 取法="RPC 的 get_commands，来源是 skill 的那几项", skill=skills)

    def close(self) -> None:
        """关掉 pi 子进程。先关它的标准输入让它自己退，等不及就强杀。"""
        if self.process is None:
            return
        try:
            if self.process.stdin and not self.process.stdin.closed:
                self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=SHUTDOWN_TIMEOUT)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=SHUTDOWN_TIMEOUT)
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=2.0)
        self._note_exit(self.process.poll())
        if self._archive is not None:
            self._archive.close()
            self._archive = None
        if self._notes is not None:
            self._notes.close()
            self._notes = None
        if self._times is not None:
            self._times.close()
            self._times = None
        self.process = None

    def restart(self, resume: bool = True) -> Path | None:
        """重启 pi。resume 为真时接回原来那条会话，返回接回的会话文件路径。

        用途是改了 pi 进程里的工具代码之后让新代码生效，同时不丢前面说过的话。
        """
        session_file = None
        if resume:
            state = self.get_state()
            raw = state.get("sessionFile")
            session_file = Path(raw) if raw else None
        self.close()
        self.start(session_file=session_file)
        return session_file

    def _note_received(self, line_number: int, received: float) -> None:
        """记下归档文件第几行是什么时候读到的。写进与归档并行的收到时刻索引文件。

        原始事件流一个字都不改：时刻单独存一份，按行号一一对应。
        """
        with self._notes_lock:
            if self._times is None:
                return
            try:
                self._times.write(json.dumps(
                    {"行号": line_number, "收到时刻": round(received, 3)},
                    ensure_ascii=False) + "\n")
                self._times.flush()
            except (OSError, ValueError):
                pass

    def _note_exit(self, code: int | None) -> None:
        """记一条 pi 退出的补记。不管是谁先发现进程没了，都只记一次。"""
        with self._notes_lock:
            if self._exit_noted:
                return
            self._exit_noted = True
        self._note("退出", 退出码=code, 标准错误=self.stderr_text.strip())

    def _note(self, kind: str, **fields) -> None:
        """往后端补记文件里写一行。写不进去也不能把会话带倒，所以这里把出错咽掉。"""
        line = json.dumps({"记录": kind, "时刻": time.strftime("%Y-%m-%dT%H:%M:%S"), **fields},
                          ensure_ascii=False, default=str)
        with self._notes_lock:
            if self._notes is None:
                return
            try:
                self._notes.write(line + "\n")
                self._notes.flush()
            except (OSError, ValueError):
                pass

    @property
    def notes_path(self) -> Path | None:
        """这次启动的后端补记写在哪个文件里。"""
        return self._notes_path

    @property
    def archive_path(self) -> Path | None:
        """这次启动的原始事件流归档在哪个文件里。"""
        return self._archive_path

    @property
    def stderr_text(self) -> str:
        return "".join(self._stderr)

    def alive(self) -> bool:
        return self.process is not None and self.process.poll() is None

    # ───────────── 两个读线程 ─────────────

    def _read_stdout(self) -> None:
        """一行一行读 pi 的标准输出：原样归档，再按类型分给三个去处。"""
        stream = self.process.stdout
        for raw in stream:
            received = time.time()
            line = raw.rstrip("\n").rstrip("\r")
            if self._archive is not None:
                self._archive.write(line + "\n")
                self._archive.flush()
                self._archived_lines += 1
                self._note_received(self._archived_lines, received)
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                # 标准输出里夹了非 JSON 的行。不当错误处理，原样留着并让调用方看得到。
                self.bad_lines.append(line)
                self._events.put({"type": "非JSON行", "line": line})
                continue
            kind = message.get("type")
            if kind == "response":
                slot = self._responses.get(str(message.get("id")))
                if slot is not None:
                    slot.put(message)
                else:
                    self._events.put(message)
            elif kind == "extension_ui_request":
                self._answer_ui_request(message)
                if message.get("method") == "setStatus" and message.get("statusKey") == TASK_STATUS_REPORT_KEY:
                    try:
                        reported = json.loads(message.get("statusText") or "{}")
                    except json.JSONDecodeError:
                        reported = {}
                    note = {"type": SYSTEM_NOTE_EVENT, "custom_type": TASK_STATUS_CUSTOM_TYPE,
                            "text": reported.get("text", ""), "details": reported.get("details"),
                            "entry_id": reported.get("entry_id"), "session_id": reported.get("session_id")}
                    self.system_notes.append(note)
                    self._note("扩展写入的消息", 类型=TASK_STATUS_CUSTOM_TYPE, 文字=note["text"],
                               会话条目编号=note["entry_id"], 会话编号=note["session_id"])
                    self._events.put(note)
            else:
                self._events.put(message)
                note = self._system_note_of(message)
                if note is not None and note["custom_type"] == TASK_STATUS_CUSTOM_TYPE:
                    note = None   # 任务现状消息一律以扩展经状态栏报来的那一份为准，免得会话中途换会话时记两次
                if note is not None:
                    self.system_notes.append(note)
                    self._note("扩展写入的消息", 类型=note["custom_type"], 文字=note["text"])
                    self._events.put(note)
        # 标准输出到头了，说明进程没了。先把退出码与标准错误记下来，再叫醒所有还在等的人。
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=2.0)
        code = None
        if self.process is not None:
            try:
                code = self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                code = self.process.poll()
        self._note_exit(code)
        self._exited.set()
        self._events.put(None)
        for slot in list(self._responses.values()):
            slot.put(None)

    @staticmethod
    def _system_note_of(message: dict) -> dict | None:
        """扩展写进会话的自定义消息（message_end 事件，角色是 custom）转成一条可识别的事件；别的事件返回 None。

        例如打开会话时的任务现状消息。它不是人打的字，也不触发运行；转成的事件形如
        {"type": "system_note", "custom_type": "taskwright-task-status", "text": …, "details": …}。
        """
        if message.get("type") != "message_end":
            return None
        body = message.get("message") or {}
        if body.get("role") != "custom":
            return None
        content = body.get("content")
        text = content if isinstance(content, str) else "".join(
            p.get("text", "") for p in (content or []) if isinstance(p, dict))
        return {"type": SYSTEM_NOTE_EVENT, "custom_type": str(body.get("customType") or ""),
                "text": text, "details": body.get("details")}

    def _read_stderr(self) -> None:
        for raw in self.process.stderr:
            self._stderr.append(raw)
            self._note("标准错误", 文字=raw.rstrip("\n"))

    # ───────────── 自动应答界面请求 ─────────────

    def _answer_ui_request(self, message: dict) -> None:
        """扩展要跟人交互时 pi 会发这种请求并一直等着。

        本类一律回一个「取消」或「否」，好让会话不卡死；回了什么都记下来，事后能查。
        不需要应答的那几种（提示、状态栏之类）只记录，不回。
        """
        method = str(message.get("method", ""))
        title = str(message.get("title", ""))
        status_key = str(message.get("statusKey", "")) if method == "setStatus" else ""
        if status_key == TURN_STATUS_KEY:
            # 小扩展在每一轮开始时报来的那几样事实。原样记下来，观测台据此显示 pi 给的轮号，
            # 并给这一轮拼一条直达 Langfuse 那条运行记录的链接。
            raw = str(message.get("statusText", ""))
            try:
                fact = json.loads(raw)
            except json.JSONDecodeError:
                fact = None
            self._note("本轮事实", 内容=fact, 原文=raw)
            self._events.put({"type": "本轮事实", "内容": fact})
            return
        if status_key == ACTIVE_TOOLS_STATUS_KEY:
            # 进程内那个只读小扩展把实际激活的工具清单经状态栏带出来了。原样记下来。
            raw = str(message.get("statusText", ""))
            try:
                tools = json.loads(raw)
            except json.JSONDecodeError:
                tools = None
            self._note("实际工具清单", 工具=tools, 原文=raw)
            self._events.put({"type": "实际工具清单", "工具": tools})
            return
        if method not in DIALOG_METHODS:
            self.ui_requests.append((method, title, "不需要应答，只记录"))
            self._note("界面请求应答", 方法=method, 标题=title,
                       要不要应答=False, 回了什么="不需要应答，只记录",
                       请求编号=message.get("id"))
            event = {"type": "界面请求", "method": method, "title": title, "answered": None}
            if method == "setStatus":
                # 扩展命令（/tw-user、/tw-ui）经状态栏回传结果；任务服务从事件队列里按键名认出它们。
                event["status_key"] = status_key
                event["status_text"] = str(message.get("statusText", ""))
            self._events.put(event)
            return
        if method == "confirm":
            reply = {"type": "extension_ui_response", "id": message.get("id"), "confirmed": False}
            answer = "回了「否」"
        else:
            reply = {"type": "extension_ui_response", "id": message.get("id"), "cancelled": True}
            answer = "回了「取消」"
        self.ui_requests.append((method, title, answer))
        self._note("界面请求应答", 方法=method, 标题=title,
                   要不要应答=True, 回了什么=answer, 请求编号=message.get("id"))
        self._write(reply)
        self._events.put({"type": "界面请求", "method": method, "title": title, "answered": answer})

    # ───────────── 发命令 ─────────────

    def _write(self, payload: dict) -> None:
        if self.process is None or self.process.stdin is None:
            raise PiExited(None, self.stderr_text)
        line = json.dumps(payload, ensure_ascii=False)
        with self._write_lock:
            try:
                self.process.stdin.write(line + "\n")
                self.process.stdin.flush()
            except (BrokenPipeError, ValueError):
                raise PiExited(self.process.poll(), self.stderr_text) from None

    def request(self, command: str, timeout: float = RESPONSE_TIMEOUT, **fields) -> dict:
        """发一条命令并等它的回应。回应里 success 为假时抛异常，带上 pi 给的原因。"""
        self._counter += 1
        request_id = f"{self.label}-{self._counter}"
        slot: queue.Queue = queue.Queue(maxsize=1)
        self._responses[request_id] = slot
        try:
            self._write({"id": request_id, "type": command, **fields})
            try:
                message = slot.get(timeout=timeout)
            except queue.Empty:
                raise TimeoutError(f"等 pi 回应命令「{command}」等了 {timeout:.0f} 秒还没等到。") from None
        finally:
            self._responses.pop(request_id, None)
        if message is None:
            raise PiExited(self.process.poll() if self.process else None, self.stderr_text)
        if not message.get("success", False):
            raise RuntimeError(f"pi 拒绝了命令「{command}」：{message.get('error', '没有给原因')}")
        return message.get("data") or {}

    def next_event(self, timeout: float | None = None) -> dict | None:
        """取下一条事件，不像 send() 那样清掉队列里的残留。给常驻的任务服务用：它有一个线程一直在取。

        超时返回 None；pi 进程没了时返回 {"type": "进程已退出"}。
        """
        try:
            event = self._events.get(timeout=timeout)
        except queue.Empty:
            return None
        return {"type": "进程已退出"} if event is None else event

    def get_state(self) -> dict:
        return self.request("get_state")

    def get_session_stats(self) -> dict:
        return self.request("get_session_stats")

    def abort(self) -> None:
        """中止当前这句话。pi 会等到它真的停下来才回应。"""
        self.request("abort", timeout=RESPONSE_TIMEOUT)

    def new_session(self) -> dict:
        """在同一个 pi 进程里另起一条会话，前面说过的话不再带着。"""
        return self.request("new_session")

    # ───────────── 发话 ─────────────

    def send(self, text: str):
        """把一句话发给 pi，然后逐条交出事件，直到这句话结束。

        这是一个生成器：调用方每拿到一条事件就可以立刻显示。
        以 agent_settled 事件判定结束，之后再用 get_state 确认没有正卡在压缩里。
        """
        if not self.alive():
            raise PiExited(self.process.poll() if self.process else None, self.stderr_text)
        while True:                       # 把上一句话残留的事件清掉，免得混进这一句
            try:
                self._events.get_nowait()
            except queue.Empty:
                break
        self._note("提示", 原文=text, 投递方式="后端经 RPC 的 prompt 命令提交",
                   下一条请求编号=f"{self.label}-{self._counter + 1}")
        self.request("prompt", message=text)
        while True:
            event = self._events.get()
            if event is None:
                raise PiExited(self.process.poll() if self.process else None, self.stderr_text)
            yield event
            if event.get("type") == "agent_settled":
                break
        state = self.get_state()
        if state.get("isCompacting"):
            # 还在压缩上下文，等它压完再把这句话算作结束。
            while True:
                event = self._events.get()
                if event is None:
                    raise PiExited(self.process.poll() if self.process else None, self.stderr_text)
                yield event
                if event.get("type") == "compaction_end":
                    break
