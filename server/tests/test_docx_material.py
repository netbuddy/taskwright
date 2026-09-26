"""Word 材料（.docx）：上传时经 agent 的命令行入口生成 Markdown 投影与图片目录、坏文件与保留名拒绝；材料原样取回的端点；
content 端点对 .docx 给投影（0.2 的 .txt 投影照旧给）；命令行建任务复制 .docx 时也生成投影；导出文档里的出处不带段落号。
投影本身怎样写的测试在 agent/tests/docx_markdown.test.ts。夹具是 examples/library-lending/requirements-styled.docx。"""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from taskwright_server import launch
from taskwright_server.service import docx_projection, render
from taskwright_server.service.app import Service, serve
from taskwright_server.service.errors import ApiError

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "examples/library-lending/requirements-styled.docx"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@unittest.skipIf(shutil.which("node") is None, "本机没有 node")
class ProjectionTest(unittest.TestCase):
    def test_经命令行入口生成投影_写投影与图片目录(self):
        with tempfile.TemporaryDirectory() as tmp:
            docx = Path(tmp) / "x.docx"
            shutil.copy(SAMPLE, docx)
            self.assertEqual(docx_projection.write_projection(docx, "inputs/x.docx"), Path(tmp) / "x.docx.md")
            text = (Path(tmp) / "x.docx.md").read_text(encoding="utf-8")
            self.assertTrue(text.startswith("<!--\n由 x.docx 生成，供助手阅读。段落总数：114。"))
            self.assertIn("\n### 3.1.1 [p75] 逾期罚款\n", text)
            self.assertTrue((Path(tmp) / "x.docx.media/image1.png").is_file())
            self.assertEqual(docx_projection.projection_text(docx, "inputs/x.docx"), text)
            # 分段清单随投影写，参数按传进来的
            segments = json.loads((Path(tmp) / "x.docx.segments.json").read_text(encoding="utf-8"))
            self.assertEqual((segments["source"], len(segments["blocks"])), ("inputs/x.docx", 11))
            docx_projection.write_projection(docx, "inputs/x.docx", {**launch.SEGMENT_DEFAULTS, "heading_depth": 1})
            self.assertEqual(len(json.loads((Path(tmp) / "x.docx.segments.json").read_text(encoding="utf-8"))["blocks"]), 6)
            docx_projection.remove_projection(docx)
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ["x.docx"])

    def test_不是docx时抛错(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "坏.docx"
            bad.write_bytes(b"not a zip")
            with self.assertRaises(ValueError) as caught:
                docx_projection.write_projection(bad, "inputs/坏.docx")
            self.assertEqual(str(caught.exception), "不是 Word 文件（.docx），或者文件已损坏")

    def test_找投影_先md后txt(self):
        with tempfile.TemporaryDirectory() as tmp:
            docx = Path(tmp) / "x.docx"
            self.assertEqual(docx_projection.projection_path(docx).name, "x.docx.md")
            (Path(tmp) / "x.docx.txt").write_text("[第 1 段] 旧", encoding="utf-8")
            self.assertEqual(docx_projection.projection_path(docx).name, "x.docx.txt")
            (Path(tmp) / "x.docx.md").write_text("[p1] 新", encoding="utf-8")
            self.assertEqual(docx_projection.projection_path(docx).name, "x.docx.md")


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

    def test_上传docx_旁边生成投影与图片目录_清单里两份都在(self):
        self.assertEqual(self.service.upload(self.t, "需求.docx", SAMPLE.read_bytes()), {"ok": True, "path": "inputs/需求.docx"})
        projection = self.t.dir / "inputs/需求.docx.md"
        self.assertTrue(projection.read_text(encoding="utf-8").startswith("<!--\n由 需求.docx 生成"))
        self.assertIn("出处写 inputs/需求.docx#p段落号", projection.read_text(encoding="utf-8"))
        self.assertIn("![图 1](inputs/需求.docx.media/image1.png)", projection.read_text(encoding="utf-8"))
        self.assertTrue((self.t.dir / "inputs/需求.docx.media/image1.png").is_file())
        # 重名加序号时，投影与图片目录跟着新名字
        self.assertEqual(self.service.upload(self.t, "需求.docx", SAMPLE.read_bytes())["path"], "inputs/需求-2.docx")
        self.assertIn("![图 1](inputs/需求-2.docx.media/image1.png)", (self.t.dir / "inputs/需求-2.docx.md").read_text(encoding="utf-8"))
        self.assertTrue((self.t.dir / "inputs/需求-2.docx.media/image2.png").is_file())
        # 材料清单只列文件，图片目录不列
        paths = [m["path"] for m in self.service.task_page(self.t)["materials"]]
        self.assertEqual(paths, ["inputs/需求-2.docx", "inputs/需求-2.docx.md", "inputs/需求-2.docx.segments.json",
                                 "inputs/需求.docx", "inputs/需求.docx.md", "inputs/需求.docx.segments.json"])
        # 投影与分段清单标明派生自哪份 Word 文件，界面据此不列出；原始材料为 None
        marks = {m["path"]: m["derived_from"] for m in self.service.task_page(self.t)["materials"]}
        self.assertEqual(marks, {"inputs/需求-2.docx": None, "inputs/需求-2.docx.md": "inputs/需求-2.docx",
                                 "inputs/需求-2.docx.segments.json": "inputs/需求-2.docx",
                                 "inputs/需求.docx": None, "inputs/需求.docx.md": "inputs/需求.docx",
                                 "inputs/需求.docx.segments.json": "inputs/需求.docx"})
        segments = json.loads((self.t.dir / "inputs/需求.docx.segments.json").read_text(encoding="utf-8"))
        self.assertEqual((segments["source"], segments["projection"], len(segments["blocks"])), ("inputs/需求.docx", "inputs/需求.docx.md", 11))
        # 0.2 的 .txt 投影同样标明；没有对应 .docx 的 .md 是普通材料
        (self.t.dir / "inputs/需求.docx.txt").write_text("[第 1 段] 旧", encoding="utf-8")
        (self.t.dir / "inputs/孤儿.docx.md").write_text("x", encoding="utf-8")
        (self.t.dir / "inputs/孤儿.docx.segments.json").write_text("{}", encoding="utf-8")
        marks = {m["path"]: m["derived_from"] for m in self.service.task_page(self.t)["materials"]}
        self.assertEqual((marks["inputs/需求.docx.txt"], marks["inputs/孤儿.docx.md"], marks["inputs/孤儿.docx.segments.json"]),
                         ("inputs/需求.docx", None, None))

    def test_坏的docx与保留名拒绝(self):
        for name, data, code in (("坏.docx", b"x", "unsupported_type"), ("a.docx.txt", b"x", "bad_request"),
                                 ("a.docx.md", b"x", "bad_request"), ("图.png", b"x", "unsupported_type")):
            with self.assertRaises(ApiError) as caught:
                self.service.upload(self.t, name, data)
            self.assertEqual(caught.exception.code, code, name)
        # 坏文件连同投影都不留下
        self.assertEqual(sorted(p.name for p in (self.t.dir / "inputs").iterdir()), [])

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
            self.assertIn("\n[p76] 逾期的每本每天罚款一角，罚款最多不超过这本书的定价。罚款怎样缴纳待定。\n", text)
            # 0.2 的任务：只有纯文本投影时照旧给它；投影都没有时现算一份 Markdown 投影（不写文件）
            (self.t.dir / "inputs/需求.docx.md").rename(self.t.dir / "inputs/需求.docx.txt")
            with get("content", "inputs/需求.docx") as r:
                self.assertEqual(json.loads(r.read())["text"], (self.t.dir / "inputs/需求.docx.txt").read_text(encoding="utf-8"))
            (self.t.dir / "inputs/需求.docx.txt").unlink()
            with get("content", "inputs/需求.docx") as r:
                self.assertIn("\n[p76] 逾期的每本每天罚款一角", json.loads(r.read())["text"])
            self.assertFalse((self.t.dir / "inputs/需求.docx.md").exists())
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
            self.assertTrue((target / "inputs/requirements-styled.docx.md").is_file())
            self.assertTrue((target / "inputs/requirements-styled.docx.media/image1.png").is_file())


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
