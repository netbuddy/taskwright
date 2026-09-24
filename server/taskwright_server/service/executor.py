"""执行者看护：每个任务一个。它启动、续接、切换 pi 会话，一个线程一直读 pi 的事件流，拼成过程与对话类事件
（docs/api.md §3.2）交给事件分发（hub），并把用户的话与界面操作转交给 pi。它不写库，不解读用户的话。

同一任务同一时刻只有一条活动会话（pi 进程一次只接一条会话）：执行者在会话 A 里工作时，对会话 B 的请求
返回 session_busy；空闲时切换会话即让 pi 接上另一条会话文件（RPC 的 switch_session）。

对话严格轮替与单一写入者：用户的一句话或一次直接操作是一个动作，执行者的一次运行是一个动作，同一时刻只进行一个。
执行者工作中收到说话、卡片点击或直接操作，一律返回 session_busy（data.reason 为 working），不交给 pi 排队
（不用 prompt 的 followUp），所以 pi 的排队与插话在这里用不上；前端这时本就灰化了发送与写入按钮，这里是后端的保证。
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from taskwright_observatory import taskdb
from taskwright_server.pi_session import PiExited, PiSession
from taskwright_server.service import clock, conversation, work_summary
from taskwright_server.service.errors import ApiError

LABEL = "service"
USER_RESULT_KEY = "taskwright-user-result"
UI_RESULT_KEY = "taskwright-ui-result"
WRITE_TOOLS = {"save_revision", "create_task", "complete_task"}
REPLY_TOOL = "reply"
ACTION_TIMEOUT = 10.0
#: 用户消息的 message_end 到达时，这条消息可能还没写进会话记录（卡片点击那句话由扩展排到运行里，写入更晚）。
#: 查不到它的条目编号就隔一会儿再取一次，最多取这么多次；每次间隔 ENTRY_RETRY_DELAY 秒，合计约半秒。
ENTRY_RETRIES = 10
ENTRY_RETRY_DELAY = 0.05
STATE_TEXT = {
    "not_started": "助手还没有启动。",
    "starting": "助手正在启动。",
    "idle": "助手空闲，可以开始。",
    "working": "助手正在做事。",
    "exited": "助手已经退出，下一次说话时会重新启动。",
    "failed_to_start": "助手没有启动起来。",
}


def new_id(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:12]}"


#: 「先不管这条」之后发给执行者的固定模板。前缀用来把这句话认成界面操作之后发的话。
KEEP_PENDING_NOTICE_PREFIX = "我先不管 "


def keep_pending_notice(item_ids: str) -> str:
    return f"{KEEP_PENDING_NOTICE_PREFIX}{item_ids}，请接着往下做。"


class Executor:
    def __init__(self, task_id: str, task_dir: Path, runs_dir: Path, profile: dict, hub):
        self.task_id = task_id
        self.task_dir = Path(task_dir)
        self.runs_dir = Path(runs_dir) / task_id
        self.profile = profile
        self.hub = hub
        self.lock = threading.RLock()
        self.pi: PiSession | None = None
        self.state = "not_started"
        self.detail = ""
        self.active_session: str | None = None
        self.session_files: dict[str, Path] = {}
        self.cursor: str | None = None
        self.work: dict | None = None
        self.waiters: dict[str, dict] = {}
        self.pending_clients: deque = deque()      # （发给 pi 的原文, client_id），按先后
        self.pending_origin: dict[str, str] = {}   # 发给 pi 的原文 → origin（ui_request 之类）
        self.named: set[str] = set()
        self.last_click: dict | None = None
        self.last_user_entry: str | None = None   # 上一次认出条目编号的那条用户消息
        self._pump: threading.Thread | None = None

    # ───────────── 会话文件 ─────────────

    @property
    def session_dir(self) -> Path:
        return self.runs_dir / "pi-sessions" / LABEL

    def list_sessions(self) -> list[dict]:
        rows = []
        seen = set()
        if self.session_dir.is_dir():
            for path in sorted(self.session_dir.glob("*.jsonl")):
                info = conversation.session_info(path)
                if not info["session_id"]:
                    continue
                self.session_files[info["session_id"]] = path
                seen.add(info["session_id"])
                rows.append(info)
        # 刚新建、还没有助手消息的会话，pi 还没把文件写出来；活动会话照样列出来。
        if self.active_session and self.active_session not in seen:
            rows.append({"session_id": self.active_session, "name": None, "started_at": None, "last_active_at": None,
                         "message_count": 0, "file": str(self.session_files.get(self.active_session, ""))})
        for row in rows:
            row["active"] = row["session_id"] == self.active_session and self.running()
            row.pop("file", None)
        return rows

    def session_file(self, session_id: str) -> Path | None:
        if session_id not in self.session_files:
            self.list_sessions()
        return self.session_files.get(session_id)

    # ───────────── 状态 ─────────────

    def running(self) -> bool:
        return self.pi is not None and self.pi.alive()

    def set_state(self, state: str, detail: str = "") -> None:
        self.state = state
        self.detail = detail
        self.hub.emit("executor_state", {"state": state, "text": STATE_TEXT.get(state, "") + (f"（{detail}）" if detail else ""),
                                         "active_session": self.active_session, "at": clock.now()})

    def view(self) -> dict:
        state = self.state if (self.running() or self.state in ("not_started", "failed_to_start", "starting")) else "exited"
        return {"state": state, "text": STATE_TEXT.get(state, ""), "active_session": self.active_session}

    # ───────────── 启动、续接、切换、新建 ─────────────

    def _start(self, session_file: Path | None) -> None:
        self.set_state("starting")
        pi = PiSession(self.profile, self.task_dir, self.runs_dir, LABEL)
        try:
            pi.start(session_file=session_file)
            state = pi.get_state()
        except Exception as error:     # pi 没起来：如实给出原因
            detail = (pi.stderr_text or str(error)).strip()[-500:]
            try:
                pi.close()
            except Exception:
                pass
            self.pi = None
            self.set_state("failed_to_start", detail)
            raise ApiError("executor_unavailable", "助手现在不可用。", {"detail": detail})
        self.pi = pi
        self._adopt(state)
        self.cursor = None
        self._pump = threading.Thread(target=self._pump_loop, args=(pi,), daemon=True)
        self._pump.start()
        self.set_state("idle")

    def _adopt(self, state: dict) -> None:
        self.active_session = state.get("sessionId")
        if state.get("sessionFile") and self.active_session:
            self.session_files[self.active_session] = Path(state["sessionFile"])

    def open_session(self, session_id: str) -> None:
        """打开一条会话：pi 没在跑就启动并续接它；在跑、接着别的会话、并且空闲时切过去；正在工作时返回 session_busy。"""
        with self.lock:
            if self.state == "starting":
                raise ApiError("executor_starting", "助手正在启动，请稍候。")
            if self.running() and self.active_session == session_id:
                return
            path = self.session_file(session_id)
            if path is None or not path.is_file():
                raise ApiError("not_found", f"这个任务里没有会话 {session_id}。")
            if not self.running():
                self._start(path)
                return
            self._busy_check(session_id)
            self.pi.request("switch_session", sessionPath=str(path))
            self._adopt(self.pi.get_state())
            self.cursor = None
            self.set_state("idle")

    def new_session(self) -> str:
        with self.lock:
            if self.state == "starting":
                raise ApiError("executor_starting", "助手正在启动，请稍候。")
            if not self.running():
                self._start(None)
            else:
                self._busy_check(None)
                self.pi.request("new_session")
                self._adopt(self.pi.get_state())
                self.cursor = None
                self.set_state("idle")
            return self.active_session

    def _busy_check(self, session_id: str | None) -> None:
        if self.state == "working" and self.active_session != session_id:
            raise ApiError("session_busy", "助手正在另一条会话里工作，做完才能在这里继续。", {"active_session": self.active_session})

    def require(self, session_id: str | None, start: bool) -> None:
        """说话与界面操作之前：会话要是活动的那条；start 为真时 pi 不在就按需启动（说话），否则失败（界面操作）。"""
        with self.lock:
            if self.state == "starting":
                raise ApiError("executor_starting", "助手正在启动，请稍候。")
            if not self.running():
                if not start:
                    raise ApiError("executor_unavailable", "助手现在不可用，界面操作要在助手启动之后才能做。",
                                   {"detail": self.detail or "pi 没有在跑"})
                if session_id:
                    self.open_session(session_id)
                else:
                    self._start(None)
                return
            if session_id and session_id != self.active_session:
                self._busy_check(session_id)
                self.open_session(session_id)

    def close(self) -> None:
        with self.lock:
            if self.pi is not None:
                self.pi.close()
                self.pi = None
            self.set_state("exited")

    # ───────────── 说话、卡片点击、界面操作、停下 ─────────────

    def _turn_check(self, what: str = "say") -> None:
        """执行者正在工作时不接下一句话，也不接直接操作（docs/api.md §5.1、§6）。在会话锁里调用。"""
        if self.state == "working":
            text = ("助手正在工作，这一轮做完之后才能发下一句。你可以先把话打好。" if what == "say"
                    else "助手正在工作，结束后你可以继续修改。")
            raise ApiError("session_busy", text, {"active_session": self.active_session, "reason": "working"})

    def say(self, session_id: str | None, text: str, client_id: str | None, original: str | None = None) -> bool:
        """把用户的一句话交给 pi。执行者正在工作时返回 session_busy（对话严格轮替），所以返回值恒为 False（没有排队）。
        text 是发给 pi 的文字；它与用户原来打的字不同时（斜杠改写、附上材料路径），两者都记进归档的后端补记。"""
        self.require(session_id, start=True)
        with self.lock:
            self._turn_check()
            if original is not None and original != text:
                self.pi._note("提示改写", 原文=original, 改写后=text, 依据="docs/api.md §5.1：斜杠开头加「用户说：」；附件按第 7 节模板附上路径")
            self.pending_clients.append((text, client_id))
            try:
                self.pi.request("prompt", message=text)
            except (PiExited, RuntimeError) as error:
                raise ApiError("executor_unavailable", "助手现在不可用。", {"detail": str(error)})
        return False

    def card_click(self, session_id: str | None, text: str, client_id: str | None, annotation: dict) -> bool:
        """卡片上需要执行者再出力的点击：经扩展命令 /tw-ui 先追加标注、再发模板句。"""
        self.require(session_id, start=True)
        op_id = new_id("ui-op-")
        command = {"op_id": op_id, "reply_entry": annotation.get("reply_message_id"), "option_key": annotation.get("option_key"),
                   "option_text": annotation.get("option_text"), "text": text}
        with self.lock:
            self._turn_check()
            self.pending_clients.append((text, client_id))
        result = self._command("/tw-ui", command, op_id)
        if not result.get("ok"):
            error = result.get("error") or {}
            raise ApiError(error.get("code", "bad_request"), error.get("message", "卡片点击没有转交成功。"), error.get("data") or {})
        return False

    def action(self, session_id: str | None, body: dict) -> str:
        """用户的直接操作：经扩展命令 /tw-user 写库；返回操作编号，拒绝时抛 ApiError。"""
        self.require(session_id, start=False)
        # 单一写入者规则管的是交付物内容。打开详情写已读（mark_viewed 且不通知执行者）不改内容，是唯一的例外：
        # 执行者工作中也照写，免得用户这时看过的条目一直显示未读。卡片上点「这几条都看过了」要通知执行者，照旧受限。
        viewing = body.get("kind") == "mark_viewed" and not body.get("notify_executor")
        if not viewing:
            with self.lock:
                self._turn_check("action")
        op_id = new_id("ui-op-")
        command = {k: body.get(k) for k in ("kind", "task_id", "targets", "fields", "notify_executor") if k in body}
        command["op_id"] = op_id
        if command.get("notify_executor"):
            self.pending_origin["我已经看过了："] = "ui_request"
            self.pending_origin[KEEP_PENDING_NOTICE_PREFIX] = "ui_request"
        result = self._command("/tw-user", command, op_id)
        if not result.get("ok"):
            error = result.get("error") or {}
            raise ApiError(error.get("code", "rejected"), error.get("message", "这次操作没有通过。"), error.get("data") or {})
        self.hub.trigger()
        if command.get("kind") == "keep_pending" and command.get("notify_executor"):
            # 「先不管这条」之后按固定模板告诉执行者（固定模板见 docs/api.md）。确认之后的那句由扩展命令发，
            # 先不管这一种扩展命令不发，所以在这里发；写库已经在上面的扩展命令里完成，这里只是一句话。
            ids = "、".join(str(t.get("item_id")) for t in command.get("targets") or [] if t.get("item_id"))
            self.say(session_id, keep_pending_notice(ids), None)
        return op_id

    def _command(self, name: str, command: dict, op_id: str) -> dict:
        waiter = {"event": threading.Event(), "result": None}
        self.waiters[op_id] = waiter
        try:
            with self.lock:
                if not self.running():
                    raise ApiError("executor_unavailable", "助手现在不可用。", {"detail": "pi 没有在跑"})
                self.pi.request("prompt", message=f"{name} " + json.dumps(command, ensure_ascii=False))
            if not waiter["event"].wait(ACTION_TIMEOUT):
                raise ApiError("busy_timeout", "这次操作没有在 10 秒内得到结果，请稍后看是否已经生效。", {"op_id": op_id})
            return waiter["result"] or {}
        finally:
            self.waiters.pop(op_id, None)

    def stop(self, session_id: str | None) -> list[str]:
        with self.lock:
            if not self.running():
                return []
            if session_id and session_id != self.active_session:
                raise ApiError("session_busy", "助手正在另一条会话里工作。", {"active_session": self.active_session})
            cleared = self.pi.request("clear_queue") or {}
            if self.work is not None:
                self.work["stopped"] = True
            self.pi.request("abort")
        texts = list(cleared.get("steering") or []) + list(cleared.get("followUp") or [])
        return [conversation.display_text(t) for t in texts]

    # ───────────── 对话记录 ─────────────

    def entries(self, session_id: str) -> list[dict]:
        """一条会话的全部条目：pi 在跑且接着它时用 get_entries，否则直接读会话文件。"""
        with self.lock:
            if self.running() and self.active_session == session_id:
                try:
                    return list((self.pi.request("get_entries") or {}).get("entries") or [])
                except (PiExited, RuntimeError, TimeoutError):
                    pass
        path = self.session_file(session_id)
        return conversation.read_session_file(path) if path and path.is_file() else []

    def current_work(self, session_id: str) -> dict | None:
        work = self.work
        if not work or self.active_session != session_id:
            return None
        return {"work_id": work["work_id"], "started_at": work["started_at"], "triggered_by": work["triggered_by"],
                "steps": list(work["steps"].values())}

    # ───────────── 读 pi 事件流 ─────────────

    def _pump_loop(self, pi: PiSession) -> None:
        while True:
            event = pi.next_event(timeout=1.0)
            if event is None:
                if not pi.alive():
                    break
                continue
            if event.get("type") == "进程已退出":
                break
            try:
                self._handle(pi, event)
            except Exception as error:      # 一条事件拼坏了不能让整个看护停下
                pi._note("任务服务拼事件出错", 事件类型=event.get("type"), 原因=str(error))
        with self.lock:
            if self.pi is pi:
                self.pi = None
                self.set_state("exited", "pi 进程退出了")

    def _fetch_new_entries(self, pi: PiSession) -> list[dict]:
        try:
            data = pi.request("get_entries", since=self.cursor) if self.cursor else pi.request("get_entries")
        except (PiExited, RuntimeError, TimeoutError):
            data = pi.request("get_entries")
        entries = list((data or {}).get("entries") or [])
        if entries:
            self.cursor = entries[-1]["id"]
        return entries

    def _handle(self, pi: PiSession, event: dict) -> None:
        kind = event.get("type")
        sid = self.active_session
        if kind == "agent_start":
            if self.work is None:
                self.work = {"work_id": new_id("work-"), "started": time.time(), "started_at": clock.now(), "triggered_by": None,
                             "announced": False, "steps": {}, "step_count": 0, "turn": 0, "turn_tools": [], "replied": False,
                             "stopped": False, "failed": False, "last_text": None, "last_user_id": None, "replied_since_user": True}
                self.set_state("working")
            return
        if kind == "本轮事实":
            fact = event.get("内容") or {}
            if self.work is not None and isinstance(fact.get("turnIndex"), int):
                self.work["turn"] = fact["turnIndex"]
            return
        if kind == "turn_start":
            if self.work is not None:
                self.work["turn_tools"] = []
            return
        if kind == "message_end":
            self._message_end(pi, event.get("message") or {}, sid)
            return
        if kind == "tool_execution_start":
            self._announce_work(sid)
            self._tool_start(event, sid)
            return
        if kind == "tool_execution_end":
            self._tool_end(event, sid)
            return
        if kind == "turn_end":
            self._turn_end(sid)
            return
        if kind == "auto_retry_start":
            self.hub.emit("problem", {"session_id": sid, "code": "model_unavailable",
                                      "text": f"模型服务暂时不可用，正在第 {event.get('attempt')} 次重试。",
                                      "retry": {"attempt": event.get("attempt"), "delay_ms": event.get("delayMs")}})
            return
        if kind == "agent_settled":
            self._settled(pi, sid)
            return
        if kind == "system_note":
            # 会话类把扩展写进会话的自定义消息都转成 system_note；只有任务现状消息算系统说明，
            # 界面操作的通知（taskwright-user-edit）已经在 message_end 里转成 ui_action_noted，这里不再重复。
            if event.get("custom_type") != conversation.TASK_STATUS:
                return
            self.hub.emit("system_note", {"session_id": event.get("session_id") or sid, "message_id": event.get("entry_id"),
                                          "at": clock.now(), "text": event.get("text", "")})
            return
        if kind == "界面请求" and event.get("method") == "setStatus":
            key = event.get("status_key")
            if key in (USER_RESULT_KEY, UI_RESULT_KEY):
                try:
                    result = json.loads(event.get("status_text") or "{}")
                except json.JSONDecodeError:
                    result = {}
                waiter = self.waiters.get(result.get("op_id") or "")
                if waiter is not None:
                    waiter["result"] = result
                    waiter["event"].set()
                if key == USER_RESULT_KEY and result.get("ok"):
                    self.hub.trigger()
            return

    def _announce_work(self, sid: str | None) -> None:
        work = self.work
        if work is not None and not work["announced"]:
            work["announced"] = True
            self.hub.emit("work_started", {"session_id": sid, "work_id": work["work_id"], "at": work["started_at"],
                                           "triggered_by": work["triggered_by"]})

    def _message_end(self, pi: PiSession, message: dict, sid: str | None) -> None:
        role = message.get("role")
        if role == "user" and conversation.text_of(message.get("content")) == conversation.FALLBACK_TEXT:
            # 兜底扩展追加的那句固定文字：转成 system_note，不当作用户的话。
            raw = conversation.FALLBACK_TEXT
            entries = self._fetch_new_entries(pi)
            hit = next((e for e in reversed(entries) if e.get("type") == "message"
                        and (e.get("message") or {}).get("role") == "user"
                        and conversation.text_of((e.get("message") or {}).get("content")) == raw), None)
            self.hub.emit("system_note", {"session_id": sid, "message_id": hit.get("id") if hit else None, "at": clock.now(),
                                          "text": conversation.fallback_note_text(raw)})
            return
        if role == "user":
            raw = conversation.text_of(message.get("content"))
            entries = self._fetch_new_entries(pi)
            hit = self._user_entry(entries, raw)
            # 按「上次取到的位置之后」没找到时，到全部条目里找：前一条界面操作的说明取条目时可能已经把这句话一并取走、
            # 游标越过了它；这句话也可能还没写进会话记录（卡片点击、界面操作之后的那句话由扩展排进运行，写入更晚），
            # 那就隔一会儿再取，最多约半秒。只在上一次认过的那条用户消息之后找，免得认回更早说过的同一句话；
            # 实在找不到就用不上确定的工作编号（刷新后仍能从会话文件重算）。
            for attempt in range(ENTRY_RETRIES + 1 if hit is None else 0):
                if attempt:
                    time.sleep(ENTRY_RETRY_DELAY)
                try:
                    everything = self._fetch_all_entries(pi)
                except (PiExited, RuntimeError, TimeoutError):
                    break
                ids = [e.get("id") for e in everything]
                start = ids.index(self.last_user_entry) + 1 if self.last_user_entry in ids else 0
                hit = self._user_entry(everything[start:], raw)
                if hit is not None:
                    entries = everything
                    break
            if hit is not None:
                self.last_user_entry = hit.get("id")
            click = next((e for e in reversed(entries) if e.get("type") == "custom_message" and e.get("customType") == conversation.UI_CLICK
                          and (e.get("details") or {}).get("text") == raw), None)
            if click is None and self.last_click and (self.last_click.get("details") or {}).get("text") == raw:
                click = self.last_click     # 标注早一步到、条目已经在上一次取编号时取过了
            self.last_click = None
            client_id = None
            for n, (text, cid) in enumerate(self.pending_clients):
                if text == raw:
                    client_id = cid
                    del self.pending_clients[n]
                    break
            origin, annotation = "typed", None
            if click is not None:
                d = click.get("details") or {}
                origin = "card_choice"
                annotation = {"reply_message_id": d.get("reply_entry"), "option_key": d.get("option_key"),
                              "option_text": d.get("option_text"), "click_message_id": click.get("id")}
            elif any(raw.startswith(p) for p in self.pending_origin):
                origin = "ui_request"
            message_id = hit.get("id") if hit else None
            self.hub.emit("user_message", {"session_id": sid, "message_id": message_id, "at": clock.now(),
                                           "text": conversation.display_text(raw), "origin": origin, "annotation": annotation,
                                           "queued": False, "client_id": client_id})
            if self.work is not None:
                if self.work["triggered_by"] is None:
                    self.work["triggered_by"] = message_id
                    # 工作编号改用触发它的那句话的会话条目编号，与刷新后从会话文件算出的编号一致（work_summary.py）。
                    # 这一轮的工作还没有推出去（work_started 在这之后才发）时才改，推出去之后编号不再变。
                    if message_id and not self.work["announced"]:
                        self.work["work_id"] = f"w-{message_id}"
                self.work["last_user_id"] = message_id
                self.work["replied_since_user"] = False
                self.work["last_text"] = None
                self._announce_work(sid)
            if sid and sid not in self.named and raw.strip():
                self._maybe_name(pi, sid, conversation.display_text(raw))
            return
        if role == "custom":
            ctype = message.get("customType")
            if ctype == conversation.USER_EDIT:
                entries = self._fetch_new_entries(pi)
                hit = next((e for e in reversed(entries) if e.get("type") == "custom_message" and e.get("customType") == ctype), None)
                details = message.get("details") or {}
                seqs = details.get("event_seqs") or []
                self.hub.emit("ui_action_noted", {"session_id": sid, "message_id": hit.get("id") if hit else None, "at": clock.now(),
                                                  "text": conversation.text_of(message.get("content")), "event_seq": seqs[0] if seqs else None,
                                                  "undoable": bool(details.get("undoable")), "op_id": details.get("op_id"),
                                                  "revision_no": details.get("revision_no")})
            elif ctype == conversation.UI_CLICK:
                entries = self._fetch_new_entries(pi)
                hit = next((e for e in reversed(entries) if e.get("type") == "custom_message" and e.get("customType") == ctype), None)
                self.last_click = {"id": hit.get("id") if hit else None, "details": message.get("details") or {}}
            return
        if role == "assistant" and self.work is not None:
            text = conversation.text_of(message.get("content")).strip()
            calls = [p for p in (message.get("content") or []) if isinstance(p, dict) and p.get("type") == "toolCall"]
            if message.get("stopReason") == "error":
                self.work["failed"] = True
            if text and not calls:
                self.work["last_text"] = text
                self.work["last_text_entry"] = None

    @staticmethod
    def _user_entry(entries: list[dict], raw: str) -> dict | None:
        """会话条目里文字与 raw 相同的最后一条用户消息。"""
        return next((e for e in reversed(entries) if e.get("type") == "message" and (e.get("message") or {}).get("role") == "user"
                     and conversation.text_of((e.get("message") or {}).get("content")) == raw), None)

    def _emit_summary(self, pi: PiSession, sid: str | None, work: dict) -> None:
        """工作结束时推一条过程摘要：从会话条目里切出这次工作（从触发它的那句用户的话起），
        与刷新后从会话文件重算的是同一个函数。工作编号用实时的那个，前端据此换掉 work_ended 时先拼的那一条。"""
        user_id = work.get("last_user_id") or work.get("triggered_by")
        if not user_id:
            return
        try:
            path = conversation.branch(self._fetch_all_entries(pi))
        except (PiExited, RuntimeError, TimeoutError):
            return
        found = next((w for w in work_summary.works_from_entries(path, self._definition(), conversation.FALLBACK_TEXT, conversation.text_of)
                      if w["user_message_id"] == user_id), None)
        if found is None:
            return
        self.hub.emit("work_summary", {"session_id": sid, "work_id": work["work_id"], "at": found["at"], "seconds": found["seconds"],
                                       "step_count": found["step_count"], "stages": found["stages"]})

    def _fetch_all_entries(self, pi: PiSession) -> list[dict]:
        return list((pi.request("get_entries") or {}).get("entries") or [])

    def _maybe_name(self, pi: PiSession, sid: str, text: str) -> None:
        """会话名按第一句用户的话自动起，存在 pi 会话文件的名字字段里（RPC 的 set_session_name）。"""
        self.named.add(sid)
        try:
            state = pi.get_state()
            if not state.get("sessionName"):
                pi.request("set_session_name", name=text.strip().splitlines()[0][:24])
        except (PiExited, RuntimeError, TimeoutError):
            pass

    def _definition(self) -> dict:
        conn = None
        try:
            from taskwright_server.service import library
            conn = library.open_ro(self.task_dir)
            row = conn.execute("SELECT definition_text FROM task LIMIT 1").fetchone() if conn else None
            return taskdb.parse_definition(row[0]) if row else {}
        except Exception:
            return {}
        finally:
            if conn is not None:
                conn.close()

    def _step_text(self, tool: str, args: dict, done: bool, failed: bool, details: dict | None) -> str:
        return work_summary.step_text(tool, args, done, failed, details, self._definition())

    def _tool_start(self, event: dict, sid: str | None) -> None:
        work = self.work
        if work is None:
            return
        tool = event.get("toolName") or ""
        work["turn_tools"].append({"id": event.get("toolCallId"), "tool": tool, "args": event.get("args") or {}, "done": False,
                                   "failed": False, "details": None})
        work["step_count"] += 1
        key = f"{work['work_id']}-{work['turn']}"
        step = {"session_id": sid, "work_id": work["work_id"], "step_key": key,
                "text": self._step_text(tool, event.get("args") or {}, False, False, None), "in_progress": True, "failed": False}
        work["steps"][key] = step
        self.hub.emit("step", step)

    def _tool_end(self, event: dict, sid: str | None) -> None:
        work = self.work
        tool = event.get("toolName") or ""
        failed = bool(event.get("isError"))
        result = event.get("result") or {}
        details = result.get("details") or {}
        if failed and tool == "save_revision":
            # 保存修订被拒时原因只在结果正文里，先拆出来，实时的 step 行与过程摘要同一个写法。
            details = {**details, "reasons": work_summary.rejection_reasons(details, work_summary.result_text(result))}
        if work is not None:
            for t in work["turn_tools"]:
                if t["id"] == event.get("toolCallId"):
                    t.update(done=True, failed=failed, details=details)
        if tool in WRITE_TOOLS and not failed:
            self.hub.trigger()
        if tool == REPLY_TOOL and not failed:
            reply = details.get("reply") or {}
            if work is not None:
                work["replied"] = True
                work["replied_since_user"] = True
            self.hub.emit("assistant_reply", {"session_id": sid, "message_id": details.get("message_id"), "at": clock.now(),
                                              "work_id": work["work_id"] if work else None, "via_reply_tool": True,
                                              "informs": reply.get("informs") or [], "act": reply.get("act"), "text": reply.get("text") or "",
                                              # 连续被拒到上限后放行的纯文字回复，前端照普通文字显示并加一行说明。
                                              "degraded": bool(details.get("degraded"))})

    def _turn_end(self, sid: str | None) -> None:
        work = self.work
        if work is None or not work["turn_tools"]:
            return
        key = f"{work['work_id']}-{work['turn']}"
        texts = [self._step_text(t["tool"], t["args"], True, t["failed"], t["details"]) for t in work["turn_tools"]]
        step = {"session_id": sid, "work_id": work["work_id"], "step_key": key, "text": "；".join(texts),
                "in_progress": False, "failed": any(t["failed"] for t in work["turn_tools"])}
        work["steps"][key] = step
        self.hub.emit("step", step)

    def _settled(self, pi: PiSession, sid: str | None) -> None:
        work = self.work
        if work is None:
            return
        try:
            if pi.get_state().get("isCompacting"):
                return
        except (PiExited, RuntimeError, TimeoutError):
            pass
        if not work["replied_since_user"]:
            # 兜底：这段话之后没有一次被接受的「回复」。转发最后一条助手正文；正文也没有就发 problem。
            if work["last_text"]:
                entries = self._fetch_new_entries(pi)
                hit = next((e for e in reversed(entries) if e.get("type") == "message"
                            and (e.get("message") or {}).get("role") == "assistant"), None)
                self.hub.emit("assistant_reply", {"session_id": sid, "message_id": hit.get("id") if hit else None, "at": clock.now(),
                                                  "work_id": work["work_id"], "via_reply_tool": False, "informs": [], "act": None,
                                                  "text": work["last_text"]})
            elif not work["stopped"]:
                self.hub.emit("problem", {"session_id": sid, "code": "no_reply",
                                          "text": "助手这次没有说话就停下了，你可以再问它一句。", "retry": None})
        self._emit_summary(pi, sid, work)
        outcome = "stopped_by_user" if work["stopped"] else "failed" if work["failed"] else "replied" if work["replied"] else "no_reply"
        self.hub.emit("work_ended", {"session_id": sid, "work_id": work["work_id"], "at": clock.now(),
                                     "seconds": round(time.time() - work["started"], 1), "step_count": work["step_count"],
                                     "outcome": outcome})
        self.work = None
        self.pending_origin.clear()
        self.set_state("idle")
        self.hub.trigger()
