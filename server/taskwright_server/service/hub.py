"""事件分发：每个任务一个。管 SSE 订阅者、库事件的转发、兜底轮询与 Last-Event-ID 补发（约定第 2、3 节）。

库事件的正本是库里的事件表。后端记着「已经转发到第几号」，三种提示会让它去查库：写入类工具的
tool_execution_end、扩展命令经状态栏带回的结果、pi 在跑期间每 2 秒一次的兜底轮询。查到新行就按序号现拼内容推送。
后端重启、pi 重启、断线补发走同一条路：从第 N 号之后查事件表、现拼内容，不依赖内存里存过什么。
"""

from __future__ import annotations

import queue
import sqlite3
import threading
import time
from pathlib import Path

from taskwright_observatory import taskdb
from taskwright_server.service import library

REPLAY_WINDOW = 500
POLL_SECONDS = 2.0


class Subscriber:
    def __init__(self, session: str | None):
        self.session = session
        self.queue: queue.Queue = queue.Queue()
        self.last_seq = 0


class Hub:
    def __init__(self, task_dir: Path, is_running=lambda: False):
        self.task_dir = Path(task_dir)
        self.is_running = is_running
        self.lock = threading.Lock()
        self.subscribers: list[Subscriber] = []
        self.forwarded = self.current_max()
        self.stats = {"轮询次数": 0, "轮询发现新行次数": 0, "提示次数": 0, "推送的库事件数": 0}
        self._stop = threading.Event()
        threading.Thread(target=self._poll_loop, daemon=True).start()

    def current_max(self) -> int:
        """SELECT MAX(seq)：每次新开连接、查完就关，不留读事务（实测长开读事务会让 -wal 文件一直变大）。"""
        path = library.db_file(self.task_dir)
        if not path.is_file():
            return 0
        conn = taskdb.open_readonly(path)
        try:
            return int(conn.execute("SELECT COALESCE(MAX(seq), 0) FROM event").fetchone()[0])
        except sqlite3.Error:
            return 0
        finally:
            conn.close()

    # ───────────── 推送 ─────────────

    def emit(self, name: str, data: dict) -> None:
        """过程与对话类事件：没有 id，漏了不补。订阅时带了 session 的只收自己会话的。"""
        for sub in list(self.subscribers):
            if sub.session and data.get("session_id") and data["session_id"] != sub.session:
                continue
            sub.queue.put((name, None, data))

    def trigger(self) -> None:
        """有提示说库里可能有新行：查、拼、推，更新已转发序号。"""
        self.stats["提示次数"] += 1
        with self.lock:
            events, top = library.library_events(self.task_dir, self.forwarded)
            for name, data in events:
                for sub in list(self.subscribers):
                    sub.queue.put((name, data["seq"], data))
                self.stats["推送的库事件数"] += 1
            self.forwarded = max(self.forwarded, top)

    def _poll_loop(self) -> None:
        while not self._stop.wait(POLL_SECONDS):
            if not self.is_running():
                continue
            self.stats["轮询次数"] += 1
            if self.current_max() > self.forwarded:
                self.stats["轮询发现新行次数"] += 1
                self.trigger()

    # ───────────── 订阅 ─────────────

    def subscribe(self, session: str | None, last_event_id: int | None) -> tuple[Subscriber, list]:
        """先登记订阅者，再算补发：带了 Last-Event-ID 的，从它之后补；差距超过 500 条发 resync。"""
        sub = Subscriber(session)
        with self.lock:
            self.subscribers.append(sub)
            replay: list = []
            if last_event_id is not None:
                top = self.current_max()
                if top - last_event_id > REPLAY_WINDOW:
                    replay = [("resync", None, {"reason": "gap_too_large"})]
                elif top > last_event_id:
                    events, _ = library.library_events(self.task_dir, last_event_id)
                    replay = [(name, data["seq"], data) for name, data in events]
                sub.last_seq = last_event_id
        return sub, replay

    def unsubscribe(self, sub: Subscriber) -> None:
        with self.lock:
            if sub in self.subscribers:
                self.subscribers.remove(sub)

    def close(self) -> None:
        self._stop.set()
