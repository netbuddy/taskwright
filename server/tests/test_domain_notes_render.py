"""文档导出里的「领域说明」：真实的软件需求规格说明模板多了「术语与定义」「总体描述」两节，后面的章节顺延编号；
模板引擎的「按字段值筛选」与「按字段归组」两种写法；种类为「领域说明」的来源写成「领域说明 DN-001（「摘录」）」。

库由 agent 的写入一侧（Node 子进程调用 createTask 与 saveRevision）按真实任务类型建出来，模板用任务类型目录里的那一份。
本机没有 node 时整组跳过。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from taskwright_server.service import library, render
from taskwright_server.service.errors import ApiError

TYPE_DIR = library.REPO_ROOT / "task-types" / "srs-authoring"
MATERIAL = "读者凭口令登录。管理员在服务台办理借还。"
SOURCE = {"kind": "文档原文", "locator": "inputs/材料.md", "excerpt": "读者凭口令登录。"}


def note(title: str, category: str, content: str) -> dict:
    return {"op": "add", "collection": "领域说明", "fields": {"标题": title, "内容": content, "类别": category}, "sources": [SOURCE]}


OPERATIONS = [
    [note("口令", "术语", "读者登录时输入的一串字符"), note("管理员", "角色", "在服务台办理借还的工作人员"),
     note("开学第一周", "背景", "借还量最大的一周"), note("借阅", "术语", "读者把书借走")],
    [{"op": "add", "collection": "功能用例",
      "fields": {"用例名称": "登录", "用例功能": "读者登录系统。", "参与者": ["读者"], "基本流程": ["输入口令"]},
      "sources": [SOURCE, {"kind": "领域说明", "locator": "DN-001", "excerpt": "读者登录时输入的一串字符", "supports": [{"field": "基本流程", "index": 0}]}]}],
]


def build_task(root: Path) -> Path:
    ws = root / "task"
    shutil.copytree(TYPE_DIR, ws)
    (ws / "inputs").mkdir()
    (ws / "inputs" / "材料.md").write_text(MATERIAL, encoding="utf-8")
    lib_dir = library.REPO_ROOT / "agent" / "src" / "lib"
    script = (
        f"const {{ createTask }} = await import('{lib_dir / 'create_task.ts'}');"
        f"const {{ saveRevision }} = await import('{lib_dir / 'save_revision.ts'}');"
        "const ws = process.argv[1]; let n = 0; const call = () => ({ workspaceDir: ws, sessionId: 's', callId: `c${++n}` });"
        "createTask(call(), { definition_path: 'docs/task-definitions/srs-authoring.json' });"
        "for (const operations of JSON.parse(process.argv[2])) saveRevision(call(), { operations });"
    )
    subprocess.run(["node", "--input-type=module", "-e", script, str(ws), json.dumps(OPERATIONS, ensure_ascii=False)], check=True)
    return ws


def read_lib(ws: Path) -> library.Library:
    conn = library.open_ro(ws)
    try:
        return library.Library(library.read_all(conn))
    finally:
        conn.close()


@unittest.skipUnless(shutil.which("node"), "本机没有 node，建不出任务库")
class DomainNotesDocumentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.ws = build_task(Path(cls.tmp.name))
        cls.text = render.render(cls.ws, read_lib(cls.ws))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def section(self, title: str) -> str:
        start = self.text.index(f"## {title}")
        end = self.text.find("\n## ", start + 1)
        return self.text[start:end if end >= 0 else None]

    def test_功能需求之前多了两节_后面的章节顺延编号(self):
        heads = [line for line in self.text.splitlines() if line.startswith("## ")]
        self.assertEqual(heads, ["## 1 术语与定义", "## 2 总体描述", "## 3 功能需求", "## 4 非功能需求", "## 5 约束", "## 6 问题"])

    def test_术语与定义只收类别为术语的_按编号排(self):
        terms = self.section("1 术语与定义")
        self.assertIn("- **口令**（DN-001）：读者登录时输入的一串字符 ［修订 1 · 未确认］来源：文档原文，出处 inputs/材料.md（「读者凭口令登录。」）", terms)
        self.assertLess(terms.index("DN-001"), terms.index("DN-004"))
        self.assertNotIn("DN-002", terms)
        self.assertNotIn("DN-003", terms)

    def test_总体描述收其余的_按类别归组_组的先后按每组第一个编号(self):
        overview = self.section("2 总体描述")
        self.assertLess(overview.index("### 角色"), overview.index("### 背景"))
        self.assertIn("- **DN-002 管理员**：在服务台办理借还的工作人员", overview)
        self.assertIn("- **DN-003 开学第一周**：借还量最大的一周", overview)
        self.assertNotIn("DN-001", overview)
        self.assertNotIn("本文档没有总体描述。", overview)

    def test_定义视图带上集合的界面一项_没写的集合为空(self):
        lib = read_lib(self.ws)
        view = library.definition_view(lib.definition)["collections"]
        notes = next(c for c in view if c["name"] == "领域说明")
        self.assertEqual(notes["display"], {"side_tab": True, "group_field": "类别", "leading_groups": ["术语"],
                                            "note": "材料里或你说明过的背景、术语、角色，供条目引用。"})
        self.assertIsNone(next(c for c in view if c["name"] == "功能用例")["display"])
        self.assertFalse(notes["needs_review"])

    def test_领域说明作来源写成编号加摘录(self):
        uc = self.section("3 功能需求")
        self.assertIn("领域说明 DN-001（「读者登录时输入的一串字符」）", uc)
        self.assertNotIn("出处 DN-001", uc)


class TemplateSyntaxTest(unittest.TestCase):
    """筛选与归组两种写法本身：用最小的假交付物测，不经真库。"""

    def render(self, template: str, rows: list[tuple[str, dict]]) -> str:
        class Lib:
            definition = {"文档模板": "t.md"}
            collections = {"说明": {"字段": [{"名": "类别", "类型": "文本"}, {"名": "标签", "类型": "文本列表"}]}}
            items = {item_id: {"collection": "说明", "serial": n} for n, (item_id, _) in enumerate(rows, 1)}
            data = {"sources": {}, "event_meta": {}}

            def latest_revision(self):
                return 1

            def alive_at(self, revision_no):
                return [(item_id, 1) for item_id, _ in rows]

            def fields_of(self, item_id, revision_no):
                return dict(rows)[item_id]

            def sources_of(self, item_id, revision_no):
                return []

        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "t.md").write_text(template, encoding="utf-8")
        original = render.review_state, render.confirm_state
        render.review_state = render.confirm_state = lambda *a: ""
        try:
            return render.render(tmp, Lib())
        finally:
            render.review_state, render.confirm_state = original

    ROWS = [("N-1", {"类别": "术语", "标签": ["甲"]}), ("N-2", {"类别": "角色", "标签": ["乙"]}),
            ("N-3", {"类别": "术语", "标签": ["甲", "乙"]}), ("N-4", {"类别": "", "标签": []}), ("N-5", {"类别": "角色"})]

    def test_按字段值筛选_等于与不等于_列表按含有比_几个条件同时成立(self):
        self.assertEqual(self.render("{{#每个 说明 类别=术语}}{{编号}} {{/每个}}", self.ROWS), "N-1 N-3 ")
        self.assertEqual(self.render("{{#每个 说明 类别!=术语}}{{编号}} {{/每个}}", self.ROWS), "N-2 N-4 N-5 ")
        self.assertEqual(self.render("{{#每个 说明 标签=乙}}{{编号}} {{/每个}}", self.ROWS), "N-2 N-3 ")
        self.assertEqual(self.render("{{#每个 说明 类别=术语 标签!=乙}}{{编号}} {{/每个}}", self.ROWS), "N-1 ")
        self.assertEqual(self.render("{{#没有 说明 类别=例子}}没有例子{{/没有}}{{#没有 说明 类别=术语}}没有术语{{/没有}}", self.ROWS), "没有例子")

    def test_按字段归组_组名_组内每个_空值一组_没有条目时整段不输出(self):
        template = "{{#按 类别 归组 说明}}[{{组名}}]{{#组内每个}}{{编号}},{{/组内每个}}\n{{/按}}"
        # 与「每个」一样，结束标记后面紧跟的一个换行随标记一起去掉。
        self.assertEqual(self.render(template, self.ROWS), "[术语]N-1,N-3,[角色]N-2,N-5,[（未填）]N-4,")
        self.assertEqual(self.render("{{#按 类别 归组 说明 类别!=术语}}[{{组名}}]{{#组内每个}}{{编号}},{{/组内每个}}{{/按}}", self.ROWS),
                         "[角色]N-2,N-5,[（未填）]N-4,")
        self.assertEqual(self.render("前{{#按 类别 归组 说明 类别=例子}}[{{组名}}]{{/按}}后", self.ROWS), "前后")

    def test_筛选条件写错时说清楚(self):
        with self.assertRaises(ApiError) as caught:
            self.render("{{#每个 说明 类别}}{{编号}}{{/每个}}", self.ROWS)
        self.assertIn("「类别」写得不对", str(caught.exception.args))


if __name__ == "__main__":
    unittest.main()
