"""观测台读取层的单元测试。

用的是 `fixtures/runs/` 下那一小份夹具数据：它照真实归档裁出来，结构一样，内容换成中性的，
里面不含本机的家目录路径。任务数据库不入库，由本文件在临时目录里现建一份，
建库的语句与旧格式库的表结构一致。

夹具里有两次 pi 进程启动，同一条会话：第一次启动里有两次运行，第二次启动里有一次运行，
每次运行两轮。第二次启动配了后端补记（含 pi 给的轮号与 Langfuse 运行记录编号）与收到时刻索引，
第一次故意没配，这样两条路（有补记与没补记）都测得到。
另有一份 `fixtures/langfuse观测记录.json`，是从 Langfuse 读取接口的真实返回裁出来的，
只留对应规则用得到的字段，地址、项目标识、密钥一概没留。测试不访问网络。

另有一份 `fixtures/runs并行/`，专门覆盖两种真实归档里还没有出现过的情形：同一轮里两次工具调用
在时间上重叠（并行执行），以及同一轮里因为自动重试出现两次模型请求。它同样是造出来的中性数据。

测这些事：会话与任务的对应、会话名的取法与会话列表的找会话字段、启动时传 runs 上一级目录的展开与任务目录的默认值、
修订的投影、被拒与改正的分组、重启的识别、运行与轮的划界、
提示来源的识别、轮号的取用规则、第二级链接的对应规则、时间条各段的起止取自收到时刻、
缺收到时刻索引时不画时间条、并行的工具调用在一轮里怎么归组、「带的消息」两个来源怎么取用。

有一条规则不在这里测：**时间条上「真实宽度不到最小可见宽度就拉宽并打斜纹」那一条**。
它要先知道一条泳道在浏览器里实际有多少像素宽，这个数只有排版之后才有，在后端算不出来，
所以规则写在前端的 `web/js/flow.js` 里（`markNarrowSegments`），靠浏览器里的走查核对：
窗口宽 1280 与 1900 各看一遍，被拉宽的段带斜纹、耗时写在段的右边，改窗口宽度后会重新量一遍。

跑法：在代码仓目录下运行 `python3 -m unittest taskwright_observatory.tests.test_readers`。
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import runs as runs_module
from taskwright_observatory.__main__ import default_workspaces_dir, expand_archive_dirs
from taskwright_observatory.api import Index
from taskwright_observatory.langfuse import LangfuseLinks, count_input_messages

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
FIXTURE_RUNS = FIXTURE_DIR / "runs"

#: 夹具里第二次启动那两轮报出来的 Langfuse 运行记录编号。
FIXTURE_TRACE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"


class 夹具链接(LangfuseLinks):
    """把向 Langfuse 发请求那一步换成读夹具文件，这样测试不碰网络。"""

    def __init__(self):
        super().__init__(base_url="http://langfuse.example", project_id="项目夹具")
        self._public_key = "公钥夹具"
        self._secret_key = "私钥夹具"
        self.请求过的地址: list[str] = []

    def _get(self, path: str):
        self.请求过的地址.append(path)
        return json.loads((FIXTURE_DIR / "langfuse观测记录.json").read_text(encoding="utf-8"))

#: 夹具里那条会话的编号，与 fixtures/runs 下归档里写的一致。
SESSION_ID = "01a0be00-0000-7000-8000-000000000001"

#: 建一份旧格式表结构的任务数据库。只建观测台会读的那四张表。
SCHEMA = """
CREATE TABLE task (id TEXT PRIMARY KEY, def_name TEXT NOT NULL, def_file TEXT NOT NULL,
    def_json TEXT NOT NULL, instance TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT, ended_at TEXT);
CREATE TABLE slot (task_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, value TEXT,
    version INTEGER NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, name));
CREATE TABLE slot_history (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
    name TEXT NOT NULL, old TEXT, new TEXT, version INTEGER NOT NULL, source TEXT NOT NULL,
    at TEXT NOT NULL, event_seq INTEGER NOT NULL);
CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, ts REAL NOT NULL,
    call_id INTEGER, kind TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
    payload TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, command TEXT NOT NULL);
