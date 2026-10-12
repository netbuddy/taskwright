"""评测命令行自己的几样规矩：每遍的轮数上限缺省 60（单跑一遍演练仍是 12）。"""

from __future__ import annotations

import unittest

from sim import evals, run

RUN = ["run", "--persona", "p.json", "--expect", "e.json", "--label", "试一次"]


class MaxRoundsTest(unittest.TestCase):
    def test_评测每遍的轮数上限缺省六十_单跑演练仍是十二_给了就照给的(self):
        parser, _ = evals.build_parser()
        self.assertEqual((evals.MAX_ROUNDS, parser.parse_args(RUN).max_rounds), (60, 60))
        self.assertEqual(parser.parse_args([*RUN, "--max-rounds", "30"]).max_rounds, 30)
        self.assertEqual(run.build_parser().parse_args(["--persona", "p.json"]).max_rounds, 12)
        # 别的参数照旧从单跑演练的那一份来。
        self.assertEqual((parser.parse_args(RUN).stall_rounds, parser.parse_args(RUN).repeat), (run.STALL_ROUNDS, 1))


if __name__ == "__main__":
    unittest.main()
