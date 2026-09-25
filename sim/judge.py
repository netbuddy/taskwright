"""判定程序：对一次演练做第一层（用户 agent 有没有按用户画像演）与第二层（库里的事实）判定。

用法：python3 -m sim.judge <演练目录> [--persona <用户画像文件>] [--no-summary]
（--persona 用于拿修改过的画像重判旧演练；不给就用演练目录里那份画像副本。）

用户 agent 说出一条隐藏事实（这一轮的话里关键词组全部出现）时，按执行者上一轮做了什么分三种情形：
- 问出：执行者上一轮针对性地问了——它的主行为（提问、请选择、给建议值、提议、请确认）的文字、选项、建议值、预览，或者
  主行为点名的条目那一版的内容里有「问到的迹象」（例如请用户确认一条写着「48 个工作小时」的约束，用户借此说明工作小时怎么算）；
- 用户主动补充：执行者上一轮摆出的东西里有这件事（回复正文、告知里写到了，例如应用户要求把全部条目贴了出来），但主行为没有
  针对它问；用户借机说出来。这不算用户 agent 演错，也不算问出，单独列出；
- 泄底：执行者上一轮摆出的东西里根本没有这件事，用户 agent 自己说了出来。这是用户 agent 演错。

第一层只做代码能查的两项：泄底（查全部轮次）；点「这几条都看过了」（早期版本是「确认」）之前没有在同一轮里用「看界面」看过该条目的详情（没看内容就接受）。
第一层按轮作废：出错的最早一轮是第 1 轮，整场无效；是之后的第 k 轮，第 1 到 k−1 轮有效、第 k 轮起作废，
标「部分有效」。作废轮次里才说出的隐藏事实不算问出。第二层其余各项按演练结束时的库判定，部分有效时照样列出，但注明含作废
轮次之后的改动、只作参考。评判者查的两项（说了画像与材料都没有的事实、违背人设）不在这里。

隐藏事实的关键词组（画像里的「必须同时出现」）：一组里是同义的几种写法，出现一种就算这一组出现；所有组都出现
才算说到了这件事。画像没写「必须同时出现」时，把「关键词」里每个词各当一组。

第二层：check_db 全过、功能用例至少一个、必填齐、来源逐字（文档原文在材料里找得到，用户的话在执行者会话的用户消息里
找得到，其中包括界面操作之后后端代发的固定句子）、每条隐藏事实有没有被问出来（关键词组全部出现在同一个当前条目里，而且不是用户 agent 主动说出来的）、
接受底线逐条按用户画像里写的判据查、执行者被工具拒绝的次数与原因、停止原因、完成条件（经 Node 子进程调 conditions.ts）。

输出：演练目录下的「判定报告.md」与「判定摘要.json」（批处理汇总读它），并往 <演练目录的上级>/sim-summary.jsonl 追加一行。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from taskwright_observatory import check_db, taskdb
from taskwright_server.service import library


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def load(sim: Path, persona_path: Path | None = None) -> dict:
    sim = Path(sim)
    record = json.loads((sim / "record.json").read_text(encoding="utf-8"))
    persona = json.loads(Path(persona_path or sim / "用户画像.json").read_text(encoding="utf-8"))
    materials = {p.name: p.read_text(encoding="utf-8") for p in (sim / "materials").glob("*")} if (sim / "materials").is_dir() else {}
    return {"sim": sim, "record": record, "persona": persona, "materials": materials}


def user_utterances(record: dict) -> list[dict]:
    """用户 agent 每一轮真正发出去的东西：说的话、点的按钮（连同按钮背后发给执行者的那句话）。"""
    out = []
    for turn in record.get("轮") or []:
        respond = (turn.get("用户 agent") or {}).get("respond") or {}
        sent = respond.get("sent") or {}
        out.append({"轮": turn["轮"], "text": sent.get("text"), "kind": sent.get("kind"), "targets": sent.get("targets"),
                    "card": sent.get("card"), "looks": (turn.get("用户 agent") or {}).get("looks") or [],
                    "done": respond.get("done"), "give_up": respond.get("give_up"), "reason": respond.get("reason")})
    return out


def keyword_groups(fact: dict) -> list[list[str]]:
    """这条隐藏事实必须同时出现的关键词组；画像没写就把每个关键词各当一组。"""
    return fact.get("必须同时出现") or [[k] for k in fact.get("关键词") or []]


def groups_hit(groups: list[list[str]], text: str) -> list[str] | None:
    """所有组都出现时返回每组命中的那个词，否则返回 None。"""
    hits = []
    for group in groups:
        word = next((k for k in group if k in text), None)
        if word is None:
            return None
        hits.append(word)
    return hits


def revision_text(db_dir: Path | None, item_id: str, revision_no: int | None) -> str:
    """库里某条目在某次修订下的字段全文；没有库或查不到时为空。"""
    if db_dir is None or not (Path(db_dir) / taskdb.DB_NAME).is_file() or revision_no is None:
        return ""
    import sqlite3
    with sqlite3.connect(Path(db_dir) / taskdb.DB_NAME) as db:
        row = db.execute("SELECT fields FROM item_version WHERE item_id = ? AND revision_no = ?", (item_id, revision_no)).fetchone()
    return row[0] if row else ""


def executor_asked(turn: dict, db_dir: Path | None = None) -> str:
    """执行者在这一轮里针对性地问用户的东西：主行为的文字、选项、建议值、提议的预览，以及主行为点名的条目在那次修订下的内容。
    回复正文与告知不算——那是它说给用户听的，不是在问（例如应用户要求把全部条目贴出来）。"""
    parts = []
    for r in (turn.get("执行者") or {}).get("replies") or []:
        act = r.get("act") or {}
        if not act:
            continue
        parts += [act.get("text") or "", str(act.get("value") or ""), *(o.get("text") or "" for o in act.get("options") or [])]
        parts += [p.get("text") or "" for p in act.get("preview") or []]
        parts += [revision_text(db_dir, i.get("item_id"), i.get("revision_no")) for i in act.get("items") or []]
    return "\n".join(parts)


def executor_said(turn: dict, db_dir: Path | None = None) -> str:
    """执行者在这一轮里向用户摆出来的全部文字：回复正文、告知、向用户要的回应的文字与选项，以及它点名的条目在那次修订下的内容
    （执行者请用户确认或回答某个条目，等于把这个条目的内容摆在用户面前问他，条目里写到的事就算问到了）。"""
    parts = []
    for r in (turn.get("执行者") or {}).get("replies") or []:
        parts += [r.get("text") or "", *((one if isinstance(one, str) else (one or {}).get("text") or "") for one in r.get("informs") or [])]
        act = r.get("act") or {}
        parts += [act.get("text") or "", *(o.get("text") or "" for o in act.get("options") or [])]
        parts += [revision_text(db_dir, i.get("item_id"), i.get("revision_no")) for i in act.get("items") or []]
    return "\n".join(parts)


QUESTIONED = "问出"
VOLUNTEERED = "用户主动补充"
LEAKED = "泄底"


def disclosures(persona: dict, record: dict, db_dir: Path | None = None) -> list[dict]:
    """每条隐藏事实第一次出现在用户 agent 话里的那一轮，以及按执行者上一轮做了什么归成的情形（问出、用户主动补充、泄底）。
    用户 agent 一直没说出的隐藏事实不在列表里。"""
    turns = {t["轮"]: t for t in record.get("轮") or []}
    out = []
    for fact in persona.get("隐藏事实") or []:
        groups = keyword_groups(fact)
        for u in user_utterances(record):
            hits = groups_hit(groups, u["text"] or "")
            if hits is None:
                continue
            prev = turns.get(u["轮"] - 1) or {}
            asked, said = executor_asked(prev, db_dir), executor_said(prev, db_dir)
            signs = fact.get("问到的迹象") or []
            kind = (QUESTIONED if any(k in asked for k in signs) else
                    VOLUNTEERED if any(k in said for k in signs) else LEAKED)
            out.append({"轮": u["轮"], "事实": fact["事实"], "情形": kind, "命中的关键词": hits, "用户 agent 的话": u["text"],
                        "执行者上一轮": said[:200] or "（没有上一轮）"})
            break
    return out


def leaks(persona: dict, record: dict, db_dir: Path | None = None) -> list[dict]:
    """用户 agent 泄底的轮次：执行者上一轮摆出的东西里根本没有这件事，用户 agent 自己说了出来。"""
    return [d for d in disclosures(persona, record, db_dir) if d["情形"] == LEAKED]


def validity(first: list[dict]) -> dict:
    """第一层按轮作废：出错的最早一轮是第 1 轮整场无效；是第 k 轮（k 大于 1）则第 1 到 k−1 轮有效，标部分有效。"""
    rounds = [x["轮"] for c in first if not c["通过"] for x in c.get("细节") or [] if isinstance(x, dict) and x.get("轮")]
    if not rounds:
        return {"有效性": "有效", "作废起始轮": None, "说明": "这次演练有效。"}
    k = min(rounds)
    if k <= 1:
        return {"有效性": "无效", "作废起始轮": 1, "说明": "这次演练无效：用户 agent 第 1 轮就没有按画像演，整场不计入执行者成绩。"}
    return {"有效性": "部分有效", "作废起始轮": k,
            "说明": f"这次演练部分有效：用户 agent 第 {k} 轮起没有按画像演，{'第 1 轮' if k == 2 else f'第 1 到 {k - 1} 轮'}有效，第 {k} 轮起作废。"}


# ───────────────────────── 第一层 ─────────────────────────

#: 卡片上表示看过了的那一下点击：现在走 mark_viewed，早期版本的演练记录里是 confirm。
SEEN_KINDS = ("mark_viewed", "confirm")


def layer1(data: dict) -> list[dict]:
    persona, record = data["persona"], data["record"]
    utterances = user_utterances(record)
    checks = []
    leaked = leaks(persona, record, data["sim"] / "库副本")
    checks.append({"项": "没有在执行者没问的时候主动说出隐藏事实（查全部轮次）", "通过": not leaked,
                   "说明": "没有。" if not leaked else "；".join(f"第 {x['轮']} 轮泄底「{x['事实'][:24]}……」" for x in leaked),
                   "细节": leaked})
    unseen = []
    for u in utterances:
        if u["kind"] not in SEEN_KINDS:
            continue
        looked = {x for x in u["looks"] if x}
        for target in u["targets"] or []:
            if target["item_id"] not in looked:
                unseen.append({"轮": u["轮"], "条目": target["item_id"], "这一轮看过的条目": sorted(looked)})
    checks.append({"项": "点「这几条都看过了」之前在同一轮里看过该条目的详情", "通过": not unseen,
                   "说明": f"一共点了 {sum(1 for u in utterances if u['kind'] in SEEN_KINDS)} 次「这几条都看过了」。", "细节": unseen})
    return checks


# ───────────────────────── 第二层 ─────────────────────────

def item_text(version: dict) -> str:
    return json.dumps(version["字段"], ensure_ascii=False)


def criterion(rule: dict, items: list[dict], sources: list[dict]) -> tuple[bool, str]:
    kind = rule.get("类型")
    if kind == "关键词组都出现在集合里":
        text = "".join(item_text(i["当前内容"]) for i in items if i["所属集合"] == rule["集合"])
        missing = [group for group in rule["关键词组"] if not any(k in text for k in group)]
        return not missing, ("三组关键词都找到了" if not missing else f"集合「{rule['集合']}」里找不到：" + "；".join("／".join(g) for g in missing))
    if kind == "某种来源的条数大于零":
        count = sum(1 for s in sources if s["种类"] == rule["来源种类"])
        return count > 0, f"最新内容里种类为「{rule['来源种类']}」的来源有 {count} 条"
    if kind == "关键词不在集合标题里而在另一集合里":
        titles = [i["条目编号"] for i in items if i["所属集合"] == rule["不在标题"] and rule["关键词"] in item_title(i)]
        elsewhere = [i["条目编号"] for i in items if i["所属集合"] == rule["要在集合"] and rule["关键词"] in item_text(i["当前内容"])]
        return (not titles and bool(elsewhere),
                f"「{rule['关键词']}」出现在{rule['不在标题']}标题里的：{titles or '没有'}；出现在{rule['要在集合']}里的：{elsewhere or '没有'}")
    return False, f"不认识的判据类型「{kind}」"


def item_title(item: dict) -> str:
    fields = item["当前内容"]["字段"]
    first = next(iter(fields.values()), "") if fields else ""
    return first if isinstance(first, str) else json.dumps(first, ensure_ascii=False)


def executor_events(sim: Path):
    """执行者 pi 事件文件里的每一个事件（后端自己的附记文件不算）。"""
    for path in sorted((sim / "backend").glob("*/pi-events/*.jsonl")):
        if path.name.endswith((".backend.jsonl", ".times.jsonl")):
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def materials_read(sim: Path, names: list[str]) -> dict[str, int]:
    """执行者用 read 读每个材料文件的次数（按文件名认，读几次记几次）。"""
    counts = {name: 0 for name in names}
    for e in executor_events(sim):
        if e.get("type") == "tool_execution_start" and e.get("toolName") == "read":
            path = str((e.get("args") or {}).get("path") or "")
            for name in names:
                if path.endswith("/" + name) or path == name:
                    counts[name] += 1
    return counts


def executor_user_messages(sim: Path) -> list[str]:
    """执行者会话里全部的用户消息：用户 agent 说的话，以及界面操作之后后端代发的固定句子（例如点「先不管」之后的
    「我先不管 TBD-001，请接着往下做。」）。执行者的「用户的话」来源可以摘录其中任何一句，逐字核对以它为准。"""
    out = []
    for e in executor_events(sim):
        message = e.get("message") or {}
        if e.get("type") == "message_end" and message.get("role") == "user":
            content = message.get("content")
            out.append(content if isinstance(content, str) else "".join(p.get("text", "") for p in content or [] if isinstance(p, dict)))
    return out


def all_version_sources(db_dir: Path, kind: str) -> int:
    """条目在全部修订下某种来源的条数（同一条目同一修订同一位置的来源按一条算，不按支持的字段展开）。"""
    import sqlite3
    with sqlite3.connect(db_dir / taskdb.DB_NAME) as db:
        return db.execute("SELECT COUNT(*) FROM (SELECT DISTINCT item_id, revision_no, position FROM item_source WHERE kind = ?)",
                          (kind,)).fetchone()[0]


def rejected_calls(sim: Path) -> list[dict]:
    out = []
    for e in executor_events(sim):
        if e.get("type") == "tool_execution_end" and e.get("isError"):
            text = "".join(p.get("text", "") for p in (e.get("result") or {}).get("content") or [] if isinstance(p, dict))
            out.append({"工具": e.get("toolName"), "原因": " ".join(text.split())[:300] if text else ""})
    return out


def layer2(data: dict) -> tuple[list[dict], dict]:
    sim, persona, record = data["sim"], data["persona"], data["record"]
    db_dir = sim / "库副本"
    checks: list[dict] = []
    facts: dict = {"停止原因": record.get("停止原因"), "轮数": len(record.get("轮") or [])}
    if not (db_dir / taskdb.DB_NAME).is_file():
        checks.append({"项": "有库副本", "通过": False, "说明": "演练目录里没有库副本。"})
        return checks, facts
    results = check_db.check(db_dir)
    failed = [r for r in results if not r["通过"]]
    checks.append({"项": "check_db 全过", "通过": not failed, "说明": f"{len(results)} 项里 {len(failed)} 项不通过。",
                   "细节": [{"名目": r["名目"], "不通过的行": r["不通过的行"][:5]} for r in failed]})
    task = taskdb.read_workspace(db_dir)["任务"][0]
    definition = task["任务定义"]
    items = [i for i in task["条目"] if i["在第几次修订删除"] is None]
    counts = {c["名称"]: sum(1 for i in items if i["所属集合"] == c["名称"]) for c in definition["集合"]}
    facts["条目数"] = counts
    checks.append({"项": "功能用例至少一个", "通过": counts.get("功能用例", 0) > 0, "说明": f"各集合条目数：{counts}"})
    missing = []
    for i in items:
        coll = next(c for c in definition["集合"] if c["名称"] == i["所属集合"])
        for f in coll["字段"]:
            value = i["当前内容"]["字段"].get(f["名"])
            if f["必填"] and (value in (None, "", []) or (isinstance(value, str) and not value.strip())):
                missing.append(f"{i['条目编号']} 的「{f['名']}」")
    checks.append({"项": "必填字段齐", "通过": not missing, "说明": "；".join(missing) or "最新内容的必填字段全部有值。"})
    material = "\n".join(data["materials"].values())
    said = [u["text"] or "" for u in user_utterances(record)] + executor_user_messages(sim)
    sources = [dict(s, 条目=i["条目编号"]) for i in items for s in i["当前内容"]["来源"]]
    bad_sources = []
    for s in sources:
        if s["种类"] == "文档原文" and _norm(s["摘录"]) not in _norm(material):
            bad_sources.append(f"{s['条目']} 的文档原文摘录在材料里找不到：「{s['摘录'][:60]}」")
        if s["种类"] == "用户的话" and not any(_norm(s["摘录"]) in _norm(t) for t in said):
            bad_sources.append(f"{s['条目']} 的「用户的话」摘录在执行者会话的用户消息里找不到：「{s['摘录'][:60]}」")
    kinds = {k: sum(1 for s in sources if s["种类"] == k) for k in ("文档原文", "用户的话", "执行者补充")}
    facts["来源种类"] = kinds
    facts["执行者补充累计"] = all_version_sources(db_dir, "执行者补充")
    facts["执行者读材料"] = materials_read(sim, sorted(data["materials"]))
    checks.append({"项": "来源逐字", "通过": not bad_sources, "说明": f"最新内容的来源 {len(sources)} 条：{kinds}。", "细节": bad_sources})
    facts["隐藏事实"] = []
    said_by = {x["事实"]: x for x in disclosures(persona, record, db_dir)}
    cutoff = data.get("作废起始轮")
    for fact in persona.get("隐藏事实") or []:
        groups = keyword_groups(fact)
        found = [(i["条目编号"], h) for i in items if (h := groups_hit(groups, item_text(i["当前内容"]))) is not None]
        told = said_by.get(fact["事实"])
        void = bool(told and cutoff and told["轮"] >= cutoff)
        asked = bool(found) and (told is None or told["情形"] == QUESTIONED) and not void
        facts["隐藏事实"].append({"事实": fact["事实"], "写进了条目": [f[0] for f in found], "问出来了": asked,
                                  "用户 agent 说出的轮次": told["轮"] if told else None,
                                  "情形": told["情形"] if told else None, "在作废轮次里": void,
                                  "用户 agent 主动说出的轮次": told["轮"] if told and told["情形"] == LEAKED else None})
        label = "＋".join("／".join(g) for g in groups)
        note = (f"关键词组全部出现在同一条目里的：{[f[0] for f in found]}" if found else "没有一个条目里关键词组全部出现")
        if told and told["情形"] == LEAKED:
            note += f"；但这件事是用户 agent 第 {told['轮']} 轮泄底说的（执行者上一轮根本没提到），不算问出来"
        elif told and told["情形"] == VOLUNTEERED:
            note += (f"；这件事是用户 agent 第 {told['轮']} 轮主动补充的：执行者上一轮摆出的内容里提到了，但没有针对它问，"
                     "不算问出来")
        elif told:
            note += f"；执行者第 {told['轮'] - 1} 轮针对性地问了，用户 agent 第 {told['轮']} 轮答出"
        if void:
            note += f"；第 {told['轮']} 轮在作废轮次里（第 {cutoff} 轮起作废），不算"
        checks.append({"项": f"隐藏事实被问出来：{label}", "通过": asked, "说明": note})
    for rule in persona.get("接受底线") or []:
        ok, note = criterion(rule["判据"], items, sources)
        checks.append({"项": f"接受底线：{rule['说法'][:40]}……", "通过": ok, "说明": note})
    rejected = rejected_calls(sim)
    facts["被工具拒绝"] = rejected
    comp = library.completion(db_dir, task["任务编号"], definition, counts)
    if comp is None:
        facts["完成条件"] = None
    else:
        states = [c.get("state") or ("met" if c["met"] else "unmet") for c in comp["conditions"]]
        empty = states.count("empty")
        facts["完成条件"] = (f"还差 {states.count('unmet')} 项" if "unmet" in states else "都已满足") + \
            (f"；另有 {empty} 项因集合暂无条目暂不需要核对" if empty else "")
    return checks, facts


def judge(sim: Path, persona_path: Path | None = None, summary_line: bool = True) -> Path:
    data = load(sim, persona_path)
    first = layer1(data)
    state = validity(first)
    data["作废起始轮"] = state["作废起始轮"]
    second, facts = layer2(data)
    valid = state["有效性"] == "有效"
    volunteered = [d for d in disclosures(data["persona"], data["record"], sim / "库副本") if d["情形"] == VOLUNTEERED]
    record = data["record"]
    lines = [f"# 判定报告：{record['演练']}", "",
             f"- 演练目标：{record.get('演练目标')}",
             f"- 用户画像：{record.get('用户画像')}" + (f"（本次判定用的画像：{Path(persona_path).name}，是重判）" if persona_path else ""),
             f"- 任务：{record.get('任务编号')}；执行者会话 {record.get('执行者会话')}；用户 agent 会话 {record.get('用户 agent 会话')}",
             f"- 代码版本：提交 {(record.get('代码版本') or {}).get('提交号') or '没有记'}"
             + (f"，另有未提交的改动 {len((record.get('代码版本') or {}).get('未提交的改动') or [])} 个文件" if (record.get('代码版本') or {}).get('未提交的改动') else ""),
             f"- 执行者实际的工具清单：{'、'.join(record.get('执行者工具清单') or []) or '没有记'}",
             f"- Langfuse 环境标签：{record.get('Langfuse 环境标签')}", f"- 停止原因：{facts.get('停止原因')}；轮数：{facts.get('轮数')}",
             f"- {state['说明']}", "",
             "## 第一层：用户 agent 有没有按画像演（代码能查的两项）", ""]
    for c in first:
        lines.append(f"- {'通过' if c['通过'] else '不通过'}：{c['项']}。{c['说明']}" + (f" 细节：{json.dumps(c['细节'], ensure_ascii=False)}" if c.get("细节") else ""))
    lines += ["", "## 用户主动补充（不算问出，也不算演错）", "",
              "执行者上一轮摆出的内容里提到了这件事（例如回复正文、告知里写到了），但它的主行为没有针对这件事问，用户 agent 借机说了出来。", ""]
    lines += [f"- 第 {d['轮']} 轮：「{d['事实'][:30]}……」。用户 agent 的话：{d['用户 agent 的话']}" for d in volunteered] or ["- 没有。"]
    lines += ["", "## 第二层：库里的事实", ""]
    if state["有效性"] == "部分有效":
        lines += [f"部分有效：隐藏事实一项按轮判（第 {state['作废起始轮']} 轮起说出的不算）；其余各项按演练结束时的库判定，"
                  "含作废轮次之后的改动，只作参考。", ""]
    for c in second:
        lines.append(f"- {'通过' if c['通过'] else '不通过'}：{c['项']}。{c['说明']}" + (f" 细节：{json.dumps(c['细节'], ensure_ascii=False)}" if c.get("细节") else ""))
    lines += ["", "## 其他事实", "",
              f"- 各集合条目数：{facts.get('条目数')}", f"- 来源种类（最新内容）：{facts.get('来源种类')}",
              f"- 「执行者补充」来源：最新内容 {(facts.get('来源种类') or {}).get('执行者补充')} 条，全部修订累计 {facts.get('执行者补充累计')} 条",
              f"- 执行者用 read 读材料的次数：{facts.get('执行者读材料')}",
              f"- 完成条件：{facts.get('完成条件')}（只说明离完成还差几项，不代表交付质量）",
              f"- 执行者被工具拒绝 {len(facts.get('被工具拒绝') or [])} 次：" + ("；".join(f"{r['工具']}：{r['原因']}" for r in facts.get("被工具拒绝") or []) or "没有"),
              "", "## 每轮双方原话", ""]
    for turn in record.get("轮") or []:
        user = turn.get("用户 agent") or {}
        respond = user.get("respond") or {}
        sent = respond.get("sent") or {}
        clicked = {"mark_viewed": "这几条都看过了", "confirm": "确认", "keep_pending": "先不管"}.get(sent.get("kind"))
        said = sent.get("text") or (f"点了「{clicked}」：{sent.get('targets')}" if clicked else "（没有发话）")
        flag = "；表示目标达成" if respond.get("done") else f"；放弃：{respond.get('reason')}" if respond.get("give_up") else ""
        lines.append(f"### 第 {turn['轮']} 轮")
        lines.append(f"- 用户 agent（看了 {len(user.get('looks') or [])} 次界面，细看了 {[x for x in user.get('looks') or [] if x]}）：{said}{flag}")
        for r in (turn.get("执行者") or {}).get("replies") or []:
            act = r.get("act")
            lines.append(f"- 执行者{'（经回复工具）' if r.get('via_reply_tool') else '（没有经回复工具）'}：{r.get('text')}" +
                         (f"【{act.get('kind')}：{act.get('text')}】" if act else ""))
    path = Path(sim) / "判定报告.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    summary = {"演练": record["演练"], "用户画像": record.get("用户画像"), "有效": valid, "有效性": state["有效性"],
               "作废起始轮": state["作废起始轮"], "用户主动补充": [{"轮": d["轮"], "事实": d["事实"]} for d in volunteered],
               "停止原因": facts.get("停止原因"),
               "轮数": facts.get("轮数"), "第一层": {c["项"]: c["通过"] for c in first}, "第二层": {c["项"]: c["通过"] for c in second},
               "隐藏事实": [{"写进了条目": f["写进了条目"], "问出来了": f["问出来了"], "主动说出的轮次": f["用户 agent 主动说出的轮次"],
                             "说出的轮次": f["用户 agent 说出的轮次"], "情形": f["情形"], "在作废轮次里": f["在作废轮次里"]}
                            for f in facts.get("隐藏事实") or []],
               "被工具拒绝次数": len(facts.get("被工具拒绝") or []), "来源种类": facts.get("来源种类"),
               "执行者补充累计": facts.get("执行者补充累计"), "执行者读材料": facts.get("执行者读材料"), "重判": bool(persona_path)}
    (Path(sim) / "判定摘要.json").write_text(json.dumps(dict(summary, 第一层说明={c["项"]: c["说明"] for c in first},
                                                           第二层说明={c["项"]: c["说明"] for c in second}),
                                                      ensure_ascii=False, indent=1), encoding="utf-8")
    if summary_line:
        with open(Path(sim).parent / "sim-summary.jsonl", "a", encoding="utf-8") as out:
            out.write(json.dumps(summary, ensure_ascii=False) + "\n")
    return path


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="对一次演练做两层判定，写判定报告.md")
    parser.add_argument("sim")
    parser.add_argument("--persona", default=None, help="用这份画像判定（重判旧演练时用）；不给就用演练目录里的画像副本")
    parser.add_argument("--no-summary", action="store_true", help="不往 sim-summary.jsonl 追加")
    args = parser.parse_args()
    print(judge(Path(args.sim), Path(args.persona) if args.persona else None, not args.no_summary))
