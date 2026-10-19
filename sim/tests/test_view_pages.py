"""用户 agent 看主题页与确认待核实：真的后端、真的 pi、假模型端点，走一次完整的演练，再看库里记下了什么。

两种动作与网页走同一条接口（actions 的 mark_viewed）：
- 看一页主题：不待核实的页打开就记已读；待核实的页打开不记。
- 确认这一页待核实的几处：带着 confirm 再看一次才记，记了之后这一页不再待核实。

脚本里助手立两页主题：「借书」出自材料；「预约保留期」的「它是什么」是助手补的，所以这一页待核实。用户 agent 第二轮依次
打开第一页、打开第二页、带着确认再看第二页，然后说一句并表示目标达成。本机没有 pi 或 node 时跳过。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import taskdb

from sim import lamps, run
from sim.run import FIRST_WAKE
from sim.tests.test_evals import EXAMPLES, REPO, intent, source
from sim.tests.test_user_agent_round import ENV_AGENT_DIR, FakeModel


def look(**arguments) -> dict:
    return {"tool_calls": [{"name": "look", "arguments": arguments}]}


def respond(**arguments) -> dict:
    return {"tool_calls": [{"name": "respond", "arguments": arguments}]}


def user(reply: dict, max_uses: int | None = None, **when) -> dict:
    """用户 agent 的一条规则：它的每个请求里都有驾驭程序唤起它的头一句话。max_uses 给了就只用这么多次。"""
    rule = {"when": {"any_contains": FIRST_WAKE, **when}, "reply": reply}
    return rule if max_uses is None else {**rule, "max_uses": max_uses}


PAGES = [
    {"op": "add", "collection": "业务说明", "fields": {"标题": "借书", "它是什么": "读者凭借书证借书，每本书可以续借一次。", "例子": ["读者凭借书证借书"],
                                                     "标签": ["流程"], "状态": "在用"},
     "sources": [source("读者凭借书证借书，每本书可以续借一次。")]},
    {"op": "add", "collection": "业务说明", "fields": {"标题": "预约保留期", "它是什么": "书还回来以后只为预约的读者留着的那段时间。", "例子": ["这本书为他保留 3 天"],
                                                     "标签": ["概念"], "状态": "在用"},
     "sources": [{**source("这本书为他保留 3 天"), "supports": [{"field": "例子", "index": 0}]},
                 {"kind": "助手补充", "excerpt": "材料没有给这个词下定义，按常见的说法补的，等用户确认。", "supports": [{"field": "它是什么", "inserted": ["书还回来以后只为预约的读者留着的那段时间"]}]}]},
]
QUESTION = "这两页里哪一处与你们馆的做法不一样？"
SCRIPT = {"rules": [
    # 用户 agent 第二轮：带着确认看完第二页之后说一句并结束；看到第二页还有没确认的，就带着确认再看一次；
    # 看完第一页接着打开第二页；在提纲里看到有一页等着确认，先打开第一页。
    user(respond(text="两页都看过了。", done=True), last_role="tool", last_contains="并确认了助手补的"),
    # 这一条只用一次：确认要是没有生效，界面上仍会写着「还没有确认」，不限次数的话用户 agent 会一直重看下去。
    user(look(item_id="OA-002", confirm=True), max_uses=1, last_role="tool", last_contains="还没有确认"),
    user(look(item_id="OA-002"), last_role="tool", last_contains="OA-001「借书」，集合"),
    user(look(item_id="OA-001"), last_role="tool", last_contains="等你确认"),
    # 用户 agent 第一轮：看一眼界面，说想做的事。
    user(respond(text="帮我把这份需求整理成规格说明。"), last_role="tool"),
    user(look(), last_role="user"),
    # 助手：第一句话之后立两页主题；工具结果回来之后提一个问题；用户说看过了之后回一句。
    {"when": {"last_role": "user", "last_contains": "帮我把这份需求整理"},
     "reply": {"text": intent("request", "把需求整理成规格说明"), "tool_calls": [{"name": "save_revision", "arguments": {"operations": PAGES}}]}},
    {"when": {"last_role": "user", "last_contains": "两页都看过了"},
     "reply": {"text": intent("inform", "两页都看过了"), "tool_calls": [{"name": "reply", "arguments": {"informs": [], "act": None, "text": "好的，我接着往下做。"}}]}},
    {"when": {"last_role": "tool"},
     "reply": {"tool_calls": [{"name": "reply", "arguments": {"informs": [], "act": {"kind": "ask", "text": QUESTION, "scope": "general"},
                                                             "text": "我立了两页主题，请你看一下。" + QUESTION}}]}},
], "default": {"text": "好的。"}}


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class ViewPagesTest(unittest.TestCase):
    def test_不待核实的页打开就记已读_待核实的页打开不记_带着确认再看才记(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-view-it-"))
        fake = FakeModel(SCRIPT, root)
        fake.start()
        saved = dict(os.environ)
        try:
            for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                os.environ.pop(name, None)
            os.environ.update({ENV_AGENT_DIR: str(fake.agent_dir), "PI_OFFLINE": "1", "XDG_DATA_HOME": str(root / "data"),
                               "TASKWRIGHT_SETTINGS_FILE": str(root / "settings.json")})
            code = run.main(["--persona", str(REPO / "sim" / "personas" / "library-short.json"), "--materials-dir", str(EXAMPLES),
                             "--port", "0", "--profile", "fake", "--user-model", "fake/fake-model",
                             "--sim-root", str(root / "sims"), "--max-rounds", "4"])
        finally:
            fake.stop()
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(code, 0)
        sim = root / "sims" / "sim-001"
        record = json.loads((sim / "record.json").read_text(encoding="utf-8"))
        self.assertEqual(record["停止原因"], "用户 agent 表示目标达成")
        second = record["轮"][1]["用户 agent"]
        # 第二轮：看界面、打开第一页、打开第二页、带着确认再看第二页。
        self.assertEqual((second["looks"], second["confirms"]), ([None, "OA-001", "OA-002", "OA-002"], ["OA-002"]))
        task = taskdb.read_workspace(sim / "库副本")["任务"][0]
        marks = [(d["条目编号"], d["修订号"], d["态度"], [b.get("依据") for b in mark["依据"]]) for mark in task["判读"] for d in mark["明细"]]
        # 库里正好两条已读：第一页打开时一条；第二页只有带着确认的那一次记了，不带确认的那一次没有记。
        self.assertEqual(marks, [("OA-001", 1, "接受", ["已读"]), ("OA-002", 1, "接受", ["已读"])])
        # 确认之后第二页不再待核实（与产品同一个算法）。
        facts, problem = lamps.overall_facts(sim / "库副本" / taskdb.DB_NAME, task["任务编号"])
        self.assertEqual(problem, "")
        self.assertEqual({key: value["pending_verification"] for key, value in facts["verification"].items()}, {"OA-001": False, "OA-002": False})
        self.assertEqual(lamps.viewed_items(task), {"OA-001", "OA-002"})
        # 用户 agent 看到的界面：提纲里第二页写着等确认；打开它时写明是哪一处、怎样确认。
        seen = "\n".join(json.dumps(r["请求体"]["messages"][-1], ensure_ascii=False) for r in fake.requests()
                         if FIRST_WAKE in json.dumps(r["请求体"]["messages"], ensure_ascii=False))
        self.assertIn("OA-001「借书」〔流程〕：你还没看过现在这一版", seen)
        self.assertIn("OA-002「预约保留期」〔概念〕：有 1 处是助手补的，等你确认", seen)
        self.assertIn("这一页有 1 处是助手补的，还没有确认：「它是什么」。", seen)
        self.assertIn("（你正在看它现在的内容，并确认了助手补的 1 处）", seen)
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
