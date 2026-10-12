"""评测汇总里几样内容的写法：灯按阶段分组与本组通过率、「例外」一节没有命中时的说明、「模型」一节的名字。
每遍的「评测.json」照评测命令写出的样子手写，不起后端。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import evals as eval_files

from sim import evals, lamps
from sim.tests.test_evals import META, group, write_run


def lamp(key: str, state: str, stage: str = "随便写的", text: str | None = None) -> dict:
    return {"阶段": stage, "键": key, "说明": text or f"{key} 的说明。", "结果": state, "通过": None, "差的条目编号": [], "备注": ""}


def write_lamps(root: Path, name: str, rows: list[dict]) -> Path:
    """一遍的「评测.json」，灯换成给定的这几盏。"""
    sim = write_run(root, name, {}, None)
    result = json.loads((sim / evals.RUN_FILE).read_text(encoding="utf-8"))
    (sim / evals.RUN_FILE).write_text(json.dumps({**result, "灯": rows}, ensure_ascii=False), encoding="utf-8")
    return sim


class StageGroupTest(unittest.TestCase):
    def test_灯按键找阶段_以各遍实际出现的为准_灯表里没有的键归其他_每组给本组通过率(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # 两遍各有四盏，先后是乱的；其中一盏的键灯表里没有，它自己带的阶段名不作数；第二遍多一盏第一遍没有的。
            sims = [write_lamps(root, "sim-001", [lamp("completion_met", "未通过"), lamp("以后才有的灯", "通过", "评审确认"),
                                                 lamp("no_untagged_pages", "通过"), lamp("materials_cited", "通过")]),
                    write_lamps(root, "sim-002", [lamp("completion_met", "通过"), lamp("以后才有的灯", "未通过"), lamp("no_untagged_pages", "不适用"),
                                                 lamp("materials_cited", "通过"), lamp("no_duplicate_titles", "不适用")])]
            summary = evals.summarize(root, "甲", sims, META)
            text = evals.summary_path(root, "甲", "md").read_text(encoding="utf-8")
        # 行按阶段的先后排，「其他」在最后；灯表里另外那些这两遍都没有出现的灯不在汇总里。
        self.assertEqual([(row["阶段"], row["键"], row["各遍"]) for row in summary["灯"]], [
            ("核读材料", "materials_cited", ["通过", "通过"]), ("整理建模", "no_untagged_pages", ["通过", "不适用"]),
            ("整理建模", "no_duplicate_titles", ["算不了", "不适用"]), ("评审确认", "completion_met", ["未通过", "通过"]),
            ("其他", "以后才有的灯", ["通过", "未通过"])])
        self.assertEqual(summary["灯按阶段"], [
            {"阶段": "核读材料", "键": ["materials_cited"], "灯数": 1, "能算的灯数": 1, "通过率": 1.0},
            {"阶段": "整理建模", "键": ["no_untagged_pages", "no_duplicate_titles"], "灯数": 2, "能算的灯数": 1, "通过率": 1.0},
            {"阶段": "评审确认", "键": ["completion_met"], "灯数": 1, "能算的灯数": 1, "通过率": 0.5},
            {"阶段": "其他", "键": ["以后才有的灯"], "灯数": 1, "能算的灯数": 1, "通过率": 0.5}])
        # 总的灯通过率照旧：有通过率的四盏的平均。
        self.assertAlmostEqual(summary["灯通过率"], (1 + 1 + 0.5 + 0.5) / 4)
        for line in ("| 阶段 | 几盏灯 | 本组通过率 |", "| 核读材料 | 1 | 100% |", "| 整理建模 | 2 | 100% |", "| 评审确认 | 1 | 50% |", "| 其他 | 1 | 50% |",
                     "| 其他 | 以后才有的灯 的说明。 | 通过 | 未通过 | 1／2 |"):
            self.assertIn(line, text)
        self.assertLess(text.index("| 阶段 | 几盏灯 | 本组通过率 |"), text.index("| 阶段 | 灯 | 第 1 遍 |"))

    def test_灯表里每一盏都找得到它的阶段_一组里一盏能算的都没有时本组通过率为空(self):
        self.assertEqual([evals.stage_of(key) for _stage, key, _text in lamps.LAMPS], [stage for stage, _key, _text in lamps.LAMPS])
        self.assertEqual(evals.stage_of("没有这盏灯"), "其他")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            idle = {key: state for (stage, key, _text), state in zip([one for one in lamps.LAMPS if one[0] == "澄清"], ["不适用", "算不了"] * len(lamps.LAMPS))}
            summary = evals.summarize(root, "甲", [write_run(root, "sim-001", idle, None)], META)
            text = evals.summary_path(root, "甲", "md").read_text(encoding="utf-8")
        stages = {one["阶段"]: one for one in summary["灯按阶段"]}
        # 灯表里的每一盏都在，阶段的先后与灯表相同。
        self.assertEqual((list(stages), sum(one["灯数"] for one in stages.values())), (list(dict.fromkeys(stage for stage, _k, _t in lamps.LAMPS)), len(lamps.LAMPS)))
        self.assertEqual((stages["澄清"]["能算的灯数"], stages["澄清"]["通过率"], stages["核读材料"]["通过率"]), (0, None, 1.0))
        self.assertIn(f"| 澄清 | {stages['澄清']['灯数']} | 没有能算的 |", text)


class PromptVersionTest(unittest.TestCase):
    def test_汇总取各遍里第一份取得到的提示词版本_写进汇总与列表_几遍不一样时写明(self):
        files = lambda digest: [{"路径": "agent/prompts/stages/common.md", "来自": "代码仓", "字节数": 120, "摘要值": digest},      # noqa: E731
                                {"路径": ".pi/skills/srs-authoring/SKILL.md", "来自": "任务目录", "字节数": 80, "摘要值": "cccc"}]
        prompt = lambda digest: {"版本": eval_files.prompt_version(files(digest)), "文件": files(digest), "说明": ""}                # noqa: E731

        def write_prompt(root: Path, name: str, found: dict | None) -> Path:
            sim = write_run(root, name, {}, None)
            result = json.loads((sim / evals.RUN_FILE).read_text(encoding="utf-8"))
            (sim / evals.RUN_FILE).write_text(json.dumps({**result, **({"提示词": found} if found else {})}, ensure_ascii=False), encoding="utf-8")
            return sim

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nothing = {"版本": None, "文件": [], "说明": eval_files.NO_LAUNCH_NOTE}
            # 第一遍没有跑起来，取不到；第二、三遍是同一版。
            same = evals.summarize(root, "甲", [write_prompt(root, "sim-001", nothing), write_prompt(root, "sim-002", prompt("1111")),
                                                write_prompt(root, "sim-003", prompt("1111"))], META)
            same_text = evals.summary_path(root, "甲", "md").read_text(encoding="utf-8")
            evals.write_list(root, same)
            # 跑到一半有文件改过：两遍的版本不一样。
            mixed = evals.summarize(root, "乙", [write_prompt(root, "sim-004", prompt("1111")), write_prompt(root, "sim-005", prompt("2222"))], META)
            mixed_text = evals.summary_path(root, "乙", "md").read_text(encoding="utf-8")
            # 早先跑的几遍，「评测.json」里没有这一项。
            old = evals.summarize(root, "丙", [write_prompt(root, "sim-006", None)], META)
            old_text = evals.summary_path(root, "丙", "md").read_text(encoding="utf-8")
            listed = evals.listed(root)
        version = prompt("1111")["版本"]
        self.assertEqual((same["提示词版本"], same["提示词文件"], same["各遍提示词版本"], listed[0]["提示词版本"]), (version, files("1111"), [None, version, version], version))
        for line in (f"- 提示词版本：{version}（每份文件见最后的「提示词」一节）", "## 提示词", f"- 版本：{version}，一共 2 份文件。",
                     "| agent/prompts/stages/common.md | 代码仓 | 120 | 1111 |", "| .pi/skills/srs-authoring/SKILL.md | 任务目录 | 80 | cccc |"):
            self.assertIn(line, same_text)
        self.assertNotIn("各遍用的提示词版本不一样", same_text)
        self.assertEqual((mixed["提示词版本"], mixed["各遍提示词版本"]), (version, [version, prompt("2222")["版本"]]))
        self.assertIn(f"- 各遍用的提示词版本不一样（跑到一半有文件改过）：第 1 遍 {version}、第 2 遍 {prompt('2222')['版本']}。下面列的是第一份取得到的那一遍的文件。", mixed_text)
        self.assertEqual((old["提示词版本"], old["提示词文件"]), (None, []))
        self.assertIn("- 提示词版本：取不到（每份文件见最后的「提示词」一节）", old_text)
        self.assertIn(f"- {eval_files.NO_LAUNCH_NOTE}", old_text)


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
