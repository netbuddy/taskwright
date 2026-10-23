"""一个只用 Python 标准库的小型 HTTP 服务：读取接口返回 JSON，另外把网页文件发出去。

它只回应 GET 请求，没有任何写入的路径。数据每次都从磁盘重读一遍，不过会看一眼文件的修改时刻，
没变就用上一次读好的，免得每点一下都把几十个文件再扫一遍。命令行给的是上一级目录时，每次读取前重新把它展开成
下面的各个归档目录（只列目录，不读文件），所以观测台启动之后新建的任务也看得到，不用重启。

给了模拟器的演练根目录（--sim-root）时，它下面每一遍演练（sim-001、sim-002……）的归档与任务目录也收进来：一遍演练的归档在
`sim-<序号>/backend/<任务目录>/pi-events`，任务目录在 `sim-<序号>/tasks/<任务目录>`。同样每次读取前重新展开，评测跑到一半
新出的那一遍也看得到。模拟用户自己的归档（`sim-<序号>/user-agent`）不收，免得会话列表里混进模拟用户的会话。
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
from taskwright_observatory import evals, pack as packs, taskpage

WEB_DIR = Path(__file__).resolve().parent / "web"


def is_archive_dir(path: Path) -> bool:
    """是不是一个归档目录：有事件归档（pi-events）或者会话文件（pi-sessions）。数据包缺省不带事件归档，导入来的任务只有会话文件。"""
    return (path / "pi-events").is_dir() or (path / "pi-sessions").is_dir()


def expand_archive_dirs(given: list[Path]) -> list[Path]:
    """把命令行给的目录展开成归档目录：本身是归档目录（见 is_archive_dir）的就是它；不是的，收它下面每个是归档目录的
    直接子目录（按名字排）。本身不是、子目录也都不是的，照旧当归档目录交给读取层，读出来就是空的。去掉重复的。
    只列目录、不读文件，每次读取前调用一次也不费事。"""
    found: list[Path] = []
    for one in given:
        if is_archive_dir(one):
            picked = [one]
        else:
            picked = (sorted(p for p in one.iterdir() if p.is_dir() and is_archive_dir(p)) if one.is_dir() else []) or [one]
        found.extend(p for p in picked if p not in found)
    return found


def expand_sim_root(sim_root: Path | None) -> tuple[list[Path], list[Path]]:
    """演练根目录下每一遍演练的两处：（各遍的 backend 目录，各遍的 tasks 目录），按演练的名字排。没有给时两个都是空的。"""
    if sim_root is None or not Path(sim_root).is_dir():
        return [], []
    sims = sorted(p for p in Path(sim_root).iterdir() if p.is_dir() and p.name.startswith("sim-"))
    return [s / "backend" for s in sims if (s / "backend").is_dir()], [s / "tasks" for s in sims if (s / "tasks").is_dir()]


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
    """读一次留着用，文件变了、或者展开出来的归档目录变了（新建了任务）再读。"""

    def __init__(self, given_dirs: list[Path], workspaces_dir: Path | None,
                 langfuse_base: str, langfuse_project: str, sim_root: Path | None = None, only_session: str = ""):
        # 命令行给的目录，不是展开后的归档目录：每次读取前重新展开。
        self.given_dirs = [Path(d) for d in given_dirs]
        self.workspaces_dir = Path(workspaces_dir) if workspaces_dir is not None else None
        self.sim_root = Path(sim_root) if sim_root is not None else None
        self.only_session = only_session
        # 链接对象只建一次：它内存里那份 Langfuse 读取结果的缓存，不该随数据重读而丢。
        self.links = LangfuseLinks(langfuse_base, langfuse_project)
        self._lock = threading.Lock()
        self._signature = None
        self._index: Index | None = None

    def get(self) -> Index:
        sim_backends, sim_tasks = expand_sim_root(self.sim_root)
        # 演练的 backend 目录下还没有归档时不收：它不是归档目录，照「给的目录本身」收进去会多出一个读不出东西的归档目录。
        archive_dirs = expand_archive_dirs(self.given_dirs)
        archive_dirs += [d for d in expand_archive_dirs(sim_backends) if is_archive_dir(d) and d not in archive_dirs]
        workspace_dirs = ([self.workspaces_dir] if self.workspaces_dir is not None else []) + sim_tasks
        # 展开结果本身也放进指纹：新建的任务目录还没有文件时，也算变了。
        signature = (tuple(str(d) for d in archive_dirs), tuple(str(d) for d in workspace_dirs),
                     directory_signature(*archive_dirs, *workspace_dirs))
        with self._lock:
            if self._index is None or signature != self._signature:
                self._index = Index(archive_dirs, workspace_dirs, links=self.links, only_session=self.only_session)
                self._signature = signature
            return self._index


#: 打开的是数据包、按会话编号要的会话不在包里时的说法。
NOT_IN_PACK_TEXT = "这段的归档不在包里"


def make_handler(cache: IndexCache, pack: "packs.OpenedPack | None" = None):
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
                if pack is not None and path.startswith(("/api/sessions/", "/api/taskpage/session/")):
                    self._error(404, f"{NOT_IN_PACK_TEXT}（{error}）")
                else:
                    self._error(404, str(error))
            except BrokenPipeError:
                pass
            except Exception:                     # noqa: BLE001 - 服务不能被一次出错带倒
                self._error(500, "观测台读数据时出错了：\n" + traceback.format_exc())

        do_HEAD = do_GET                          # noqa: N815 - 标准库的写法

        def _api(self, route: str, query: dict):
            parts = [p for p in route.split("/") if p]
            if parts and parts[0] == "evals":
                # 评测的三个读取接口只读演练根目录下的评测结果文件，不用扫归档。
                return self._evals(parts[1:], query)
            if parts and parts[0] == "pack":
                return self._pack(parts[1:])
            index = cache.get()
            if parts == ["overview"]:
                # 打开的是数据包时多一项「诊断包」：首页顶部那一块的各项（见 pack.py 的 header）。
                return self._json(200, {**index.overview(), "诊断包": packs.header(pack) if pack is not None else None})
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

        def _pack(self, rest: list[str]):
            """打开的数据包里的后端日志与设置摘录。不是打开的包时没有这几个接口。"""
            if pack is None:
                return self._error(404, "观测台没有打开数据包（启动时没有给 --pack）。")
            if rest == ["logs"]:
                return self._json(200, {"日志": packs.log_files(pack)})
            if len(rest) == 2 and rest[0] == "logs":
                try:
                    return self._json(200, {"文件": rest[1], "全文": packs.log_text(pack, rest[1])})
                except FileNotFoundError:
                    raise NotFound(f"包里没有这份日志：{rest[1]}") from None
            if rest == ["settings"]:
                return self._json(200, {"设置摘录": packs.settings_excerpt(pack)})
            return self._error(404, f"没有这个读取接口：/api/pack/{'/'.join(rest)}")

        def _evals(self, rest: list[str], query: dict):
            try:
                if not rest:
                    return self._json(200, evals.read_list(cache.sim_root))
                if rest == ["compare"]:
                    first, second = (query.get("a") or [""])[0], (query.get("b") or [""])[0]
                    if not first or not second:
                        return self._error(400, "对照要给两次评测的标签：/api/evals/compare?a=前一次&b=后一次")
                    return self._json(200, evals.compare(cache.sim_root, first, second))
                if len(rest) == 1:
                    return self._json(200, evals.read_detail(cache.sim_root, rest[0]))
            except evals.EvalNotFound as error:
                raise NotFound(str(error)) from None
            return self._error(404, f"没有这个读取接口：/api/evals/{'/'.join(rest)}")

        def _static(self, path: str):
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            target = (WEB_DIR / name).resolve()
            if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
                return self._error(404, f"没有这个文件：{name}")
            kind, _ = mimetypes.guess_type(target.name)
            charset = "; charset=utf-8" if (kind or "").startswith(("text/", "application/j")) else ""
            self._send(200, target.read_bytes(), (kind or "application/octet-stream") + charset)

    return Handler


def serve(given_dirs: list[Path], workspaces_dir: Path | None, port: int, host: str,
          langfuse_base: str, langfuse_project: str, sim_root: Path | None = None,
          pack: "packs.OpenedPack | None" = None) -> None:
    """given_dirs 是命令行给的目录（归档目录，或者它们的上一级目录），每次读取前重新展开。sim_root 是模拟器的演练根目录，可以不给。
    pack 是 --pack 打开的数据包（见 pack.py），给了时首页显示包头，并多出读包里日志与设置摘录的接口。"""
    cache = IndexCache(given_dirs, workspaces_dir, langfuse_base, langfuse_project, sim_root,
                       only_session=packs.session_of(pack) if pack is not None else "")
    cache.get()                                   # 先读一遍，启动时就能暴露路径写错之类的问题
    httpd = ThreadingHTTPServer((host, port), make_handler(cache, pack))
    print(f"观测台已经起来了，用浏览器打开 http://127.0.0.1:{port}/ 就能看。")
    if pack is not None:
        print(f"  打开的包是 {pack.source}，解到 {pack.root}")
        if pack.too_new:
            print(f"  {pack.too_new}包里的数据没有解析。")
    if given_dirs:
        print(f"  归档目录是 {'、'.join(str(d) for d in given_dirs)}（上一级目录下新建的任务随时收进来）")
        print(f"  任务目录所在目录是 {workspaces_dir}")
    if sim_root is not None:
        print(f"  演练根目录是 {sim_root}（它下面每一遍演练的归档与任务随时收进来）")
    print("  按 Ctrl+C 停掉它。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n观测台已经停了。")
    finally:
        httpd.server_close()
