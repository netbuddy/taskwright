"""双方连续几轮没有进展就停这一遍：判法的单元测试，与一次假模型的评测（真的后端、真的 pi、假模型端点）。

评测那一例里，助手第一轮立一页主题、发一张问答卡片，之后每轮只回一句不带卡片的话；用户 agent 每轮也只回一句，以「先停在这里」开头
（任务类型有分析提纲时核读的回复要带卡片，用户叫停时除外）。第 1 轮有修订，算有进展；
第 2 到 5 轮什么都没有，连续 4 轮，停在第 5 轮。判定报告与评测汇总都单独标出这一遍没有做完。
另一例把 --stall-rounds 设成 0：同样的走法一直跑到轮数上限。本机没有 pi 或 node 时这两例跳过。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from sim import run
from sim.run import STALL_ROUNDS, build_parser, clicked_card, made_progress, stall_reason
from sim.tests.test_evals import EXAMPLES, REPO, intent, quiet
from sim.tests.test_stage_run import FIRST_WORDS, PAGE, say, tool
from sim.tests.test_user_agent_round import ENV_AGENT_DIR, FakeModel
from sim.tests.test_view_pages import look, respond, user

WAIT = "好的，等你问清楚后再继续。"
ROUNDS = 8
SCRIPT = {
    "rules": [
        # 用户 agent：看到助手说等它，就也回一句等；第一轮说想做的事。
        user(respond(text="先停在这里，等我问清楚再来。"), last_role="tool", last_contains="等你问清楚"),
        user(respond(text=FIRST_WORDS), last_role="tool"),
        user(look(), last_role="user"),
        # 助手：用户说等，它也只回一句不带卡片的话。用户打字说的话，助手回复之前要先写下对这句话的理解。
        {"when": {"last_role": "user", "last_contains": "等我问清楚"}, "reply": {"text": intent("inform", "等问清楚再来"), **say(WAIT)}},
    ],
    # 助手第一轮：立一页主题，再发一张问答卡片。
    "sequence": [{"text": intent("request", "把需求整理成规格说明"), **tool("save_revision", {"operations": [PAGE]})},
                 say("我立了一页主题。智能推荐这件事" + WAIT, {"kind": "choose", "topic": "借书 · 缺口 1（材料没写）", "text": "为了写清借书一页：材料没说要不要智能推荐。这一期要做吗？",
                                                        "options": [{"key": "a", "text": "这一期做", "reason": "requirements.md 第 4 段提到。"}, {"key": "b", "text": "以后再做", "reason": "同类系统通常放在二期。"}]})],
    "default": {"text": "好的。"},
}


def reply_event(act: dict | None, **more) -> dict:
    return {"event": "assistant_reply", "data": {"text": "好的。", "act": act, **more}}


class ProgressTest(unittest.TestCase):
    def test_四样有一样就算有进展_打开条目或图记下的已读不算(self):
        typed = {"route": "message", "sent": {"text": "好，等我问清楚再来。"}}
        self.assertFalse(made_progress([], typed))
        self.assertFalse(made_progress([reply_event(None), {"event": "work_ended", "data": {}}, {"event": "item_viewed", "data": {}},
                                        {"event": "diagram_viewed", "data": {}}, {"event": "executor_state", "data": {"state": "idle"}}], typed))
        for name in ("deliverable_changed", "diagram_changed", "activity_started", "stage_proposed", "task_changed"):
            self.assertTrue(made_progress([{"event": name, "data": {}}], typed), name)
        card = {"kind": "ask", "text": "借期多长？", "scope": "general"}
        self.assertTrue(made_progress([reply_event(card)], typed))
        # 连续被拒之后放行的纯文字回复带着卡片的内容，界面上不画卡片：不算。
        self.assertFalse(made_progress([reply_event(card, degraded=True)], typed))

    def test_开场替用户在开展一项活动里选哪一项_不引出助手运行的操作有哪些(self):
        from sim.run import OPENING_DEFAULT, SILENT_ACTIONS, expects_executor, opening_choice
        launch = {"current": None,
                  "flows": [{"activity": "reading", "in_flow": True, "label": "启动需求分析", "enabled": True, "state": "从核读材料开始"}],
                  "activities": [{"activity": "clarifying", "in_flow": False, "label": "澄清", "enabled": True, "state": "可以开展"},
                                 {"activity": "writing", "in_flow": False, "label": "写条目", "enabled": False, "state": "业务说明还没有页"}],
                  "later": []}
        self.assertEqual(OPENING_DEFAULT, "启动需求分析")
        # 画像不写「开场」：启动需求分析；写单独开展哪一项就选哪一项；写不选就不选。
        self.assertEqual(opening_choice(launch, ""), (launch["flows"][0], "选了「启动需求分析」"))
        self.assertEqual(opening_choice(launch, "单独开展：澄清"), (launch["activities"][0], "选了「澄清」"))
        self.assertEqual(opening_choice(launch, "不选"), (None, "画像写的是不选，任务从空闲开始"))
        # 找不到、现在不能选、任务状况里没有这一节：都不选，说明里写原因。
        self.assertEqual(opening_choice(launch, "单独开展：写条目"), (None, "「单独开展：写条目」现在不能选（业务说明还没有页），没有选"))
        self.assertEqual(opening_choice(launch, "需求变更"), (None, "「开展一项活动」里没有「需求变更」这一项，没有选"))
        self.assertEqual(opening_choice(None, ""), (None, "任务状况里没有「开展一项活动」这一节，没有选"))
        # 流程走过一段之后那一项写「继续需求分析（从某阶段接着）」：写到「继续需求分析」就认。
        resume = {**launch, "flows": [{"activity": "writing", "in_flow": True, "label": "继续需求分析（从写条目接着）", "enabled": True, "state": "可以开展"}]}
        self.assertEqual(opening_choice(resume, "继续需求分析")[0], resume["flows"][0])
        # 在「开展一项活动」里选一项、选「继续本阶段」都不引出助手的运行；不选什么都不发，也不等助手。
        self.assertEqual(SILENT_ACTIONS, ("continue_stage", "start_activity"))
        self.assertFalse(expects_executor({"route": "action", "sent": {"kind": "start_activity"}}))
        self.assertFalse(expects_executor({"route": "none", "sent": None}))
        self.assertTrue(expects_executor({"route": "message", "sent": {"text": "开始吧"}}))

    def test_用户点了卡片上的按钮算有进展_只打字不算(self):
        self.assertTrue(clicked_card({"route": "message", "sent": {"text": "我选：已解决", "origin": "card_choice", "card": {"choice": "resolved"}}}))
        self.assertTrue(clicked_card({"route": "action", "sent": {"kind": "mark_viewed", "notify_executor": True, "targets": []}}))
        self.assertTrue(clicked_card({"route": "action", "sent": {"kind": "continue_stage", "targets": []}}))
        self.assertFalse(clicked_card({"route": "message", "sent": {"text": "好。"}}))
        self.assertFalse(clicked_card({"route": "none", "sent": None, "done": True}))
        self.assertFalse(clicked_card(None))
        self.assertTrue(made_progress([], {"route": "action", "sent": {"kind": "keep_pending", "targets": []}}))

    def test_参数缺省四轮_停止原因写明连续几轮(self):
        self.assertEqual(STALL_ROUNDS, 4)
        self.assertEqual(build_parser().parse_args(["--persona", "p.json"]).stall_rounds, 4)
        self.assertEqual(build_parser().parse_args(["--persona", "p.json", "--stall-rounds", "0"]).stall_rounds, 0)
        self.assertEqual(stall_reason(4), "双方连续 4 轮没有进展：没有新的修订、卡片、阶段移动，模拟用户也没有点卡片")


@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class StallRunTest(unittest.TestCase):
    def play(self, root: Path, argv: list[str], evals_run: bool):
        fake = FakeModel(SCRIPT, root)
        fake.start()
        saved = dict(os.environ)
        try:
            for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                os.environ.pop(name, None)
            os.environ.update({ENV_AGENT_DIR: str(fake.agent_dir), "PI_OFFLINE": "1", "XDG_DATA_HOME": str(root / "data"),
                               "TASKWRIGHT_SETTINGS_FILE": str(root / "settings.json")})
            common = ["--persona", str(REPO / "sim" / "personas" / "library-short.json"), "--materials-dir", str(EXAMPLES),
                      "--port", "0", "--profile", "fake", "--user-model", "fake/fake-model", "--sim-root", str(root / "sims"),
                      "--max-rounds", str(ROUNDS), *argv]
            if evals_run:
                return quiet(["run", "--expect", str(REPO / "sim" / "expectations" / "library-short.json"), "--repeat", "1", "--label", "互相等", *common])[0]
            return run.main(common)
        finally:
            fake.stop()
            os.environ.clear()
            os.environ.update(saved)

    def test_连续四轮没有进展就停_判定报告与评测汇总单独标出(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-stall-it-"))
        self.assertEqual(self.play(root, [], evals_run=True), 0)
        sim = root / "sims" / "sim-001"
        record = json.loads((sim / "record.json").read_text(encoding="utf-8"))
        self.assertEqual(record["停止原因"], stall_reason(4))
        self.assertEqual(record["没有进展而停"], {"连续轮数": 4, "从第几轮起": 2})
        self.assertEqual([turn["有进展"] for turn in record["轮"]], [True, False, False, False, False])
        summary = json.loads((sim / "判定摘要.json").read_text(encoding="utf-8"))
        self.assertIs(summary["没有进展而停"], True)
        self.assertIn("- **这一遍没有做完：** 从第 2 轮起双方连续 4 轮没有进展", (sim / "判定报告.md").read_text(encoding="utf-8"))
        one = json.loads((sim / "评测.json").read_text(encoding="utf-8"))
        self.assertIs(one["没有进展而停"], True)
        total = json.loads((root / "sims" / "评测汇总_互相等.json").read_text(encoding="utf-8"))
        self.assertEqual((total["没有进展而停的遍数"], [r["没有进展而停"] for r in total["各遍"]]), (1, [True]))
        self.assertIn("- 有 1 遍因为双方没有进展而停，没有做完：第 1 遍。", (root / "sims" / "评测汇总_互相等.md").read_text(encoding="utf-8"))
        shutil.rmtree(root, ignore_errors=True)

    def test_写零不查_同样的走法一直跑到轮数上限(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-stall-off-it-"))
        self.assertEqual(self.play(root, ["--stall-rounds", "0"], evals_run=False), 0)
        sim = root / "sims" / "sim-001"
        record = json.loads((sim / "record.json").read_text(encoding="utf-8"))
        self.assertEqual((record["停止原因"], len(record["轮"])), (f"到了轮数上限 {ROUNDS}", ROUNDS))
        self.assertNotIn("没有进展而停", record)
        self.assertIs(json.loads((sim / "判定摘要.json").read_text(encoding="utf-8"))["没有进展而停"], False)
        self.assertNotIn("这一遍没有做完", (sim / "判定报告.md").read_text(encoding="utf-8"))
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
