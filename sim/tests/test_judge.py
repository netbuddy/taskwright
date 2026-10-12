"""判定程序对一份手造的演练记录：库由 agent 里真实的核心函数写出，记录与用户画像手写。"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from sim import judge

REPO = Path(__file__).resolve().parents[2]
MATERIAL = "读者凭借书证借书，每本书可以续借一次。读者还书时，逾期的每本每天罚款一角。寒暑假期间的借期另行规定。系统还要能智能推荐图书。"
PERSONA = json.loads((REPO / "sim" / "personas" / "librarian.json").read_text(encoding="utf-8"))

# 建任务目录、放起始文件、写任务记录：与任务服务建任务时用的是同一个函数（backend/src/workspace.ts 的 createTaskDir）。
CREATE = r"""
import { createTaskDir } from "./backend/src/workspace.ts";
process.stdout.write(JSON.stringify(createTaskDir(process.argv[1], "srs-authoring", null, null, "TASK-T")));
"""

SCRIPT = r"""
import { saveRevision } from "./agent/src/lib/save_revision.ts";
const dir = process.argv[1];
const src = (excerpt, supports = []) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt, supports });
saveRevision({ workspaceDir: dir, sessionId: "s", callId: "ui-op-1", actor: "user" }, { operations: [
  { op: "add", collection: "功能用例", fields: { 用例名称: "借书、还书与续借", 用例功能: "读者借书、还书，每本书可以续借一次。",
    参与者: ["读者"], 基本流程: ["读者出示借书证", "系统登记借书"] }, sources: [src("读者凭借书证借书，每本书可以续借一次。"),
    { kind: "助手补充", excerpt: "按常识补了出示借书证这一步" }] },
  { op: "add", collection: "约束", fields: { 类别: "时限", 句式类型: "普遍型", 需求语句: "寒暑假期间借出的图书，借期应当顺延到开学后第一周的周五。" },
    sources: [{ kind: "用户的话", locator: "s#e1", excerpt: "寒暑假借的书顺延到开学第一周周五" }] },
  { op: "add", collection: "问题", fields: { 事项: "遗失的图书怎样处理", 种类: "待澄清", 是否阻断下游: "不阻断", 何时回看: "评审确认时", 状态: "未解决" },
    sources: [src("读者还书时，逾期的每本每天罚款一角。")] },
  { op: "add", collection: "问题", fields: { 事项: "智能推荐的范围不明确", 种类: "待澄清", 是否阻断下游: "不阻断", 何时回看: "评审确认时", 状态: "未解决" },
    sources: [src("系统还要能智能推荐图书。")] },
] });
"""


ASK_HOURS = {"replies": [{"text": "材料里说寒暑假期间的借期另行规定，具体怎么算？", "act": {"kind": "ask", "text": "寒暑假借期怎么算？"}}]}


def build(root: Path, first_words: str, looked: list, second_words: str = "寒暑假借的书顺延到开学第一周周五",
          executor_first: dict | None = None) -> Path:
    sim = root / "sim-001"
    task = json.loads(subprocess.run(["node", "--input-type=module", "-e", CREATE, str(sim / "tasks" / "TASK-T")], cwd=str(REPO), check=True,
                                     capture_output=True, text=True).stdout)
    subprocess.run(["node", "--input-type=module", "-e", SCRIPT, task["任务目录"]], cwd=str(REPO), check=True, capture_output=True, text=True)
    (sim / "库副本").mkdir(parents=True)
    for f in Path(task["任务目录"]).glob("task.sqlite*"):
        shutil.copy2(f, sim / "库副本" / f.name)
    (sim / "materials").mkdir()
    (sim / "materials" / "材料.md").write_text(MATERIAL, encoding="utf-8")
    (sim / "用户画像.json").write_text(json.dumps(PERSONA, ensure_ascii=False), encoding="utf-8")
    record = {"演练": "sim-001", "演练目标": "测试", "用户画像": "librarian.json", "任务编号": "TASK-T", "停止原因": "用户 agent 表示目标达成",
              "轮": [
                  {"轮": 1, "用户 agent": {"looks": [None], "respond": {"sent": {"text": first_words}, "route": "message"}},
                   "执行者": ASK_HOURS if executor_first is None else executor_first},
                  {"轮": 2, "用户 agent": {"looks": [None, *looked], "respond": {"sent": {"text": second_words}, "route": "message"}}},
                  {"轮": 3, "用户 agent": {"looks": [None, *looked], "respond": {
                      "sent": {"kind": "mark_viewed", "targets": [{"item_id": "UC-001", "base_revision": 1}]}, "route": "action", "done": True}}},
              ]}
    (sim / "record.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    return sim


@unittest.skipUnless(shutil.which("node"), "本机没有 node")
class JudgeTest(unittest.TestCase):
    def test_有效的演练_第二层逐项(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "帮我把借还书的需求整理成规格说明", ["UC-001"])
            report = judge.judge(sim).read_text(encoding="utf-8")
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertTrue(summary["有效"])
        second = summary["第二层"]
        self.assertTrue(second["check_db 全过"])
        self.assertTrue(second["功能用例至少一个"])
        self.assertTrue(second["必填字段齐"])
        self.assertTrue(second["来源逐字"], report)
        self.assertEqual([h["问出来了"] for h in summary["隐藏事实"]], [True, False])
        bottom = [v for k, v in second.items() if k.startswith("接受底线")]
        self.assertEqual(bottom, [True, True, True], report)
        self.assertIn("这次演练有效", report)
        self.assertIn("### 第 3 轮", report)
        # 完成条件由 agent 的核对函数逐项核对（经观测台起的 Node 子进程）：用例与约束各缺评审与已读，问题有未解决的；
        # 非功能需求与领域说明没有条目，这三项暂不需要核对。
        self.assertIn("- 完成条件：还差 5 项；另有 3 项因集合暂无条目暂不需要核对", report)

    def test_第一句泄底与没看内容就确认都标为无效(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "丢书要按书价两倍赔，另收加工费，先记一下", [])
            report = judge.judge(sim).read_text(encoding="utf-8")
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertFalse(summary["有效"])
        self.assertEqual(list(summary["第一层"].values()), [False, False, True])
        self.assertIn("命中的关键词", report)
        self.assertIn("\"条目\": \"UC-001\"", report)

    def test_关键词组要在同一条目里全部出现_只出现一个不算(self):
        # 库里「遗失」只出现在一条问题条目里，「两倍」「加工费」都没有：第二条隐藏事实不算问出。
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "帮我整理借还书系统", ["UC-001"])
            judge.judge(sim)
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(summary["隐藏事实"][1], {"写进了条目": [], "问出来了": False, "主动说出的轮次": None,
                                                 "说出的轮次": None, "情形": None, "在作废轮次里": False})
        self.assertEqual(summary["隐藏事实"][0]["写进了条目"], ["CON-001"])

    def test_执行者没问而用户_agent_在后面的轮次说出隐藏事实_标为主动泄露(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "帮我整理借还书系统", ["UC-001"],
                        executor_first={"replies": [{"text": "用例整理好了，请看看。", "act": None}]})
            report = judge.judge(sim).read_text(encoding="utf-8")
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertFalse(summary["有效"])
        self.assertEqual((summary["有效性"], summary["作废起始轮"]), ("部分有效", 2))    # 第 1 轮有效，第 2 轮起作废
        self.assertFalse(summary["第一层"]["没有在执行者没问的时候主动说出隐藏事实（查全部轮次）"])
        self.assertEqual(summary["隐藏事实"][0], {"写进了条目": ["CON-001"], "问出来了": False, "主动说出的轮次": 2,
                                                 "说出的轮次": 2, "情形": "泄底", "在作废轮次里": True})
        self.assertIn("第 2 轮泄底", report)
        self.assertIn("不算问出来", report)
        self.assertIn("这次演练部分有效：用户 agent 第 2 轮起没有按画像演，第 1 轮有效，第 2 轮起作废。", report)

    def test_执行者请确认的条目里写到了这件事_用户借此说出_不算主动(self):
        confirm_con = {"replies": [{"text": "请确认下面这条。", "act": {"kind": "confirm", "text": "请确认",
                                                                   "items": [{"item_id": "CON-001", "revision_no": 1}]}}]}
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "帮我整理借还书系统", ["UC-001"], executor_first=confirm_con)
            judge.judge(sim)
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertTrue(summary["有效"])
        self.assertEqual(summary["隐藏事实"][0]["主动说出的轮次"], None)

    def test_第1轮泄底_整场无效(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "丢书要按书价两倍赔，另收加工费，先记一下", ["UC-001"])
            judge.judge(sim)
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual((summary["有效性"], summary["作废起始轮"]), ("无效", 1))
        self.assertEqual(summary["隐藏事实"][1]["情形"], "泄底")

    def test_执行者把条目贴在正文里_没有针对它问_用户借机说出_记为用户主动补充(self):
        # 情形：用户要求展开全部条目，执行者把内容贴在回复正文里（写到了寒暑假借期），主行为问的是别的事。
        pasted = {"replies": [{"text": "全部条目如下：CON-001 寒暑假期间借出的图书，借期另行规定……", "informs": ["我把条目都贴出来了。"],
                               "act": {"kind": "ask", "text": "还有哪里要改？"}}]}
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "帮我整理借还书系统", ["UC-001"], executor_first=pasted)
            report = judge.judge(sim).read_text(encoding="utf-8")
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertTrue(summary["有效"])                                    # 不算演错
        self.assertEqual(summary["隐藏事实"][0]["情形"], "用户主动补充")
        self.assertFalse(summary["隐藏事实"][0]["问出来了"])                  # 也不算问出
        self.assertEqual(summary["用户主动补充"], [{"轮": 2, "事实": PERSONA["隐藏事实"][0]["事实"]}])
        self.assertIn("## 用户主动补充（不算问出，也不算演错）", report)
        self.assertIn("是用户 agent 第 2 轮主动补充的", report)

    def test_执行者针对性地问_情形记为问出(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "帮我整理借还书系统", ["UC-001"])       # 第 1 轮执行者用提问问了寒暑假借期怎么算
            judge.judge(sim)
            summary = json.loads((Path(tmp) / "sim-summary.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(summary["隐藏事实"][0]["情形"], "问出")
        self.assertTrue(summary["隐藏事实"][0]["问出来了"])

    def test_执行者会话里的用户消息_含后端代发的固定句子_都算用户的话(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = Path(tmp)
            events = sim / "backend" / "T" / "pi-events"
            events.mkdir(parents=True)
            lines = [{"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "我先不管 TBD-001，请接着往下做。"}]}},
                     {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "好的"}]}},
                     {"type": "message_end", "message": {"role": "user", "content": "帮我整理"}}]
            (events / "service-1.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines), encoding="utf-8")
            (events / "service-1.backend.jsonl").write_text(json.dumps(lines[0], ensure_ascii=False), encoding="utf-8")
            self.assertEqual(judge.executor_user_messages(sim), ["我先不管 TBD-001，请接着往下做。", "帮我整理"])

    def test_换画像重判_不追加汇总行(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = build(Path(tmp), "帮我整理借还书系统", ["UC-001"])
            other = Path(tmp) / "新画像.json"
            other.write_text(json.dumps(PERSONA, ensure_ascii=False), encoding="utf-8")
            report = judge.judge(sim, other, summary_line=False).read_text(encoding="utf-8")
            self.assertFalse((Path(tmp) / "sim-summary.jsonl").exists())
        self.assertIn("本次判定用的画像：新画像.json，是重判", report)



START_CARD = {"kind": "choose", "text": "这两页你看过之后，现在开始写条目吗？", "items": [{"item_id": "OA-001", "revision_no": 1}, {"item_id": "OA-002", "revision_no": 1}],
              "options": [{"key": "start_items", "text": "开始写条目"}, {"key": "continue_clarify", "text": "继续澄清"}]}


ENTER_CHECK = "点进入下一段的卡片之前打开过卡片点名的条目"


def start_record(looks_2: list, looks_3: list, choice: str = "start_items", card: dict | None = START_CARD) -> dict:
    """三轮：第 1 轮说要整理，助手发提议的卡片；第 2 轮看页并说一句；第 3 轮看页并在卡片上点一个选项。"""
    said = lambda n, text, looks, sent=None: {"轮": n, "用户 agent": {"looks": looks, "respond": {"sent": sent or {"text": text}, "route": "message"}}}      # noqa: E731
    reply = {"text": "我立了两页主题。", "message_id": "m-card", "act": card, "via_reply_tool": True}
    click = {"text": "我选：开始写条目", "origin": "card_choice", "card": {"reply_message_id": "m-card", "kind": "choose", "choice": choice}}
    return {"演练": "sim-001", "任务编号": "TASK-T", "轮": [
        {**said(1, "帮我整理需求。", [None]), "执行者": {"replies": [reply]}},
        {**said(2, "我先看看。", looks_2), "执行者": {"replies": [{"text": "好的。", "message_id": "m-2", "act": None}]}},
        {**said(3, "", looks_3, click), "执行者": {"replies": []}}]}


class StartItemsTest(unittest.TestCase):
    def check(self, record: dict, sim: Path | None = None) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            return judge.layer1({"persona": {}, "record": record, "sim": sim or Path(tmp)})[2]

    def test_之前各轮或同一轮打开过卡片点名的每一页_通过(self):
        found = self.check(start_record([None, "OA-001"], [None, "OA-002"]))
        self.assertEqual((found["项"], found["通过"], found["说明"], found["细节"]),
                         (ENTER_CHECK, True, "一共点了 1 次进入下一段的卡片：第 3 轮「开始写条目」。", []))

    def test_有一页从头到尾没打开过就点了_不通过_从那一轮起作废(self):
        found = self.check(start_record([None, "OA-001"], [None, "UC-001"]))
        self.assertEqual((found["通过"], found["细节"]),
                         (False, [{"轮": 3, "点的选项": "开始写条目", "没打开过的条目": ["OA-002"], "卡片点名的条目": ["OA-001", "OA-002"]}]))
        self.assertEqual(judge.validity([found])["作废起始轮"], 3)

    def test_没有点过_点的是继续澄清_卡片没有点名页_都通过(self):
        never = {"演练": "sim-001", "轮": [{"轮": 1, "用户 agent": {"looks": [None], "respond": {"sent": {"text": "帮我整理。"}}}, "执行者": {"replies": []}}]}
        self.assertEqual((self.check(never)["通过"], self.check(never)["说明"]), (True, "没有点过进入下一段的卡片。"))
        self.assertEqual(self.check(start_record([None], [None], choice="continue_clarify"))["说明"], "没有点过进入下一段的卡片。")
        no_items = self.check(start_record([None], [None], card={**START_CARD, "items": []}))
        self.assertEqual((no_items["通过"], no_items["说明"]), (True, "一共点了 1 次进入下一段的卡片：第 3 轮「开始写条目」。"))

    def test_每一张进入下一段的卡片都查_按键的写法认_不逐张列出(self):
        # 四张现有的卡片与一张产品以后才有的（键以 enter_ 开头）都算进入下一段；留在这一段的键与完成任务那张卡片的两个键不算。
        self.assertEqual([judge.enters_next_stage(key) for key in ("enter_clarify", "enter_consolidate", "start_items", "enter_review", "enter_document")], [True] * 5)
        self.assertEqual([judge.enters_next_stage(key) for key in ("continue_reading", "continue_clarify", "continue", "complete", "不对", None)], [False] * 6)
        for key, text in (("enter_clarify", "进入澄清"), ("enter_consolidate", "进入整理建模"), ("enter_review", "进入评审确认")):
            card = {**START_CARD, "options": [{"key": key, "text": text}, {"key": "continue_reading", "text": "再核读一遍"}]}
            opened = self.check(start_record([None, "OA-001"], [None, "OA-002"], choice=key, card=card))
            self.assertEqual((opened["通过"], opened["说明"]), (True, f"一共点了 1 次进入下一段的卡片：第 3 轮「{text}」。"))
            skipped = self.check(start_record([None], [None, "OA-001"], choice=key, card=card))
            self.assertEqual((skipped["通过"], skipped["细节"]),
                             (False, [{"轮": 3, "点的选项": text, "没打开过的条目": ["OA-002"], "卡片点名的条目": ["OA-001", "OA-002"]}]))
        # 卡片上找不到这个键的文字时写键。
        unknown = self.check(start_record([None, "OA-001", "OA-002"], [None], choice="enter_document"))
        self.assertEqual(unknown["说明"], "一共点了 1 次进入下一段的卡片：第 3 轮「enter_document」。")

    @unittest.skipUnless(shutil.which("node"), "本机没有 node")
    def test_打开过但库里没有那一修订上看过的记录_不算演错_在说明里单独写出(self):
        from sim.tests.test_lamps import CREATE, SAVE, VIEW, copy_db, node
        with tempfile.TemporaryDirectory() as tmp:
            sim = Path(tmp) / "sim-001"
            task_dir = Path(json.loads(node(CREATE, str(sim / "tasks" / "TASK-T")))["任务目录"])
            node(SAVE, str(task_dir))           # 两页主题 OA-001、OA-002
            node(VIEW, str(task_dir))           # 用户只在 OA-001 的修订 1 上记了看过
            copy_db(task_dir, sim)
            found = judge.layer1({"persona": {}, "record": start_record([None, "OA-001", "OA-002"], [None]), "sim": sim})[2]
        self.assertTrue(found["通过"])
        self.assertEqual(found["说明"], "一共点了 1 次进入下一段的卡片：第 3 轮「开始写条目」。打开过、但库里没有它在卡片所写修订上看过的记录的（这一页有助手补的内容而没有确认，"
                         "或者那之后又改过），不算演错，列在这里：第 3 轮 OA-002。")


if __name__ == "__main__":
    unittest.main()