"""

TASK_ID = "术语澄清-夹具"
DEFINITION = {
    "名字": "术语澄清",
    "槽位": {"术语": {"说明": "要澄清的术语", "类型": "文本"},
             "释义草稿": {"说明": "释义的草稿", "类型": "文本"}},
    "领域规矩": "一到三句话，先说是什么。",
}
FIRST = "甲。"
SECOND = "甲。乙。"


def build_workspace(root: Path) -> Path:
    """在临时目录里现建一个任务目录，里面的事件带着夹具归档里那两个调用编号。"""
    workspace = root / "任务目录"
    workspace.mkdir(parents=True)
    conn = sqlite3.connect(workspace / "task.sqlite")
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO task VALUES (?,?,?,?,?,?,?,?)",
                 (TASK_ID, "术语澄清", "docs/task-definitions/term.json",
                  json.dumps(DEFINITION, ensure_ascii=False), "夹具", "执行中",
                  "2026-01-01T00:00:00", None))
    for name in ("术语", "释义草稿"):
        conn.execute("INSERT INTO slot VALUES (?,?,?,?,?,?,?)",
                     (TASK_ID, name, "文本", "null", 0, "初始化", "2026-01-01T00:00:00"))
    conn.execute("UPDATE slot SET value = ?, version = 2, source = '模型' "
                 "WHERE task_id = ? AND name = '释义草稿'",
                 (json.dumps(SECOND, ensure_ascii=False), TASK_ID))

    def history(row_id, name, old, new, version, source, at, seq):
        conn.execute("INSERT INTO slot_history VALUES (?,?,?,?,?,?,?,?,?)",
                     (row_id, TASK_ID, name,
                      json.dumps(old, ensure_ascii=False), json.dumps(new, ensure_ascii=False),
                      version, source, at, seq))

    def event(seq, call_id, name, payload, at, actor, source, command):
        conn.execute("INSERT INTO event VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (seq, TASK_ID, float(seq), call_id, "state", source, name,
                      json.dumps(payload, ensure_ascii=False), at, actor, command))

    # 建库时把两个字段都摆成空值：这两条不带调用编号，所以不算修订。
    history(1, "术语", None, None, 0, "初始化", "2026-01-01T00:00:00", 1)
    history(2, "释义草稿", None, None, 0, "初始化", "2026-01-01T00:00:00", 2)
    event(1, None, "DATA_CHANGED", {"slot": "术语", "old": None, "new": None, "source": "初始化"},
          "2026-01-01T00:00:00", "驱动程序", "tod.task.start", "tod task start")
    event(2, None, "DATA_CHANGED", {"slot": "释义草稿", "old": None, "new": None,
                                    "source": "初始化"},
          "2026-01-01T00:00:00", "驱动程序", "tod.task.start", "tod task start")
    # 两次真正的写入，调用编号与夹具归档里的一致。
    history(3, "释义草稿", None, FIRST, 1, "模型", "2026-01-01T00:00:02", 8)
    event(8, "调用一", "DATA_CHANGED",
          {"slot": "释义草稿", "old": None, "new": FIRST, "source": "模型"},
          "2026-01-01T00:00:02", "模型", "save_version", "save_version …")
    history(4, "释义草稿", FIRST, SECOND, 2, "模型", "2026-01-01T00:00:22", 9)
    event(9, "调用三", "DATA_CHANGED",
          {"slot": "释义草稿", "old": FIRST, "new": SECOND, "source": "模型"},
          "2026-01-01T00:00:22", "模型", "save_version", "save_version …")
    conn.commit()
    conn.close()
    return workspace


class ReaderTests(unittest.TestCase):
    """八件事各测一条。每个测试方法的名字说的就是它在核对什么。"""

    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory()
        root = Path(cls._temp.name)
        build_workspace(root)
        cls.index = Index(FIXTURE_RUNS, root)
        cls.session = cls.index.session_detail(SESSION_ID)

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def test_会话对上了它写过的那个任务(self):
        """会话里的调用编号能在库里对上任务；对不上的那条会话不该凭空多出一个任务。"""
        tasks = self.session["提取出的任务"]
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["任务标识"], TASK_ID)
        self.assertEqual(tasks[0]["本会话写下的修订"], [1, 2])
        failed = [s for s in self.index.session_list()["会话"] if s["启动失败"]]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["提取出的任务"], [])
        self.assertIn("Failed to load extension", failed[0]["启动失败原因"])

    def test_修订是整份交付物的快照而不是单个字段的版本(self):
        """两次写入投影成两次修订；建库那两条不算修订；每次修订都带整份交付物的快照。"""
        task = self.index.task_detail(f"任务目录/{TASK_ID}")
        self.assertEqual(task["修订次数"], 2)
        self.assertEqual(task["建库时的变更条数"], 2)
        self.assertEqual(task["字段顺序"], ["术语", "释义草稿"])
        first, second = task["修订"]
        self.assertEqual(first["改动字段"], ["释义草稿"])
        self.assertEqual(first["快照"], {"术语": "", "释义草稿": FIRST})
        self.assertEqual(second["快照"], {"术语": "", "释义草稿": SECOND})
        self.assertEqual(second["上一次快照"]["释义草稿"], FIRST)
        # 修订指回的是「第几次运行的第几轮」，与 pi 的层次对齐。
        self.assertEqual(second["产生它的那一步"]["运行序号"], 3)
        self.assertEqual(second["产生它的那一步"]["轮号"], 0)
        self.assertEqual(second["事件序号"], 9)

    def test_被拒的那次调用指向后来改正的那一步(self):
        """被拒发生在第二次运行，改正发生在第三次运行，所以不是同一次运行，但仍然算改正成功。"""
        calls = [call for one in self.session["运行"] for turn in one["轮"]
                 for call in turn["工具调用"]]
        rejected = [call for call in calls if call["是否被拒"]]
        self.assertEqual(len(rejected), 1)
        fix = rejected[0]["改正"]
        self.assertTrue(fix["有没有再试"])
        self.assertTrue(fix["改正成功"])
        self.assertFalse(fix["是不是同一次运行"])
        self.assertEqual(fix["运行序号"], 3)
        self.assertEqual(fix["轮号"], 0)
        rows = self.index.health(SESSION_ID)["门禁"]["行"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["发生次数"], 1)
        self.assertEqual(rows[0]["其后改正成功次数"], 1)

    def test_同一条会话的两次启动被认成一次重启(self):
        """两个归档文件带同一个会话编号，说明中途重启过 pi 进程；第三次运行落在第二次启动里。"""
        self.assertTrue(self.session["是否重启过"])
        self.assertEqual(self.session["pi 进程启动次数"], 2)
        self.assertEqual([one["启动序号"] for one in self.session["运行"]], [0, 0, 1])
        self.assertEqual(self.session["运行"][2]["归档文件"], "试跑-20260101-000010.jsonl")
        self.assertEqual(self.session["运行"][0]["提示"]["用户消息条目编号"], "消息一")

    def test_运行与轮的划界(self):
        """一次运行从 agent_start 到 agent_settled；一轮从 turn_start 到 turn_end。

        夹具里三次运行，每次两轮：第一轮调工具，第二轮只说话。轮号在每次运行里从 0 重新起。
        模型请求数等于轮数，因为每一轮的助手消息各带一个响应编号。
        """
        self.assertEqual(self.session["运行次数"], 3)
        self.assertEqual(self.session["轮数"], 6)
        self.assertEqual(self.session["模型请求次数"], 6)
        self.assertEqual(self.session["工具调用次数"], 3)
        for one in self.session["运行"]:
            self.assertEqual([turn["轮号"] for turn in one["轮"]], [0, 1])
            self.assertEqual(len(one["轮"][0]["工具调用"]), 1)
            self.assertEqual(len(one["轮"][1]["工具调用"]), 0)
            for turn in one["轮"]:
                self.assertEqual(len(turn["模型请求"]), 1)
                self.assertTrue(turn["模型请求"][0]["响应编号"] == ""
                                or isinstance(turn["模型请求"][0]["响应编号"], str))
        # 第二次启动配了收到时刻索引，所以那一次运行的耗时算得出来；第一次启动没配，显示未知。
        self.assertIsNone(self.session["运行"][0]["耗时秒"])
        self.assertIsNotNone(self.session["运行"][2]["耗时秒"])
        self.assertIsNotNone(self.session["运行"][2]["轮"][0]["耗时秒"])

    def test_轮号的取用规则(self):
        """轮号以 pi 给的为准；取不到时按 turn_start 的先后自己数，并记下是谁给的。

        给人读的序数一律是轮号加一，从 1 起。
        """
        first, _, third = self.session["运行"]
        # 第一次启动没有「本轮事实」补记，所以那两次运行的轮号是观测台数出来的。
        for turn in first["轮"]:
            self.assertIsNone(turn["pi 给的轮号"])
            self.assertEqual(turn["轮号是谁给的"], "观测台按先后数出来的")
            self.assertEqual(turn["给人读的序数"], turn["自数轮号"] + 1)
        # 第二次启动补记里有 pi 给的轮号，那一次运行就用 pi 的。
        for turn in third["轮"]:
            self.assertIsNotNone(turn["pi 给的轮号"])
            self.assertEqual(turn["轮号是谁给的"], "pi 给的")
            self.assertEqual(turn["轮号"], turn["pi 给的轮号"])
            self.assertEqual(turn["给人读的序数"], turn["pi 给的轮号"] + 1)
        self.assertEqual([t["给人读的序数"] for t in third["轮"]], [1, 2])
        # 运行记录编号也从那份补记里来，一次运行里各轮报的是同一个。
        self.assertEqual(third["Langfuse 运行记录编号"], FIXTURE_TRACE_ID)
        self.assertTrue(third["各轮报来的运行记录编号一致吗"])
        self.assertEqual(first["Langfuse 运行记录编号"], "")

    def test_第二级链接的对应规则(self):
        """工具调用按 metadata.tool_id 精确对上，模型请求按 metadata.assistant_index 对上。

        对不上的不硬凑：夹具里没有的调用编号取不到链接，调用方据此退回第一级。
        """
        links = 夹具链接()
        steps = links.steps_of(FIXTURE_TRACE_ID)
        self.assertTrue(steps["取到了吗"])
        self.assertEqual(steps["工具调用"]["调用一"],
                         f"http://langfuse.example/project/项目夹具/traces/"
                         f"{FIXTURE_TRACE_ID}?observation=cccc3333dddd4444")
        self.assertEqual(steps["模型请求"][0],
                         f"http://langfuse.example/project/项目夹具/traces/"
                         f"{FIXTURE_TRACE_ID}?observation=aaaa1111bbbb2222")
        self.assertEqual(steps["模型请求"][1],
                         f"http://langfuse.example/project/项目夹具/traces/"
                         f"{FIXTURE_TRACE_ID}?observation=eeee5555ffff6666")
        # 那条 SPAN 既没有 tool_id 也没有 assistant_index，所以两张表里都不该有它。
        self.assertNotIn("7777888899990000", "".join(steps["工具调用"].values()))
        self.assertEqual(len(steps["工具调用"]), 1)
        self.assertEqual(len(steps["模型请求"]), 2)
        # 对不上的调用编号取不到链接。
        self.assertEqual(steps["工具调用"].get("没这个调用编号"), None)
        # 只发 GET 读取请求，而且第二次问同一条记录时命中缓存，不再发请求。
        self.assertEqual(len(links.请求过的地址), 1)
        links.steps_of(FIXTURE_TRACE_ID)
        self.assertEqual(len(links.请求过的地址), 1)
        # 状态里一个密钥字符都没有。
        printed = json.dumps(links.status(), ensure_ascii=False)
        self.assertNotIn("私钥夹具", printed)
        self.assertNotIn("公钥夹具", printed)

    def test_提示来源的识别(self):
        """有后端补记时用补记里的记录；没有补记时退回到归档里那条 prompt 回应行。"""
        first, _, third = self.session["运行"]
        self.assertEqual(first["提示"]["投递方式"], "后端经 RPC 的 prompt 命令提交")
        self.assertEqual(first["提示"]["投递方式的依据"], "归档里有一条 command 为 prompt 的回应行")
        self.assertEqual(first["提示"]["原文"], "把释义草稿记成：甲。")
        self.assertEqual(third["提示"]["投递方式"], "后端经 RPC 的 prompt 命令提交")
        self.assertEqual(third["提示"]["投递方式的依据"], "后端补记里的「提示」记录")
        self.assertEqual(third["提示"]["原文"], "存错地方了，把乙接在释义草稿后面。")
        self.assertEqual(third["提示"]["用户消息条目编号"], "消息六")
        # 每次运行只有一条用户消息，而且就是触发它的那一条。
        for one in self.session["运行"]:
            self.assertEqual(len(one["用户消息"]), 1)
            self.assertTrue(one["用户消息"][0]["这条是不是触发这次运行的那条"])


class FindSessionTests(unittest.TestCase):
    """找会话：会话名取自会话文件里最后一条 session_info，会话列表每行带任务名与会话名；
    启动时传 runs 这一层，下面每个含 pi-events 的子目录都收进来。"""

    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(self._temp.name)

    def tearDown(self):
        self._temp.cleanup()

    def test_会话名取最后一次起的名字_列表行带任务名与会话名(self):
        archive = self.root / "runs" / "任务目录"
        shutil.copytree(FIXTURE_RUNS, archive)
        session_file = next((archive / "pi-sessions").glob("*/*.jsonl"))
        with session_file.open("a", encoding="utf-8") as out:
            for name in ("先起的名字", "后改的名字"):
                out.write(json.dumps({"type": "session_info", "id": name, "parentId": None,
                                      "timestamp": "2026-01-01T00:01:00.000Z", "name": name}, ensure_ascii=False) + "\n")
        workspaces = self.root / "tasks"
        workspaces.mkdir()
        build_workspace(workspaces)
        index = Index(archive, workspaces)
        row = next(r for r in index.session_list()["会话"] if r["会话编号"] == SESSION_ID)
        self.assertEqual(row["会话名"], "后改的名字")
        self.assertEqual((row["任务编号"], row["任务名"]), (TASK_ID, "术语澄清"))
        self.assertEqual(row["任务怎么对上的"], "调用编号")
        self.assertIsInstance(row["开始秒"], float)
        self.assertEqual(index.session_detail(SESSION_ID)["会话名"], "后改的名字")

    def test_没有起名字时会话名为空(self):
        index = Index(FIXTURE_RUNS, self.root)
        self.assertEqual(index.session_detail(SESSION_ID)["会话名"], "")
        self.assertEqual(index.session_options()[0]["名字"], "未命名会话")

    def test_传runs这一层时收进每个含pi_events的子目录(self):
        runs = self.root / "runs"
        for name in ("TASK-B", "TASK-A"):
            (runs / name / "pi-events").mkdir(parents=True)
        (runs / "杂项").mkdir()                                          # 没有 pi-events 的子目录不收
        (self.root / "tasks").mkdir()
        found = expand_archive_dirs([runs])
        self.assertEqual([d.name for d in found], ["TASK-A", "TASK-B"])
        self.assertEqual(default_workspaces_dir(runs, found[0]), self.root / "tasks")
        # 直接给一个归档目录：照旧取它的上一级。
        self.assertEqual(expand_archive_dirs([runs / "TASK-A"]), [runs / "TASK-A"])
        self.assertEqual(default_workspaces_dir(runs / "TASK-A", runs / "TASK-A"), runs)
        # runs 旁边没有 tasks/ 时，也取第一个归档目录的上一级。
        shutil.rmtree(self.root / "tasks")
        self.assertEqual(default_workspaces_dir(runs, found[0]), runs)
        # 两个都给、有重复的，只收一次。
        self.assertEqual(len(expand_archive_dirs([runs, runs / "TASK-A"])), 2)


class TimelineTests(unittest.TestCase):
    """时间条这一层：起止取自收到时刻，取不到就不画，并行的调用分到不同泳道。"""

    FIXTURE_PARALLEL = FIXTURE_DIR / "runs并行"
    PARALLEL_SESSION = "01a0be00-0000-7000-8000-000000000002"

    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory()
        root = Path(cls._temp.name)
        build_workspace(root)
        cls.index = Index(FIXTURE_RUNS, root)
        cls.session = cls.index.session_detail(SESSION_ID)
        cls.parallel = Index(cls.FIXTURE_PARALLEL, root).session_detail(cls.PARALLEL_SESSION)

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    @staticmethod
    def archive_lines(archive_name: str) -> list[tuple[int, dict]]:
        """把一个归档读成（行号，事件）的一串。"""
        rows, _ = runs_module.read_jsonl(FIXTURE_DIR / "runs并行" / "pi-events" / archive_name)
        return list(enumerate(rows, 1))

    @staticmethod
    def received_times(archive_name: str) -> dict[int, float]:
        """把一个归档旁边那份收到时刻索引读成「行号 → 收到时刻」。"""
        path = FIXTURE_DIR / "runs并行" / "pi-events" / archive_name
        rows, _ = runs_module.read_jsonl(path)
        return {int(one["行号"]): one["收到时刻"] for one in rows}

    def test_时间条各段的起止取自收到时刻(self):
        """每一段的起止，就是对应那两行在收到时刻索引里记的时刻，一秒也不差。

        模型请求取这条助手消息的 message_start 与 message_end 两行；
        工具调用取 tool_execution_start 与 tool_execution_end 两行。
        """
        times = self.received_times("并行验证-20260101-000000.times.jsonl")
        lines = self.archive_lines("并行验证-20260101-000000.jsonl")
        # 行号不写死：到归档里按事件种类找，找到哪一行就用哪一行的收到时刻。
        find = lambda test: next(n for n, e in lines if test(e))
        role = lambda e: (e.get("message") or {}).get("role")
        one = self.parallel["运行"][0]
        self.assertTrue(one["时间条"]["能不能画"])
        self.assertEqual(one["时间条"]["起"], times[find(lambda e: e.get("type") == "agent_start")])
        self.assertEqual(one["时间条"]["止"], times[find(lambda e: e.get("type") == "agent_settled")])
        request = one["轮"][0]["模型请求"][0]
        start = find(lambda e: e.get("type") == "message_start" and role(e) == "assistant")
        end = find(lambda e: e.get("type") == "message_end" and role(e) == "assistant")
        self.assertEqual(request["开始收到时刻"], times[start])
        self.assertEqual(request["结束收到时刻"], times[end])
        self.assertEqual(request["耗时秒"], round(times[end] - times[start], 3))
        for call in one["轮"][0]["工具调用"]:
            begin = find(lambda e: e.get("type") == "tool_execution_start" and e.get("toolCallId") == call["调用编号"])
            done = find(lambda e: e.get("type") == "tool_execution_end" and e.get("toolCallId") == call["调用编号"])
            self.assertEqual(call["开始收到时刻"], times[begin])
            self.assertEqual(call["结束收到时刻"], times[done])

    def test_缺收到时刻索引时不画时间条(self):
        """没有收到时刻索引的那次运行，时间条不画，并写明画不出的原因；步骤流照常给出来。

        夹具里第一次启动故意没有配收到时刻索引，第二次配了，所以两条路都走得到。
        观测台不拿任务数据库或 pi 消息自带的时间戳去顶替，起止一律留空。
        """
        first, _, third = self.session["运行"]
        self.assertFalse(first["时间条"]["能不能画"])
        self.assertIn(".times.jsonl", first["时间条"]["画不出的原因"])
        self.assertIsNone(first["时间条"]["起"])
        self.assertIsNone(first["时间条"]["止"])
        self.assertTrue(first["轮"])                      # 步骤流该有的轮一轮也没有少
        self.assertIsNone(first["轮"][0]["模型请求"][0]["开始收到时刻"])
        self.assertIsNone(first["轮"][0]["模型请求"][0]["耗时秒"])
        self.assertTrue(third["时间条"]["能不能画"])
        self.assertIsNotNone(third["时间条"]["起"])

    def test_并行的工具调用归到不同泳道(self):
        """一轮里时间上重叠的两次调用算并行，分到不同泳道；不重叠的共用一条泳道。

        泳道编号从 1 起，因为时间条的第 0 条泳道固定放模型请求。
        """
        turn = self.parallel["运行"][0]["轮"][0]
        self.assertTrue(turn["工具调用是不是并行的"])
        self.assertEqual([call["泳道"] for call in turn["工具调用"]], [1, 2])
        # pi 的一轮里只有一次模型请求。自动重试开的是新的一段低层运行，另见 test_stream.py。
        self.assertEqual(len(turn["模型请求"]), 1)
        self.assertFalse(turn["模型请求"][0]["是不是自动重试"])
        # 不重叠的那一轮不算并行。
        self.assertFalse(self.parallel["运行"][0]["轮"][1]["工具调用是不是并行的"])
        # 判重叠与排泳道的规则本身，直接用一组构造出来的调用再核对一遍。
        made = [{"开始收到时刻": 0.0, "结束收到时刻": 1.0},
                {"开始收到时刻": 0.5, "结束收到时刻": 1.5},
                {"开始收到时刻": 2.0, "结束收到时刻": 3.0}]
        runs_module.assign_lanes(made)
        self.assertEqual([one["泳道"] for one in made], [1, 2, 1])
        self.assertTrue(runs_module.calls_are_parallel(made))
        self.assertFalse(runs_module.calls_are_parallel(made[1:]))
        # 取不到收到时刻的调用一律排在第 1 条泳道，不去猜它与谁并行。
        blind = [{"开始收到时刻": None, "结束收到时刻": None}]
        runs_module.assign_lanes(blind)
        self.assertEqual(blind[0]["泳道"], 1)
        self.assertFalse(runs_module.calls_are_parallel(blind))

    def test_带的消息两个来源的取用规则(self):
        """观测台自己数一个数；配了密钥并且对得上时，再从 Langfuse 取一个数。

        两个数一样就写一个并说明两边对得上；不一样就两个都写，各自注明来源，不挑一个；
        取不到 Langfuse 那个数时只写观测台自己数的那个。测试不访问网络，读的是夹具文件。
        """
        # 一、数消息的规则：系统提示不算，形状不对就返回空值。
        self.assertEqual(count_input_messages(
            [{"role": "system", "content": "x"}, {"role": "user", "content": "y"}]), 1)
        self.assertEqual(count_input_messages([]), 0)
        self.assertIsNone(count_input_messages({"field": "术语"}))
        self.assertIsNone(count_input_messages(None))
        # 二、没有配 Langfuse 时只有观测台自己数的那个数。
        plain = self.session["运行"][0]["轮"][0]["模型请求"][0]["带的消息"]
        self.assertIsNone(plain["取自 Langfuse 的"])
        self.assertIsInstance(plain["观测台数出来的"], int)
        self.assertTrue(plain["两个数一样吗"])
        # 三、配了密钥时两个数都给出来。夹具里两个数故意不一样，所以「两个数一样吗」是假。
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            build_workspace(root)
            linked = Index(FIXTURE_RUNS, root, links=夹具链接())
            detail = linked.session_detail(SESSION_ID)
        counts = detail["运行"][2]["轮"][0]["模型请求"][0]["带的消息"]
        self.assertEqual(counts["取自 Langfuse 的"], 1)        # 夹具里第一条生成记录的输入
        self.assertNotEqual(counts["观测台数出来的"], 1)
        self.assertFalse(counts["两个数一样吗"])
        second = detail["运行"][2]["轮"][1]["模型请求"][0]["带的消息"]
        self.assertEqual(second["取自 Langfuse 的"], 3)
        # 没有带出运行记录编号的那几次运行，取不到 Langfuse 那个数。
        self.assertIsNone(detail["运行"][0]["轮"][0]["模型请求"][0]["带的消息"]["取自 Langfuse 的"])


if __name__ == "__main__":
    unittest.main()
