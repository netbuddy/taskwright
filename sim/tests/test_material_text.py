"""材料的文字：文本材料按原文读，Word 材料取产品的文字版（经 agent 的命令行入口，要用 node）。"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from sim import launch_user, material_text

REPO = Path(__file__).resolve().parents[2]
EXAMPLES = REPO / "examples" / "library-lending"
DOCX = "requirements-styled.docx"

TEXT_VERSION = """<!--
由 x.docx 生成，供助手阅读。段落总数：6。
-->

# 1 [p1] 概述

[p2] 读者凭借书证借书。

- [p3] 学生
   - 3.1 [p4] 本科生：凭学生证办理

| [p5] 读者类型 | [p6] 上限 |
"""


class PlainTextTest(unittest.TestCase):
    def test_文本材料按原文读_两种用途相同(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.md"
            path.write_text("读者凭借书证借书。\n", encoding="utf-8")
            self.assertEqual(material_text.material_text(path), "读者凭借书证借书。\n")
            self.assertEqual(material_text.material_for_check(path), "读者凭借书证借书。\n")

    def test_各段正文接成一串_记号与段落号都不要(self):
        self.assertEqual(material_text.paragraphs_joined(TEXT_VERSION), "概述读者凭借书证借书。学生本科生：凭学生证办理读者类型上限")

    def test_助手读_Word_材料时读的是文字版的文件名(self):
        self.assertEqual(material_text.read_names("a.docx"), ("a.docx", "a.docx.md"))
        self.assertEqual(material_text.read_names("a.md"), ("a.md",))


@unittest.skipUnless(shutil.which("node"), "本机没有 node")
class DocxTest(unittest.TestCase):
    def test_Word_材料给人读的是文字版_去掉开头给助手看的说明(self):
        text = material_text.material_text(EXAMPLES / DOCX)
        self.assertFalse(text.lstrip().startswith("<!--"))
        self.assertNotIn("供助手阅读", text)
        self.assertIn("[p11] 本期只覆盖图书的借、还、续借、预约与罚款登记；电子资源、馆际互借不在本期范围内。", text)

    def test_核对来源时_跨相邻两段的摘录找得到(self):
        joined = material_text.material_for_check(EXAMPLES / DOCX)
        self.assertIn("逾期：借期（含续借延长的部分）届满之日的次日起仍未归还。预约保留期：被预约的图书归还上架后", joined)
        self.assertNotIn("[p13]", joined)

    def test_画像里熟悉的材料是_Word_文件_文字版放进系统提示(self):
        persona = {"名字": "测试用户", "人设": "说话很短。", "目标": "拿到一份需求说明。", "材料": [DOCX], "熟悉的材料": [DOCX],
                   "材料说明": "一份需求。", "隐藏事实": [], "接受底线": []}
        prompt = launch_user.system_prompt(persona, EXAMPLES)
        self.assertIn(f"#### 《{DOCX}》", prompt)
        self.assertIn("[p7] 我们学校图书馆现在用纸质登记簿记录借还", prompt)

    def test_不是合法的_Word_文件_报给人看的一句话(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "坏的.docx"
            path.write_bytes(b"not a zip")
            with self.assertRaises(material_text.MaterialError) as caught:
                material_text.material_text(path)
        self.assertIn("坏的.docx", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
