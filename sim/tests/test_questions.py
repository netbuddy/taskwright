"""助手问过的问题按轮列出；用户 agent 答不上的问题挑出来请人过目。"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from sim import questions

PERSONA = {"名字": "测试用户", "答不上的说法": ["得问一下教务处"],
           "隐藏事实": [{"事实": "丢书按定价两倍赔。", "关键词": ["两倍"], "问到的迹象": ["丢", "赔偿"]}]}

LONG = "寒暑假期间借出的书借期怎么算？" + "材料里只写了另行规定，没有写具体的做法。" * 12


def reply(kind: str, text: str, options=()) -> dict:
    return {"text": "我整理了一下。", "act": {"kind": kind, "text": text, "options": [{"key": f"k{n}", "text": o} for n, o in enumerate(options)]}}


def turn(n: int, said: str, replies=()) -> dict:
    return {"轮": n, "用户 agent": {"looks": [None], "respond": {"sent": {"text": said}, "route": "message"}}, "执行者": {"replies": list(replies)}}


RECORD = {"演练": "sim-001", "任务编号": "TASK-T", "轮": [
    turn(1, "帮我整理这份需求。", [reply("ask", LONG)]),
    turn(2, "这个我得问一下教务处。", [{"text": "好的，先记成问题。", "act": None}, reply("choose", "书丢了怎么赔？", ["按定价赔", "按两倍赔"])]),
    turn(3, "这个我不清楚。", [reply("ask", "系统要不要支持校外读者？")]),
    turn(4, "我不知道什么叫用例，你看着办。", []),
    turn(5, "可以。", []),
]}


def make_db(sim: Path, acts: list[tuple]) -> None:
    """只建评测要读的两张表：对话行为表与事件表（列与产品的建表语句相同）。"""
    (sim / "库副本").mkdir(parents=True)
    conn = sqlite3.connect(sim / "库副本" / "task.sqlite")
    conn.executescript("""
        CREATE TABLE dialogue_act (task_id TEXT, session_id TEXT, act_id TEXT, run_id TEXT, speaker TEXT, function TEXT, targets TEXT,
          responds_to TEXT, expects_response INTEGER, confidence TEXT, summary TEXT, source_entry TEXT, origin TEXT, event_seq INTEGER, created_at TEXT);
        CREATE TABLE event (seq INTEGER PRIMARY KEY, task_id TEXT, session_id TEXT, call_id TEXT, name TEXT, payload TEXT, actor TEXT, at TEXT);
    """)
    for act_id, speaker, function, expects, summary, targets in acts:
        conn.execute("INSERT INTO dialogue_act VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     ("TASK-T", "s", act_id, act_id.split("-")[0], speaker, function, json.dumps(targets, ensure_ascii=False), None, expects, None,
                      summary, None, "reply" if speaker == "executor" else "understanding", 0, "2026-01-01T00:00:00.000"))
    conn.commit()
    conn.close()


class QuestionTest(unittest.TestCase):
    def test_问题取自任务库的对话行为_轮次靠演练记录对上_文字用完整的(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = Path(tmp)
            make_db(sim, [
                ("r1-1", "user", "request", 0, "整理需求", []),
                ("r1-2", "executor", "inform", 0, "我整理了一下。", []),
                ("r1-3", "executor", "ask", 1, LONG[:59] + "…", [{"item_id": "TBD-001"}]),
                ("r2-2", "executor", "choose", 1, "书丢了怎么赔？", []),
                ("r3-2", "executor", "ask", 1, "系统要不要支持校外读者？", []),
                ("r9-1", "executor", "confirm", 1, "演练记录里没有的一问", []),
            ])
            out = questions.asked(sim, RECORD)
        self.assertEqual(out["怎样列的"], questions.BY_DB)
        self.assertEqual([(q["轮"], q["行为编号"], q["功能"]) for q in out["问题"]],
                         [(1, "r1-3", "提问"), (2, "r2-2", "请选择"), (3, "r3-2", "提问"), (None, "r9-1", "请确认")])
        self.assertEqual((out["问题"][0]["文字"], out["问题"][0]["针对"]), (LONG, "TBD-001"))
        self.assertEqual(out["问题"][1]["选项"], ["按定价赔", "按两倍赔"])
        self.assertEqual(out["问题"][3]["文字"], "演练记录里没有的一问")

    def test_没有库副本时只按演练记录列(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = questions.asked(Path(tmp), RECORD)
        self.assertEqual(out["怎样列的"], questions.BY_RECORD)
        self.assertEqual([(q["轮"], q["行为编号"], q["功能码"]) for q in out["问题"]], [(1, None, "ask"), (2, None, "choose"), (3, None, "ask")])

    def test_答不上的问题_对回上一轮的问题_画像里可能已有的单独列(self):
        with tempfile.TemporaryDirectory() as tmp:
            asked = questions.asked(Path(tmp), RECORD)["问题"]
        out = questions.unanswered(PERSONA, RECORD, asked)
        # 第 2 轮用了画像里列的说法，对回第 1 轮的问题；第 4 轮的「不知道」对回第 3 轮；第 5 轮没有答不上的说法。
        self.assertEqual([(x["轮"], x["命中的说法"], [q["文字"] for q in x["上一轮的问题"]]) for x in out["待人答"]],
                         [(2, "得问一下教务处", [LONG]), (4, "不知道", ["系统要不要支持校外读者？"])])
        self.assertEqual(out["待人答"][1]["用户 agent 的话"], "我不知道什么叫用例，你看着办。")
        # 第 3 轮说不清楚，而上一轮问的是丢书怎么赔：画像的隐藏事实里有这件事，单独列出。
        self.assertEqual([(x["轮"], x["命中的说法"], x["画像里可能有的事实"]) for x in out["画像里可能已有"]], [(3, "不清楚", ["丢书按定价两倍赔。"])])

    def test_上一轮助手没有提问_原话照列_问题为空(self):
        record = {"轮": [turn(1, "帮我整理。", [{"text": "好的。", "act": None}]), turn(2, "这个要问一下领导。", [])]}
        out = questions.unanswered({}, record, questions.record_questions(record))
        self.assertEqual([(x["轮"], x["上一轮的问题"]) for x in out["待人答"]], [(2, [])])


if __name__ == "__main__":
    unittest.main()
