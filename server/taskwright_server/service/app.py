"""任务服务的路由与各接口（见 docs/api.md）。只用标准库的 http.server。

用法见 __main__.py。所有路径以 /api/v1 开头；错误一律是 docs/api.md「错误」一节的形状。
"""

from __future__ import annotations

import datetime as _dt
import email.parser
import email.policy
import json
import re
import uuid
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from taskwright_server import create_task as create_task_module
from taskwright_server import new_workspace
from taskwright_observatory import taskdb
from taskwright_server.service import clock, conversation, docx_projection, library, occupancy, render, work_summary
from taskwright_server.service.errors import ApiError
from taskwright_server.service.executor import Executor
from taskwright_server.service.hub import Hub

SLASH_PREFIX = "用户说："
MAX_UPLOAD = 5 * 1024 * 1024
UPLOAD_TYPES = (".md", ".txt", ".docx")
# 材料原样取回（GET …/materials/raw）时按扩展名给的内容类型；不在表里的给 application/octet-stream。
RAW_TYPES = {".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
             ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


def rewrite_slash(text: str) -> str:
    """用户打的字首字符是斜杠时，前面加「用户说：」，免得被 pi 当作扩展命令吞掉（docs/api.md §5.1）。"""
    return SLASH_PREFIX + text if text.startswith("/") else text


def with_attachments(text: str, paths: list[str]) -> str:
    """用户附了材料时在话后面补一句路径；Word 材料另说一句读哪份投影、出处怎么写。"""
    if not paths:
        return text
    words = [p for p in paths if p.lower().endswith(".docx")]
    note = f"其中 Word 文件请读同名的 .md 投影（{'、'.join(p + '.md' for p in words)}），引用时出处写 Word 文件加段落号" if words else ""
    return f"{text}\n（我上传了材料：{'、'.join(paths)}{'；' + note if note else ''}）"


def card_annotation(body: dict, entries: list[dict] | None = None) -> dict:
    """卡片点击的标注。两种写法都认：annotation {reply_message_id, option_key, option_text}；
    前端骨架的 card {reply_message_id, kind, choice}，choice 是选项的 key 或「不对」「采纳」之类的按钮字。

    card 写法里没有选项的文字：按 reply_message_id 在会话条目里找到那条回复，从它「回复」工具参数的 act.options
    里按键查回文字；查不到（「不对」「采纳」这类按钮，或那条回复不在条目里）就用 choice 本身。"""
    if isinstance(body.get("annotation"), dict):
        return body["annotation"]
    card = body.get("card") if isinstance(body.get("card"), dict) else {}
    choice = card.get("choice")
    text = reply_option_text(entries or [], card.get("reply_message_id"), choice)
    return {"reply_message_id": card.get("reply_message_id"), "option_key": choice,
            "option_text": text if text is not None else choice, "card_kind": card.get("kind")}


def reply_option_text(entries: list[dict], reply_id: str | None, key: str | None) -> str | None:
    """那条回复的卡片上，键为 key 的选项的文字；找不到返回 None。"""
    if not reply_id or key is None:
        return None
    for e in entries:
        if e.get("id") != reply_id or e.get("type") != "message":
            continue
        for part in (e.get("message") or {}).get("content") or []:
            if isinstance(part, dict) and part.get("type") == "toolCall" and part.get("name") == "reply":
                act = (part.get("arguments") or {}).get("act") or {}
                for option in act.get("options") or []:
                    if isinstance(option, dict) and option.get("key") == key:
                        return option.get("text")
    return None


def task_types() -> list[dict]:
    """任务类型：task-types/ 下的每个目录，显示名取它的任务定义里的「任务名」。"""
    out = []
    for name in new_workspace.available_templates():
        path = new_workspace.FIXTURE_DIR / name / "docs" / "task-definitions" / f"{name}.json"
        try:
            label = json.loads(path.read_text(encoding="utf-8")).get("任务名")
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(label, str) and label:      # 旧形状的模板（例如 term-clarification）没有新格式的任务定义，不列
            out.append({"task_type": name, "name": label})
    return out


def new_task_id() -> str:
    return f"TASK-{_dt.date.today():%Y%m%d}-{uuid.uuid4().hex[:4].upper()}"


class Task:
    """一个任务目录连同它的事件分发与执行者看护。"""

    def __init__(self, task_id: str, task_dir: Path, service: "Service"):
        self.task_id = task_id
        self.dir = task_dir
        self.executor: Executor | None = None
        self.hub = Hub(task_dir, is_running=lambda: bool(self.executor and self.executor.running()))
        self.executor = Executor(task_id, task_dir, service.runs_dir, service.profile, self.hub)

    def row(self) -> dict | None:
        conn = library.open_ro(self.dir)
        if conn is None:
            return None
        try:
            row = conn.execute("SELECT * FROM task LIMIT 1").fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def definition(self) -> dict:
        row = self.row()
        return taskdb.parse_definition(row["definition_text"]) if row else {}

    def require_open(self) -> None:
        row = self.row()
        if row is None:
            raise ApiError("no_task", "这个任务目录里没有任务记录。")
        if row["status"] != "进行中":
            raise ApiError("task_closed", f"任务已经{row['status']}，只能查看。", {"status": row["status"]})


class Service:
    """任务服务。它接手 --tasks 目录下的每个任务时写一份占用标记（service.lock，见 occupancy.py），退出时删掉；
    正被别的活着的服务占用的任务不接手：列表里写明被谁占用，打开它的请求一律以 task_occupied 拒绝。"""

    def __init__(self, tasks_dir: Path, runs_dir: Path, profile: dict, port: int | None = None):
        self.tasks_dir = Path(tasks_dir)
        self.runs_dir = Path(runs_dir)
        self.profile = profile
        self.port = port
        self.tasks: dict[str, Task] = {}
        #: 正被别的服务占用、本服务没有接手的任务：任务编号 → {"lock": 那份占用标记, "dir": 任务目录}。
        self.occupied: dict[str, dict] = {}
        self.skipped: set[str] = set()
        self.lock = threading.Lock()
        self.tasks_dir.mkdir(parents=True, exist_ok=True)

    def scan(self) -> None:
        for d in sorted(self.tasks_dir.iterdir()):
            if not (d / taskdb.DB_NAME).is_file():
                continue
            conn = library.open_ro(d)
            try:
                if conn is not None and library.is_pre_revision(conn):
                    # 修订统一之前建的任务：本版本不支持，不列出来（库表改动不做迁移）。
                    if d.name not in self.skipped:
                        self.skipped.add(d.name)
                        print(f"跳过任务目录 {d.name}：{library.OLD_FORMAT_TEXT}", flush=True)
                    row = None
                else:
                    row = conn.execute("SELECT task_id FROM task LIMIT 1").fetchone() if conn else None
            except Exception:
                row = None
            finally:
                if conn is not None:
                    conn.close()
            if row and row[0] not in self.tasks:
                taken = occupancy.claim(d, self.port)
                if taken is not None:
                    if row[0] not in self.occupied:
                        print(f"任务 {row[0]}（目录 {d.name}）正被端口 {taken.get('port')} 的服务（主机 {taken.get('host')}，进程 {taken.get('pid')}）占用，"
                              "本服务不接手它。", flush=True)
                    self.occupied[row[0]] = {"lock": taken, "dir": d}
                    continue
                self.occupied.pop(row[0], None)
                self.tasks[row[0]] = Task(row[0], d, self)

    def task(self, task_id: str) -> Task:
        with self.lock:
            if task_id not in self.tasks:
                self.scan()
            if task_id in self.occupied:
                lock = self.occupied[task_id]["lock"]
                raise ApiError("task_occupied", occupancy.occupied_text(lock),
                               {"port": lock.get("port"), "pid": lock.get("pid"), "host": lock.get("host")})
            if task_id not in self.tasks:
                raise ApiError("not_found", f"没有任务 {task_id}。")
            return self.tasks[task_id]

    def close(self) -> None:
        for t in self.tasks.values():
            print(f"任务 {t.task_id} 的事件分发统计：{t.hub.stats}", flush=True)
            t.hub.close()
            if t.executor:
                t.executor.close()
            occupancy.release(t.dir)

    # ───────────── 任务与会话 ─────────────

    def list_tasks(self) -> list[dict]:
        with self.lock:
            self.scan()
            tasks = list(self.tasks.values())
            skipped = set(self.skipped)
            occupied = dict(self.occupied)
        out = []
        for t in tasks:
            seq, view = library.task_snapshot(t.dir)
            if view is None:
                continue
            sessions = t.executor.list_sessions()
            actives = [s["last_active_at"] for s in sessions if s.get("last_active_at")] + [view["started_at"]]
            comp = view.get("completion")
            out.append({"task_id": view["task_id"], "task_name": view["task_name"], "task_type": view["task_type"],
                        "domain_tag": view["domain_tag"], "status": view["status"], "item_count": len(view["items"]),
                        "completion_met": sum(c["met"] for c in comp["conditions"]) if comp else None,
                        "completion_total": len(comp["conditions"]) if comp else None,
                        "completion_unmet": comp["unmet_count"] if comp else None,
                        "last_active_at": max(a for a in actives if a), "session_count": len(sessions), "supported": True})
        # 正被别的服务占用的任务：照样列出来，写明被哪个服务占用，打不开。
        for task_id, info in sorted(occupied.items()):
            lock = info["lock"]
            name = task_id
            conn = library.open_ro(info["dir"])
            try:
                got = conn.execute("SELECT task_name FROM task LIMIT 1").fetchone() if conn else None
                name = (got[0] if got and got[0] else task_id)
            except Exception:
                pass
            finally:
                if conn is not None:
                    conn.close()
            out.append({"task_id": task_id, "task_name": name, "task_type": None, "domain_tag": None, "status": "占用中",
                        "item_count": None, "completion_met": None, "completion_total": None, "completion_unmet": None,
                        "last_active_at": None, "session_count": None, "supported": False,
                        "occupied": {"port": lock.get("port"), "pid": lock.get("pid"), "host": lock.get("host")},
                        "note": occupancy.occupied_text(lock)})
        # 修订统一之前建的任务：本版本打不开，照样列出来并标明不支持，免得用户以为任务丢了。
        for name in sorted(skipped):
            folder = self.tasks_dir / name
            out.append({"task_id": name, "task_name": name, "task_type": None, "domain_tag": None, "status": "旧格式",
                        "item_count": None, "completion_met": None, "completion_total": None, "completion_unmet": None,
                        "last_active_at": clock.from_epoch(folder.stat().st_mtime) if folder.exists() else None, "session_count": None,
                        "supported": False, "note": library.OLD_FORMAT_TEXT})
        return out

    def create(self, body: dict) -> dict:
        task_type = body.get("task_type") or create_task_module.DEFAULT_TYPE
        if task_type not in new_workspace.available_templates():
            raise ApiError("bad_request", f"没有「{task_type}」这种任务类型。", {"available": new_workspace.available_templates()})
        name = (body.get("task_name") or "").strip() or None
        tag = (body.get("domain_tag") or "").strip() or None
        task_id = new_task_id()
        try:
            result = create_task_module.create_task(self.tasks_dir / task_id, task_type, name, tag, task_id=task_id)
        except create_task_module.CreateTaskError as error:
            raise ApiError("rejected", "任务没有创建成功。", {"reasons": [str(error)]})
        with self.lock:
            self.scan()
        return {"ok": True, "task_id": result["task_id"]}

    def task_page(self, t: Task) -> dict:
        seq, view = library.task_snapshot(t.dir)
        if view is None:
            raise ApiError("no_task", "这个任务目录里没有任务记录。")
        return {**view, "materials": library.materials(t.dir, t.definition()), "sessions": t.executor.list_sessions()}

    def snapshot(self, t: Task, session: str | None) -> dict:
        if session:
            t.executor.open_session(session)
        seq, view = library.task_snapshot(t.dir)
        info = None
        conv = None
        work = None
        if session:
            info = next((s for s in t.executor.list_sessions() if s["session_id"] == session), None)
            work = t.executor.current_work(session)
            messages = conversation.messages(t.executor.entries(session), session, t.definition(), t.dir)
            if work is not None:
                # 正在进行的这次工作还没有结束：它的过程由 current_work 的步骤行显示，从会话文件算出的半截摘要不放进对话。
                # 实时与刷新后的工作编号一致（都是「w-触发它的那句话的会话条目编号」），所以按编号认。
                messages = [m for m in messages if not (m["type"] == "work_summary" and m.get("work_id") == work["work_id"])]
            conv = conversation.page(messages)
        return {"seq": seq, "generated_at": clock.now(), "executor": t.executor.view(),
                "session": {k: info[k] for k in ("session_id", "name", "started_at", "last_active_at")} if info else None,
                "task": view, "materials": library.materials(t.dir, t.definition()),
                "conversation": conv, "current_work": work}

    # ───────────── 修订日志 ─────────────

    def revision_log(self, t: Task) -> dict:
        """修订日志（docs/api.md 4.3）：库里的每次修订，补上会话记录里的两样——执行者的修订属于哪次工作（work_id，
        按保存修订那次工具调用的调用编号在会话里找）与触发这次工作的那句话；用户直接操作的修订写操作名。
        只是把库与会话记录里已有的事实拼在一起，不做判断。会话记录读不出来时这两样留空。"""
        rows = library.revision_log(t.dir)
        if rows is None:
            raise ApiError("no_task", "这个任务目录里没有任务记录。")
        definition = t.definition()
        works: dict[str, dict] = {}       # 调用编号 → 所在的那次工作
        spoken: dict[str, dict] = {}      # 用户的话的会话条目编号 → 那条对话记录
        actions: dict[str, dict] = {}     # 操作编号 → 界面操作的记录（种类、说明）
        for session_id in sorted({r["session_id"] for r in rows if r["session_id"]}):
            try:
                entries = t.executor.entries(session_id)
            except Exception:       # 会话记录读不出来：只是少了触发它的事，日志照给
                continue
            path = conversation.branch(entries)
            for work in work_summary.works_from_entries(path, definition, conversation.FALLBACK_TEXT, conversation.text_of):
                for call_id in work["call_ids"]:
                    works[call_id] = work
            for m in conversation.messages(entries, session_id, definition):
                if m["type"] == "user_message" and m.get("message_id"):
                    spoken[m["message_id"]] = m
            for e in path:
                details = e.get("details") or {}
                if e.get("type") == "custom_message" and e.get("customType") == conversation.USER_EDIT and details.get("op_id"):
                    actions[details["op_id"]] = details
        out = []
        for r in rows:
            work = works.get(r["call_id"]) if r["by"] == "executor" else None
            said = spoken.get(work["user_message_id"]) if work else None
            if r["by"] == "user":
                trigger = {"kind": "user_action", "action": (actions.get(r["call_id"]) or {}).get("kind"),
                           "text": user_action_text((actions.get(r["call_id"]) or {}).get("kind"), r)}
            elif said is not None:
                trigger = {"kind": said.get("origin") or "typed", "text": said.get("text") or "", "message_id": said["message_id"]}
            else:
                trigger = {"kind": "none", "text": ""}
            out.append({"revision_no": r["revision_no"], "at": r["at"], "by": r["by"], "session_id": r["session_id"],
                        "work_id": work["work_id"] if work else None, "op_id": r["call_id"] if r["by"] == "user" else None,
                        "undo_of_revision": r["undo_of_revision"], "trigger": trigger, "operations": r["operations"],
                        "intent": r.get("intent")})
        return {"latest_revision": max((r["revision_no"] for r in rows), default=0), "revisions": out}

    # ───────────── 材料 ─────────────

    def material_path(self, t: Task, rel: str) -> Path:
        folder = t.definition().get("材料目录") or taskdb.DEFAULT_MATERIALS_DIR
        base = (t.dir / folder).resolve()
        target = (t.dir / rel).resolve()
        if not rel or not str(target).startswith(str(base) + "/"):
            raise ApiError("bad_request", f"路径 {rel} 不在材料目录 {folder} 里。")
        return target

    def upload(self, t: Task, filename: str, data: bytes, session: str | None = None) -> dict:
        if not filename or "/" in filename or "\\" in filename or filename in (".", ".."):
            raise ApiError("bad_request", "文件名里不能带路径分隔符。")
        if not filename.lower().endswith(UPLOAD_TYPES):
            raise ApiError("unsupported_type", "只接受 .md、.txt 与 .docx（Word）三种文件。")
        if docx_projection.is_reserved(filename):
            raise ApiError("bad_request", "以 .docx.md 或 .docx.txt 结尾的文件名留给由 Word 材料生成的投影用，请改个名字再上传。")
        is_docx = filename.lower().endswith(".docx")
        if len(data) > MAX_UPLOAD:
            raise ApiError("too_large", "单个文件不能超过 5 MB。")
        folder_rel = t.definition().get("材料目录") or taskdb.DEFAULT_MATERIALS_DIR
        folder = t.dir / folder_rel
        folder.mkdir(parents=True, exist_ok=True)
        stem, dot, ext = filename.rpartition(".")
        target, n = folder / filename, 1
        while target.exists():
            n += 1
            target = folder / f"{stem}-{n}.{ext}"
        target.write_bytes(data)
        path = f"{folder_rel}{target.name}"
        if is_docx:
            # Word 材料另生成一份 Markdown 投影（图片抽到旁边的目录），执行者读它，保存修订时核对摘录也对着它；
            # 它不单独发 material_added。生成不了（不是合法的 .docx）时连同这份文件一起删掉。
            try:
                docx_projection.write_projection(target, path)
            except ValueError as e:
                target.unlink(missing_ok=True)
                docx_projection.remove_projection(target)
                raise ApiError("unsupported_type", f"{e}，请用 Word 另存为 .docx 后再上传。")
        # 材料清单只在整份数据里读一次；上传之后推一条过程类事件，工作视图与任务页据此更新清单、显示正文。
        # 材料属于任务，session_id 只说明是从哪条会话上传的（可空），订阅了别的会话的页面也收得到。
        t.hub.emit("material_added", {"session_id": session, "at": clock.now(), "path": path,
                                      "bytes": target.stat().st_size, "modified_at": clock.from_epoch(target.stat().st_mtime)})
        return {"ok": True, "path": path}


def user_action_text(kind: str | None, revision: dict) -> str:
    """用户直接操作产生的修订，写成「你……」一句操作名（修订日志卡片的副标题）。种类读不到时按修订里的操作写。"""
    ops = revision["operations"]
    ids = "、".join(op["item_id"] for op in ops)
    if kind == "undo" or revision.get("undo_of_revision"):
        return f"你撤销了修订 {revision.get('undo_of_revision')}"
    if kind == "delete_item" or (kind is None and ops and all(op["op"] == "delete" for op in ops)):
        return f"你删除了 {ids}"
    if kind == "keep_pending":
        return f"你把 {ids} 标为先不管"
    if kind == "edit_fields" or (kind is None and ops and all(op["op"] == "update" for op in ops)):
        fields = "".join(f"「{f}」" for op in ops for f in op["fields_changed"])
        return f"你改了 {ids} 的{fields}" if fields else f"你改了 {ids}"
    return "你在界面上直接修改"


def words_locator(t):
    """生成文档时把「用户的话」的出处「会话编号#消息编号」换成读者看得懂的说法：会话「名称」里用户的第 N 句话。
    按会话记录现算，每个会话只读一次；会话记录找不到或消息不在当前分支上时返回 None，由渲染写通用说法。"""
    cache: dict[str, tuple[str | None, dict[str, int]]] = {}

    def locate(locator: str) -> str | None:
        session_id, _, message_id = locator.partition("#")
        if not session_id or not message_id:
            return None
        if session_id not in cache:
            try:
                msgs = conversation.messages(t.executor.entries(session_id), session_id, t.definition())
                names = {row["session_id"]: row.get("name") for row in t.executor.list_sessions()}
            except Exception:  # 会话记录读不出来：不影响生成文档，只是出处写通用说法
                cache[session_id] = (None, {})
            else:
                users = [m["message_id"] for m in msgs if m.get("type") == "user_message"]
                cache[session_id] = (names.get(session_id), {mid: n for n, mid in enumerate(users, 1)})
        name, order = cache[session_id]
        n = order.get(message_id)
        if n is None:
            return None
        return f"会话「{name}」里用户的第 {n} 句话" if name else f"对话里用户的第 {n} 句话"

    return locate


def parse_multipart(content_type: str, body: bytes) -> tuple[str, bytes]:
    """取出 multipart 请求里的第一个文件：返回（文件名, 内容）。"""
    message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
    for part in message.iter_parts():
        name = part.get_filename()
        if name:
            return name, part.get_payload(decode=True) or b""
    raise ApiError("bad_request", "请求里没有文件。")


ROUTES = [
    ("GET", r"/api/v1/tasks", "list_tasks"),
    ("GET", r"/api/v1/task-types", "list_task_types"),
    ("POST", r"/api/v1/tasks", "create_task"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)", "get_task"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/sessions", "list_sessions"),
    ("POST", r"/api/v1/tasks/(?P<task>[^/]+)/sessions", "new_session"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/events", "events"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/snapshot", "snapshot"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/items/(?P<item>[^/]+)/revisions", "revisions"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/revisions", "revision_log"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/materials/content", "material"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/materials/raw", "material_raw"),
    ("POST", r"/api/v1/tasks/(?P<task>[^/]+)/materials", "upload"),
    ("GET", r"/api/v1/tasks/(?P<task>[^/]+)/conversation", "conversation"),
    ("POST", r"/api/v1/tasks/(?P<task>[^/]+)/messages", "messages"),
    ("POST", r"/api/v1/tasks/(?P<task>[^/]+)/actions", "actions"),
    ("POST", r"/api/v1/tasks/(?P<task>[^/]+)/control", "control"),
    ("POST", r"/api/v1/tasks/(?P<task>[^/]+)/documents/(?P<mode>preview|download)", "documents"),
]


