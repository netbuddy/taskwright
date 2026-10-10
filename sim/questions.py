"""评测里与提问有关的两样：助手问过哪些问题（按轮列出），以及用户 agent 答不上的问题（请人过目后补进画像）。

助手问过的问题取自任务库的对话行为表：说话方是助手、期待回应的那些行为（提问、请确认、给建议值、请选择、提议），
经观测台的 dialogue.read_session 读。那张表按运行记，不按演练的轮记；所在的轮靠演练记录对上：演练记录每轮记着助手这一轮
的行为种类与完整文字，库里的摘要是同一段文字截短的，所以按先后逐个对，种类相同、文字对得上的就是同一问。库里有而演练记录
里对不上的，轮次留空；库里没有对话行为表（或没有库副本）时，只按演练记录列。

用户 agent 答不上的问题：用户 agent 某一轮的话里出现了「答不上的说法」（程序自带的几种，加上画像里「答不上的说法」一键列的），
就把上一轮助手问的那几问连同这句话记成一条。这是请人过目的清单，不是结论，局限有三条：
- 用户 agent 换了一种没列出的说法就抓不到——把新说法加进画像的那个键再重判即可；
- 会多抓，例如「我不知道什么叫用例」不是缺事实，所以每条都带着原话；
- 一句话里答了一半、另一半说要去问时，分不出是哪一半，上一轮的几问都列上。
上一轮的问题碰到了某条隐藏事实的「问到的迹象」时，说明画像里可能已经有这件事而用户 agent 说不知道，这种单独列出，不算缺内容。
"""

from __future__ import annotations

import re
from pathlib import Path

from taskwright_observatory import dialogue, taskdb

from sim.judge import user_utterances

#: 程序自带的「答不上的说法」。
DEFAULT_MARKERS = ("不知道", "不清楚", "要问一下", "得问", "还没定", "说不好")
PERSONA_MARKERS = "答不上的说法"

BY_DB = "按任务库的对话行为列，轮次靠演练记录对上"
BY_RECORD = "任务库里没有对话行为，只按演练记录列"


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def record_questions(record: dict) -> list[dict]:
    """演练记录里助手每一轮向用户要回应的行为：轮、种类、完整文字、选项的文字。"""
    out = []
    for turn in record.get("轮") or []:
        for reply in (turn.get("执行者") or {}).get("replies") or []:
            act = reply.get("act") or {}
            if act.get("kind"):
                out.append({"轮": turn["轮"], "功能码": act["kind"], "文字": act.get("text") or "",
                            "选项": [o.get("text") or "" for o in act.get("options") or []]})
    return out


def db_questions(db_dir: Path, task_id: str) -> list[dict] | None:
    """任务库里助手期待回应的对话行为，按记下的先后。没有库或没有对话行为表时是 None。"""
    path = Path(db_dir) / taskdb.DB_NAME
    if not path.is_file():
        return None
    conn = taskdb.open_readonly(path)
    try:
        if not dialogue.has_dialogue(conn):
            return None
        sessions = [row[0] for row in conn.execute("SELECT session_id FROM dialogue_act WHERE task_id = ? GROUP BY session_id ORDER BY MIN(rowid)", (task_id,))]
        out = []
        for session_id in sessions:
            for act in dialogue.read_session(conn, task_id, session_id)["行为"]:
                if act["speaker"] == "executor" and act["expects_response"]:
                    out.append({"行为编号": act["act_id"], "运行号": act["run_id"], "功能码": act["function"], "摘要": act["summary"],
                                "针对": dialogue.target_text(act["targets"])})
        return out
    finally:
        conn.close()


def asked(sim: Path, record: dict) -> dict:
    """助手问过的问题，按轮列出。返回 {"问题": [...], "怎样列的": 一句话}。"""
    names = dialogue.function_names()["executor"]
    recorded = record_questions(record)
    found = db_questions(Path(sim) / "库副本", record.get("任务编号") or "")
    if found is None:
        return {"怎样列的": BY_RECORD,
                "问题": [{"轮": q["轮"], "行为编号": None, "功能": names.get(q["功能码"], q["功能码"]), "功能码": q["功能码"],
                          "文字": q["文字"], "选项": q["选项"], "针对": ""} for q in recorded]}
    out, at = [], 0
    for act in found:
        head = _flat(act["摘要"]).rstrip("…")
        hit = next((n for n in range(at, len(recorded)) if recorded[n]["功能码"] == act["功能码"] and _flat(recorded[n]["文字"]).startswith(head)), None)
        match = recorded[hit] if hit is not None else None
        if hit is not None:
            at = hit + 1
        out.append({"轮": match["轮"] if match else None, "行为编号": act["行为编号"], "功能": names.get(act["功能码"], act["功能码"]),
                    "功能码": act["功能码"], "文字": match["文字"] if match else act["摘要"], "选项": match["选项"] if match else [],
                    "针对": act["针对"]})
    return {"怎样列的": BY_DB, "问题": out}


def markers(persona: dict) -> list[str]:
    """画像里列的说法排在前面：它们更具体，一句话两种都对得上时记画像里的那一种。"""
    return [*[m for m in persona.get(PERSONA_MARKERS) or [] if isinstance(m, str) and m], *DEFAULT_MARKERS]


def unanswered(persona: dict, record: dict, questions: list[dict]) -> dict:
    """用户 agent 答不上的问题。返回两张清单：「待人答」（画像里看来没有这件事），与「画像里可能已有」
    （上一轮的问题碰到了某条隐藏事实的「问到的迹象」，用户 agent 却说不知道）。"""
    words = markers(persona)
    by_round: dict[int, list[dict]] = {}
    for q in questions:
        if q["轮"] is not None:
            by_round.setdefault(q["轮"], []).append(q)
    pending, known = [], []
    for u in user_utterances(record):
        text = u["text"] or ""
        hit = next((w for w in words if w in text), None)
        if hit is None:
            continue
        before = by_round.get(u["轮"] - 1) or []
        question_text = "\n".join([q["文字"], *q["选项"]][n] for q in before for n in range(1 + len(q["选项"])))
        facts = [f["事实"] for f in persona.get("隐藏事实") or [] if any(sign in question_text for sign in f.get("问到的迹象") or [])]
        entry = {"轮": u["轮"], "用户 agent 的话": text, "命中的说法": hit,
                 "上一轮的问题": [{"行为编号": q["行为编号"], "功能": q["功能"], "文字": q["文字"]} for q in before],
                 "画像里可能有的事实": facts}
        (known if facts else pending).append(entry)
    return {"待人答": pending, "画像里可能已有": known}
