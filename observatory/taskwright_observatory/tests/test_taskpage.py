"""任务页（taskpage.py）、比对函数（diffs.py）与启动补记的单元测试。

测这些事：按轮归类的判定与合并（本页已不再输出，判定函数留待后端改写时清理，用例照旧保留）；归类声明的读取与缺省；
按运行排的流程（每次运行一行的计数、完整的用户的话与助手应答、关键动作，用户操作与任务现状按时刻插行，界面点击挂到它触发的运行上）；
需要注意的每一条判据；页头统计句、概括句与流程末端；知识的使用的四种归类；跨会话任务按会话分段；旧库表的转换与
对不上时的提示；自动重试与中途插话；新库表的看板（完成条件经 agent 的核对函数核对）；文字与列表比对；
后端在启动时补记的知识仓库摘要值与上下文文件。

判定与流程用手写的、与读取接口同形状的轮；其余用 fixtures/ 下的中性夹具，新库表的库由 agent 里真实的核心函数
写出（要用 node，本机没有 node 时那几条跳过）。

有几样不在这里测，它们在前端（web/js/taskpage.js），这个仓库的测试只用 Python 标准库，没有跑 JavaScript 的
测试环境，所以靠浏览器里的走查核对，结论写在结果文件里：按字段类型画一个值；时间条上「真实宽度不到最小可见宽度
就拉宽并打斜纹」；运行表的列可以隐藏、选择记在浏览器本地。

跑法：在代码仓的 observatory 目录下、PYTHONPATH 含 server 目录时（新库表那几条要用 server/tests 里的造库函数）运行
`python3 -m unittest taskwright_observatory.tests.test_taskpage`；scripts/test-all.sh 已经这样设好。
"""

from __future__ import annotations

import copy
import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_server import launch
from taskwright_observatory import taskpage
from taskwright_observatory.api import Index
from taskwright_observatory.diffs import MAX_DIFF_TOKENS, diff_list, diff_text
from taskwright_observatory.tests.test_readers import FIXTURE_DIR, FIXTURE_RUNS, SESSION_ID, build_workspace

RULES = taskpage.load_rules()
SOURCE = {"执行方法": ".pi/skills/demo/SKILL.md", "领域规矩": ["docs/domain-knowledge/规矩.md"],
          "文档模板": "docs/templates/demo.md", "材料目录": "inputs/"}
DECL = taskpage.declaration(RULES, SOURCE, "演示任务", {"全部": "测试里手写的"})
WS = "/任务目录"


# ───────────── 手写同形状的轮 ─────────────

def call(tool, path=None, rejected=False, written=False, seconds=0.01, **extra):
    args = {"path": path} if path is not None else {}
    shaped = {"编号": f"c-{tool}-{path}", "工具": tool, "中文名": "", "参数": args,
              "参数摘要": path or "", "相对路径": taskpage.relative_to_workspace(path, WS),
              "结果全文": "ENOENT: no such file" if rejected else "内容", "结果摘要": "",
              "被拒": rejected, "有没有执行结果": True, "耗时秒": seconds, "起止": [None, None],
              "泳道": 1, "链接": "", "改动": [], "有没有写入": written, "对不上": "", "事件": [],
              "修订序号": None, "改正": None, "要求到此为止": False}
    if written:
        shaped["改动"] = [{"类别": "交付物的变化", "标题句": "交付物形成第 1 次修订：新增了 1 个用例条目。",
                           "标签": ["UC-001"], "操作": [], "事件": []}]
    shaped.update(extra)
    return shaped


def turn(number, calls=(), text="", stop="toolUse"):
    return {"序数": number, "轮号": number - 1, "正文": text, "耗时秒": 1.0, "时刻": "",
            "起止": [None, None], "行": [None, None], "归档文件": "",
            "请求": [{"停止原因": stop, "耗时秒": 1.0, "出错说明": "", "是不是自动重试": False}],
            "调用": list(calls), "插话": [], "自动重试说明": "", "运行记录链接": ""}


def run(number, turns, prompt="请整理材料。", said=None):
    last = said if said is not None else next((t["正文"] for t in reversed(turns) if t["正文"]), "")
    return {"运行序号": number, "提示": {"原文": prompt, "时刻": None}, "轮": turns,
            "时间条": {"能不能画": False}, "启动说明": "", "助手最后说的话": last, "被中止": False}


def stages_of(runs, decl=DECL):
    return taskpage.build_stages(runs, decl, RULES, None, WS, "")


def rows_of(runs):
    """手写的运行照页面装配那样变成流程里的运行行。"""
    return [taskpage.run_row(r) for r in runs]


def alerts_of(runs, closed=None, decl=DECL):
    return taskpage.build_alerts(rows_of(runs), decl, closed)


