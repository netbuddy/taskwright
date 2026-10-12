"""评测汇总里几样内容的写法：「例外」一节没有命中时的说明、「模型」一节的名字。每遍的「评测.json」照评测命令写出的样子手写，不起后端。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import evals as eval_files

from sim import evals
from sim.tests.test_evals import META, group, write_run


class ExceptionCellTest(unittest.TestCase):
    def test_例外一节没有命中而别的例子里提到了_汇总里写出是哪几页(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            elsewhere = {**group("例外·借书", ["超过上限", "最多借"], False), "只在别的例子里提到的页": ["OA-001", "OA-004"], "流程的页": ["OA-001", "OA-004"]}
            strict = {**group("例外·借书", ["超过上限", "最多借"], True), "只在别的例子里提到的页": [], "流程的页": ["OA-001"]}
            sims = [write_run(root, "sim-001", {}, [elsewhere]), write_run(root, "sim-002", {}, [strict]),
                    write_run(root, "sim-003", {}, [group("例外·借书", ["超过上限", "最多借"], False)])]
            summary = evals.summarize(root, "甲", sims, META)
            text = evals.summary_path(root, "甲", "md").read_text(encoding="utf-8")
        row = summary["至少应有"][0]
        self.assertEqual((row["各遍"], row["各遍只在别的例子里提到的页"], row["命中遍数"]), ([False, True, False], [["OA-001", "OA-004"], [], []], 1))
        self.assertNotIn("各遍以例外开头", row)
        self.assertIn("| 例外·借书 | 超过上限／最多借 | 没有（OA-001、OA-004 的例子里提到了，但不以「例外：」开头） | 命中（UC-001） | 没有 | 1／3 |", text)


class ModelSectionTest(unittest.TestCase):
    def test_模型一节按种类的键对照_汇总与对照里写种类的名字(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            model = lambda hit, name: {**group("模型·class", ["借书证"], hit), "部分名": name, "这一种的图": ["DG-001"]}      # noqa: E731
            evals.write_list(root, evals.summarize(root, "甲", [write_run(root, "sim-001", {}, [model(True, "模型·类图")])], META))
            # 后一次评测里这一种图换了名字：键没有变，两次仍然对得上，名字按后一次的写。
            evals.write_list(root, evals.summarize(root, "乙", [write_run(root, "sim-002", {}, [model(False, "模型·对象关系图")])], META))
            first = evals.summary_path(root, "甲", "md").read_text(encoding="utf-8")
            compared = eval_files.compare(root, "甲", "乙")
            printed = eval_files.compare_markdown(compared)
        self.assertIn("| 模型·类图 | 借书证 | 命中（UC-001） | 1／1 |", first)
        self.assertEqual([(row["部分"], row["部分名"], row["前"]["分子"], row["后"]["分子"], row["变差"]) for row in compared["至少应有"]],
                         [("模型·class", "模型·对象关系图", 1, 0, True)])
        self.assertIn("| 模型·对象关系图 | 借书证 | 1／1（100%） | 0／1（0%） | −100 个百分点，**变差** |", printed)


if __name__ == "__main__":
    unittest.main()