def make_handler(service: Service):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:
            pass

        # ── 小工具 ──

        def send_json(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def body_json(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                value = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                raise ApiError("bad_request", "请求体不是合法的 JSON。")
            if not isinstance(value, dict):
                raise ApiError("bad_request", "请求体应当是一个 JSON 对象。")
            return value

        def dispatch(self, method: str) -> None:
            url = urlparse(self.path)
            self.query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            path = unquote(url.path).rstrip("/") or "/"
            try:
                for m, pattern, name in ROUTES:
                    match = re.fullmatch(pattern, path)
                    if m == method and match:
                        getattr(self, name)(**match.groupdict())
                        return
                raise ApiError("not_found", f"没有这个接口：{method} {path}")
            except ApiError as error:
                self.send_json(error.status, error.body())
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                traceback.print_exc()
                self.send_json(500, {"ok": False, "error": {"code": "internal", "message": "后端出错了。", "data": {"detail": str(error)}}})

        def do_GET(self):
            self.dispatch("GET")

        def do_POST(self):
            self.dispatch("POST")

        def session_param(self, body: dict | None = None) -> str | None:
            return self.query.get("session") or (body or {}).get("session_id") or None

        # ── 任务与会话 ──

        def list_tasks(self):
            self.send_json(200, {"ok": True, "tasks": service.list_tasks()})

        def list_task_types(self):
            self.send_json(200, {"ok": True, "task_types": task_types()})

        def create_task(self):
            self.send_json(200, service.create(self.body_json()))

        def get_task(self, task):
            self.send_json(200, {"ok": True, **service.task_page(service.task(task))})

        def list_sessions(self, task):
            self.send_json(200, {"ok": True, "sessions": service.task(task).executor.list_sessions()})

        def new_session(self, task):
            t = service.task(task)
            self.send_json(200, {"ok": True, "session_id": t.executor.new_session()})

        def snapshot(self, task):
            t = service.task(task)
            self.send_json(200, {"ok": True, **service.snapshot(t, self.session_param())})

        def revisions(self, task, item):
            rows = library.item_revisions(service.task(task).dir, item)
            if rows is None:
                raise ApiError("not_found", f"没有条目 {item}。")
            self.send_json(200, {"ok": True, "item_id": item, "revisions": rows})

        def revision_log(self, task):
            self.send_json(200, {"ok": True, **service.revision_log(service.task(task))})

        def material(self, task):
            t = service.task(task)
            rel = self.query.get("path") or ""
            target = service.material_path(t, rel)
            if not target.is_file():
                raise ApiError("not_found", f"没有材料 {rel}。")
            if target.suffix.lower() == ".docx":
                projection = docx_projection.projection_path(target)
                try:
                    text = projection.read_text(encoding="utf-8") if projection.is_file() else docx_projection.projection_text(target, rel)
                except ValueError as e:
                    raise ApiError("unsupported_type", f"{e}。")
            else:
                text = target.read_text(encoding="utf-8", errors="replace")
            self.send_json(200, {"ok": True, "path": rel, "text": text})

        def material_raw(self, task):
            """材料文件的原始字节，内容类型按扩展名给；材料区用它按原版式显示 Word 材料。路径限制与 content 端点相同。"""
            t = service.task(task)
            rel = self.query.get("path") or ""
            target = service.material_path(t, rel)
            if not target.is_file():
                raise ApiError("not_found", f"没有材料 {rel}。")
            raw = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", RAW_TYPES.get(target.suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def upload(self, task):
            t = service.task(task)
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_UPLOAD + 64 * 1024:
                raise ApiError("too_large", "单个文件不能超过 5 MB。")
            name, data = parse_multipart(self.headers.get("Content-Type") or "", self.rfile.read(length))
            self.send_json(200, service.upload(t, name, data, self.session_param()))

        def conversation(self, task):
            t = service.task(task)
            session = self.session_param()
            if not session:
                raise ApiError("bad_request", "要带 session 参数。")
            all_messages = conversation.messages(t.executor.entries(session), session, t.definition(), t.dir)
            limit = int(self.query.get("limit") or 100)
            self.send_json(200, {"ok": True, **conversation.page(all_messages, self.query.get("before"), limit)})

        # ── 说话、操作、停下 ──

        def messages(self, task):
            t = service.task(task)
            body = self.body_json()
            t.require_open()
            text = (body.get("text") or "").strip()
            if not text:
                raise ApiError("bad_request", "text 不能是空的。")
            attachments = body.get("attachments") or []
            for rel in attachments:
                if not service.material_path(t, rel).is_file():
                    raise ApiError("bad_request", f"附件 {rel} 不在材料目录里。")
            session = self.session_param(body)
            client_id = body.get("client_id")
            if body.get("origin") == "card_choice":
                queued = t.executor.card_click(session, text, client_id, card_annotation(body, t.executor.entries(session) if session else []))
            else:
                sent = with_attachments(rewrite_slash(text), attachments)
                queued = t.executor.say(session, sent, client_id, original=text)
            self.send_json(200, {"ok": True, "client_id": client_id, "queued": queued})

        def actions(self, task):
            t = service.task(task)
            body = self.body_json()
            t.require_open()
            op_id = t.executor.action(self.session_param(body), body)
            self.send_json(200, {"ok": True, "client_id": body.get("client_id"), "op_id": op_id})

        def control(self, task):
            t = service.task(task)
            body = self.body_json()
            if body.get("action") != "stop":
                raise ApiError("bad_request", "action 现在只能是 stop。")
            self.send_json(200, {"ok": True, "cleared": t.executor.stop(self.session_param(body))})

        def documents(self, task, mode):
            t = service.task(task)
            body = self.body_json()
            if (body.get("format") or "markdown") != "markdown":
                raise ApiError("bad_request", "现在只支持 markdown。")
            conn = library.open_ro(t.dir)
            try:
                data = library.read_all(conn)
            finally:
                conn.close()
            revision_no, items = render.document_request(body)
            text = render.render(t.dir, library.Library(data), revision_no, items, words_locator(t))
            if mode == "preview":
                self.send_json(200, {"ok": True, "text": text})
                return
            raw = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{t.task_id}.md"')
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        # ── 事件流 ──

        def events(self, task):
            t = service.task(task)
            raw = self.headers.get("Last-Event-ID") or self.query.get("last_event_id")
            last = int(raw) if raw and raw.isdigit() else None
            sub, replay = t.hub.subscribe(self.session_param(), last)
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                for item in replay:
                    self.write_event(sub, *item)
                while True:
                    try:
                        item = sub.queue.get(timeout=15)
                    except Exception:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        continue
                    self.write_event(sub, *item)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                t.hub.unsubscribe(sub)
                self.close_connection = True

        def write_event(self, sub, name: str, seq: int | None, data: dict) -> None:
            if seq is not None:
                if seq <= sub.last_seq:
                    return        # 补发与实时推送重叠的那几条只发一次
                sub.last_seq = seq
            lines = f"event: {name}\n" + (f"id: {seq}\n" if seq is not None else "") + \
                "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"
            self.wfile.write(lines.encode("utf-8"))
            self.wfile.flush()

    return Handler


def serve(service: Service, host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(service))
    server.daemon_threads = True
    return server
