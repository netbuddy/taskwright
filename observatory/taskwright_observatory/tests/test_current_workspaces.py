"""观测台适配当前任务目录与工具的现实：任务按任务目录挂接、查调用编号不跨库、「回复」算对用户说话、
连着出错每次各有说明、被拒发生在任务结束之后不算异常。

挂接与查找直接在读取层的索引对象上造一份最小的数据来测；按轮归类与判据用与读取接口同形状的手写数据
（造法与 test_taskpage.py 相同）。「回复」的排版要调 agent 的命令行入口，本机没有 node 时那一条跳过。

跑法：在代码仓的 observatory 目录下运行 `python3 -m unittest taskwright_observatory.tests.test_current_workspaces`。
"""

from __future__ import annotations

import datetime as dt
import shutil
import unittest

from taskwright_observatory import taskdb
from taskwright_observatory import runs as runs_module
from taskwright_observatory import taskpage
from taskwright_observatory.api import Index
from taskwright_observatory.labels import load_tool_names
from taskwright_observatory.tests.test_taskpage import RULES, WS, alerts_of, call, run, stages_of, turn


# ───────────── 一、挂接与查找 ─────────────

def event(workspace: str, task_id: str, call_id: str, name: str = "REVISION_SAVED") -> dict:
    return {"任务目录": workspace, "任务标识": task_id, "任务类型": "演示任务", "调用编号": call_id, "事件序号": 2,
            "事件名": name, "来源": "", "发起方": "executor", "内容": {"revision_no": 1, "operations": []}, "时刻": 0}


def session(workspace: str, call_ids=()) -> dict:
    calls = [{"调用编号": c, "工具": "save_revision", "是否被拒": False} for c in call_ids]
    return {"会话编号": f"s-{workspace}", "工作目录": f"/任意/上级/{workspace}", "运行": [{"轮": [{"工具调用": calls}]}]}


def make_index() -> Index:
    """三个新格式的任务目录（ws-a、ws-b 各一个任务，ws-c 没有任务），一个旧格式的任务目录 ws-l。
    ws-a 与 ws-b 的库里各有一条调用编号都是 dup 的事件（例如假模型端点自动生成的编号撞上了）。"""
    index = Index.__new__(Index)
    current = lambda tid, created: {"格式": taskdb.FORMAT_CURRENT, "任务标识": tid, "任务类型": "演示任务", "状态": "进行中",
                                    "新库": {"创建它的调用编号": created, "判读": [], "任务名": tid}}
    index.tasks = {"ws-a/TASK-001": current("TASK-001", "ui-op-1"), "ws-b/TASK-001": current("TASK-001", "call-x"),
                   "ws-l/old": {"格式": taskdb.FORMAT_LEGACY, "任务标识": "old", "任务类型": "旧任务", "状态": "进行中"}}
    index.task_workspace = {"ws-a/TASK-001": "ws-a", "ws-b/TASK-001": "ws-b", "ws-l/old": "ws-l"}
    index.projections = {k: {"修订次数": 1, "修订": []} for k in index.tasks}
    index.workspaces = [{"任务目录": w, "任务目录路径": f"/任意/上级/{w}"} for w in ("ws-a", "ws-b", "ws-c", "ws-l")]
    index.workspace_names = {w["任务目录"] for w in index.workspaces}
    index.events_by_call = {"dup": [event("ws-a", "TASK-001", "dup"), event("ws-b", "TASK-001", "dup")],
                            "legacy-call": [event("ws-l", "old", "legacy-call", name="SLOT_WRITTEN")]}
    index.model_calls_by_call = {"dup": [{"任务目录": "ws-a", "角色": "评审者"}, {"任务目录": "ws-b", "角色": "评审者"}]}
    index.revision_by_call = {("ws-a", "dup"): {"修订序号": 1}}
    return index


