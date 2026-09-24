"""一个只用 Python 标准库的小型 HTTP 服务：读取接口返回 JSON，另外把网页文件发出去。

它只回应 GET 请求，没有任何写入的路径。数据每次都从磁盘重读一遍，不过会看一眼文件的修改时刻，
没变就用上一次读好的，免得每点一下都把几十个文件再扫一遍。
"""

from __future__ import annotations

import json
import mimetypes
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from taskwright_observatory.api import Index, NotFound
from taskwright_observatory.langfuse import LangfuseLinks
from taskwright_observatory import taskpage

WEB_DIR = Path(__file__).resolve().parent / "web"


def directory_signature(*directories: Path) -> tuple:
    """给几个目录算一个「有没有变过」的指纹：文件路径、大小与修改时刻。"""
    marks = []
    for directory in directories:
        directory = Path(directory)
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                try:
                    stat = path.stat()
                except OSError:
                    continue
                marks.append((str(path), stat.st_size, int(stat.st_mtime)))
    return tuple(marks)


class IndexCache:
    """读一次留着用，文件变了再读。"""

    def __init__(self, archive_dirs: list[Path], workspaces_dir: Path,
                 langfuse_base: str, langfuse_project: str):
        self.archive_dirs = [Path(d) for d in archive_dirs]
        self.workspaces_dir = Path(workspaces_dir)
        # 链接对象只建一次：它内存里那份 Langfuse 读取结果的缓存，不该随数据重读而丢。
        self.links = LangfuseLinks(langfuse_base, langfuse_project)
        self._lock = threading.Lock()
        self._signature = None
        self._index: Index | None = None

    def get(self) -> Index:
        signature = directory_signature(*self.archive_dirs, self.workspaces_dir)
        with self._lock:
            if self._index is None or signature != self._signature:
                self._index = Index(self.archive_dirs, self.workspaces_dir, links=self.links)
                self._signature = signature
            return self._index


def make_handler(cache: IndexCache):
    class Handler(BaseHTTPRequestHandler):
        server_version = "taskwright-observatory"

        def log_message(self, fmt, *args):       # 把访问日志压成一行，别刷屏
            print(f"  {self.address_string()} {fmt % args}")

        # ───────────── 回应 ─────────────

        def _send(self, status: int, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, value):
            body = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8")

        def _error(self, status: int, message: str):
            self._json(status, {"出错了": message})

        # ───────────── 路由 ─────────────

        def do_GET(self):                         # noqa: N802 - 标准库要求这个名字
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            try:
                if path.startswith("/api/"):
                    self._api(path[len("/api/"):], query)
                else:
                    self._static(path)
            except NotFound as error:
                self._error(404, str(error))
            except BrokenPipeError:
                pass
            except Exception:                     # noqa: BLE001 - 服务不能被一次出错带倒
                self._error(500, "观测台读数据时出错了：\n" + traceback.format_exc())

        do_HEAD = do_GET                          # noqa: N815 - 标准库的写法

        def _api(self, route: str, query: dict):
            index = cache.get()
            parts = [p for p in route.split("/") if p]
            if parts == ["overview"]:
                return self._json(200, index.overview())
            if parts == ["sessions"]:
                return self._json(200, index.session_list())
            if len(parts) == 2 and parts[0] == "sessions":
                return self._json(200, index.session_detail(parts[1]))
            if len(parts) == 3 and parts[0] == "taskpage" and parts[1] == "session":
                # 会话详情页：与任务页同一个组件，按会话取数据，见 taskpage.py。
                return self._json(200, taskpage.page_for_session(index, parts[2]))
            if len(parts) == 4 and parts[0] == "taskpage" and parts[1] == "task":
                # 任务页：一个任务可以跨好几条会话，按时间接起来。
                key = parts[2] + "/" + parts[3]
                try:
                    return self._json(200, taskpage.page_for_task(index, key))
                except KeyError:
                    raise NotFound(f"找不到任务「{key}」。") from None
                except LookupError:
                    raise NotFound(f"任务「{key}」在当前扫到的归档里对不上任何一条会话。") from None
            if parts == ["tasklist"]:
                return self._json(200, {"任务": taskpage.task_list(index)})
            if parts == ["tasks"]:
                return self._json(200, {"任务": [index.task_detail(t) for t in index.tasks]})
            if len(parts) == 3 and parts[0] == "tasks":
                return self._json(200, index.task_detail(parts[1] + "/" + parts[2]))
            if len(parts) == 2 and parts[0] == "tasks":
                # 只给任务目录名：这个任务目录还没有创建任务时，交付物页照实这样说。
                return self._json(200, index.task_detail(parts[1] + "/"))
            if len(parts) == 2 and parts[0] == "calls":
                return self._json(200, index.call_detail(parts[1]))
            if parts == ["health"]:
                return self._json(200, index.health((query.get("scope") or [""])[0]))
            if parts == ["concepts"]:
                return self._json(200, index.concepts())
            if parts == ["session-options"]:
                return self._json(200, {"会话": index.session_options()})
            return self._error(404, f"没有这个读取接口：/api/{route}")

        def _static(self, path: str):
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            target = (WEB_DIR / name).resolve()
            if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
                return self._error(404, f"没有这个文件：{name}")
            kind, _ = mimetypes.guess_type(target.name)
            charset = "; charset=utf-8" if (kind or "").startswith(("text/", "application/j")) else ""
            self._send(200, target.read_bytes(), (kind or "application/octet-stream") + charset)

    return Handler


def serve(archive_dirs: list[Path], workspaces_dir: Path, port: int, host: str,
          langfuse_base: str, langfuse_project: str) -> None:
    cache = IndexCache(archive_dirs, workspaces_dir, langfuse_base, langfuse_project)
    cache.get()                                   # 先读一遍，启动时就能暴露路径写错之类的问题
    httpd = ThreadingHTTPServer((host, port), make_handler(cache))
    print(f"观测台已经起来了，用浏览器打开 http://127.0.0.1:{port}/ 就能看。")
    print(f"  归档目录是 {'、'.join(str(d) for d in archive_dirs)}")
    print(f"  任务目录所在目录是 {workspaces_dir}")
    print("  按 Ctrl+C 停掉它。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n观测台已经停了。")
    finally:
        httpd.server_close()