class StageTests(unittest.TestCase):
    """按轮归类的判定与合并。本页已不再输出这一层，判定函数留待后端改写时清理，用例照旧保留。"""

    def test_一轮只属于一个阶段_按第一个工具调用判(self):
        """并行的两个调用落在同一轮里，这一轮按第一个调用判，第二个不另起阶段，只把它的阶段名接在「，同时」后面。"""
        stages = stages_of([run(1, [
            turn(1, [call("read", f"{WS}/.pi/skills/demo/SKILL.md"), call("ls", "inputs")]),
            turn(2, [], text="好了。", stop="stop")])])
        names = [s["名称"] for s in stages]
        self.assertEqual(names, ["用户发话", "了解方法，同时找材料", "对用户说话"])
        self.assertEqual(len(stages[1]["轮"][0]["调用"]), 2)
        # 两个调用种类不同，那一句话把两样都如实写出来。
        self.assertIn("执行方法文件 SKILL.md", stages[1]["一句话"])
        self.assertIn("inputs", stages[1]["一句话"])

    def test_并行调用的阶段名_几种用顿号_被拒的与同种的不接(self):
        stages = stages_of([run(1, [
            turn(1, [call("read", "inputs/材料.md"), call("read", "inputs/材料二.md"),
                     call("read", "docs/domain-knowledge/规矩.md"), call("ls", "docs"),
                     call("read", "inputs/没有.md", rejected=True)]),
            turn(2, [call("read", "inputs/材料三.md")]),
            turn(3, [], text="好了。", stop="stop")])])
        self.assertEqual([s["名称"] for s in stages], ["用户发话", "读材料，同时读规矩、找材料", "对用户说话"])
        self.assertEqual(len(stages[1]["轮"]), 2)                            # 合并照旧按第一个调用判

    def test_连着的同类轮合并_不同类就分开(self):
        stages = stages_of([run(1, [
            turn(1, [call("read", "docs/domain-knowledge/规矩.md")]),
            turn(2, [call("read", "inputs/材料.md")]),
            turn(3, [call("read", "inputs/材料二.md")]),
            turn(4, [call("save_revision", written=True)]),
            turn(5, [call("save_revision", written=True)]),
            turn(6, [], text="写完了。", stop="stop")])])
        self.assertEqual([(s["名称"], len(s["轮"])) for s in stages],
                         [("用户发话", 0), ("读规矩", 1), ("读材料", 2), ("写交付物", 2), ("对用户说话", 1)])
        self.assertIn("2 轮合并出来的", stages[2]["说明"])
        self.assertEqual(stages[3]["条目"], ["UC-001"])

    def test_没有工具调用的轮_说了话与没说话(self):
        stages = stages_of([run(1, [turn(1, [], text="", stop="stop")])])
        self.assertEqual(stages[1]["名称"], "没有说话也没有调用工具")
        stages = stages_of([run(1, [turn(1, [], text="你好。", stop="stop")])])
        self.assertEqual(stages[1]["名称"], "对用户说话")

    def test_用户说的话是用户的阶段(self):
        stages = stages_of([run(1, [turn(1, [], text="好。", stop="stop")], prompt="你好")])
        self.assertEqual((stages[0]["参与者"], stages[0]["类型"], stages[0]["全文"]), ("用户", "用户发话", "你好"))
        self.assertEqual(stages[1]["触发"]["编号"], stages[0]["编号"])
        self.assertTrue(stages[1]["触发"]["紧挨着吗"])

    def test_被拒的轮判成调用失败_名字取自工具(self):
        stages = stages_of([run(1, [turn(i, [call("read", f"inputs/{i}.md", rejected=True)])
                                          for i in range(1, 4)])])
        failed = stages[1]
        self.assertEqual((failed["名称"], failed["类型"], failed["结果"]), ("read被拒", "异常", "失败"))
        self.assertEqual(failed["被拒次数"], 3)
        self.assertIn("文件不存在（3 次）", failed["一句话"])

    def test_路径归不上类与工具没有登记(self):
        stages = stages_of([run(1, [turn(1, [call("read", "README.md")]),
                                          turn(2, [call("bash")])])])
        self.assertEqual([s["名称"] for s in stages[1:]], ["读文件", "用了工具 bash"])

    def test_判定只看路径不看内容_点开头的路径不被误伤(self):
        """.pi 开头的路径去掉 ./ 时不能把点也去掉。"""
        self.assertEqual(taskpage.strip_dot_slash("./.pi/skills/demo/SKILL.md"), ".pi/skills/demo/SKILL.md")
        self.assertEqual(taskpage.path_class(".pi/skills/demo/SKILL.md", DECL), "执行方法")
        self.assertEqual(taskpage.path_class("inputs", DECL), "材料目录")
        self.assertIsNone(taskpage.path_class("inputsx/a.md", DECL))


class DeclarationTests(unittest.TestCase):
    """归类声明：路径归类读任务定义，缺的用观测台自带的默认值。"""

    def test_材料目录缺省为inputs(self):
        decl = taskpage.declaration(RULES, {"执行方法": "a.md"}, "某任务", {})
        self.assertEqual(decl["路径归类"]["材料目录"], ["inputs/"])
        self.assertEqual(decl["路径归类"]["领域规矩"], [])

    def test_工具对应的阶段与阈值取自默认值文件(self):
        self.assertEqual(DECL["工具对应的阶段"]["save_version"], "写任务字段")
        self.assertEqual(DECL["异常判据"]["一次运行走多少轮算异常"], 20)

    def test_没有任务时_任务目录里只有一份任务定义就按它猜(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "docs" / "task-definitions").mkdir(parents=True)
            (Path(folder) / "docs" / "task-definitions" / "one.json").write_text(json.dumps(
                {"任务名": "猜的任务", "执行方法": ".pi/skills/x/SKILL.md", "材料目录": "materials"},
                ensure_ascii=False), encoding="utf-8")

            class NoTasks:
                tasks = {}
            decl, note = taskpage.declaration_for(NoTasks(), None, folder, RULES)
            self.assertEqual(decl["路径归类"]["材料目录"], ["materials/"])
            self.assertIn("one.json", note)
            (Path(folder) / "docs" / "task-definitions" / "two.json").write_text("{}", encoding="utf-8")
            decl, note = taskpage.declaration_for(NoTasks(), None, folder, RULES)
            self.assertEqual(decl["这份声明是给谁用的"], "观测台自己带的默认声明")
            self.assertIn("默认声明", note)


