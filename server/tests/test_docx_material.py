"""Word 材料（.docx）：文本投影与抽取脚本逐行一致；上传时生成投影、坏文件与保留名拒绝；材料原样取回的端点；
content 端点对 .docx 给投影；命令行建任务复制 .docx 时也生成投影；导出文档里的出处不带段落号。
夹具是 examples/library-lending/requirements-styled.docx。"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from taskwright_server import launch
from taskwright_server.service import docx_text, render
from taskwright_server.service.app import Service, serve
from taskwright_server.service.errors import ApiError

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "examples/library-lending/requirements-styled.docx"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class ProjectionTest(unittest.TestCase):
    def test_样本114段_每段一行_表格写位置(self):
        lines = [ln for ln in docx_text.projection_text(SAMPLE.read_bytes(), "inputs/x.docx").splitlines() if ln.startswith("[")]
        self.assertEqual(len(lines), 114)
        self.assertEqual(lines[0], "[第 1 段] 学校图书馆借还书系统需求说明")
        self.assertEqual(lines[36], "[第 37 段 · 表 1 行 1 列 2] 一次最多（本）")
        self.assertTrue(lines[90].startswith("[第 91 段 · 表 3 行 2 列 2] 开学第一周是借还高峰，系统要能每分钟处理至少 100 笔借还。"))

    @unittest.skipIf(shutil.which("node") is None, "本机没有 node")
    def test_与抽取脚本逐行一致(self):
        node = subprocess.run(["node", str(ROOT / "scripts/docx_paragraphs.mjs"), str(SAMPLE)], check=True, capture_output=True, text=True)
        expected = [ln.replace("↵", " ") for ln in node.stdout.splitlines()]
        got = [ln for ln in docx_text.projection_text(SAMPLE.read_bytes(), "inputs/x.docx").splitlines() if ln.startswith("[")]
        self.assertEqual(got, expected)

    def test_不是docx时抛错(self):
        with self.assertRaises(ValueError):
            docx_text.projection_text(b"not a zip", "inputs/x.docx")


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，建不了任务")
class DocxMaterialServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.service = Service(root / "tasks", root / "runs", launch.load_profile("dev"))
        self.task_id = self.service.create({"task_type": "srs-authoring", "task_name": "Word 材料"})["task_id"]
        self.t = self.service.task(self.task_id)

    def tearDown(self):
        self.service.close()
        self.tmp.cleanup()

    def test_上传docx_旁边生成投影_清单里两份都在(self):
        self.assertEqual(self.service.upload(self.t, "需求.docx", SAMPLE.read_bytes()), {"ok": True, "path": "inputs/需求.docx"})
        projection = self.t.dir / "inputs/需求.docx.txt"
        self.assertTrue(projection.read_text(encoding="utf-8").startswith("# 由 需求.docx 生成"))
        self.assertIn("出处写 inputs/需求.docx#p段落号", projection.read_text(encoding="utf-8"))
        # 重名加序号时，投影跟着新名字
        self.assertEqual(self.service.upload(self.t, "需求.docx", SAMPLE.read_bytes())["path"], "inputs/需求-2.docx")
        self.assertTrue((self.t.dir / "inputs/需求-2.docx.txt").is_file())
        paths = [m["path"] for m in self.service.task_page(self.t)["materials"]]
        self.assertEqual(paths, ["inputs/需求-2.docx", "inputs/需求-2.docx.txt", "inputs/需求.docx", "inputs/需求.docx.txt"])

    def test_坏的docx与保留名拒绝(self):
        for name, data, code in (("坏.docx", b"x", "unsupported_type"), ("a.docx.txt", b"x", "bad_request"), ("图.png", b"x", "unsupported_type")):
            with self.assertRaises(ApiError) as caught:
                self.service.upload(self.t, name, data)
            self.assertEqual(caught.exception.code, code, name)
        self.assertFalse((self.t.dir / "inputs/坏.docx").exists())

    def test_原样取回端点_内容类型_路径越界拒绝_content给投影(self):
        self.service.upload(self.t, "需求.docx", SAMPLE.read_bytes())
        self.service.upload(self.t, "说明.md", "甲".encode())
        server = serve(self.service, "127.0.0.1", 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/api/v1/tasks/{self.task_id}/materials"
        get = lambda what, rel: urllib.request.urlopen(f"{base}/{what}?path={urllib.parse.quote(rel)}", timeout=10)
        try:
            with get("raw", "inputs/需求.docx") as r:
                self.assertEqual(r.headers["Content-Type"], DOCX_TYPE)
                self.assertEqual(r.read(), SAMPLE.read_bytes())
            with get("raw", "inputs/说明.md") as r:
                self.assertEqual((r.headers["Content-Type"], r.read()), ("text/markdown; charset=utf-8", "甲".encode()))
            for bad, status in (("inputs/../task.sqlite", 400), ("/etc/passwd", 400), ("", 400), ("inputs/没有.docx", 404)):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    get("raw", bad)
                self.assertEqual(caught.exception.code, status, bad)
                caught.exception.close()
            with get("content", "inputs/需求.docx") as r:
                text = json.loads(r.read())["text"]
            self.assertIn("[第 76 段] 逾期的每本每天罚款一角，罚款最多不超过这本书的定价。罚款怎样缴纳待定。", text)
        finally:
            server.shutdown()
            server.server_close()


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，建不了任务")
class CreateTaskDocxTest(unittest.TestCase):
    def test_命令行建任务复制docx时也生成投影(self):
        from taskwright_server.create_task import create_task
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "t"
            create_task(target, materials=[SAMPLE])
            self.assertTrue((target / "inputs/requirements-styled.docx.txt").is_file())


class ExportLocatorTest(unittest.TestCase):
    def test_导出文档里Word材料的出处只写文件名(self):
        class Lib:
            def sources_of(self, item_id, revision_no):
                return [{"kind": "文档原文", "locator": "inputs/需求.docx#p76", "excerpt": "逾期的每本每天罚款一角"},
                        {"kind": "文档原文", "locator": "inputs/a.md", "excerpt": "原文"}]
        self.assertEqual(render.sources_text(Lib(), "UC-001", 1),
                         "文档原文，出处 inputs/需求.docx（「逾期的每本每天罚款一角」）；文档原文，出处 inputs/a.md（「原文」）")


if __name__ == "__main__":
    unittest.main()
