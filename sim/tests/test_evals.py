"""评测的命令：汇总怎样算（手写的几遍结果），以及用假模型端点接连演练两遍的一次完整评测。

集成测试里一个假模型端点同时应付助手与模拟用户：模拟用户的每个请求里都有驾驭程序唤起它的头一句话，脚本靠这句话分清两边。
助手第一轮立一页主题、记一条待澄清的问题、提一个问题；模拟用户第二轮说要去问一下，并表示目标达成。助手在这一例里不写用例：
产品有了工作的阶段之后，用例要等用户点了「开始写条目」才能写，主题页与问题条目则在哪个阶段都能写，所以这一例在有没有阶段的
产品上都走得通（从核读一直走到完成的那一例在 test_stage_run.py）。本机没有 pi 或 node 时跳过。
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from sim import evals, lamps
from sim.run import FIRST_WAKE
from sim.tests.test_user_agent_round import ENV_AGENT_DIR, FakeModel

REPO = Path(__file__).resolve().parents[2]
EXAMPLES = REPO / "examples" / "library-lending"
META = {"时间": "2026-01-01T09:00:00", "提交号": "0123456789abcdef", "未提交的改动": 0, "模型": "服务/模型", "模拟用户的模型": "服务/模型",
        "材料": ["a.md"], "画像": "p.json", "清单": "e.json", "轮数上限": 12}


def lamp_states(states: dict[str, str]) -> list[dict]:
    """二十一盏灯的一遍结果：没有点名的都是通过。"""
    return [{"阶段": stage, "键": key, "说明": text, "结果": states.get(key, "通过"), "通过": None,
             "差的条目编号": ["OA-001"] if states.get(key) == "未通过" else [], "备注": ""} for stage, key, text in lamps.LAMPS]


def group(section: str, words: list[str], hit: bool) -> dict:
    return {"部分": section, "组": words, "命中": hit, "命中的词": words[0] if hit else None, "命中的条目编号": ["UC-001"] if hit else []}


def write_run(root: Path, name: str, states: dict[str, str], groups: list[dict] | None, error: str = "") -> Path:
    sim = root / name
    sim.mkdir(parents=True)
    (sim / evals.RUN_FILE).write_text(json.dumps({
        "标签": "甲", "演练": name, "任务目录": "TASK-1", "任务编号": "TASK-1", "画像": "p.json", "清单": "e.json", "停止原因": "到了轮数上限 12",
        "轮数": 12, "轮数上限": 12, "开始": "2026-01-01T09:00:00", "结束": "2026-01-01T09:07:05", "用时秒": 425, "出错": error,
        "灯": lamp_states(states), "至少应有": groups,
        "助手问过的问题": {"怎样列的": "……", "问题": [{"轮": 1, "行为编号": "r1-2", "功能": "提问", "功能码": "ask", "文字": "寒暑假借期怎么算？", "选项": [], "针对": ""}]},
        "模拟用户答不上的问题": {"待人答": [{"轮": 2, "用户 agent 的话": "这个我得问一下。", "命中的说法": "得问",
                                          "上一轮的问题": [{"行为编号": "r1-2", "功能": "提问", "文字": "寒暑假借期怎么算？"}], "画像里可能有的事实": []}],
                               "画像里可能已有": []}}, ensure_ascii=False), encoding="utf-8")
    return sim


class SummaryTest(unittest.TestCase):
    def test_通过率只数能算的遍_不适用与算不了不进分母_清单按组数命中的遍(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sims = [
                write_run(root, "sim-001", {"flows_have_flowchart_with_branch": "未通过", "decisions_have_goal": "不适用"},
                          [group("功能用例", ["借书", "借阅"], True), group("问题", ["寒暑假"], False)]),
                write_run(root, "sim-002", {"decisions_have_goal": "不适用", "completion_met": "未通过"},
                          [group("功能用例", ["借书", "借阅"], True), group("问题", ["寒暑假"], True)]),
                write_run(root, "sim-003", {key: "算不了" for _s, key, _t in lamps.LAMPS}, None, "RuntimeError：后端任务服务没有起来。"),
            ]
            summary = evals.summarize(root, "甲", sims, META)
            evals.write_list(root, summary)
            text = evals.summary_path(root, "甲", "md").read_text(encoding="utf-8")
            listed = evals.listed(root)
            # 同一个标签再写一次：换掉那一行，不多出一行。
            evals.write_list(root, {**summary, "灯通过率": 0.5})
            again = evals.listed(root)
        rows = {row["键"]: row for row in summary["灯"]}
        self.assertEqual((rows["flows_have_flowchart_with_branch"]["各遍"], rows["flows_have_flowchart_with_branch"]["通过遍数"], rows["flows_have_flowchart_with_branch"]["能算的遍数"],
                          rows["flows_have_flowchart_with_branch"]["通过率"]), (["未通过", "通过", "算不了"], 1, 2, 0.5))
        self.assertEqual((rows["decisions_have_goal"]["能算的遍数"], rows["decisions_have_goal"]["通过率"]), (0, None))
        self.assertEqual(rows["materials_cited"]["通过率"], 1.0)
        # 二十盏有通过率：十八盏是 1，两盏是 0.5；没有能算的那一盏不进平均。
        self.assertAlmostEqual(summary["灯通过率"], (18 + 0.5 + 0.5) / 20)
        groups = {evals.expectations.group_label(row["组"]): row for row in summary["至少应有"]}
        self.assertEqual((groups["借书／借阅"]["各遍"], groups["借书／借阅"]["命中遍数"], groups["寒暑假"]["各遍"], groups["寒暑假"]["命中遍数"],
                          groups["寒暑假"]["核对的遍数"]), ([True, True, None], 2, [False, True, None], 1, 2))
        self.assertAlmostEqual(summary["清单命中率"], 3 / 4)
        self.assertEqual([r["任务的键"] for r in summary["各遍"]], ["TASK-1/TASK-1"] * 3)
        self.assertEqual(summary["各遍"][2]["出错"], "RuntimeError：后端任务服务没有起来。")
        for line in ("# 评测汇总：甲", "- 灯通过率：95%；清单命中率：75%",
                     "| 整理建模 | 每个标签为「流程」的页有一张以它为来源、带判断分叉的流程图。 | 未通过（差 OA-001） | 通过 | 算不了 | 1／2 |",
                     "| 问题 | 寒暑假 | 没有 | 命中（UC-001） | 没有核对 | 1／2 |",
                     "- 第 1 轮，提问：寒暑假借期怎么算？",
                     "- 第 2 轮，模拟用户说：「这个我得问一下。」上一轮的问题：寒暑假借期怎么算？\n"):
            self.assertIn(line, text)
        self.assertIn("| 第 3 遍 | ", text)
        self.assertIn("| 7 分 5 秒 | RuntimeError：后端任务服务没有起来。 |", text)
        self.assertEqual((len(listed), listed[0]["标签"], listed[0]["遍数"], listed[0]["各灯通过率"]["flows_have_flowchart_with_branch"], listed[0]["汇总"]),
                         (1, "甲", 3, 0.5, "评测汇总_甲.json"))
        self.assertEqual((len(again), again[0]["灯通过率"]), (1, 0.5))

    def test_对照的命令行_打印两次评测的对照_找不到标签时说明并以_1_退出(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            groups = lambda hit: [group("功能用例", ["借书", "借阅"], True), group("问题", ["寒暑假"], hit)]      # noqa: E731
            for label, first, states in (("甲", "sim-001", {"flows_have_flowchart_with_branch": "未通过"}), ("乙", "sim-002", {"no_untagged_pages": "未通过"})):
                sims = [write_run(root, first, states, groups(label == "甲"))]
                evals.write_list(root, evals.summarize(root, label, sims, META))
            code, printed = quiet(["compare", "甲", "乙", "--sim-root", str(root)])
            missing, complaint = quiet(["compare", "甲", "丙", "--sim-root", str(root)])
        self.assertEqual(code, 0)
        for line in ("# 评测对照：甲 与 乙", "- 变差的灯有 1 盏，清单里变差的组有 1 组。",
                     "| 整理建模 | 每个标签为「流程」的页有一张以它为来源、带判断分叉的流程图。 | 0／1（0%） | 1／1（100%） | +100 个百分点 |",
                     "| 问题 | 寒暑假 | 1／1（100%） | 0／1（0%） | −100 个百分点，**变差** |"):
            self.assertIn(line, printed)
        self.assertEqual(missing, 1)
        self.assertIn("找不到评测「丙」。", complaint)

    def test_标签要能当文件名的一段(self):
        self.assertIsNone(evals.check_label("基线-短版"))
        for bad in ("", "  ", "a/b", ".隐藏", "两\n行", "compare"):
            self.assertIsNotNone(evals.check_label(bad), bad)


def intent(function: str, summary: str) -> str:
    return "```json\n" + json.dumps({"acts": [{"function": function, "confidence": "high", "summary": summary}]}, ensure_ascii=False) + "\n```"


def source(excerpt: str) -> dict:
    return {"kind": "文档原文", "locator": "inputs/requirements.md", "excerpt": excerpt}


QUESTION = "寒暑假期间借出的书，借期怎么算？"
#: 助手问 QUESTION 用的卡片：任务类型有分析提纲时，核读材料里的提问一律是写了 topic、带候选的请选择。
CARD_TEXT = "为了写清借书一页的借期一段：材料只说寒暑假借期另行规定。" + QUESTION
CARD = {"kind": "choose", "topic": "借期 · 缺口 1（材料没写）", "text": CARD_TEXT,
        "options": [{"key": "a", "text": "顺延到开学后第一周", "reason": "高校图书馆通常如此。"}, {"key": "b", "text": "照平时的借期算", "reason": "材料没有另写，照常规办。"}]}
FIRST_WORDS = "帮我把这份需求整理成规格说明。"
SCRIPT = {"rules": [
    # 模拟用户：看到助手的问题就说要去问一下并表示目标达成；头一次看完界面先说想做的事；被唤起时先看界面。
    {"when": {"any_contains": FIRST_WAKE, "last_role": "tool", "last_contains": "寒暑假期间借出的书"},
     "reply": {"tool_calls": [{"name": "respond", "arguments": {"text": "这个我得问一下教务处。", "done": True}}]}},
    {"when": {"any_contains": FIRST_WAKE, "last_role": "tool"}, "reply": {"tool_calls": [{"name": "respond", "arguments": {"text": FIRST_WORDS}}]}},
    {"when": {"any_contains": FIRST_WAKE, "last_role": "user"}, "reply": {"tool_calls": [{"name": "look", "arguments": {}}]}},
    # 助手：第一句话之后立一页主题、记一条待澄清的问题；工具结果回来之后提问；用户说要去问之后回一句。
    {"when": {"last_role": "user", "last_contains": "帮我把这份需求整理"},
     "reply": {"text": intent("request", "把需求整理成规格说明"), "tool_calls": [
         {"name": "save_revision", "arguments": {"operations": [{"op": "add", "collection": "业务说明", "fields": {
             "标题": "借书", "它是什么": "读者凭借书证借书，每本书可以续借一次（requirements.md 第 1 段）。", "例子": ["读者凭借书证借书"], "标签": ["流程"], "状态": "在用"},
             "sources": [source("读者凭借书证借书，每本书可以续借一次。")]}]}},
         {"name": "save_revision", "arguments": {"operations": [{"op": "add", "collection": "问题", "fields": {
             "事项": "寒暑假期间的借期怎样算", "种类": "待澄清", "是否阻断下游": "不阻断", "何时回看": "评审确认时", "状态": "未解决"},
             "sources": [source("寒暑假期间的借期另行规定。")]}]}}]}},
    {"when": {"last_role": "user", "last_contains": "教务处"},
     "reply": {"text": intent("inform", "要去问教务处"), "tool_calls": [{"name": "reply", "arguments": {"informs": [], "act": None, "text": "好的，这件事先记着。"}}]}},
    {"when": {"last_role": "tool"},
     "reply": {"tool_calls": [{"name": "reply", "arguments": {"informs": [], "act": CARD,
                                                             "text": "我先立了一页主题，写了一个用例。" + QUESTION}}]}},
], "default": {"text": "好的。"}}


def quiet(argv: list[str]) -> tuple[int | None, str]:
    """运行评测的命令行，收起它打印的进度；命令行自己退出时返回它的退出码。"""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            return evals.main(argv), out.getvalue() + err.getvalue()
        except SystemExit as stop:
            return stop.code if isinstance(stop.code, int) else 1, out.getvalue() + err.getvalue()


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class EvalRunTest(unittest.TestCase):
    def test_假模型下接连两遍_每遍有评测结果_汇总与列表写出来_换清单重判_标签不许重复(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-evals-it-"))
        sims_root = root / "sims"
        fake = FakeModel(SCRIPT, root)
        fake.start()
        saved = dict(os.environ)
        try:
            for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                os.environ.pop(name, None)
            os.environ.update({ENV_AGENT_DIR: str(fake.agent_dir), "PI_OFFLINE": "1", "XDG_DATA_HOME": str(root / "data"),
                               "TASKWRIGHT_SETTINGS_FILE": str(root / "settings.json")})
            base = ["run", "--persona", str(REPO / "sim" / "personas" / "library-short.json"), "--expect", str(REPO / "sim" / "expectations" / "library-short.json"),
                    "--materials-dir", str(EXAMPLES), "--port", "0", "--profile", "fake", "--user-model", "fake/fake-model",
                    "--sim-root", str(sims_root), "--max-rounds", "4"]
            code, printed = quiet([*base, "--repeat", "2", "--label", "试跑"])
            self.assertEqual(code, 0, printed)
            first, second = sims_root / "sim-001", sims_root / "sim-002"
            runs = [json.loads((sim / evals.RUN_FILE).read_text(encoding="utf-8")) for sim in (first, second)]
            summary = json.loads(evals.summary_path(sims_root, "试跑", "json").read_text(encoding="utf-8"))
            text = evals.summary_path(sims_root, "试跑", "md").read_text(encoding="utf-8")
            listed = evals.listed(sims_root)
            # 同一个标签再跑：不起演练，直接说明并退出。
            again, complaint = quiet([*base, "--repeat", "1", "--label", "试跑"])
            # 换一份只有一组的清单重判第一遍：同一次评测的第二遍一并重算，汇总跟着重写。
            other = root / "另一份清单.json"
            other.write_text(json.dumps({"问题": [["寒暑假"]]}, ensure_ascii=False), encoding="utf-8")
            rejudged, _ = quiet(["judge", str(first), "--expect", str(other)])
            after = json.loads(evals.summary_path(sims_root, "试跑", "json").read_text(encoding="utf-8"))
            after_list = evals.listed(sims_root)
        finally:
            fake.stop()
            os.environ.clear()
            os.environ.update(saved)
        for n, one in enumerate(runs):
            self.assertEqual((one["标签"], one["演练"], one["停止原因"], one["轮数"], one["轮数上限"], one["出错"]),
                             ("试跑", f"sim-00{n + 1}", "用户 agent 表示目标达成", 2, 4, ""))
            self.assertRegex(one["任务编号"], r"^TASK-")
            states = {x["键"]: x["结果"] for x in one["灯"]}
            # 立了一页流程主题并被引用；还没有给它画流程图；没有用例依据这一页；没有评审过。
            self.assertEqual((states["materials_cited"], states["flows_have_flowchart_with_branch"], states["flows_backed_by_use_cases"],
                              states["no_untagged_pages"], states["roles_in_context_and_use_cases"], states["reviews_no_open_findings"]),
                             ("只报数", "未通过", "未通过", "通过", "不适用", "未通过"))
            hits = [(x["部分"], x["组"][0]) for x in one["至少应有"] if x["命中"]]
            self.assertEqual(hits, [("业务说明·流程页", "借书"), ("问题", "寒暑假")])
            # 助手的问题取自任务库的对话行为，轮次靠演练记录对上。
            asked = one["助手问过的问题"]
            self.assertEqual((asked["怎样列的"], [(q["轮"], q["功能"], q["文字"]) for q in asked["问题"]]),
                             ("按任务库的对话行为列，轮次靠演练记录对上", [(1, "请选择", CARD_TEXT)]))
            self.assertRegex(asked["问题"][0]["行为编号"], r"^r1-\d+$")
            # 模拟用户说要去问教务处：上一轮问的是寒暑假借期，画像的隐藏事实里有这件事，所以列在「画像里可能已有」。
            stuck = one["模拟用户答不上的问题"]
            self.assertEqual((stuck["待人答"], [(x["轮"], x["命中的说法"]) for x in stuck["画像里可能已有"]]), ([], [(2, "得问一下教务处")]))
        # 两边的模型是从各自的事件流里读出来的实际用的那个。
        self.assertEqual((summary["遍数"], summary["模型"], summary["模拟用户的模型"], summary["材料"], summary["画像"], summary["清单"], summary["轮数上限"]),
                         (2, "fake/fake-model", "fake/fake-model", ["requirements.md"], "library-short.json", "library-short.json", 4))
        self.assertEqual([r["任务的键"] for r in summary["各遍"]], [f"{one['任务编号']}/{one['任务编号']}" for one in runs])
        self.assertEqual({row["键"]: row["各遍"] for row in summary["灯"]}["flows_have_flowchart_with_branch"], ["未通过", "未通过"])
        # 短版清单一共 64 组：原有的 37 组，加上「模型」一节五种图的 22 组（这一遍没有画图，一组都没有命中），
        # 再加上「导语页」小节的 5 组（这一遍没有走到编写文档，一组都没有命中）。
        self.assertEqual(len(summary["至少应有"]), 64)
        self.assertEqual(sum(1 for row in summary["至少应有"] if row["部分"] == "业务说明·导语页"), 5)
        self.assertEqual(sum(1 for row in summary["至少应有"] if row["部分"].startswith("模型·")), 22)
        self.assertAlmostEqual(summary["清单命中率"], 4 / 128)
        self.assertIn("# 评测汇总：试跑", text)
        self.assertIn(f"- 第 1 轮，请选择：{CARD_TEXT}", text)
        self.assertIn(f"- 第 2 轮，模拟用户说：「这个我得问一下教务处。」上一轮的问题：{CARD_TEXT}画像里可能已有这件事（寒暑假期间借出的书，借期一律顺延到开学后第一周的周五，"
                      "这段时间不算逾期），请看是不是模拟用户演错了。", text)
        self.assertEqual((len(listed), listed[0]["标签"], listed[0]["遍数"], [Path(d).name for d in listed[0]["各遍目录"]]), (1, "试跑", 2, ["sim-001", "sim-002"]))
        self.assertEqual(again, 2)
        self.assertIn("标签「试跑」在", complaint)
        self.assertFalse((sims_root / "sim-003").exists())
        self.assertEqual(rejudged, 0)
        self.assertEqual((after["清单"], len(after["至少应有"]), after["至少应有"][0]["各遍"], after["清单命中率"], after["时间"]),
                         ("另一份清单.json", 1, [True, True], 1.0, summary["时间"]))
        self.assertEqual((len(after_list), after_list[0]["清单"], after_list[0]["清单命中率"]), (1, "另一份清单.json", 1.0))
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
