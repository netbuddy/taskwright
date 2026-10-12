"""一次评测从核读材料走到完成任务：真的后端、真的 pi、假模型端点，用户 agent 自己看主题页、点「开始写条目」。

只在产品有了工作的阶段之后才跑（判据是 agent/src/lib/stage.ts 在不在）：有了阶段，助手写条目之前要有一页用户看过的主题，
往前进入下一个阶段都由用户在助手提议的卡片上点，助手自己只能退回。走法：

1. 用户 agent 说要整理需求；助手立一页主题，发「开始写条目」的卡片并点名这一页。
2. 用户 agent 打开这一页，点「开始写条目」；助手写一个依据这一页的用例，发起评审（评审者由假模型回「没有发现」），
   发「进入评审确认」的卡片。
3. 用户 agent 点「进入评审确认」；助手请用户确认这个用例。
4. 用户 agent 打开用例，点「这几条都看过了」；助手发是否完成的卡片。
5. 用户 agent 点「已完成，提交交付物」；助手完成任务（完成任务要在评审确认阶段，所以第 3 步少不了）。
6. 用户 agent 看到任务完成，表示目标达成。

助手的回答按先后写成一串（这一例只跑一遍）；用户 agent 与评审者的回答写成规则，靠请求里的话认。本机没有 pi 或 node 时跳过。
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import taskdb

from sim import evals
from sim.tests.test_evals import EXAMPLES, REPO, free_port, intent, quiet, source
from sim.tests.test_user_agent_round import ENV_AGENT_DIR, FakeModel
from sim.tests.test_view_pages import look, respond, user

HAS_STAGES = (REPO / "agent" / "src" / "lib" / "stage.ts").is_file()

FIRST_WORDS = "帮我把这份需求整理成规格说明。"
QUOTE = "读者凭借书证借书，每本书可以续借一次。"
PAGE = {"op": "add", "collection": "总体分析", "sources": [source(QUOTE)],
        "fields": {"标题": "借书", "它是什么": QUOTE, "例子": ["读者凭借书证借书", "例外：名下有逾期未还图书的读者不能续借"], "标签": ["流程"], "状态": "在用"}}
USE_CASE = {"op": "add", "collection": "功能用例", "sources": [{"kind": "条目", "locator": "OA-001", "excerpt": QUOTE}],
            "fields": {"用例名称": "借书", "用例功能": "读者凭借书证借书。", "参与者": ["读者"], "基本流程": ["读者出示借书证", "系统登记借出的图书"]}}
START_CARD = {"kind": "choose", "text": "这一页你看过之后，现在开始写条目吗？", "items": [{"item_id": "OA-001", "revision_no": 1}],
              "options": [{"key": "start_items", "text": "开始写条目"}, {"key": "continue_reading", "text": "再核读一遍"}]}
REVIEW_CARD = {"kind": "choose", "text": "用例写好了，评审也通过了。现在进入评审确认吗？", "items": [{"item_id": "UC-001", "revision_no": 2}],
               "options": [{"key": "enter_review", "text": "进入评审确认"}, {"key": "continue_writing", "text": "继续写条目"}]}
CONFIRM_CARD = {"kind": "confirm", "text": "请看一下这个用例。", "items": [{"item_id": "UC-001", "revision_no": 2}]}
DONE_CARD = {"kind": "choose", "text": "功能用例一共 1 个条目，已经评审通过，你也看过了。这个任务是否已经完成？提交之后交付物不能再改，仍然可以生成文档。",
             "options": [{"key": "complete", "text": "已完成，提交交付物"}, {"key": "continue", "text": "还没完成，继续修改"}]}


def tool(name: str, arguments: dict) -> dict:
    return {"tool_calls": [{"name": name, "arguments": arguments}]}


def say(text: str, act: dict | None = None, **move) -> dict:
    return tool("reply", {"informs": [], "act": act, "text": text, **move})


SCRIPT = {
    "rules": [
        {"when": {"any_contains": "你是评审者"}, "reply": {"text": json.dumps({"发现": []}, ensure_ascii=False)}},
        # 用户 agent：按看到的东西决定下一步。先后有讲究：每条只认它那一步独有的话。
        user(respond(click="已完成，提交交付物"), last_role="tool", last_contains="选项 complete"),
        user(respond(done=True), last_role="tool", last_contains="任务已经完成"),
        user(respond(click="这几条都看过了"), last_role="tool", last_contains="UC-001「借书」，集合"),
        user(look(item_id="UC-001"), last_role="tool", last_contains="【卡片：请确认】"),
        user(respond(click="进入评审确认"), last_role="tool", last_contains="选项 enter_review"),
        user(respond(click="开始写条目"), last_role="tool", last_contains="OA-001「借书」，集合"),
        user(look(item_id="OA-001"), last_role="tool", last_contains="选项 start_items"),
        user(respond(text=FIRST_WORDS), last_role="tool"),
        user(look(), last_role="user"),
    ],
    # 助手：按先后一条一条来。
    "sequence": [
        {"text": intent("request", "把需求整理成规格说明"), **tool("save_revision", {"operations": [PAGE]})},
        say("材料读完了，我立了一页主题。你看过之后，现在开始写条目吗？", START_CARD),
        tool("save_revision", {"operations": [USE_CASE]}),
        tool("request_review", {}),
        say("写好了一个用例，评审通过了。现在进入评审确认吗？", REVIEW_CARD),
        say("请你看一下这个用例。", CONFIRM_CARD),
        say("完成条件都满足了，请在卡片上选。", DONE_CARD),
        tool("complete_task", {}),
        say("任务已经完成。"),
    ],
    "default": {"text": "好的。"},
}


@unittest.skipUnless(HAS_STAGES, "产品还没有工作的阶段")
@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class StageRunTest(unittest.TestCase):
    def test_用户_agent_看过主题页点开始写条目_一次评测从核读走到完成(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-stage-it-"))
        sims_root = root / "sims"
        fake = FakeModel(SCRIPT, root)
        fake.start()
        saved = dict(os.environ)
        try:
            for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                os.environ.pop(name, None)
            os.environ.update({ENV_AGENT_DIR: str(fake.agent_dir), "PI_OFFLINE": "1", "XDG_DATA_HOME": str(root / "data"),
                               "TASKWRIGHT_SETTINGS_FILE": str(root / "settings.json")})
            code, printed = quiet(["run", "--persona", str(REPO / "sim" / "personas" / "library-short.json"),
                                   "--expect", str(REPO / "sim" / "expectations" / "library-short.json"), "--materials-dir", str(EXAMPLES),
                                   "--port", str(free_port()), "--profile", "fake", "--user-model", "fake/fake-model",
                                   "--sim-root", str(sims_root), "--max-rounds", "8", "--repeat", "1", "--label", "走到完成"])
        finally:
            fake.stop()
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(code, 0, printed)
        sim = sims_root / "sim-001"
        record = json.loads((sim / "record.json").read_text(encoding="utf-8"))
        result = json.loads((sim / evals.RUN_FILE).read_text(encoding="utf-8"))
        summary = json.loads((sim / "判定摘要.json").read_text(encoding="utf-8"))
        self.assertEqual((record["停止原因"], len(record["轮"]), result["出错"]), ("用户 agent 表示目标达成", 6, ""))
        # 用户 agent 每一轮做了什么：第 2 轮打开主题页再点「开始写条目」，第 3 轮点「进入评审确认」，第 4 轮打开用例再点「这几条都看过了」，第 5 轮点完成。
        turns = [(t["用户 agent"]["looks"], (t["用户 agent"]["respond"]["sent"] or {}).get("card", {}).get("choice"),
                  (t["用户 agent"]["respond"]["sent"] or {}).get("kind")) for t in record["轮"]]
        self.assertEqual(turns, [([None], None, None), ([None, "OA-001"], "start_items", None), ([None], "enter_review", None),
                                 ([None, "UC-001"], None, "mark_viewed"), ([None], "complete", None), ([None], None, None)])
        # 助手没有被拦过一次：用例是在用户点了「开始写条目」之后才写的，完成任务是在用户点了「进入评审确认」之后才做的。
        self.assertEqual(summary["被工具拒绝次数"], 0)
        # 第一层三项都过，其中点「开始写条目」之前打开过卡片点名的那一页。
        self.assertEqual(summary["第一层"], {"没有在执行者没问的时候主动说出隐藏事实（查全部轮次）": True, "点「这几条都看过了」之前在同一轮里看过该条目的详情": True,
                                           "点「开始写条目」之前打开过卡片点名的主题页": True})
        self.assertEqual(summary["第一层说明"]["点「开始写条目」之前打开过卡片点名的主题页"], "一共点了 1 次「开始写条目」。")
        # 库里：任务已完成；两次移动都是用户在卡片上点的，从核读材料直接进入写条目，再进入评审确认。
        task = taskdb.read_workspace(sim / "库副本")["任务"][0]
        self.assertEqual(task["状态"], "已完成")
        with sqlite3.connect(sim / "库副本" / taskdb.DB_NAME) as db:
            moves = db.execute("SELECT actor, from_stage, stage, reason FROM stage_record ORDER BY record_id").fetchall()
        self.assertEqual(moves, [("user", "reading", "writing", "用户在卡片上选了「开始写条目」"),
                                 ("user", "writing", "reviewing", "用户在卡片上选了「进入评审确认」")])
        # 灯：写条目与评审确认两段都过了；这份演示脚本从核读材料直接进入写条目，没有画图，流程页没有流程图那一盏不通过。
        states = {x["键"]: x["结果"] for x in result["灯"]}
        self.assertEqual(states, {
            "materials_cited": "通过", "tagged_pages_no_open_questions": "通过", "decisions_have_goal": "不适用",
            "roles_in_context_and_use_cases": "不适用", "concepts_related_in_class": "不适用", "flows_have_flowchart_with_branch": "未通过",
            "stateful_concepts_have_state": "不适用", "no_duplicate_titles": "通过", "no_untagged_pages": "通过", "rules_no_conflict": "不适用",
            "flows_backed_by_use_cases": "通过", "basis_pages_viewed": "通过", "basis_diagrams_viewed": "不适用", "no_pending_items": "通过",
            "reviews_no_open_findings": "通过", "completion_met": "通过"})
        hits = [(x["部分"], x["组"][0]) for x in result["至少应有"] if x["命中"]]
        self.assertEqual(hits, [("总体分析·流程页", "借书"), ("例外·借书", "有逾期"), ("功能用例", "借书")])
        # 助手问过的问题按轮对上：第 1 轮提议开始写条目，第 2 轮提议进入评审确认，第 3 轮请确认用例，第 4 轮问是否完成。
        self.assertEqual([(q["轮"], q["功能"]) for q in result["助手问过的问题"]["问题"]], [(1, "请选择"), (2, "请选择"), (3, "请确认"), (4, "请选择")])
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
