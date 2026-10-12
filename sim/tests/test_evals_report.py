"""评测汇总里几样内容的写法：「例外」一节没有命中时的说明。每遍的「评测.json」照评测命令写出的样子手写，不起后端。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
