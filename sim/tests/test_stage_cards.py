"""一次两遍的评测，用户 agent 在助手提议进入下一段的五张卡片上依次点进入，在编写文档阶段点「看过了，生成文档」，从核读材料走到完成任务：
真的后端、真的 pi、假模型端点。

与 test_stage_run.py 的那一例（从核读材料直接点「开始写条目」）不同，这里每一段都走到：

1. 用户 agent 说要整理需求；助手立一页主题，发「进入澄清」的卡片并点名这一页。
2. 用户 agent 打开这一页，点「进入澄清」；助手发「进入整理建模」的卡片，没有点名条目。
3. 用户 agent 点「进入整理建模」；助手发「开始写条目」的卡片，点名同一页（用户 agent 在第 2 轮打开过）。
4. 用户 agent 点「开始写条目」；助手写一个依据这一页的用例，发起评审（评审者由假模型回「没有发现」），发「进入评审确认」的卡片并点名用例。
5. 用户 agent 打开用例，点「进入评审确认」；助手请用户确认这个用例。
6. 用户 agent 打开用例，点「这几条都看过了」；助手发「进入编写文档」的卡片。
7. 用户 agent 点「进入编写文档」；助手给业务流程这一章补一页导语，发请过目的卡片并点名这一页。
8. 用户 agent 打开导语页，点「看过了，生成文档」：只留一条界面操作通知、把这一页记为看过，助手不因此运行。
9. 用户 agent 说文档可以了，请完成任务；助手发是否完成的卡片。
10. 用户 agent 点「已完成，发布版本」；助手发布第 1 版。
11. 用户 agent 看到任务完成，表示目标达成。

两遍用同一个假模型端点：助手的回答按先后写成一串，重复两次；用户 agent 与评审者的回答写成规则，靠请求里的话认，两遍通用。
核对的是不随灯的增删而变的几样：每遍的点击与阶段记录、第一层三项、汇总里灯按阶段分组、提示词版本与它的文件清单。
只在产品有了工作的阶段之后才跑；本机没有 pi 或 node 时跳过。
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from taskwright_observatory import evals as eval_files, taskdb

from sim import evals, judge, lamps
from sim.tests.test_evals import EXAMPLES, REPO, intent, quiet
from sim.tests.test_stage_run import CONFIRM_CARD, DONE_CARD, FIRST_WORDS, HAS_STAGES, PAGE, REVIEW_CARD, USE_CASE, say, tool
from sim.tests.test_user_agent_round import ENV_AGENT_DIR, FakeModel
from sim.tests.test_view_pages import look, respond, user

PAGE_REF = [{"item_id": "OA-001", "revision_no": 1}]
CLARIFY_CARD = {"kind": "choose", "text": "材料读完了，立了一页主题。你看过之后，进入澄清吗？", "items": PAGE_REF,
                "options": [{"key": "enter_clarify", "text": "进入澄清"}, {"key": "continue_reading", "text": "再核读一遍"}]}
MODEL_CARD = {"kind": "choose", "text": "要问的都问完了。进入整理建模吗？", "items": [],
              "options": [{"key": "enter_consolidate", "text": "进入整理建模"}, {"key": "continue_clarify", "text": "继续澄清"}]}
START_CARD = {"kind": "choose", "text": "这一页整理好了。现在开始写条目吗？", "items": PAGE_REF,
              "options": [{"key": "start_items", "text": "开始写条目"}, {"key": "continue_consolidate", "text": "再整理一遍"}]}
DOCUMENT_CARD = {"kind": "choose", "text": "条目都确认过了。进入编写文档，把各章的导语补上吗？", "items": [],
                 "options": [{"key": "enter_document", "text": "进入编写文档"}, {"key": "continue_review", "text": "再看看条目"}]}
#: 业务流程这一章的导语页：不贴标签，「导语所属章」写章名；助手补写的，来源种类是助手补充。主题页、用例各占一次修订，它是第 3 次。
INTRO = {"op": "add", "collection": "总体分析", "sources": [{"kind": "助手补充", "excerpt": "据 OA-001 与 UC-001 概括。"}],
         "fields": {"标题": "业务流程导语", "导语所属章": "业务流程", "它是什么": "这一章讲读者怎样借书。", "状态": "在用"}}
READ_CARD = {"kind": "choose", "text": "补写了业务流程这一章的导语，请过目。看过之后在条目区按「生成文档」。", "items": [{"item_id": "OA-002", "revision_no": 3}],
             "options": [{"key": "document_reviewed", "text": "看过了，生成文档"}, {"key": "document_revise", "text": "需要修改"}]}
DONE_WORDS = "文档可以了，请完成任务。"

ONE_PASS = [
    {"text": intent("request", "把需求整理成规格说明"), **tool("save_revision", {"operations": [PAGE]})},
    say("材料读完了，我立了一页主题。", CLARIFY_CARD),
    say("这份材料没有要再问的。", MODEL_CARD),
    say("这一页已经有例外的例子，不用再补。", START_CARD),
    tool("save_revision", {"operations": [USE_CASE]}),
    tool("request_review", {}),
    say("写好了一个用例，评审通过了。", REVIEW_CARD),
    say("请你看一下这个用例。", CONFIRM_CARD),
    say("条目你都看过了。", DOCUMENT_CARD),
    tool("save_revision", {"operations": [INTRO]}),
    say("补写了业务流程这一章的导语。", READ_CARD),
    # 这一句是答用户自己打的那句话，要先写下对它的理解。
    {"text": intent("request", "文档可以了，完成任务"), **say("完成条件都满足了，请在卡片上选。", DONE_CARD)},
    tool("publish_version", {}),
    say("任务已经完成。"),
]
PASSES = 2
SCRIPT = {
    "rules": [
        {"when": {"any_contains": "你是评审者"}, "reply": {"text": json.dumps({"发现": []}, ensure_ascii=False)}},
        # 用户 agent：按看到的东西决定下一步。先后有讲究：每条只认它那一步独有的话。
        user(respond(click="已完成，发布版本"), last_role="tool", last_contains="选项 complete"),
        user(respond(done=True), last_role="tool", last_contains="任务已经完成"),
        # 编写文档阶段：先打开导语页，再点「看过了，生成文档」；点了之后助手不说话，下一次看到的是界面记下的那条操作，这时请助手完成任务。
        user(respond(text=DONE_WORDS), last_role="tool", last_contains="选了「看过了，生成文档」"),
        user(respond(click="看过了，生成文档"), last_role="tool", last_contains="OA-002「业务流程导语」，集合"),
        user(look(item_id="OA-002"), last_role="tool", last_contains="选项 document_reviewed"),
        user(respond(click="进入编写文档"), last_role="tool", last_contains="选项 enter_document"),
        # 打开用例之后点哪一个，看之前见没见过请确认的卡片：见过就是在确认，没见过就是在「进入评审确认」的卡片上。
        {"when": {"any_contains": "【卡片：请确认】", "last_role": "tool", "last_contains": "UC-001「借书」，集合"}, "reply": respond(click="这几条都看过了")},
        user(respond(click="进入评审确认"), last_role="tool", last_contains="UC-001「借书」，集合"),
        user(look(item_id="UC-001"), last_role="tool", last_contains="【卡片：请确认】"),
        user(look(item_id="UC-001"), last_role="tool", last_contains="选项 enter_review"),
        user(respond(click="开始写条目"), last_role="tool", last_contains="选项 start_items"),
        user(respond(click="进入整理建模"), last_role="tool", last_contains="选项 enter_consolidate"),
        user(respond(click="进入澄清"), last_role="tool", last_contains="OA-001「借书」，集合"),
        user(look(item_id="OA-001"), last_role="tool", last_contains="选项 enter_clarify"),
        user(respond(text=FIRST_WORDS), last_role="tool"),
        user(look(), last_role="user"),
    ],
    "sequence": ONE_PASS * PASSES,
    "default": {"text": "好的。"},
}
LABEL = "五张卡片"


@unittest.skipUnless(HAS_STAGES, "产品还没有工作的阶段")
@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class StageCardsTest(unittest.TestCase):
    def test_两遍都经五张卡片从核读走到编写文档再完成_汇总按阶段分组并列出提示词文件(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-cards-it-"))
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
                                   "--port", "0", "--profile", "fake", "--user-model", "fake/fake-model",
                                   "--sim-root", str(sims_root), "--max-rounds", "13", "--repeat", str(PASSES), "--label", LABEL])
        finally:
            fake.stop()
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(code, 0, printed)
        for name in ("sim-001", "sim-002"):
            sim = sims_root / name
            record = json.loads((sim / "record.json").read_text(encoding="utf-8"))
            result = json.loads((sim / evals.RUN_FILE).read_text(encoding="utf-8"))
            first = json.loads((sim / "判定摘要.json").read_text(encoding="utf-8"))
            self.assertEqual((record["停止原因"], len(record["轮"]), result["出错"]), ("用户 agent 表示目标达成", 11, ""), name)
            # 演练记录里五张卡片的点击都记着键；「开始写条目」那张卡片点名的页是第 2 轮打开的，「进入评审确认」之前打开了用例；
            # 第 8 轮打开导语页之后点「看过了，生成文档」，发的是界面操作 continue_stage，紧接着把这一页标为已读。
            turns = [(t["用户 agent"]["looks"], (t["用户 agent"]["respond"]["sent"] or {}).get("card", {}).get("choice"),
                      (t["用户 agent"]["respond"]["sent"] or {}).get("kind")) for t in record["轮"]]
            self.assertEqual(turns, [([None], None, None), ([None, "OA-001"], "enter_clarify", None), ([None], "enter_consolidate", None),
                                     ([None], "start_items", None), ([None, "UC-001"], "enter_review", None), ([None, "UC-001"], None, "mark_viewed"),
                                     ([None], "enter_document", None), ([None, "OA-002"], None, "continue_stage"), ([None], None, None),
                                     ([None], "complete", None), ([None], None, None)])
            reviewed = record["轮"][7]["用户 agent"]["respond"]
            self.assertEqual((reviewed["route"], reviewed["sent"]["fields"]["option_key"], reviewed["sent"]["notify_executor"]), ("action", "document_reviewed", False))
            self.assertEqual((reviewed["then"]["kind"], reviewed["then"]["targets"], reviewed["then"]["notify_executor"]),
                             ("mark_viewed", [{"item_id": "OA-002", "base_revision": 3}], False))
            # 点了之后助手没有运行：这一轮没有助手的回复；下一轮用户 agent 自己说了那句话。
            self.assertEqual((record["轮"][7].get("执行者") or {}).get("replies") or [], [])
            self.assertEqual(record["轮"][8]["用户 agent"]["respond"]["sent"]["text"], DONE_WORDS)
            # 库里五次移动都是用户在卡片上点的，一段接一段；发布了第 1 版，任务照常进行中，助手没有一次调用被拦。
            with sqlite3.connect(sim / "库副本" / taskdb.DB_NAME) as db:
                moves = db.execute(
                    "SELECT e.actor, json_extract(e.payload, '$.from'), COALESCE(json_extract(e.payload, '$.node'), json_extract(e.payload, '$.activity')), "
                    "json_extract(e.payload, '$.reason') FROM event e WHERE e.name IN ('ACTIVITY_STARTED', 'ACTIVITY_NODE_ENTERED') ORDER BY e.seq").fetchall()
            # 读的是启动与换站的事件。第一条是开场时驾驭程序替用户启动的需求分析：从核读材料开始；后面每一条是这个工作项换了一站。
            self.assertEqual(moves, [("user", None, "reading", ""),
                                     ("user", "reading", "clarifying", "用户在卡片上选了「进入澄清」"), ("user", "clarifying", "modeling", "用户在卡片上选了「进入整理建模」"),
                                     ("user", "modeling", "writing", "用户在卡片上选了「开始写条目」"), ("user", "writing", "reviewing", "用户在卡片上选了「进入评审确认」"),
                                     ("user", "reviewing", "document", "用户在卡片上选了「进入编写文档」")])
            self.assertEqual((taskdb.read_workspace(sim / "库副本")["任务"][0]["状态"], first["被工具拒绝次数"]), ("进行中", 0))
            with sqlite3.connect(sim / "库副本" / taskdb.DB_NAME) as db:
                self.assertEqual(db.execute("SELECT version_no, actor FROM version_record").fetchall(), [(1, "executor")])
            # 导语页记着用户看过它（第 3 次修订）。
            self.assertIn(("OA-002", 3), judge.viewed_marks(sim / "库副本"))
            # 第一层三项都过，第三项的说明写出五次点击。
            self.assertEqual(set(first["第一层"].values()), {True})
            self.assertEqual(first["第一层说明"][judge.ENTER_CHECK], "一共点了 5 次进入下一段的卡片：第 2 轮「进入澄清」、第 3 轮「进入整理建模」、"
                             "第 4 轮「开始写条目」、第 5 轮「进入评审确认」、第 7 轮「进入编写文档」。")
            states = {x["键"]: x["结果"] for x in result["灯"]}
            self.assertEqual((states["materials_cited"], states["completion_met"]), ("通过", "通过"))
            # 编写文档的灯：只有业务流程这一章有内容，它有了导语。
            self.assertEqual(states["chapters_have_intro"], "通过")
        summary = json.loads(evals.summary_path(sims_root, LABEL, "json").read_text(encoding="utf-8"))
        text = evals.summary_path(sims_root, LABEL, "md").read_text(encoding="utf-8")
        # 汇总里灯按阶段分组：六个阶段都在，先后与灯表相同，每组有本组通过率；这次没有哪盏灯落在「其他」。
        stages = [one["阶段"] for one in summary["灯按阶段"]]
        self.assertEqual(stages, list(dict.fromkeys(stage for stage, _key, _text in lamps.LAMPS)))
        self.assertEqual((sum(one["灯数"] for one in summary["灯按阶段"]), len(summary["灯"])), (len(lamps.LAMPS), len(lamps.LAMPS)))
        by_stage = {one["阶段"]: one for one in summary["灯按阶段"]}
        self.assertEqual((by_stage["核读材料"]["通过率"], by_stage["评审确认"]["通过率"]), (1.0, 1.0))
        self.assertEqual(stages[-1], "编写文档")
        self.assertIn("| 核读材料 | 1 | 100% |", text)
        # 提示词版本：两遍相同；文件清单里有代码仓里按阶段的说明与任务目录里任务类型的说明，没有早先的平台 skill；任务目录 docs 下的不在。
        self.assertRegex(summary["提示词版本"], r"^[0-9a-f]{12}$")
        self.assertEqual(summary["各遍提示词版本"], [summary["提示词版本"]] * PASSES)
        listed = {one["路径"]: one for one in summary["提示词文件"]}
        on_disk = sorted(f"agent/prompts/stages/{p.name}" for p in (REPO / "agent" / "prompts" / "stages").iterdir() if p.is_file())
        self.assertEqual(sorted(path for path in listed if path.startswith("agent/prompts/stages/")), on_disk)
        for path, where in (("agent/prompts/stages/common.md", "代码仓"), ("agent/prompts/stages/system.md", "代码仓"),
                            (".pi/skills/srs-authoring/SKILL.md", "任务目录"), (".pi/skills/srs-authoring/stages/reading.md", "任务目录")):
            self.assertEqual((listed[path]["来自"], len(listed[path]["摘要值"])), (where, 16), path)
        self.assertFalse([path for path in listed if path.startswith("docs/") or path.startswith("/") or path.startswith("agent/prompts/skills/")])
        self.assertIn(f"- 提示词版本：{summary['提示词版本']}（每份文件见最后的「提示词」一节）", text)
        self.assertIn(f"| agent/prompts/stages/common.md | 代码仓 | {listed['agent/prompts/stages/common.md']['字节数']} | {listed['agent/prompts/stages/common.md']['摘要值']} |", text)
        self.assertEqual(evals.listed(sims_root)[0]["提示词版本"], summary["提示词版本"])
        # 这次评测自己与自己对照：提示词是同一版，没有变了的文件。
        compared = eval_files.compare(sims_root, LABEL, LABEL)["提示词"]
        self.assertEqual((compared["相同"], compared["变了的文件"], compared["说明"]), (True, [], "两次用的是同一版提示词。"))
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
