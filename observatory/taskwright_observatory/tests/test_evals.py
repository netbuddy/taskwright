"""评测的读取：评测列表、一次评测的详情、两次评测的对照。结果文件照模拟器评测命令写出的样子手写。"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from taskwright_observatory import evals
from taskwright_observatory.server import IndexCache, make_handler


def lamp(key: str, text: str, states: list[str], stage: str = "整理建模") -> dict:
    counted = [s for s in states if s in ("通过", "未通过")]
    return {"阶段": stage, "键": key, "说明": text, "各遍": states, "各遍差的": [[] for _ in states], "各遍备注": ["" for _ in states],
            "通过遍数": states.count("通过"), "能算的遍数": len(counted), "通过率": states.count("通过") / len(counted) if counted else None}


def group(section: str, words: list[str], hits: list[bool]) -> dict:
    return {"部分": section, "组": words, "各遍": hits, "各遍命中的条目": [["UC-001"] if h else [] for h in hits],
            "命中遍数": sum(hits), "核对的遍数": len(hits)}


def write_eval(root: Path, label: str, lamps: list[dict], groups: list[dict], time: str, material: str = "a.md") -> dict:
    """写一次评测的汇总文件，并在 evals.jsonl 里追加一行。"""
    rates = [row["通过率"] for row in lamps if row["通过率"] is not None]
    total = sum(row["核对的遍数"] for row in groups)
    summary = {"标签": label, "时间": time, "提交号": "0123456789abcdef0123", "未提交的改动": 0, "模型": "服务/模型", "模拟用户的模型": "服务/模型",
               "材料": [material], "画像": "p.json", "清单": "e.json", "遍数": len(lamps[0]["各遍"]), "轮数上限": 12,
               "各遍": [{"演练": f"sim-00{n + 1}", "目录": str(root / f"sim-00{n + 1}"), "任务的键": "TASK-1/TASK-1", "停止原因": "到了轮数上限 12",
                         "轮数": 12, "用时秒": 300, "出错": ""} for n in range(len(lamps[0]["各遍"]))],
               "灯": lamps, "至少应有": groups, "灯通过率": sum(rates) / len(rates) if rates else None,
               "清单命中率": sum(row["命中遍数"] for row in groups) / total if total else None,
               "各遍的问题": [], "各遍答不上的": []}
    (root / f"评测汇总_{label}.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
    with open(root / "evals.jsonl", "a", encoding="utf-8") as out:
        out.write(json.dumps({"时间": time, "标签": label, "提交号": summary["提交号"], "模型": summary["模型"], "材料": summary["材料"],
                              "遍数": summary["遍数"], "灯通过率": summary["灯通过率"], "清单命中率": summary["清单命中率"]}, ensure_ascii=False) + "\n")
    return summary


def launch_notes(sim: Path, stages: dict[str, str], skill: str = "aaaa", task_files: dict[str, str] | None = None, name: str = "service-1") -> None:
    """照后端的写法在一遍演练目录里写一份启动补记：按阶段的说明、平台 skill 各自的文件摘要值，与任务目录知识仓库的摘要值。"""
    events = sim / "backend" / "TASK-1" / "pi-events"
    events.mkdir(parents=True, exist_ok=True)
    files = lambda digests: [{"路径": path, "字节数": 10, "摘要值": digest} for path, digest in digests.items()]      # noqa: E731
    task_files = task_files if task_files is not None else {".pi/skills/requirements-engineering/SKILL.md": "cccc", ".pi/skills/requirements-engineering/stages/reading.md": "dddd",
                                                           "docs/review-rules/ears.json": "eeee"}
    notes = [
        {"记录": "启动", "命令行": ["pi"], "平台 skill": {"有没有": True, "代码仓里的路径": "agent/prompts/skills/taskwright-executor",
                                                    "目录": "/somewhere/agent/prompts/skills/taskwright-executor", "文件": files({"SKILL.md": skill})},
         "按阶段的说明": {"有没有": True, "代码仓里的路径": "agent/prompts/stages", "目录": "/somewhere/agent/prompts/stages", "文件": files(stages)}},
        {"记录": "知识仓库摘要", "位置": [".pi/skills", "docs"],
         "文件": [*files(task_files), {"路径": "/somewhere/agent/prompts/skills/taskwright-executor/SKILL.md", "字节数": 10, "摘要值": skill, "来自": "平台 skill"}]},
    ]
    (events / f"{name}.backend.jsonl").write_text("\n".join(json.dumps(note, ensure_ascii=False) for note in notes) + "\n这一行不是 JSON\n", encoding="utf-8")
    (events / f"{name}.jsonl").write_text("", encoding="utf-8")


EXCEPTION = "每个标签为「流程」的页至少有一条以「例外：」开头的例子。"
UNTAGGED = "没有未归类的页。"
GOAL = "每个标签为「决定」的页有上级「目标」页。"


def two_evals(root: Path) -> None:
    write_eval(root, "基线", [lamp("flows_have_exception", EXCEPTION, ["未通过", "未通过", "通过"]), lamp("no_untagged_pages", UNTAGGED, ["通过", "通过", "通过"]),
                              lamp("decisions_have_goal", GOAL, ["不适用", "不适用", "不适用"], "澄清")],
               [group("功能用例", ["借书", "借阅"], [True, True, True]), group("问题", ["寒暑假"], [True, False, False]),
                group("约束", ["一角"], [False, False, False])], "2026-01-01T09:00:00")
    write_eval(root, "改了说明", [lamp("flows_have_exception", EXCEPTION, ["通过", "通过", "通过"]), lamp("no_untagged_pages", UNTAGGED, ["通过", "未通过", "未通过"]),
                                  lamp("decisions_have_goal", GOAL, ["通过", "不适用", "不适用"], "澄清")],
               [group("功能用例", ["借书", "借阅"], [True, False, True]), group("问题", ["寒暑假"], [True, True, True]),
                group("非功能需求", ["每分钟"], [True, True, True])], "2026-01-02T09:00:00", "b.docx")


class EvalReadTest(unittest.TestCase):
    def test_评测列表新的在前_没有给演练根目录时照实说(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            empty = evals.read_list(root)
            two_evals(root)
            with open(root / "evals.jsonl", "a", encoding="utf-8") as out:
                out.write("这一行不是 JSON\n")
            listed = evals.read_list(root)
        self.assertEqual((empty["有没有演练根目录"], empty["评测"]), (True, []))
        self.assertEqual([row["标签"] for row in listed["评测"]], ["改了说明", "基线"])
        none = evals.read_list(None)
        self.assertEqual((none["有没有演练根目录"], none["评测"], none["说明"]), (False, [], evals.NO_ROOT))

    def test_一次评测的详情_找不到时报找不到(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            two_evals(root)
            detail = evals.read_detail(root, "基线")
            for label in ("没有这一次", "../基线"):
                with self.assertRaises(evals.EvalNotFound):
                    evals.read_detail(root, label)
        self.assertEqual((detail["标签"], detail["遍数"], [row["键"] for row in detail["灯"]][:2], detail["各遍"][0]["任务的键"]),
                         ("基线", 3, ["flows_have_exception", "no_untagged_pages"], "TASK-1/TASK-1"))
        with self.assertRaises(evals.EvalNotFound):
            evals.read_detail(None, "基线")

    def test_两次评测的对照_每盏灯与每组两个数与差值_变差的标出来(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            two_evals(root)
            data = evals.compare(root, "基线", "改了说明")
            text = evals.compare_markdown(data)
        rows = {row["键"]: row for row in data["灯"]}
        better, worse, skipped = rows["flows_have_exception"], rows["no_untagged_pages"], rows["decisions_have_goal"]
        self.assertEqual((better["前"], better["后"]["比率"], better["变差"]), ({"分子": 1, "分母": 3, "比率": 1 / 3}, 1.0, False))
        self.assertAlmostEqual(better["差值"], 2 / 3)
        self.assertAlmostEqual(worse["差值"], -2 / 3)
        self.assertTrue(worse["变差"])
        # 前一次没有能算的遍：不比。
        self.assertEqual((skipped["前"]["比率"], skipped["差值"], skipped["变差"]), (None, None, False))
        groups = {"／".join(row["组"]): row for row in data["至少应有"]}
        self.assertEqual((groups["借书／借阅"]["变差"], groups["寒暑假"]["变差"]), (True, False))
        # 只有一边有的组：没有的那一边是空的，不比。
        self.assertEqual((groups["一角"]["后"], groups["一角"]["差值"], groups["每分钟"]["前"], groups["每分钟"]["变差"]), (None, None, None, False))
        self.assertEqual((data["变差的灯"], data["变差的组"], data["前"]["标签"], data["后"]["标签"]), (1, 1, "基线", "改了说明"))
        self.assertEqual(data["提醒"], ["两次评测的材料不同（前一次是 a.md，后一次是 b.docx），数字不能直接比。"])
        for line in ("# 评测对照：基线 与 改了说明",
                     "- 变差的灯有 1 盏，清单里变差的组有 1 组。",
                     f"| 整理建模 | {EXCEPTION} | 1／3（33%） | 3／3（100%） | +67 个百分点 |",
                     f"| 整理建模 | {UNTAGGED} | 3／3（100%） | 1／3（33%） | −67 个百分点，**变差** |",
                     f"| 澄清 | {GOAL} | 0／0 | 1／1（100%） | 不比 |",
                     "| 约束 | 一角 | 0／3（0%） | 没有这一项 | 不比 |"):
            self.assertIn(line, text)

    def test_灯按阶段分组_每组给本组通过率_早先的汇总现算_对照里同一阶段排在一起并比两次的本组通过率(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            two_evals(root)
            # 后一次另有两盏前一次没有的灯：一盏在已有的阶段里，一盏的键灯表里没有，汇总里归在「其他」。
            later = json.loads((root / "评测汇总_改了说明.json").read_text(encoding="utf-8"))
            later["灯"] += [lamp("roles_drawn", "每个角色都画进了图。", ["通过", "通过", "未通过"]), lamp("以后才有的灯", "以后才有的灯。", ["通过", "通过", "通过"], "其他")]
            (root / "评测汇总_改了说明.json").write_text(json.dumps(later, ensure_ascii=False), encoding="utf-8")
            detail = evals.read_detail(root, "基线")
            data = evals.compare(root, "基线", "改了说明")
            text = evals.compare_markdown(data)
        # 手写的汇总里没有按阶段的那一项，读出来时照每盏灯带的阶段现算：整理建模两盏的平均是 (1/3 + 1) / 2，澄清那一盏没有能算的遍。
        self.assertEqual([(one["阶段"], one["键"], one["灯数"], one["能算的灯数"]) for one in detail["灯按阶段"]],
                         [("整理建模", ["flows_have_exception", "no_untagged_pages"], 2, 2), ("澄清", ["decisions_have_goal"], 1, 0)])
        self.assertAlmostEqual(detail["灯按阶段"][0]["通过率"], 2 / 3)
        self.assertIsNone(detail["灯按阶段"][1]["通过率"])
        # 对照：只有后一次有的那盏整理建模的灯排进整理建模一组，不落在最后；「其他」一组只有后一次有。
        self.assertEqual([(row["阶段"], row["键"]) for row in data["灯"]], [
            ("整理建模", "flows_have_exception"), ("整理建模", "no_untagged_pages"), ("整理建模", "roles_drawn"), ("澄清", "decisions_have_goal"),
            ("其他", "以后才有的灯")])
        stages = {one["阶段"]: one for one in data["灯按阶段"]}
        self.assertEqual(list(stages), ["整理建模", "澄清", "其他"])
        modeling = stages["整理建模"]
        self.assertEqual((modeling["前"]["灯数"], modeling["后"]["灯数"], modeling["变差"]), (2, 3, False))
        self.assertAlmostEqual(modeling["前"]["比率"], 2 / 3)
        self.assertAlmostEqual(modeling["后"]["比率"], (1 + 1 / 3 + 2 / 3) / 3)
        self.assertAlmostEqual(modeling["差值"], 0)
        # 澄清前一次没有能算的，不比；「其他」前一次没有这一组，不比。
        self.assertEqual((stages["澄清"]["前"]["比率"], stages["澄清"]["差值"], stages["其他"]["前"], stages["其他"]["差值"]), (None, None, None, None))
        for line in ("| 阶段 | 基线 | 改了说明 | 差值 |", "| 整理建模 | 67%（2 盏） | 67%（3 盏） | 持平 |", "| 澄清 | 没有能算的（1 盏） | 100%（1 盏） | 不比 |",
                     "| 其他 | 没有这一组 | 100%（1 盏） | 不比 |"):
            self.assertIn(line, text)

    def test_对照里一个阶段的本组通过率降了_标变差(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_eval(root, "前", [lamp("no_untagged_pages", UNTAGGED, ["通过", "通过"])], [], "2026-01-01T09:00:00")
            write_eval(root, "后", [lamp("no_untagged_pages", UNTAGGED, ["通过", "未通过"])], [], "2026-01-02T09:00:00")
            data = evals.compare(root, "前", "后")
        self.assertEqual([(one["阶段"], one["前"]["比率"], one["后"]["比率"], one["差值"], one["变差"]) for one in data["灯按阶段"]], [("整理建模", 1.0, 0.5, -0.5, True)])
        self.assertIn("| 整理建模 | 100%（1 盏） | 50%（1 盏） | −50 个百分点，**变差** |", evals.compare_markdown(data))


class PromptVersionTest(unittest.TestCase):
    def test_一遍演练的提示词版本读自启动补记_三组文件都收_任务目录的_docs_不收_任何一份变了版本就不同(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runs = [root / name for name in ("一", "二", "三", "四", "五")]
            launch_notes(runs[0], {"common.md": "1111", "reading.md": "2222"})
            launch_notes(runs[1], {"reading.md": "2222", "common.md": "1111"})                                      # 同样的文件，补记里先后不同
            launch_notes(runs[2], {"common.md": "1111", "reading.md": "9999"})                                      # 一份按阶段的说明改了
            launch_notes(runs[3], {"common.md": "1111", "reading.md": "2222"}, skill="bbbb")                        # 平台 skill 改了
            launch_notes(runs[4], {"common.md": "1111", "reading.md": "2222"},
                         task_files={".pi/skills/requirements-engineering/SKILL.md": "cccc", "docs/review-rules/ears.json": "ffff"})   # 任务目录里少了一份；docs 下的改了
            # 这一遍后来又启动过一次，文件已经改过：以第一次启动为准。
            launch_notes(runs[0], {"common.md": "8888"}, name="service-2")
            (root / "空的").mkdir()
            found = [evals.prompt_of_run(run) for run in runs]
            nothing = evals.prompt_of_run(root / "空的")
        first = found[0]
        self.assertEqual([(one["路径"], one["来自"], one["摘要值"]) for one in first["文件"]], [
            (".pi/skills/requirements-engineering/SKILL.md", "任务目录", "cccc"), (".pi/skills/requirements-engineering/stages/reading.md", "任务目录", "dddd"),
            ("agent/prompts/skills/taskwright-executor/SKILL.md", "代码仓", "aaaa"), ("agent/prompts/stages/common.md", "代码仓", "1111"),
            ("agent/prompts/stages/reading.md", "代码仓", "2222")])
        self.assertRegex(first["版本"], r"^[0-9a-f]{12}$")
        self.assertEqual((first["说明"], found[1]["版本"]), ("", first["版本"]))
        # 四种变法各得一个不同的版本；补记里的本机目录不进结果。
        self.assertEqual(len({one["版本"] for one in found}), 4)
        self.assertNotIn("somewhere", json.dumps(found, ensure_ascii=False))
        self.assertEqual((nothing["版本"], nothing["文件"], nothing["说明"]), (None, [], evals.NO_LAUNCH_NOTE))

    def test_对照里版本相同就说相同_不同时逐份列出改了的多出来的与没有的_取不到时照实说(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            two_evals(root)
            file = lambda path, digest, where="代码仓": {"路径": path, "来自": where, "字节数": 10, "摘要值": digest}      # noqa: E731

            def record(label: str, files: list[dict] | None) -> None:
                path = root / f"评测汇总_{label}.json"
                summary = json.loads(path.read_text(encoding="utf-8"))
                summary.update({"提示词版本": evals.prompt_version(files or []), "提示词文件": files or [], "提示词说明": "" if files else evals.NO_LAUNCH_NOTE})
                path.write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")

            before = [file("agent/prompts/stages/common.md", "1111"), file("agent/prompts/stages/reading.md", "2222"),
                      file(".pi/skills/requirements-engineering/stages/reading.md", "3333", "任务目录")]
            record("基线", before)
            record("改了说明", before)
            same = evals.compare(root, "基线", "改了说明")
            record("改了说明", [file("agent/prompts/stages/common.md", "1111"), file("agent/prompts/stages/reading.md", "7777"),
                                file("agent/prompts/stages/drafting.md", "5555")])
            changed = evals.compare(root, "基线", "改了说明")
            text = evals.compare_markdown(changed)
            record("改了说明", None)
            unknown = evals.compare(root, "基线", "改了说明")
        self.assertEqual((same["提示词"]["相同"], same["提示词"]["变了的文件"], same["提示词"]["说明"], same["前"]["提示词版本"] == same["后"]["提示词版本"]),
                         (True, [], "两次用的是同一版提示词。", True))
        prompts = changed["提示词"]
        self.assertEqual((prompts["相同"], prompts["说明"], prompts["前"]["文件数"], prompts["后"]["文件数"]), (False, "两次用的提示词不同，有 3 份文件变了。", 3, 3))
        self.assertEqual([(one["路径"], one["来自"], one["怎样变"], one["前"], one["后"]) for one in prompts["变了的文件"]], [
            (".pi/skills/requirements-engineering/stages/reading.md", "任务目录", "后一次没有的", "3333", None),
            ("agent/prompts/stages/drafting.md", "代码仓", "后一次多出来的", None, "5555"),
            ("agent/prompts/stages/reading.md", "代码仓", "改了", "2222", "7777")])
        for line in ("## 提示词", f"- 前一次「基线」的提示词版本：{changed['前']['提示词版本']}；后一次「改了说明」的提示词版本：{changed['后']['提示词版本']}。",
                     "- 两次用的提示词不同，有 3 份文件变了。", "| agent/prompts/stages/reading.md | 代码仓 | 改了 | 2222 | 7777 |",
                     "| agent/prompts/stages/drafting.md | 代码仓 | 后一次多出来的 | 没有 | 5555 |"):
            self.assertIn(line, text)
        self.assertEqual((unknown["提示词"]["相同"], unknown["提示词"]["变了的文件"], unknown["提示词"]["说明"]),
                         (None, [], f"后一次取不到提示词版本：{evals.NO_LAUNCH_NOTE}所以列不出变了哪几份文件。"))

    def test_早先写出的汇总里没有提示词版本_照它各遍的演练目录现读_目录不在了就取不到(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            two_evals(root)                                                     # 手写的汇总里没有提示词版本，各遍目录是 sim-001 到 sim-003
            gone = evals.read_detail(root, "基线")
            launch_notes(root / "sim-002", {"common.md": "1111"})                # 第一遍的目录不在，第二遍的在
            detail = evals.read_detail(root, "基线")
            data = evals.compare(root, "基线", "改了说明")
            unchanged = json.loads((root / "评测汇总_基线.json").read_text(encoding="utf-8"))
        self.assertEqual((gone["提示词版本"], gone["提示词文件"], gone["提示词说明"]), (None, [], evals.NO_LAUNCH_NOTE))
        self.assertRegex(detail["提示词版本"], r"^[0-9a-f]{12}$")
        self.assertEqual([one["路径"] for one in detail["提示词文件"]], [".pi/skills/requirements-engineering/SKILL.md", ".pi/skills/requirements-engineering/stages/reading.md",
                                                                   "agent/prompts/skills/taskwright-executor/SKILL.md", "agent/prompts/stages/common.md"])
        # 两次评测的各遍目录相同（都是这三个），所以现读出来的是同一版；汇总文件本身没有被改写。
        self.assertEqual((data["提示词"]["相同"], data["前"]["提示词版本"]), (True, detail["提示词版本"]))
        self.assertNotIn("提示词版本", unchanged)


class EvalApiTest(unittest.TestCase):
    """三个页面各自的读取接口：起一个观测台服务，经 HTTP 取 JSON。"""

    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(self._temp.name)
        two_evals(self.root)

    def tearDown(self):
        self._temp.cleanup()

    def serve(self, sim_root: Path | None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(IndexCache([], None, "", "", sim_root=sim_root)))
        server.RequestHandlerClass.log_message = lambda *args: None       # 测试里不打访问日志
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def get(self, base: str, path: str) -> tuple[int, dict]:
        try:
            with urllib.request.urlopen(base + urllib.parse.quote(path, safe="/?=&")) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_评测列表的接口(self):
        status, data = self.get(self.serve(self.root), "/api/evals")
        self.assertEqual((status, data["有没有演练根目录"], [row["标签"] for row in data["评测"]]), (200, True, ["改了说明", "基线"]))
        # 启动时没有给演练根目录：接口照常回，写明原因，页面据此显示一句话。
        status, data = self.get(self.serve(None), "/api/evals")
        self.assertEqual((status, data["有没有演练根目录"], data["说明"]), (200, False, evals.NO_ROOT))

    def test_一次评测详情的接口(self):
        base = self.serve(self.root)
        status, data = self.get(base, "/api/evals/改了说明")
        self.assertEqual((status, data["标签"], data["遍数"], data["灯"][0]["各遍"], data["各遍"][0]["任务的键"]),
                         (200, "改了说明", 3, ["通过", "通过", "通过"], "TASK-1/TASK-1"))
        status, data = self.get(base, "/api/evals/没有这一次")
        self.assertEqual((status, data["出错了"]), (404, "找不到评测「没有这一次」。"))

    def test_两次评测对照的接口(self):
        base = self.serve(self.root)
        status, data = self.get(base, "/api/evals/compare?a=基线&b=改了说明")
        self.assertEqual((status, data["前"]["标签"], data["后"]["标签"], data["变差的灯"], data["变差的组"]), (200, "基线", "改了说明", 1, 1))
        self.assertEqual([row["键"] for row in data["灯"] if row["变差"]], ["no_untagged_pages"])
        self.assertEqual(self.get(base, "/api/evals/compare?a=基线")[0], 400)
        self.assertEqual(self.get(base, "/api/evals/compare?a=基线&b=没有这一次")[0], 404)
        # 别的读取接口不受影响。
        self.assertEqual(self.get(base, "/api/tasklist"), (200, {"任务": []}))

    def test_网页带着评测的页签与三个页面的脚本(self):
        base = self.serve(self.root)
        text = lambda path: urllib.request.urlopen(base + path).read().decode("utf-8")      # noqa: E731
        main, page, api = text("/js/main.js"), text("/js/evals.js"), text("/js/api.js")
        self.assertIn('{ id: "evals", name: "评测" }', main)
        for name in ("renderEvalList", "renderEvalDetail", "renderEvalCompare"):
            self.assertIn(f"export async function {name}(", page)
            self.assertIn(name, main)
        for route in ('get("/api/evals")', "/api/evals/${encodeURIComponent(label)}", "/api/evals/compare?a="):
            self.assertIn(route, api)
        # 页面只读：没有写回画像的按钮与输入框（补进画像留给以后）。
        self.assertNotIn("<textarea", page)
        self.assertNotIn("补进画像</button>", page)


if __name__ == "__main__":
    unittest.main()