class AlertTests(unittest.TestCase):
    """需要注意：只列由事实直接得出的异常。"""

    def texts(self, runs):
        return [n["文字"] for n in alerts_of(runs)]

    def test_没有异常时一条都没有(self):
        self.assertEqual(self.texts([run(1, [turn(1, [call("save_revision", written=True)]),
                                             turn(2, [], text="好了。", stop="stop")])]), [])

    def test_连着多次调用没有写入也没有说话(self):
        runs = [run(1, [turn(i, [call("read", "inputs/a.md")]) for i in range(1, 9)]
                + [turn(9, [], text="好了。", stop="stop")])]
        self.assertTrue(any("连着 8 次调用工具" in t for t in self.texts(runs)))
        # 中间说过一句话就重新数，所以 4 次加 4 次不算异常。
        runs = [run(1, [turn(i, [call("read", "inputs/a.md")]) for i in range(1, 5)]
                + [turn(5, [call("read", "inputs/b.md")], text="我先看看。")]
                + [turn(i, [call("read", "inputs/a.md")]) for i in range(6, 9)]
                + [turn(9, [], text="好了。", stop="stop")])]
        self.assertFalse(any("连着" in t for t in self.texts(runs)))

    def test_一次运行没有说过话就结束(self):
        texts = self.texts([run(1, [turn(1, [call("save_revision", written=True)])])])
        self.assertTrue(any("没有对用户说过一句话" in t for t in texts))

    def test_轮数超过阈值(self):
        runs = [run(1, [turn(i, [call("save_revision", written=True)]) for i in range(1, 22)]
                + [turn(22, [], text="好了。", stop="stop")])]
        self.assertTrue(any("走了 22 轮" in t for t in self.texts(runs)))

    def test_输出被截断(self):
        texts = self.texts([run(1, [turn(1, [], text="写到一半", stop="length")])])
        self.assertTrue(any("截断" in t for t in texts))

    def test_工具拒绝了调用_改对了与没再试(self):
        fixed = call("save_revision", rejected=True,
                     改正={"运行序号": 2, "轮号": 0, "改正成功": True, "有没有再试": True})
        texts = self.texts([run(1, [turn(1, [fixed]), turn(2, [], text="错了。", stop="stop")])])
        self.assertTrue(any("后来在第 2 次运行的第 1 轮改对了" in t for t in texts))
        gave_up = call("save_revision", rejected=True, 改正={"有没有再试": False})
        texts = self.texts([run(1, [turn(1, [gave_up]), turn(2, [], text="错了。", stop="stop")])])
        self.assertTrue(any("再也没有调用过同一个工具" in t for t in texts))
        again = call("save_revision", rejected=True,
                     改正={"运行序号": 1, "轮号": 1, "改正成功": False, "有没有再试": True})
        texts = self.texts([run(1, [turn(1, [again]), turn(2, [], text="错了。", stop="stop")])])
        self.assertTrue(any("仍然被拒绝" in t for t in texts))

    def test_每一条都指向一次运行里的一轮(self):
        notes = alerts_of([run(1, [turn(1, [call("save_revision", written=True)])])])
        self.assertTrue(notes)
        self.assertTrue(all(n["去哪"] == "turn-1-1" for n in notes))

    def test_被拒的说法落在运行上_不提阶段(self):
        fixed = call("save_revision", rejected=True,
                     改正={"运行序号": 2, "轮号": 0, "改正成功": True, "有没有再试": True})
        notes = alerts_of([run(3, [turn(1, [fixed]), turn(2, [], text="错了。", stop="stop")])])
        self.assertEqual(notes[0]["文字"], "第 3 次运行里有 1 次调用被工具拒绝了，后来在第 2 次运行的第 1 轮改对了。")
        self.assertEqual(notes[0]["去哪"], "turn-3-1")


class HeadAndTailTests(unittest.TestCase):
    """页头概括句与流程末端。"""

    HEAD = {"会话数": 1, "终态": "正常结束"}

    def test_概括句按模板拼(self):
        rows = rows_of([run(1, [turn(1, [call("save_revision", written=True)]),
                                turn(2, [], text="好了。", stop="stop")], prompt="请整理材料。")])
        board = {"格式": "新格式", "总条目数": 3,
                 "集合": [{"名称": "用例", "现有条目数": 2}, {"名称": "约束", "现有条目数": 1}],
                 "完成条件": [{"满足": True}, {"满足": False}]}
        text = taskpage.summary_sentence(self.HEAD, board, rows, "任务")
        self.assertEqual(text, "这份交付物现在有 3 个条目（用例 2 个、约束 1 个）；要完成任务还差 1 项；"
                               "助手一共运行了 1 次，最后一次运行由用户的「请整理材料。」触发；这条会话的终态是「正常结束」。")
        self.assertIn("所在的任务目录里还没有任务记录", taskpage.summary_sentence(self.HEAD, None, rows, "会话"))
        self.assertIn("助手一次也没有运行过", taskpage.summary_sentence(self.HEAD, None, [], "会话"))
        board["完成条件"][0]["满足"] = None
        self.assertIn("这一次核对不了", taskpage.summary_sentence(self.HEAD, board, rows, "任务"))

    def test_页头统计句与保存修订次数(self):
        rows = rows_of([run(1, [turn(1, [call("save_revision", written=True), call("save_revision", rejected=True)]),
                                turn(2, [call("save_revision", written=True)]),
                                turn(3, [], text="好了。", stop="stop")])])
        details = [{"运行次数": 1, "轮数": 3, "工具调用次数": 3, "被拒次数": 1, "开始时刻": "", "结束时刻": "",
                    "所在任务目录": {}, "启动": []}]
        head = taskpage.build_head(details, None, rows, [], {})
        self.assertEqual(head["保存修订次数"], 2)                     # 被拒的那一次不算
        self.assertEqual(head["统计句"], "1 次运行、3 轮、3 次工具调用、2 次保存修订，其中 1 次调用被工具拒绝")
        details[0]["被拒次数"] = 0
        self.assertTrue(taskpage.build_head(details, None, rows, [], {})["统计句"].endswith("，没有调用被工具拒绝"))

    def test_跨会话时起止取有值的那一条(self):
        """后一条会话一次也没有运行过、没有结束时刻时，页头的结束时刻取前一条会话的。"""
        details = [{"运行次数": 1, "开始时刻": "2026-01-01 00:00:00", "结束时刻": "2026-01-01 00:10:00", "启动": []},
                   {"运行次数": 0, "开始时刻": "2026-01-01 01:00:00", "结束时刻": "", "启动": []}]
        head = taskpage.build_head(details, None, [], [], {})
        self.assertEqual((head["开始时刻"], head["结束时刻"]), ("2026-01-01 00:00:00", "2026-01-01 00:10:00"))

    def test_末端如实照搬最后一句话_不替它判断(self):
        tail = taskpage.tail_state([run(1, [turn(1, [], text="请确认发票红冲能不能退？", stop="stop")])])
        self.assertEqual(tail["引子"], "助手这次运行已经结束，它最后对用户说的话是：")
        self.assertEqual(tail["原文"], "请确认发票红冲能不能退？")
        tail = taskpage.tail_state([run(1, [turn(1, [call("save_revision", written=True)])], said="")])
        self.assertFalse(tail["有没有说话"])
        self.assertIn("没有对用户说过任何话", tail["引子"])


