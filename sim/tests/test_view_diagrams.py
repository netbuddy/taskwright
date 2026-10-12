"""用户 agent 看图：真的后端、真的 pi、假模型端点，走一次到整理建模的演练，再看库里记下了什么。

看图与网页走同一条接口（actions 的 mark_diagram_viewed）：带着图的编号看界面，就取这张图的详情写成文字，并记一次看过。

脚本里助手立一页主题，经两张卡片进入整理建模，画一张以这一页为来源的流程图，然后请用户看。用户 agent 在界面上看到
「助手画的图 1 张」那一段，带着图的编号再看一次，说一句并表示目标达成。只在产品有了工作的阶段之后才跑；本机没有 pi 或 node 时跳过。
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

from sim import run
from sim.run import FIRST_WAKE, user_turn
from sim.tests.test_evals import EXAMPLES, REPO, free_port, intent
from sim.tests.test_stage_cards import CLARIFY_CARD, MODEL_CARD
from sim.tests.test_stage_run import FIRST_WORDS, HAS_STAGES, PAGE, say, tool
from sim.tests.test_user_agent_round import ENV_AGENT_DIR, FakeModel
from sim.tests.test_view_pages import look, respond, user

MERMAID = 'flowchart TD\n  a(["OA-001 借书"]) --> b{"名下有逾期未还的书？"}\n  b -- 是 --> c["不能借"]\n  b -- 否 --> d["登记借出"]'
DIAGRAM = {"name": "借书流程图", "kind": "flowchart", "mermaid": MERMAID, "note": "读者借一本书的经过。",
           "sources": [{"kind": "条目", "locator": "OA-001"}]}
SCRIPT = {
    "rules": [
        # 用户 agent：打开图之后说一句并结束；在界面上看到有一张图还没看过，就带着编号打开它；其余与四张卡片那一例相同。
        user(respond(text="图我看过了，没有问题。", done=True), last_role="tool", last_contains="D-001「借书流程图」，流程图，修订 1"),
        user(look(diagram_id="D-001"), last_role="tool", last_contains="D-001「借书流程图」（流程图）：画自 OA-001；你还没看过现在这一版"),
        user(respond(click="进入整理建模"), last_role="tool", last_contains="选项 enter_consolidate"),
        user(respond(click="进入澄清"), last_role="tool", last_contains="OA-001「借书」，集合"),
        user(look(item_id="OA-001"), last_role="tool", last_contains="选项 enter_clarify"),
        user(respond(text=FIRST_WORDS), last_role="tool"),
        user(look(), last_role="user"),
    ],
    "sequence": [
        {"text": intent("request", "把需求整理成规格说明"), **tool("save_revision", {"operations": [PAGE]})},
        say("材料读完了，我立了一页主题。", CLARIFY_CARD),
        say("这份材料没有要再问的。", MODEL_CARD),
        tool("save_diagram", DIAGRAM),
        say("我画了一张借书的流程图，请你看一下。"),
        say("好的。"),
    ],
    "default": {"text": "好的。"},
}


class UserTurnTest(unittest.TestCase):
    def test_每轮记录里看图另记一项_看页的那一项不变(self):
        def looked(**arguments) -> dict:
            return {"type": "tool_execution_start", "toolName": "look", "args": arguments}
        turn = user_turn([looked(), looked(item_id="OA-001"), looked(diagram_id="D-001"), looked(diagram_id="D-002")])
        self.assertEqual((turn["looks"], turn["confirms"], turn["diagram_looks"]), ([None, "OA-001", None, None], [], ["D-001", "D-002"]))


@unittest.skipUnless(HAS_STAGES, "产品还没有工作的阶段")
@unittest.skipUnless(shutil.which("pi") and shutil.which("node"), "本机找不到 pi 或 node")
class ViewDiagramsTest(unittest.TestCase):
    def test_界面上列出助手画的图_带着图的编号看界面就记一次看过(self):
        root = Path(tempfile.mkdtemp(prefix="taskwright-diagram-it-"))
        fake = FakeModel(SCRIPT, root)
        fake.start()
        saved = dict(os.environ)
        try:
            for name in ("TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                os.environ.pop(name, None)
            os.environ.update({ENV_AGENT_DIR: str(fake.agent_dir), "PI_OFFLINE": "1", "XDG_DATA_HOME": str(root / "data"),
                               "TASKWRIGHT_SETTINGS_FILE": str(root / "settings.json")})
            code = run.main(["--persona", str(REPO / "sim" / "personas" / "library-short.json"), "--materials-dir", str(EXAMPLES),
                             "--port", str(free_port()), "--profile", "fake", "--user-model", "fake/fake-model",
                             "--sim-root", str(root / "sims"), "--max-rounds", "6"])
        finally:
            fake.stop()
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(code, 0)
        sim = root / "sims" / "sim-001"
        record = json.loads((sim / "record.json").read_text(encoding="utf-8"))
        self.assertEqual(record["停止原因"], "用户 agent 表示目标达成")
        self.assertEqual([turn["用户 agent"]["diagram_looks"] for turn in record["轮"]], [[], [], [], ["D-001"]])
        self.assertEqual(record["轮"][3]["用户 agent"]["looks"], [None, None])
        # 库里：一张图，一条看过这张图的事件，记的是用户看到的那一次修订。
        task = taskdb.read_workspace(sim / "库副本")["任务"][0]
        self.assertEqual([(d["图的编号"], d["修订内容"][-1]["图名"]) for d in task["图"]], [("D-001", "借书流程图")])
        db = sqlite3.connect(sim / "库副本" / taskdb.DB_NAME)
        viewed = [json.loads(row[0]) for row in db.execute("SELECT payload FROM event WHERE name = 'DIAGRAM_VIEWED' ORDER BY seq")]
        db.close()
        self.assertEqual([one["diagrams"] for one in viewed], [[{"diagram_id": "D-001", "revision_no": 1}]])
        # 用户 agent 看到的界面：先是图那一段的一行，打开之后是说明、画自哪页与图的文本。
        seen = "\n".join(json.dumps(r["请求体"]["messages"][-1], ensure_ascii=False) for r in fake.requests()
                         if FIRST_WAKE in json.dumps(r["请求体"]["messages"], ensure_ascii=False))
        self.assertIn("助手画的图 1 张（想看哪一张，look 时在 diagram_id 里写它的编号）", seen)
        self.assertIn("说明：读者借一本书的经过。", seen)
        self.assertIn("画自：OA-001", seen)
        self.assertIn("名下有逾期未还的书？", seen)
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
