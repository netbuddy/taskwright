"""终端对话客户端：在命令行里跟 pi 对话。

用户打一句话回车，这句话原样发给 pi；过程中逐行显示模型说的话与每次工具调用；
这句话结束后打一行小结。以斜杠开头的是客户端自己的命令，不会发给 pi。

用法：

    python -m taskwright_server.chat <任务目录>
    python -m taskwright_server.chat <任务目录> --profile dev --label 试跑

开工前要设的环境变量见本目录的 README。
"""

from __future__ import annotations

import argparse
import json
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from taskwright_server import launch
from taskwright_observatory import dbshow
from taskwright_server.pi_session import PiExited, PiSession

#: 工具参数在一行里最多显示这么长。
ARG_LIMIT = 60

#: 工具返回的文字在一行里最多显示这么长。
RESULT_LIMIT = 90

#: 「回复」工具的名字。执行者对用户说的话都经它发出，客户端把它的参数完整显示出来，不截短。
REPLY_TOOL = "reply"

#: 这两个工具的结果怎样显示，只在 agent/src/lib/tool_render.ts 里写一份（pi 的终端界面也用它）；
#: 客户端经这个命令行入口调它，拿回排好的几行。
RENDERED_TOOLS = (REPLY_TOOL, "save_revision")
RENDER_SCRIPT = Path(__file__).resolve().parents[2] / "agent" / "src" / "cli" / "render.mts"

HELP = """可以直接打一句话回车，这句话会原样发给 pi。以下命令由客户端自己处理，不发给 pi：
  /state    看 pi 当前的状态（模型、会话文件、消息条数、是否在流式输出）
  /new      在同一个 pi 进程里另起一条会话，前面说过的话不再带着
  /abort    中止正在跑的那句话（说话过程中也可以打）
  /db       显示任务数据库里的内容，与 dbshow 打印的一样
  /restart  重启 pi 并接回原来这条会话（改了工具代码后用它让新代码生效）
  /events   打开或关掉「实时打印原始事件」
  /help     显示这段说明
  /quit     退出"""