class AttachTests(unittest.TestCase):
    """第 (3)(4) 条：任务与会话按任务目录挂接；第 (6) 条：查调用编号限定在会话所在的任务目录。"""

    def test_没写过库的会话也挂在它所在任务目录的任务上(self):
        index = make_index()
        found = index.tasks_of_session(session("ws-a"))
        self.assertEqual([(t["任务的键"], t["怎么对上的"]) for t in found], [("ws-a/TASK-001", "会话所在的任务目录")])
        self.assertEqual(index.unmatched_calls_note(session("ws-a")), "")

    def test_调用编号只在会话所在的任务目录里查(self):
        index = make_index()
        self.assertEqual([e["任务目录"] for e in index.events_of_call("ws-a", "dup")], ["ws-a"])
        self.assertEqual([c["任务目录"] for c in index.model_calls_of_call("ws-b", "dup")], ["ws-b"])
        self.assertEqual(index.events_of_call("", "dup"), [])
        found = index.tasks_of_session(session("ws-a", ["dup"]))
        self.assertEqual([t["任务的键"] for t in found], ["ws-a/TASK-001"])      # 不会把 ws-b 的任务也拉进来
        self.assertEqual(found[0]["本会话写下的修订"], [1])
        changes = index.changes_of_call({"调用编号": "dup", "工具": "save_revision", "是否被拒": False}, "ws-a")
        self.assertEqual([c["种类"] for c in changes], ["交付物的变化", "工具里的模型调用"])
        self.assertEqual([c["角色"] for c in changes[1]["调用"]], ["评审者"])

    def test_没有任务记录的任务目录如实说(self):
        index = make_index()
        self.assertEqual(index.tasks_of_session(session("ws-c")), [])
        self.assertEqual(index.unmatched_calls_note(session("ws-c")), "任务目录 ws-c 里还没有任务记录。")
        self.assertIn("不在当前扫到的目录里", index.unmatched_calls_note(session("ws-z")))

    def test_旧格式的库仍按调用编号对_也只在本任务目录里对(self):
        index = make_index()
        self.assertEqual([t["任务的键"] for t in index.tasks_of_session(session("ws-l", ["legacy-call"]))], ["ws-l/old"])
        self.assertEqual(index.tasks_of_session(session("ws-c", ["legacy-call"])), [])

    def test_会话文件缺失时按归档目录名对上(self):
        index = make_index()
        lost = {"会话编号": "s-lost", "工作目录": "", "会话文件": "", "归档目录名": "ws-a", "启动失败": False, "运行": []}
        found = index.tasks_of_session(lost)
        self.assertEqual([(t["任务的键"], t["怎么对上的"]) for t in found], [("ws-a/TASK-001", "按归档目录名对上")])
        place = index.workspace_of_session(lost)
        self.assertEqual((place["任务目录"], place["怎么对上的"]), ("ws-a", "按归档目录名对上"))
        self.assertIn("按归档目录名对上", place["说明"])
        # 会话文件在（只是没记工作目录）、归档目录名对不上、pi 没有启动起来的，都不走这条路。
        self.assertEqual(index.tasks_of_session(dict(lost, 会话文件="~/x.jsonl")), [])
        self.assertEqual(index.tasks_of_session(dict(lost, 归档目录名="runs")), [])
        self.assertIn("归档目录名也对不上", index.unmatched_calls_note(dict(lost, 归档目录名="runs")))
        self.assertEqual(index.workspace_name_of(dict(lost, 启动失败=True)), "")

    def test_谁建的任务按创建记录的编号如实说(self):
        index = make_index()
        self.assertIn("用户在界面上创建", index.who_created_note(session("ws-a")))
        self.assertIn("助手调用「创建任务」工具创建", index.who_created_note(session("ws-b")))


# ───────────── 二、「回复」算对用户说话 ─────────────

def raw_call(tool: str, rejected: bool, text: str, details: dict | None = None, args: dict | None = None) -> dict:
    # 工具的中文名由读取层（api.session_detail）按 tool_names.json 填进来，这里照样带上。
    return {"调用编号": f"raw-{tool}-{rejected}-{text[:4]}", "工具": tool, "工具中文名": load_tool_names().get(tool, ""),
            "参数": args or {}, "有没有执行结果": True,
            "是否被拒": rejected, "结果文字": text, "结果细节": details, "耗时秒": 0.01,
            "开始收到时刻": None, "结束收到时刻": None, "泳道": 1}


def raw_turn(number: int, calls=(), requests=None, text: str = "") -> dict:
    return {"给人读的序数": number, "pi 给的轮号": number - 1, "轮号是谁给的": "pi", "耗时秒": 0.1,
            "开始收到时刻": None, "结束收到时刻": None, "开始行号": None, "结束行号": None, "归档文件": "",
            "助手文字": text, "模型请求": requests or [{"停止原因": "toolUse"}], "工具调用": list(calls)}


REPLY = {"informs": ["我存好了 UC-001。"], "act": {"kind": "confirm", "text": "请确认 UC-001 第 1 版。",
                                                  "items": [{"item_id": "UC-001", "version_no": 1}]},
         "text": "UC-001 存好了，请确认第 1 版。"}


