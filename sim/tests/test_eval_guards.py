"""评测命令行自己的几样规矩：每遍的轮数上限缺省 60（单跑一遍演练仍是 12）；开跑前与两遍之间看磁盘的可用空间。

看磁盘的两例不起后端：取可用空间的函数、跑一遍演练的函数与算一遍评测的函数都换成假的，只看评测命令自己怎样决定跑不跑。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sim import evals, run
from sim.tests.test_evals import REPO, quiet, write_run

RUN = ["run", "--persona", "p.json", "--expect", "e.json", "--label", "试一次"]


class MaxRoundsTest(unittest.TestCase):
    def test_评测每遍的轮数上限缺省六十_单跑演练仍是十二_给了就照给的(self):
        parser, _ = evals.build_parser()
        self.assertEqual((evals.MAX_ROUNDS, parser.parse_args(RUN).max_rounds), (60, 60))
        self.assertEqual(parser.parse_args([*RUN, "--max-rounds", "30"]).max_rounds, 30)
        self.assertEqual(run.build_parser().parse_args(["--persona", "p.json"]).max_rounds, 12)
        # 别的参数照旧从单跑演练的那一份来。
        self.assertEqual((parser.parse_args(RUN).stall_rounds, parser.parse_args(RUN).repeat), (run.STALL_ROUNDS, 1))


GB = 1024 ** 3


class DiskSpaceTest(unittest.TestCase):
    def argv(self, root: Path, repeat: int) -> list[str]:
        return ["run", "--persona", str(REPO / "sim" / "personas" / "library-short.json"),
                "--expect", str(REPO / "sim" / "expectations" / "library-short.json"), "--materials-dir", "用不到",
                "--sim-root", str(root), "--repeat", str(repeat), "--label", "看磁盘"]

    def test_开跑前可用空间少于两个_G_就不开跑_说明剩多少要多少(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sims"
            with mock.patch.object(evals, "free_bytes", return_value=int(1.5 * GB)) as free, mock.patch.object(run, "run_once") as played:
                code, printed = quiet(self.argv(root, 3))
            self.assertEqual(code, 2)
            self.assertIn("只剩 1.5G 可用空间，少于开跑要的 2.0G，没有开跑。请先清出空间再跑。", printed)
            self.assertEqual((free.call_args.args[0], played.call_count), (root, 0))
            self.assertEqual([p.name for p in root.iterdir()], [], "一遍都没有跑，也没有写汇总")

    def test_跑完一遍后少于一个_G_就不跑剩下的_照跑完的写汇总并写明少跑几遍_以_1_退出(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sims"
            # 开跑前 5G；第一遍跑完 1.5G，够接着跑；第二遍跑完 0.5G，第三遍不跑。
            sizes = iter([5 * GB, int(1.5 * GB), GB // 2])

            def judged(sim, *_args, **_more):
                sim.rmdir()
                write_run(root, sim.name, {}, None)
                return {}
            with mock.patch.object(evals, "free_bytes", side_effect=lambda _path: next(sizes)), mock.patch.object(run, "run_once") as played, \
                    mock.patch.object(evals, "judge_one", side_effect=judged):
                code, printed = quiet(self.argv(root, 3))
            self.assertEqual((code, played.call_count), (1, 2))
            self.assertIn("第 2 遍跑完后", printed)
            self.assertIn("只剩 0.5G 可用空间，少于接着跑要的 1.0G；剩下的 1 遍没有跑。", printed)
            self.assertEqual(sorted(p.name for p in root.glob("sim-*")), ["sim-001", "sim-002"])
            summary = json.loads((root / "评测汇总_看磁盘.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["遍数"], summary["没有跑的遍数"]), (2, 1))
            self.assertIn("- 原定 3 遍，少跑了 1 遍：第 2 遍跑完后", (root / "评测汇总_看磁盘.md").read_text(encoding="utf-8"))

    def test_空间够时照常跑完_汇总里没有少跑这一项(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sims"

            def judged(sim, *_args, **_more):
                sim.rmdir()
                write_run(root, sim.name, {}, None)
                return {}
            with mock.patch.object(evals, "free_bytes", return_value=5 * GB), mock.patch.object(run, "run_once"), \
                    mock.patch.object(evals, "judge_one", side_effect=judged):
                code, _ = quiet(self.argv(root, 2))
            self.assertEqual(code, 0)
            summary = json.loads((root / "评测汇总_看磁盘.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["遍数"], "没有跑的遍数" in summary), (2, False))
            self.assertNotIn("少跑了", (root / "评测汇总_看磁盘.md").read_text(encoding="utf-8"))

    def test_两个数与取可用空间的函数(self):
        self.assertEqual((evals.MIN_FREE_TO_START, evals.MIN_FREE_TO_CONTINUE), (2 * GB, GB))
        self.assertGreater(evals.free_bytes(Path(tempfile.gettempdir())), 0)
        self.assertEqual(evals.gigabytes(int(1.26 * GB)), "1.3G")


if __name__ == "__main__":
    unittest.main()