def shorten(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + "…"


def summarize_arguments(args) -> str:
    if args is None:
        return "没有参数"
    if not isinstance(args, dict):
        return shorten(json.dumps(args, ensure_ascii=False), ARG_LIMIT)
    parts = [f"{k}={shorten(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False), ARG_LIMIT)}"
             for k, v in args.items()]
    return "，".join(parts)


def render_tool(tool: str, is_error: bool, text: str, details, args, workspace: Path | None) -> list[str] | None:
    """调 agent 的排版函数，把「回复」或「保存修订」的一次结果排成几行。调不动时返回 None，由调用方退回一行摘要。"""
    node = shutil.which("node")
    if not node:
        return None
    payload = {"tool": tool, "is_error": is_error, "text": text, "details": details or {}, "args": args or {},
               "workspace": str(workspace) if workspace else ""}
    try:
        done = subprocess.run([node, str(RENDER_SCRIPT)], input=json.dumps(payload, ensure_ascii=False),
                              capture_output=True, text=True, timeout=30)
        lines = json.loads(done.stdout) if done.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None
    return lines if isinstance(lines, list) else None


class Printer:
    """把事件变成给人看的几行字。只管显示，不改变任何状态。"""

    def __init__(self, show_events: bool = False, workspace: Path | None = None):
        self.show_events = show_events
        #: 任务目录。「保存修订」的显示要读库取条目标题。
        self.workspace = workspace
        self.model_calls = 0
        self.tool_calls = 0
        self._in_text = False
        #: 工具的参数只在 tool_execution_start 里出现，先按调用编号记下来，结束时再显示。
        self._pending_args: dict[str, object] = {}
        #: 这句话里已经见过几条用户消息。第一条是用户自己说的；之后再出现的，是扩展追加的（例如兜底）。
        self._user_messages = 0

    def reset(self) -> None:
        self.model_calls = 0
        self.tool_calls = 0
        self._in_text = False
        self._pending_args = {}
        self._user_messages = 0

    def handle(self, event: dict) -> None:
        kind = event.get("type")
        if self.show_events:
            print(f"\n[事件] {json.dumps(event, ensure_ascii=False)[:400]}")
        if kind == "message_update":
            delta = event.get("assistantMessageEvent") or {}
            if delta.get("type") == "text_delta":
                if not self._in_text:
                    print("模型：", end="", flush=True)
                    self._in_text = True
                print(delta.get("delta", ""), end="", flush=True)
            elif delta.get("type") == "text_end" and self._in_text:
                print()
                self._in_text = False
        elif kind == "message_end":
            message = event.get("message") or {}
            if message.get("role") == "user":
                self._user_messages += 1
                if self._user_messages > 1:
                    # 同一句话里又出现一条用户消息：它不是用户打的字，是扩展追加的（兜底或排队的话）。
                    content = message.get("content")
                    text = content if isinstance(content, str) else "".join(
                        p.get("text", "") for p in (content or []) if isinstance(p, dict))
                    print(f"  【扩展追加了一句话】{text}")
            if message.get("role") == "assistant":
                self.model_calls += 1
                if self._in_text:
                    print()
                    self._in_text = False
        elif kind == "tool_execution_start":
            self._pending_args[str(event.get("toolCallId"))] = event.get("args")
        elif kind == "tool_execution_end":
            self.tool_calls += 1
            if self._in_text:
                print()
                self._in_text = False
            result = event.get("result") or {}
            content = result.get("content") or [{}]
            text = content[0].get("text", "") if content else ""
            mark = "被拒绝" if event.get("isError") else "成功"
            args = self._pending_args.pop(str(event.get("toolCallId")), None)
            if event.get("toolName") in RENDERED_TOOLS:
                full = "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
                lines = render_tool(event.get("toolName"), bool(event.get("isError")), full,
                                    result.get("details"), args, self.workspace)
                if lines is not None:
                    print("\n".join(lines))
                    return
                print("  【提醒】调不动 agent 的排版函数（本机要有 node），下面只显示一行摘要。")
            print(f"  工具 {event.get('toolName')}（{summarize_arguments(args)}）{mark}："
                  f"{shorten(text, RESULT_LIMIT)}")
        elif kind == "非JSON行":
            print(f"  【提醒】pi 的标准输出里有一行不是 JSON，已原样归档：{shorten(event.get('line',''), 120)}")
        elif kind == "界面请求":
            # 状态栏、提示条这类不需要应答的请求不打扰用户，只在打开 /events 时才显示。
            if event.get("answered"):
                print(f"  【提醒】扩展要跟人交互（{event.get('method')}：{event.get('title')}），"
                      f"客户端替你{event.get('answered')}。")
        elif kind == "extension_error":
            print(f"  【扩展出错】{shorten(json.dumps(event, ensure_ascii=False), 300)}")


class Chat:
    def __init__(self, workspace: Path, profile_name: str, label: str):
        self.workspace = Path(workspace).expanduser().resolve()
        self.profile = launch.load_profile(profile_name)
        self.session = PiSession(self.profile, self.workspace, launch.runs_dir(), label=label)
        self.printer = Printer(workspace=self.workspace)
        self.settings = launch.observability_settings(self.profile)
        self.lines: queue.Queue = queue.Queue()
        self.stopped = threading.Event()
        self.pending_abort = False
        #: 会话类的 system_notes 里已经打印过前几条。
        self.notes_shown = 0

    # ───────────── 读键盘的线程 ─────────────

    def _read_input(self) -> None:
        """一直读键盘。这样在 pi 正说话的时候也能打 /abort。"""
        for line in sys.stdin:
            self.lines.put(line.rstrip("\n"))
        self.lines.put(None)

    # ───────────── 启动与主循环 ─────────────

    def start(self) -> None:
        self.session.start()
        print(f"任务目录：{self.workspace}")
        print(f"启动 pi：{launch.redact(self.session.command)}")
        for name, path in launch.describe_extensions(self.profile):
            print(f"  扩展「{name}」：{'没有加载' if path is None else path}")
        if self.settings["environment"]:
            print(f"  观测数据的环境标签：{self.settings['environment']}")
        if self.session.archive_path:
            print(f"  原始事件流归档到：{self.session.archive_path}")
        state = self.session.get_state()
        print(f"  会话文件：{state.get('sessionFile')}")
        self.session_link(state)
        print()
        print(HELP)
        print()
        self.show_system_notes()

    def show_system_notes(self) -> None:
        """打印扩展新写进会话的系统说明，例如打开会话时的任务现状消息（经状态栏键 taskwright-task-status 报来）。

        与 pi 终端界面一样，先写消息的类型名，再写正文；这类消息是扩展写的，不是用户打的字。
        """
        notes = self.session.system_notes
        for note in notes[self.notes_shown:]:
            print(f"[{note.get('custom_type') or '系统说明'}]")
            print(note.get("text", ""))
            print()
        self.notes_shown = len(notes)

    def session_link(self, state: dict) -> None:
        base, project = self.settings["base_url"], self.settings["project_id"]
        session_id = state.get("sessionId")
        if base and project and session_id:
            print(f"  Langfuse 里这条会话：{base}/project/{project}/sessions/{session_id}")
        elif not (base and project):
            print("  没有设 Langfuse 的服务地址或项目编号，所以不显示记录链接。")

    def run(self) -> int:
        threading.Thread(target=self._read_input, daemon=True).start()
        try:
            self.start()
            while not self.stopped.is_set():
                print("你：", end="", flush=True)
                line = self.lines.get()
                if line is None:
                    print()
                    break
                text = line.strip()
                if not text:
                    continue
                if text.startswith("/"):
                    if self.command(text):
                        break
                    continue
                self.say(text)
        except PiExited as error:
            # pi 没了。把它的标准错误原样打给用户，然后干净地退出，不留 Python 堆栈。
            print(f"\n{error}")
            return 1
        except TimeoutError as error:
            print(f"\n{error}")
            return 1
        finally:
            self.session.close()
        return 0

    # ───────────── 说一句话 ─────────────

    def say(self, text: str) -> None:
        self.printer.reset()
        started = time.monotonic()
        aborted = False
        try:
            for event in self.session.send(text):
                self.printer.handle(event)
                self.drain_input_during_prompt()
                if self.pending_abort:
                    self.pending_abort = False
                    aborted = True
                    self.session.abort()
                    print("\n  已中止这句话。")
        except PiExited:
            raise
        except TimeoutError as error:
            print(f"\n  【超时】{error}")
        elapsed = time.monotonic() - started
        print(f"  小结：{self.printer.model_calls} 次模型请求，{self.printer.tool_calls} 次工具调用，"
              f"耗时 {elapsed:.1f} 秒{'（这句话是被中止的）' if aborted else ''}。")
        self.show_system_notes()
        try:
            self.session_link(self.session.get_state())
        except (PiExited, TimeoutError):
            pass

    def drain_input_during_prompt(self) -> None:
        """pi 正说话时也看一眼键盘：只认 /abort，别的话提示稍等。"""
        while True:
            try:
                line = self.lines.get_nowait()
            except queue.Empty:
                return
            if line is None:
                self.stopped.set()
                return
            text = line.strip()
            if text == "/abort":
                self.pending_abort = True
            elif text:
                print(f"\n  【提醒】pi 还在说这一句，先没把「{shorten(text, 40)}」发出去。"
                      f"等它说完再打一次，或者打 /abort 中止。")

    # ───────────── 客户端自己的命令 ─────────────

    def command(self, text: str) -> bool:
        """处理以斜杠开头的命令。返回真表示该退出了。"""
        name = text.split()[0]
        if name == "/quit":
            return True
        if name == "/help":
            print(HELP)
        elif name == "/state":
            state = self.session.get_state()
            print(f"  模型 {(state.get('model') or {}).get('id')}，会话 {state.get('sessionId')}，"
                  f"消息 {state.get('messageCount')} 条，正在流式输出：{state.get('isStreaming')}，"
                  f"正在压缩：{state.get('isCompacting')}")
            print(f"  会话文件：{state.get('sessionFile')}")
            self.session_link(state)
        elif name == "/new":
            self.session.new_session()
            print("  已另起一条会话，前面说过的话不再带着。")
            self.session_link(self.session.get_state())
            self.show_system_notes()
        elif name == "/abort":
            self.session.abort()
            print("  已发出中止。")
        elif name == "/db":
            # 与 python -m taskwright_observatory.dbshow <任务目录> 打印的一样；新旧两种格式与「还没有库」都由它分辨。
            try:
                dbshow.main([str(self.workspace)])
            except SystemExit as error:
                print(f"  {error}")
                return False
        elif name == "/restart":
            resumed = self.session.restart(resume=True)
            print(f"  已重启 pi，接回的会话文件是 {resumed}。")
            print(f"  新的事件流归档到：{self.session.archive_path}")
            self.session_link(self.session.get_state())
            self.show_system_notes()
        elif name == "/events":
            self.printer.show_events = not self.printer.show_events
            print(f"  实时打印原始事件：{'开' if self.printer.show_events else '关'}")
        else:
            print(f"  没有「{name}」这个命令。打 /help 看有哪些。")
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="在命令行里跟 pi 对话。")
    parser.add_argument("workspace", help="任务目录。里面还没有 task.sqlite 也可以，执行者创建任务时才建库")
    parser.add_argument("--profile", default="dev", help="用哪份启动配置，默认 dev")
    parser.add_argument("--label", default="chat", help="这次对话的名字，用来给归档文件命名，默认 chat")
    args = parser.parse_args(argv)
    try:
        return Chat(Path(args.workspace), args.profile, args.label).run()
    except launch.LaunchError as error:
        print(f"启动不了：{error}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