class ReplyTests(unittest.TestCase):
    """第 (5) 条：执行者经「回复」说了话就算说过话，画成对话，抽屉里的排版与终端一致。"""

    def shaped(self, *calls):
        one = {"用户消息": [], "自动重试": []}
        return taskpage.turn_shape(raw_turn(1, calls), one, None, RULES, WS, 0)

    def test_送达的回复就是这一轮说的话(self):
        t = self.shaped(raw_call("reply", False, "回复已送达", {"delivered": True, "reply": REPLY, "message_id": "e1"}))
        self.assertEqual(t["正文"], "UC-001 存好了，请确认第 1 版。")
        self.assertEqual(t["正文从哪来"], "回复工具")
        self.assertEqual(t["回复"]["主行为"]["kind"], "confirm")
        self.assertEqual(t["回复"]["会话条目编号"], "e1")
        self.assertFalse(t["回复"]["降级放行"])
        if shutil.which("node"):
            self.assertEqual(t["回复"]["排版"][:3], ["助手（经回复工具）：", "  告知：", "    · 我存好了 UC-001。"])
            self.assertIn("  【请确认】请确认 UC-001 第 1 版。", t["回复"]["排版"])
        stages = stages_of([run(1, [t])])
        self.assertEqual([s["名称"] for s in stages], ["用户发话", "对用户说话"])
        self.assertEqual(stages[1]["全文"], "UC-001 存好了，请确认第 1 版。")
        self.assertFalse(any("没有对用户说过" in n["文字"] for n in alerts_of([run(1, [t])])))

    def test_被拒的回复是调用失败并写出原因(self):
        t = self.shaped(raw_call("reply", True, "这次回复的形式不对，没有送达。\n1. 缺少 text。"))
        self.assertEqual(t["正文"], "")
        self.assertTrue(t["调用"][0]["回复"]["被拒"])
        self.assertIn("缺少 text", t["调用"][0]["回复"]["被拒原因"])
        if shutil.which("node"):
            self.assertEqual(t["调用"][0]["回复"]["排版"][0], "  回复被拒绝，没有送达。拒绝的原因是：")
        stages = stages_of([run(1, [t])])
        self.assertEqual(stages[1]["名称"], "回复被拒")
        self.assertTrue(any("没有对用户说过" in n["文字"] for n in alerts_of([run(1, [t])])))

    def test_降级放行的回复标明(self):
        details = {"delivered": True, "degraded": True, "reply": {"informs": [], "act": None, "text": "纯文字。"}}
        t = self.shaped(raw_call("reply", False, "回复已送达", details))
        self.assertEqual(t["正文"], "纯文字。")
        self.assertTrue(t["回复"]["降级放行"])
        self.assertIn("没有按结构发出", t["回复"]["降级放行说明"])

    def test_读取层认回复为最后说的话(self):
        spoken = runs_module.speech_of_turn(raw_turn(1, [raw_call("reply", False, "回复已送达",
                                                                  {"reply": REPLY, "message_id": "e9"})]))
        self.assertEqual((spoken["文字"], spoken["来源"], spoken["条目编号"]), (REPLY["text"], "回复工具", "e9"))
        self.assertIsNone(runs_module.speech_of_turn(raw_turn(1, [raw_call("reply", True, "拒绝")])))
        text_only = raw_turn(1, [], requests=[{"停止原因": "stop"}], text="你好。")
        self.assertEqual(runs_module.speech_of_turn(text_only)["来源"], "模型正文")

    def test_末端写明是经回复工具说的(self):
        tail = taskpage.tail_state([{"助手最后说的话": "好的。", "助手最后说的话从哪来": "回复工具", "被中止": False}])
        self.assertTrue(tail["有没有说话"])
        self.assertIn("经「回复」工具说的", tail["引子"])

    def test_连着调用工具的计数不把回复算进去(self):
        t = self.shaped(raw_call("reply", False, "回复已送达", {"reply": REPLY}))
        reads = [turn(i, [call("read", f"inputs/材料{i}.md")]) for i in range(1, 8)]
        notes = alerts_of([run(1, reads + [dict(t, 序数=8)] + [turn(9, [call("read", "inputs/再读.md")])])])
        self.assertFalse(any("连着" in n["文字"] for n in notes))


# ───────────── 三、连着出错与自动重试 ─────────────