class FlowTests(unittest.TestCase):
    """按运行排的流程：一次运行一行，扩展写进会话的消息按时刻插行，界面点击挂到它触发的那次运行上。"""

    @staticmethod
    def timed(number, at, prompt, said, turns):
        one = run(number, turns, prompt=prompt, said=said)
        one["提示"]["时刻"] = at
        one["会话序号"] = 1
        return one

    @staticmethod
    def ext(kind, at, text, entry):
        return {"类型": kind, "时刻秒": at, "文字": text, "条目编号": entry}

    def flow(self, runs, messages):
        detail = {"会话编号": "s1", "会话名": "整理需求", "开始时刻": "", "扩展写入的消息": messages}
        return taskpage.build_flow([detail], runs)

    def test_一次运行一行_用户操作与任务现状按时刻插进去(self):
        runs = [self.timed(1, 100.0, "请整理材料。", "整理好了。", [turn(1, [call("save_revision", written=True)]),
                                                                   turn(2, [], text="整理好了。", stop="stop")]),
                self.timed(2, 300.0, "改一下 UC-001。", "改好了。", [turn(1, [], text="改好了。", stop="stop")])]
        messages = [self.ext("taskwright-task-status", 50.0, "【开头的说明】任务「演示」的状况。", "e0"),
                    self.ext("taskwright-user-edit", 200.0, "界面操作（不是用户打的字）：用户改了 UC-001 的「名称」。", "e1")]
        seg = self.flow(runs, messages)[0]
        self.assertEqual(seg["会话名"], "整理需求")
        self.assertEqual([r["种类"] for r in seg["行"]], ["任务现状", "运行", "用户操作", "运行"])
        edit = seg["行"][2]
        self.assertEqual(edit["摘要"], "用户改了 UC-001 的「名称」。")
        self.assertEqual(edit["编号"], "ext-e1")
        self.assertEqual(seg["行"][0]["摘要"], "任务「演示」的状况。")
        first = seg["行"][1]
        self.assertEqual((first["轮数"], first["工具调用次数"], first["保存修订次数"], first["被拒次数"]), (2, 1, 1, 0))
        self.assertEqual(first["关键动作"], ["save_revision 1 次"])      # 手写的调用没有中文名，照原名写
        self.assertEqual(first["助手应答"], "整理好了。")

    def test_界面点击挂到它触发的那次运行上_对不上的单独一行(self):
        runs = [self.timed(1, 100.0, "我采纳这个建议。", "好的。", [turn(1, [], text="好的。", stop="stop")])]
        messages = [self.ext("taskwright-ui-click", 99.6, "界面点击（不是用户打的字）：用户选了「采纳」。", "c1"),
                    self.ext("taskwright-ui-click", 500.0, "界面点击（不是用户打的字）：用户选了「不知道」。", "c2")]
        rows = self.flow(runs, messages)[0]["行"]
        self.assertEqual([r["种类"] for r in rows], ["运行", "界面点击"])
        self.assertEqual(rows[0]["由界面点击触发"], "用户选了「采纳」。")
        self.assertIn("对不上", rows[1]["说明"])

    def test_用户的话与助手应答给完整的话_没说话如实写(self):
        long = "甲" * 100 + "\n第二段。"
        row = taskpage.run_row(self.timed(1, 1.0, "问" * 70, long, [turn(1, [], text=long, stop="stop")]))
        self.assertEqual(row["助手应答"], long)                             # 不截断，换行照留
        self.assertEqual(row["用户的话"], "问" * 70)
        self.assertNotIn("用户的话摘要", row)
        silent = taskpage.run_row(self.timed(1, 1.0, "请整理。", "", [turn(1, [call("save_revision", rejected=True)])]))
        self.assertFalse(silent["有没有对用户说话"])
        self.assertEqual(silent["助手应答"], "")
        self.assertEqual(silent["关键动作"], ["被拒 1 次"])


