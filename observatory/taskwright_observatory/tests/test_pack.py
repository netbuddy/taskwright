"""观测台打开数据包（--pack，pack.py）的测试。

用的是 `fixtures/packs/` 下三个由产品后端真导出的小包：完整诊断包、脱敏诊断包、普通数据包（一个任务实例，不带事件归档）。
它们由 backend/tests/fixtures/make_observatory_packs.mts 生成，包里的本机路径已换成中性写法；再生办法见那个脚本的开头。

测这些事：解包到缓存目录、同一个包不重解、解到一半的重解、指向包外的路径被拒；包头各项；格式过新时的说法与不解析；
脱敏占位换成给人看的一句；包里的后端日志与设置摘录；读取接口（包头、日志、设置摘录、不在包里的会话）；
本机没有 node 时完成条件写「未核对」；普通数据包也能打开，会话写没有事件归档；观测台认得的格式与产品代码里的常量一致。

跑法：在代码仓的 observatory 目录下运行 `python3 -m pytest taskwright_observatory/tests/test_pack.py -q`
（或 `python3 -m unittest taskwright_observatory.tests.test_pack`）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError
from urllib.request import urlopen

from taskwright_observatory import __main__ as entry
from taskwright_observatory import pack as packs
from taskwright_observatory import runs, taskpage
from taskwright_observatory.api import Index
from taskwright_observatory.server import IndexCache, expand_archive_dirs, make_handler
from taskwright_observatory.taskdb import KNOWN_PACK_FORMAT, KNOWN_TASK_DB_VERSION

PACKS = Path(__file__).resolve().parent / "fixtures" / "packs"
FULL = PACKS / "diag-full.taskwright.zip"
REDACTED = PACKS / "diag-redacted.taskwright.zip"
DATA = PACKS / "data.taskwright.zip"
REPO = Path(__file__).resolve().parents[3]


class PackCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="obs-pack-test-"))
        self.env = {"XDG_CACHE_HOME": str(self.tmp / "cache")}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def open(self, path: Path) -> packs.OpenedPack:
        return packs.open_pack(path, self.env)

    def rewritten(self, source: Path, name: str, change) -> Path:
        """把一个包复制一份，清单文件经 change 改过。"""
        target = self.tmp / name
        with zipfile.ZipFile(source) as old, zipfile.ZipFile(target, "w") as new:
            for info in old.infolist():
                data = old.read(info.filename)
                if info.filename == packs.MANIFEST:
                    manifest = json.loads(data)
                    change(manifest)
                    data = json.dumps(manifest).encode()
                new.writestr(info, data)
        return target


class OpenPackTest(PackCase):
    def test_解到缓存目录且同一个包不重解(self):
        first = self.open(FULL)
        self.assertEqual(first.root, self.tmp / "cache" / "taskwright" / "observatory" / packs.fingerprint_of(FULL))
        self.assertTrue((first.root / packs.COMPLETE_MARK).is_file())
        self.assertTrue(first.runs_dir.is_dir() and first.tasks_dir.is_dir())
        marker = first.root / "解过一次的记号"
        marker.write_text("1")
        again = self.open(FULL)
        self.assertEqual(again.root, first.root)
        self.assertTrue(marker.is_file(), "已经解好的不重解")
        # 旁边没有留下临时目录。
        self.assertEqual([p.name for p in first.root.parent.iterdir()], [first.root.name])

    def test_解到一半的目录删掉重解(self):
        first = self.open(FULL)
        (first.root / packs.COMPLETE_MARK).unlink()
        (first.root / "半截的文件").write_text("x")
        again = self.open(FULL)
        self.assertTrue((again.root / packs.COMPLETE_MARK).is_file())
        self.assertFalse((again.root / "半截的文件").exists())

    def test_指向包外的路径与不是包的文件被拒(self):
        evil = self.tmp / "evil.zip"
        with zipfile.ZipFile(evil, "w") as z:
            z.writestr("manifest.json", "{}")
            z.writestr("../逃出去.txt", "x")
        with self.assertRaisesRegex(packs.PackError, "指向包外的路径"):
            self.open(evil)
        self.assertFalse((self.tmp / "cache" / "taskwright" / "逃出去.txt").exists())
        self.assertEqual([p for p in (self.tmp / "cache" / "taskwright" / "observatory").iterdir()], [], "失败时不留目录")
        plain = self.tmp / "plain.txt"
        plain.write_text("不是 zip")
        with self.assertRaisesRegex(packs.PackError, "不是一个数据包"):
            self.open(plain)


class HeaderTest(PackCase):
    def test_诊断包的包头各项(self):
        head = packs.header(self.open(REDACTED))
        self.assertEqual([head["是不是诊断包"], head["用途"], head["粒度"], head["包格式"], head["任务库格式"]],
                         [True, "脱敏", "一个任务实例", KNOWN_PACK_FORMAT, KNOWN_TASK_DB_VERSION])
        self.assertRegex(head["任务编号"], r"^TASK-\d{8}-[0-9A-F]{4}$")
        self.assertRegex(head["日志范围"], r"^\S+ 到 \S+$")
        self.assertTrue(head["导出时刻"] and head["产品版本"])
        self.assertEqual(head["格式过新"], "")
        self.assertEqual(packs.header(self.open(FULL))["用途"], "完整")

    def test_模型取启动时的那一个优先(self):
        opened = self.open(FULL)
        opened.manifest["diagnostic"] = {**opened.manifest["diagnostic"], "model": "甲模型", "launch_model": "乙模型"}
        self.assertEqual(packs.header(opened)["模型"], "乙模型")
        opened.manifest["diagnostic"] = {**opened.manifest["diagnostic"], "launch_model": None}
        self.assertEqual(packs.header(opened)["模型"], "甲模型")
        opened.manifest["diagnostic"] = {**opened.manifest["diagnostic"], "launch_model": {"provider": "deepseek", "model": "deepseek-flash", "from": "启动配置"}}
        self.assertEqual(packs.header(opened)["模型"], "deepseek-flash（deepseek，取自启动配置）")

    def test_普通数据包写明不是诊断包(self):
        head = packs.header(self.open(DATA))
        self.assertEqual([head["是不是诊断包"], head["用途"], head["日志范围"], head["带没带事件归档"]],
                         [False, "数据包（不是诊断包）", "", False])

    def test_格式过新时说请用哪一版并且不解析(self):
        newer = self.rewritten(FULL, "newer.zip", lambda m: m.update(pack_format=KNOWN_PACK_FORMAT + 1, product_version="9.9.9"))
        opened = self.open(newer)
        self.assertEqual(opened.too_new, f"这个包是格式 {KNOWN_PACK_FORMAT + 1}，这个观测台只认到格式 {KNOWN_PACK_FORMAT}，请用 9.9.9 版观测台。")
        db = self.rewritten(FULL, "db.zip", lambda m: m.update(task_db_version=KNOWN_TASK_DB_VERSION + 1, product_version="9.9.9"))
        self.assertIn(f"任务库是格式 {KNOWN_TASK_DB_VERSION + 1}", self.open(db).too_new)
        # 入口在格式过新时不把包里的目录交给服务。
        with mock.patch.dict(os.environ, self.env), mock.patch.object(entry, "serve") as serve:
            self.assertEqual(entry.main(["--pack", str(newer), "--port", "0"]), 0)
        given, workspaces = serve.call_args.args[0], serve.call_args.args[1]
        self.assertEqual([given, workspaces], [[], None])
        self.assertTrue(serve.call_args.kwargs["pack"].too_new)

    def test_入口与目录参数互斥(self):
        with mock.patch.object(entry, "serve") as serve:
            self.assertEqual(entry.main(["--pack", str(FULL), "--runs", str(self.tmp)]), 2)
        serve.assert_not_called()


class RedactedTest(PackCase):
    def test_占位换成给人看的一句(self):
        text = '{"redacted":true,"tool":"read","path":"inputs/a.md","lines":[1,200],"bytes":4795,"sha256_16":"2d005f233084e547"}'
        shown, value = runs.redacted_view(text)
        self.assertEqual(shown, "已脱敏（路径 inputs/a.md，第 1 到 200 行，4795 字节）")
        self.assertEqual(value["sha256_16"], "2d005f233084e547")
        shown, _ = runs.redacted_view('{"redacted":true,"tool":"search_knowledge","libraries":["lib-0abc"],"bytes":12,"sha256_16":"x"}')
        self.assertEqual(shown, "已脱敏（知识库 lib-0abc，12 字节）")
        self.assertEqual(runs.redacted_view("普通的结果"), ("普通的结果", None))
        self.assertEqual(runs.redacted_view('{"redacted":false}'), ('{"redacted":false}', None))

    def test_脱敏包回放时读输入资料的结果是占位句_完整包是原文(self):
        def read_results(path: Path) -> list[str]:
            opened = self.open(path)
            index = Index(expand_archive_dirs([opened.runs_dir]), [opened.tasks_dir])
            session = index.session_list()["会话"][0]["会话编号"]
            detail = json.dumps(index.session_detail(session), ensure_ascii=False)
            return re.findall(r'"结果文字": "([^"]*)"', detail)
        redacted = read_results(REDACTED)
        self.assertIn("已脱敏（路径 inputs/材料.md，27 字节）", redacted)
        self.assertNotIn("买家可以申请退货。", redacted)
        self.assertIn("买家可以申请退货。", read_results(FULL))

    def test_任务库副本里的摘录照原样带着记号(self):
        import sqlite3
        opened = self.open(REDACTED)
        db = next(opened.tasks_dir.glob("*/task.sqlite"))
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
            excerpts = [row[0] for row in conn.execute("SELECT excerpt FROM item_source WHERE excerpt <> ''")]
        self.assertTrue(excerpts and all(one.startswith("[已脱敏] 摘要值 ") for one in excerpts), excerpts)


class LogsAndSettingsTest(PackCase):
    def test_日志列表与全文(self):
        opened = self.open(FULL)
        rows = packs.log_files(opened)
        self.assertEqual(len(rows), 1)
        self.assertRegex(rows[0]["文件"], r"^backend-\d{8}\.log$")
        text = packs.log_text(opened, rows[0]["文件"])
        self.assertEqual(rows[0]["行数"], text.count("\n"))
        for bad in ["../manifest.json", "", "..", "没有这份.log"]:
            with self.assertRaises(FileNotFoundError):
                packs.log_text(opened, bad)
        self.assertEqual(packs.log_files(self.open(DATA)), [])

    def test_设置摘录(self):
        full = packs.settings_excerpt(self.open(FULL))["内容"]
        redacted = packs.settings_excerpt(self.open(REDACTED))["内容"]
        self.assertEqual(full["providers"]["taskwright-ollama"]["base_url"], "http://models.example.test:11434")
        self.assertEqual(redacted["providers"]["taskwright-ollama"]["base_url"], "[已脱敏]")
        self.assertIsNone(packs.settings_excerpt(self.open(DATA)))


class ServerTest(PackCase):
    """起一次真的读取服务（端口由系统挑），按网页的办法请求。"""

    def serve(self, path: Path):
        opened = self.open(path)
        cache = IndexCache([opened.runs_dir], opened.tasks_dir, "", "")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cache, opened))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def get(route: str):
            try:
                with urlopen(base + route) as response:
                    return response.status, json.loads(response.read())
            except HTTPError as error:
                return error.code, json.loads(error.read())
        return get

    def test_包头日志设置与不在包里的会话(self):
        get = self.serve(REDACTED)
        status, overview = get("/api/overview")
        self.assertEqual([status, overview["诊断包"]["用途"]], [200, "脱敏"])
        status, logs = get("/api/pack/logs")
        self.assertEqual(status, 200)
        name = logs["日志"][0]["文件"]
        self.assertEqual(get(f"/api/pack/logs/{name}")[0], 200)
        self.assertEqual(get("/api/pack/logs/..%2Fmanifest.json")[0], 404)
        self.assertEqual(get("/api/pack/settings")[1]["设置摘录"]["内容"]["providers"]["taskwright-ollama"]["base_url"], "[已脱敏]")
        status, missing = get("/api/sessions/0000-not-in-pack")
        self.assertEqual(status, 404)
        self.assertTrue(missing["出错了"].startswith("这段的归档不在包里（"), missing)

    def test_普通数据包可以打开_会话写没有事件归档(self):
        get = self.serve(DATA)
        status, overview = get("/api/overview")
        self.assertEqual([status, overview["诊断包"]["是不是诊断包"], overview["会话数"]], [200, False, 1])
        rows = get("/api/sessions")[1]["会话"]
        self.assertEqual(rows[0]["终态"], runs.NO_EVENTS)


class NoNodeTest(unittest.TestCase):
    def test_没有_node_时完成条件写未核对(self):
        with mock.patch.object(taskpage.shutil, "which", return_value=None):
            self.assertEqual(taskpage.check_completion(Path("/不存在"), "T", {"x": 1}), (None, "未核对（本机没有 node）", ""))
            self.assertIsNone(taskpage.render_reply_lines({"调用编号": "无 node 的一次", "工具": "reply"}))
        # 找到的 node 在调用时已经不在了：同样写未核对。
        with mock.patch.object(taskpage.shutil, "which", return_value="/不存在的目录/node"):
            self.assertEqual(taskpage.check_completion(Path("/不存在"), "T", {"x": 1}), (None, "未核对（本机没有 node）", ""))


class KnownFormatsTest(unittest.TestCase):
    def test_观测台认得的格式与产品代码里的常量一致(self):
        pack_format = re.search(r"export const PACK_FORMAT = (\d+);", (REPO / "backend" / "src" / "data_pack.ts").read_text(encoding="utf-8"))
        db_version = re.search(r"export const TASK_DB_VERSION = (\d+);", (REPO / "agent" / "src" / "lib" / "schema.ts").read_text(encoding="utf-8"))
        self.assertEqual([int(pack_format.group(1)), int(db_version.group(1))], [KNOWN_PACK_FORMAT, KNOWN_TASK_DB_VERSION])


if __name__ == "__main__":
    unittest.main()