def errored_turn(number: int, reason: str) -> dict:
    t = turn(number, [], text="", stop="error")
    t["请求"][0]["出错说明"] = reason
    return t


class ErrorTests(unittest.TestCase):
    """第 (1) 条：每次失败各有说明，按轮归类的标题按次数写。"""

    def test_连着两次出错_标题带次数_每次一条说明(self):
        stages = stages_of([run(1, [errored_turn(1, "500 第一次"), errored_turn(2, "500 第二次"),
                                          turn(3, [], text="好了。", stop="stop")])])
        self.assertEqual(stages[1]["名称"], "没有说话也没有调用工具（模型请求出错 2 次）")
        self.assertIn("连着 2 次模型请求都出错了", stages[1]["一句话"])
        self.assertEqual([s["文字"] for s in stages[1]["小步"]],
                         ["第 1 次出错，在第 1 轮：500 第一次", "第 2 次出错，在第 2 轮：500 第二次"])

    def test_只出错一次_标题写一次(self):
        stages = stages_of([run(1, [errored_turn(1, "500"), turn(2, [], text="好了。", stop="stop")])])
        self.assertEqual(stages[1]["名称"], "没有说话也没有调用工具（模型请求出错 1 次）")
        self.assertIn("出错的说明是：500", stages[1]["一句话"])

    def test_每一轮带自己的出错说明_重试旁注写明第几次与等了几秒(self):
        turns = [raw_turn(1, requests=[{"停止原因": "error", "出错说明": "500 甲"}]),
                 raw_turn(2, requests=[{"停止原因": "error", "出错说明": "500 乙", "是不是自动重试": True}]),
                 raw_turn(3, requests=[{"停止原因": "toolUse", "是不是自动重试": True}])]
        one = {"用户消息": [], "轮": turns, "自动重试": [
            {"事件": "auto_retry_start", "内容": {"attempt": 1, "delayMs": 2000}},
            {"事件": "auto_retry_start", "内容": {"attempt": 2, "delayMs": 4000}},
            {"事件": "auto_retry_end", "内容": {"success": True}}]}
        shaped = [taskpage.turn_shape(t, one, None, RULES, WS, 0) for t in turns]
        self.assertEqual([s["出错说明"] for s in shaped], [["500 甲"], ["500 乙"], []])
        self.assertEqual(shaped[0]["自动重试说明"], "")
        self.assertIn("这是第 1 次，等了 2 秒再试", shaped[1]["自动重试说明"])
        self.assertIn("这是第 2 次，等了 4 秒再试", shaped[2]["自动重试说明"])


# ───────────── 四、被拒发生在任务结束之后 ─────────────

class ClosedTaskTests(unittest.TestCase):
    """第二种误报：任务已完成之后保存修订被拒，之后不再保存是对的。"""

    def rejected_at(self, epoch: float) -> list[dict]:
        rejected = call("save_revision", rejected=True, 起止=[epoch, epoch])
        return [run(1, [turn(1, [rejected]), turn(2, [], text="任务已经完成，不能再改了。", stop="stop")])]

    def test_结束之后被拒_记轻的说明(self):
        closed = dt.datetime(2026, 9, 21, 12, 0, 0).timestamp()
        notes = alerts_of(self.rejected_at(closed + 60), closed)
        text = [n for n in notes if "被工具拒绝" in n["文字"]]
        self.assertEqual(len(text), 1)
        self.assertEqual(text[0]["轻重"], "轻")
        self.assertIn("任务已经结束", text[0]["文字"])

    def test_结束之前被拒_照旧算重的异常(self):
        closed = dt.datetime(2026, 9, 21, 12, 0, 0).timestamp()
        notes = alerts_of(self.rejected_at(closed - 60), closed)
        self.assertTrue(any(n["轻重"] == "重" and "再也没有调用过同一个工具" in n["文字"] for n in notes))
        notes = alerts_of(self.rejected_at(closed + 60), None)
        self.assertTrue(any(n["轻重"] == "重" and "再也没有调用过同一个工具" in n["文字"] for n in notes))

    def test_任务结束时刻取自库里的本地时间(self):
        self.assertIsNone(taskpage.task_closed_at({"新库": {"结束时刻": None}}))
        self.assertIsNone(taskpage.task_closed_at(None))
        self.assertEqual(taskpage.task_closed_at({"新库": {"结束时刻": "2026-09-21T12:00:00.000"}}),
                         dt.datetime(2026, 9, 21, 12, 0, 0).timestamp())


if __name__ == "__main__":
    unittest.main()