class KnowledgeTests(unittest.TestCase):
    """知识的使用：四种归类，摘要值取自启动补记。"""

    def test_四种归类(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for rel in (".pi/skills/demo/SKILL.md", ".pi/skills/other/SKILL.md", "docs/domain-knowledge/规矩.md",
                        "docs/task-definitions/demo.json", "docs/templates/demo.md"):
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_text(rel, encoding="utf-8")
            snapshot = launch.knowledge_snapshot(root)
            launches = [{"知识仓库摘要": snapshot,
                         "已加载的 skill": {"取得到吗": True, "skill": [
                             {"名字": "demo", "文件": str(root / ".pi/skills/demo/SKILL.md")},
                             {"名字": "other", "文件": str(root / ".pi/skills/other/SKILL.md")}]},
                         "上下文文件": {"照 pi 的发现规则在磁盘上查到的": [], "为什么取不到": "RPC 没有这项。",
                                        "命令行关掉了上下文文件吗": False}}]
            rows = rows_of([run(1, [
                turn(1, [call("read", str(root / ".pi/skills/demo/SKILL.md"),
                              相对路径=".pi/skills/demo/SKILL.md")]),
                turn(2, [call("create_task", 参数={"definition_path": "docs/task-definitions/demo.json"})]),
                turn(3, [], text="好了。", stop="stop")])])
            k = taskpage.build_knowledge(str(root), rows, DECL, taskpage.launch_facts(launches), RULES)
            uses = {r["文件"]: r["用法"] for r in k["文件"]}
            self.assertEqual(uses[".pi/skills/demo/SKILL.md"], taskpage.USE_READ)
            read = next(r for r in k["文件"] if r["文件"] == ".pi/skills/demo/SKILL.md")
            self.assertEqual(read["运行序号"], 1)                             # 点一行跳到读它的那次运行
            self.assertIn("在第 1 次运行里读过它 1 次", read["一句话"])
            self.assertEqual(uses["docs/task-definitions/demo.json"], taskpage.USE_TOOL)
            self.assertEqual(uses[".pi/skills/other/SKILL.md"], taskpage.USE_PROMPT)
            self.assertEqual(uses["docs/templates/demo.md"], taskpage.USE_NONE)
            digests = {r["文件"]: r["摘要值"] for r in k["文件"]}
            self.assertEqual(len(digests["docs/templates/demo.md"]), 16)
            self.assertIn("get_commands", k["skill"])
            self.assertIn("取不到", k["上下文文件"])

    def test_平台skill单列并显示代码仓里的路径(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "ws"
            (root / "docs").mkdir(parents=True)
            (root / "docs" / "a.md").write_text("a", encoding="utf-8")
            platform = Path(folder) / "repo" / "agent" / "prompts" / "skills" / "p"
            platform.mkdir(parents=True)
            (platform / "SKILL.md").write_text("平台", encoding="utf-8")
            snapshot = launch.knowledge_snapshot(root)
            snapshot["文件"].append({"路径": str(platform / "SKILL.md"), "字节数": 6, "摘要值": "abcdabcdabcdabcd",
                                   "来自": "平台 skill", "代码仓里的路径": "agent/prompts/skills/p/SKILL.md"})
            launches = [{"知识仓库摘要": snapshot,
                         "已加载的 skill": {"取得到吗": True, "skill": [{"名字": "p", "文件": str(platform / "SKILL.md")}]}}]
            facts = taskpage.launch_facts(launches)
            self.assertEqual(facts["平台 skill"], {str(platform / "SKILL.md"): "agent/prompts/skills/p/SKILL.md"})
            rows = rows_of([run(1, [
                turn(1, [call("read", str(platform / "SKILL.md"), 相对路径=str(platform / "SKILL.md"))]),
                turn(2, [], text="好了。", stop="stop")])])
            k = taskpage.build_knowledge(str(root), rows, DECL, facts, RULES)
            row = next(r for r in k["文件"] if r["种类"] == "平台执行方法（skill）")
            self.assertEqual(row["文件"], "代码仓里的 agent/prompts/skills/p/SKILL.md")
            self.assertEqual(row["用法"], taskpage.USE_READ)
            self.assertEqual(row["摘要值"], "abcdabcdabcdabcd")
            self.assertIn("代码仓里的 agent/prompts/skills/p/SKILL.md", k["skill"])
            self.assertIn("1 份是代码仓里的平台 skill", k["概括"])

    def test_补记里家目录缩写成波浪号时平台skill也能对上(self):
        home = str(Path.home())
        full = home + "/repo/agent/prompts/skills/p/SKILL.md"
        launches = [{"知识仓库摘要": {"文件": [{"路径": "~/repo/agent/prompts/skills/p/SKILL.md", "摘要值": "1234123412341234",
                                                "来自": "平台 skill", "代码仓里的路径": "agent/prompts/skills/p/SKILL.md"}]}}]
        facts = taskpage.launch_facts(launches)
        self.assertEqual(facts["平台 skill"], {full: "agent/prompts/skills/p/SKILL.md"})
        self.assertEqual(facts["摘要"][full], [(1, "1234123412341234")])

    def test_旧归档没有补记时如实写(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "docs").mkdir()
            (Path(folder) / "docs" / "a.md").write_text("a", encoding="utf-8")
            k = taskpage.build_knowledge(folder, [], DECL, taskpage.launch_facts([{}]), RULES)
            self.assertEqual(k["文件"][0]["摘要值"], taskpage.NOT_RECORDED)
            self.assertIn("这条归档没有记下", k["来源说明"])
            self.assertIn("这条归档没有记下", k["skill"])

    def test_两次启动之间知识变了要说出来(self):
        one = {"知识仓库摘要": {"文件": [{"路径": "docs/a.md", "摘要值": "1111"}]}}
        two = {"知识仓库摘要": {"文件": [{"路径": "docs/a.md", "摘要值": "2222"}]}}
        changes = taskpage.knowledge_changes_between([one, two])
        self.assertIn("1 份文件变了", changes[1])
        facts = taskpage.launch_facts([one, two])
        self.assertEqual(facts["摘要"]["docs/a.md"], [(1, "1111"), (2, "2222")])


class LaunchNoteTests(unittest.TestCase):
    """后端在启动时补记的两样：知识仓库摘要值、上下文文件。"""

    def test_知识仓库只记路径与摘要值(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".pi" / "skills" / "x").mkdir(parents=True)
            (root / ".pi" / "skills" / "x" / "SKILL.md").write_text("方法", encoding="utf-8")
            (root / "inputs").mkdir()
            (root / "inputs" / "材料.md").write_text("不在知识仓库里", encoding="utf-8")
            snap = launch.knowledge_snapshot(root)
            self.assertEqual([f["路径"] for f in snap["文件"]], [".pi/skills/x/SKILL.md"])
            self.assertNotIn("方法", json.dumps(snap, ensure_ascii=False))

    def test_上下文文件如实写取不到并照发现规则查一遍(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "ws"
            root.mkdir()
            (Path(folder) / "AGENTS.md").write_text("上级目录里的", encoding="utf-8")
            note = launch.context_file_candidates(["pi"], root, {"PI_CODING_AGENT_DIR": str(Path(folder) / "agent")})
            self.assertFalse(note["取得到吗"])
            self.assertEqual(note["照 pi 的发现规则在磁盘上查到的"], [str(Path(folder) / "AGENTS.md")])
            note = launch.context_file_candidates(["pi", "--no-context-files"], root, {})
            self.assertEqual(note["照 pi 的发现规则在磁盘上查到的"], [])


class StitchTests(unittest.TestCase):
    """跨会话的任务：各条会话的运行按时间接起来，运行序号在这一页里连续编。"""

    def test_两条会话按会话分段_运行序号连续编(self):
        def detail(name, runs_):
            return {"会话编号": name, "归档名": name, "运行": runs_, "启动": [{}], "运行次数": len(runs_),
                    "轮数": 1, "工具调用次数": 0, "被拒次数": 0, "pi 进程启动次数": 1, "终态": "正常结束",
                    "开始时刻": "", "结束时刻": "", "所在任务目录": {}, "Langfuse 链接": "", "Langfuse 状态": {}}

        def raw_run(number, text):
            return {"运行序号": number, "启动序号": 0, "提示": {"原文": text}, "用户消息": [],
                    "时间条": {"能不能画": False}, "助手最后说的话": "好了。",
                    "轮": [{"给人读的序数": 1, "pi 给的轮号": 0, "助手文字": "好了。", "模型请求": [],
                            "工具调用": [], "耗时秒": 1.0}]}

        class NoTasks:
            tasks = {}
            workspaces = []
            task_workspace = {}
        page = taskpage.assemble(NoTasks(), [detail("甲", [raw_run(1, "第一句"), raw_run(2, "第二句")]),
                                             detail("乙", [raw_run(1, "第三句")])], "任务", "甲", None)
        self.assertEqual([(seg["会话编号"], seg["运行次数"]) for seg in page["流程"]], [("甲", 2), ("乙", 1)])
        rows = taskpage.run_rows(page["流程"])
        self.assertEqual([r["运行序号"] for r in rows], [1, 2, 3])
        self.assertEqual([r["用户的话"] for r in rows], ["第一句", "第二句", "第三句"])
        self.assertEqual(len({r["编号"] for r in rows}), 3)
        self.assertIn("第 2 条会话", rows[2]["启动说明"])
        self.assertEqual(page["页头"]["会话数"], 2)
        self.assertEqual(page["页头"]["运行次数"], 3)


class LegacyFixtureTests(unittest.TestCase):
    """旧库表：字段改写转成改动的同一形状，版本号靠调用编号对上，对不上要如实说。"""

    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._temp.name)
        build_workspace(cls.root)
        cls.index = Index(FIXTURE_RUNS, cls.root)

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def test_旧库表的改动带版本(self):
        page = taskpage.page_for_session(self.index, SESSION_ID)
        blocks = [b for r in taskpage.run_rows(page["流程"]) for t in r["轮"] for c in t["调用"] for b in c["改动"]]
        self.assertTrue(blocks)
        self.assertTrue(all(b["旧库表"] for b in blocks))
        self.assertEqual(blocks[0]["操作"][0]["版本"], [None, 1])
        self.assertEqual(blocks[-1]["操作"][0]["版本"], [1, 2])
        edit = blocks[-1]["操作"][0]["变更"][0]
        self.assertEqual([p["标记"] for p in edit["段"]], ["同", "增"])
        self.assertEqual(page["看板"]["格式"], "旧格式")
        self.assertIn("默认归类声明", page["页头"]["声明说明"])
        self.assertFalse(page["页头"]["材料目录是任务定义登记的"])

    def test_调用编号在修订清单里对不上时如实写(self):
        page = taskpage.page_for_session(self.index, SESSION_ID)
        legacy = self.index.task_detail(page["任务的键"])
        broken = copy.deepcopy(legacy)
        broken["修订"] = []
        rows = copy.deepcopy(taskpage.run_rows(page["流程"]))
        for r in rows:
            for t in r["轮"]:
                for c in t["调用"]:
                    for b in c["改动"]:
                        b.pop("对不上", None)
        taskpage.fill_old_versions(rows, broken)
        notes = [b.get("对不上") for r in rows for t in r["轮"] for c in t["调用"] for b in c["改动"]]
        self.assertTrue(notes and all("找不到对应的修订记录" in n for n in notes))

    def test_写入工具接受了可是库里没有事件(self):
        shaped = taskpage.call_shape({"调用编号": "不存在", "工具": "save_version", "是否被拒": False,
                                      "参数": {}, "库里写下的事件": [], "带来的变化": []},
                                     self.index, RULES, "", 0)
        self.assertIn("这次调用在库里找不到对应的记录", shaped["对不上"])


def op(action, coll, code):
    return {"动作": action, "集合": coll, "条目编号": code}


def saved(*ops, old=False):
    return call("save_revision", written=True,
                改动=[{"类别": "交付物的变化", "旧库表": old, "标题句": "", "标签": [o["条目编号"] for o in ops],
                       "操作": list(ops), "事件": []}])


class WriteLineTests(unittest.TestCase):
    """写交付物阶段的标题句只说一共做了什么，个数由数据算出。"""

    def test_按动作与集合给个数_同一条目只算一次(self):
        calls = [saved(op("新增", "功能用例", "UC-001"), op("新增", "功能用例", "UC-002"),
                       op("新增", "非功能需求", "NFR-001")),
                 saved(op("修改", "功能用例", "UC-001"), op("新增", "待定事项", "TBD-001")),
                 saved(op("修改", "功能用例", "UC-001"), op("删除", "功能用例", "UC-002")),
                 call("save_revision")]
        self.assertEqual(taskpage.write_line(calls),
                         "助手保存了 4 次：新增功能用例 2 个、非功能需求 1 个、待定事项 1 个；"
                         "修改功能用例 1 个；删除功能用例 1 个；其中 1 次没有在库里写下改动。")

    def test_旧库表按字段计数(self):
        calls = [saved(op("新增", "任务的字段", "术语"), old=True),
                 saved(op("修改", "任务的字段", "术语"), op("新增", "任务的字段", "定义"), old=True)]
        self.assertEqual(taskpage.write_line(calls), "助手保存了 2 次：第一次写下 2 个字段；改写 1 个字段。")

    def test_什么都没写下(self):
        self.assertEqual(taskpage.write_line([call("save_revision")]),
                         "助手调用了 1 次保存，库里没有留下任何改动。")


class RetryAndSteerTests(unittest.TestCase):
    """自动重试与中途插话，用 runs重试 与 runs插话 两份夹具。"""

    def page(self, folder):
        with tempfile.TemporaryDirectory() as root:
            index = Index(FIXTURE_DIR / folder, Path(root))
            return taskpage.page_for_session(index, index.sessions[0]["会话编号"])

    def test_自动重试标在重试那一轮(self):
        turns = [t for r in taskpage.run_rows(self.page("runs重试")["流程"]) for t in r["轮"]]
        notes = [bool(t["自动重试说明"]) for t in turns]
        self.assertEqual(notes, [False, True, False])
        self.assertIn("turnIndex 是 0", turns[1]["自动重试说明"])
        # 出错的那一轮没有说话也没有调用工具，这一轮写出出错的说明。
        self.assertTrue(turns[0]["出错说明"])

    def test_插话落在它进来的那一轮_运行不断开(self):
        page = self.page("runs插话")
        rows = taskpage.run_rows(page["流程"])
        turns = [t for r in rows for t in r["轮"]]
        self.assertEqual([len(t["插话"]) for t in turns], [0, 1, 0])
        steer = turns[1]["插话"][0]
        self.assertEqual(steer["种类"], "插话（steer）")
        self.assertEqual(steer["原文"], "顺便把修改意见也记成：要点明范围。")
        self.assertEqual(len(rows), 1)


def build_current_workspace(root: Path) -> Path:
    from tests.test_current_format import make_workspace
    return make_workspace(root, "任务目录新库表", with_db=True)


@unittest.skipIf(shutil.which("node") is None, "本机没有 node，写不出夹具库，也调不动核对函数")
class CurrentFormatTests(unittest.TestCase):
    """新库表：runs新库表 这份夹具的调用编号与 agent 写出的夹具库一一对应。"""

    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._temp.name)
        cls.workspace = build_current_workspace(cls.root)
        cls.index = Index(FIXTURE_DIR / "runs新库表", cls.root)
        cls.key = "任务目录新库表/TASK-001"
        cls.page = taskpage.page_for_task(cls.index, cls.key)

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def test_完成条件经agent的核对函数核对(self):
        checks = self.page["看板"]["完成条件"]
        self.assertEqual([(c["集合"], c["条件"]) for c in checks],
                         [("用例", "至少一个条目"), ("待定事项", "没有未解决的条目")])
        # 说明原样取自 agent 的 summary，不带集合名，集合名由看板的分组标题带。
        self.assertEqual([c["说明"] for c in checks], ["现在有 1 个条目。", "没有状态为未解决的条目。"])
        self.assertEqual([c["满足"] for c in checks], [True, True])
        self.assertIn("agent", self.page["看板"]["完成条件是怎么核对的"])

    def test_看板的条目与状态格(self):
        sets = {s["名称"]: s for s in self.page["看板"]["集合"]}
        rows = {r["编号"]: r for r in sets["用例"]["条目"]}
        self.assertTrue(rows["UC-002"]["已删除"])
        self.assertEqual(sets["用例"]["现有条目数"], 1)          # UC-002 在第 3 次修订删掉了
        self.assertEqual(rows["UC-001"]["标题"], "买家申请退款")
        self.assertEqual((rows["UC-001"]["评审格"], rows["UC-001"]["确认格"]), ("", ""))
        self.assertEqual(rows["UC-001"]["评审"], "还没有这类记录")
        # 修订统一：条目只显示修订号（UC-001 在修订 1 新增、修订 2 改过），没有条目版本号。
        self.assertEqual(rows["UC-001"]["所在"], "修订 2")
        self.assertEqual([v["标签"] for v in rows["UC-001"]["全部版本"]], ["修订 1", "修订 2"])

    def test_修改的操作带改前改后与比对_标题取自条目(self):
        blocks = [b for r in taskpage.run_rows(self.page["流程"]) for t in r["轮"] for c in t["调用"] for b in c["改动"]]
        self.assertEqual(blocks[0]["类别"], "任务的变化")
        second = next(b for b in blocks if b.get("修订序号") == 2)
        edit = next(op for op in second["操作"] if op["条目编号"] == "UC-001")
        self.assertEqual(edit["动作"], "修改")
        self.assertEqual(edit["版本变化"], "修订 1 → 修订 2")
        self.assertEqual(edit["条目标题"], "买家申请退款")
        self.assertEqual(edit["变更"][0]["字段"], "名称")
        self.assertIn({"标记": "增", "文": "买家"}, edit["变更"][0]["段"])
        tbd = next(op for op in second["操作"] if op["条目编号"] == "TBD-001")
        refs = next(v for v in tbd["变更"] if v["字段"] == "关联条目")
        self.assertEqual(refs["改后"], ["UC-001"])

    def test_被拒的调用没有改动_也不算对不上(self):
        calls = [c for r in taskpage.run_rows(self.page["流程"]) for t in r["轮"] for c in t["调用"]]
        rejected = next(c for c in calls if c["编号"] == "call-rej")
        self.assertTrue(rejected["被拒"])
        self.assertEqual((rejected["改动"], rejected["对不上"]), ([], ""))

    def test_工具读过任务定义(self):
        uses = {r["文件"]: r["用法"] for r in self.page["知识仓库"]["文件"]}
        self.assertEqual(uses.get("docs/task-definitions/demo.json"), taskpage.USE_TOOL)

    def test_运行行的保存修订次数与关键动作(self):
        rows = taskpage.run_rows(self.page["流程"])
        for r in rows:
            calls = [c for t in r["轮"] for c in t["调用"]]
            saved = sum(1 for c in calls if c["工具"] == "save_revision" and c["有没有执行结果"] and not c["被拒"])
            self.assertEqual(r["保存修订次数"], saved)
            self.assertEqual(r["被拒次数"], sum(1 for c in calls if c["被拒"]))
            if saved:
                self.assertIn(f"保存修订 {saved} 次", r["关键动作"])
            if r["被拒次数"]:
                self.assertIn(f"被拒 {r['被拒次数']} 次", r["关键动作"])
        self.assertTrue(any(r["保存修订次数"] for r in rows))
        self.assertEqual(self.page["页头"]["保存修订次数"], sum(r["保存修订次数"] for r in rows))

    def test_页面数据里没有阶段这个字段(self):
        def keys(value):
            if isinstance(value, dict):
                for k, v in value.items():
                    yield k
                    yield from keys(v)
            elif isinstance(value, list):
                for v in value:
                    yield from keys(v)
        self.assertEqual([k for k in keys(self.page) if "阶段" in k], [])

    def test_新库表的任务页头标出材料目录是任务定义登记的(self):
        self.assertTrue(self.page["页头"]["材料目录是任务定义登记的"])

    def test_任务列表与任务页的范围_没有运行过的会话不进任务页(self):
        rows = {r["任务的键"]: r for r in taskpage.task_list(self.index)}
        self.assertEqual(len(rows[self.key]["涉及会话"]), 1)
        self.assertEqual(self.page["范围"], "任务")
        self.assertEqual(self.page["页头"]["任务编号"], "TASK-001")
        # 同一个任务目录里再放一条一次也没有运行过的会话：会话列表里它挂上这个任务，任务页不收它，也不为它成段。
        real = self.index.sessions[0]
        empty = dict(real, 会话编号="没有运行过的会话", 运行=[], 运行次数=0, 轮数=0, 工具调用次数=0, 被拒次数=0)
        self.index.sessions.append(empty)
        try:
            self.assertEqual([t["任务的键"] for t in self.index.tasks_of_session(empty)], [self.key])
            self.assertEqual(taskpage.sessions_of_task(self.index, self.key), [real["会话编号"]])
            page = taskpage.page_for_task(self.index, self.key)
            self.assertEqual(page["页头"]["会话数"], 1)
            self.assertEqual([seg["会话编号"] for seg in page["流程"]], [real["会话编号"]])
            self.assertEqual(page["同任务目录里没有写过这个任务的会话"], [])
        finally:
            self.index.sessions.remove(empty)


class DiffTests(unittest.TestCase):
    """文字比对与列表比对。"""

    def test_文字按字比英文按词比(self):
        parts = diff_text("把申请转人工审核。", "把申请一律转人工审核，不得自动通过。")
        self.assertEqual("".join(p["文"] for p in parts if p["标记"] != "增"), "把申请转人工审核。")
        self.assertEqual("".join(p["文"] for p in parts if p["标记"] != "删"), "把申请一律转人工审核，不得自动通过。")
        self.assertEqual(parts[1], {"标记": "增", "文": "一律"})
        parts = diff_text("见 UC-001", "见 UC-002")
        self.assertIn({"标记": "删", "文": "001"}, parts)
        self.assertIn({"标记": "增", "文": "002"}, parts)

    def test_文字比对的边界(self):
        self.assertEqual(diff_text("", "新的"), [{"标记": "增", "文": "新的"}])
        self.assertEqual(diff_text("旧的", ""), [{"标记": "删", "文": "旧的"}])
        self.assertEqual(diff_text("一样", "一样"), [{"标记": "同", "文": "一样"}])
        self.assertEqual([p["标记"] for p in diff_text("甲" * (MAX_DIFF_TOKENS + 1), "乙")], ["删", "增"])

    def test_列表按项比改了的项内部再按字比(self):
        steps = diff_list(["读取金额", "统计次数", "判定", "写日志"],
                          ["读取金额", "统计次数并读取大促标记", "判定", "放入高优先级队列"])
        self.assertEqual([s["标记"] for s in steps], ["未变", "修改", "未变", "修改"])
        self.assertIn({"标记": "增", "文": "并读取大促标记"}, steps[1]["段"])

    def test_列表的新增与删除(self):
        steps = diff_list(["甲", "乙"], ["甲", "丙", "乙", "丁"])
        self.assertEqual([(s["标记"], s.get("文")) for s in steps],
                         [("未变", "甲"), ("新增", "丙"), ("未变", "乙"), ("新增", "丁")])
        self.assertEqual([s["标记"] for s in diff_list(["甲", "乙", "丙"], ["丙"])], ["删除", "删除", "未变"])
        self.assertEqual(diff_list([], []), [])



@unittest.skipIf(shutil.which("node") is None, "本机没有 node，写不出夹具库")
class DialogueLayerPageTests(unittest.TestCase):
    """任务页的对话行为层：运行行挂上对话行为、页头三个派生事实、理解原文的标签、概念对照页的四条。"""

    @classmethod
    def setUpClass(cls):
        from taskwright_observatory.tests.dialogue_fixture import add_dialogue
        cls._temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._temp.name)
        add_dialogue(build_current_workspace(cls.root))
        cls.index = Index(FIXTURE_DIR / "runs新库表", cls.root)
        cls.page = taskpage.page_for_task(cls.index, "任务目录新库表/TASK-001")

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def test_每次运行挂上它的对话行为_按会话里第几次运行对上(self):
        rows = taskpage.run_rows(self.page["流程"])
        self.assertEqual([r["对话行为"]["运行号"] for r in rows], ["r1", "r2"])
        self.assertEqual(rows[0]["对话行为"]["理解没按格式写次数"], 1)
        self.assertEqual([a["编号"] for a in rows[1]["对话行为"]["用户行为"]], ["r2-1", "r2-2"])

    def test_页头的三个派生事实_连续追问只列两次及以上(self):
        facts = self.page["页头"]["对话"]
        self.assertEqual([w["编号"] for w in facts["等回应"]], ["r2-3", "r3-1"])
        self.assertEqual([(x["条目"], x["连续运行次数"], x["会话序号"]) for x in facts["连续追问"]], [("TBD-001", 2, 1)])
        self.assertEqual([(x["条目"], x["字段"], x["次数"]) for x in facts["改口"]], [("UC-001", "名称", 2)])

    def test_理解原文按形式认出(self):
        self.assertTrue(taskpage.is_understanding('```json\n{"acts": []}\n```'))
        self.assertTrue(taskpage.is_understanding('{"acts": [{"function": "request"}]}'))
        self.assertFalse(taskpage.is_understanding("好的，我这就整理。"))

    def test_概念对照页有对话理解的四条_功能名取自schema(self):
        from taskwright_observatory import concepts
        names = [c["名字"] for c in concepts.build()["领域概念"]]
        for one in ("对话行为", "用户功能九种", "执行者功能", "运行号（会话内）与运行序号（任务级）"):
            self.assertIn(one, names)
        nine = next(c for c in concepts.build()["领域概念"] if c["名字"] == "用户功能九种")
        self.assertIn("询问（question）", nine["它是什么"])


if __name__ == "__main__":
    unittest.main()
