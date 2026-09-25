"""过程摘要：一次工作做了几步、用了多久、合并后的阶段。

从 pi 的会话文件算：会话文件是 pi 自己归档的事件，按先后记着每条用户的话、每条助手消息里的工具调用、每个工具结果，
都带时刻。一次工作从一句用户的话开始，到下一句用户的话之前为止（兜底追加的那句固定文字不算用户的话）。
这样刷新之后也能从文件重算，不用另存；实时的那一份在工作结束时由 executor 用同一个函数算出来推给前端。

· 步数：这次工作里工具调用的次数（与实时的 step 行数一致）。
· 用时：从那句用户的话到这次工作最后一个条目的时刻。
· 阶段：每个工具调用写成一句（与实时 step 行同一套写法，见 step_text），相邻的同类调用合成一句，
  例如连着读了三份材料写成「读了材料《a》、《b》、《c》」。被拒的调用单独成一句，不与成功的合并。
  保存修订被拒时，这一句写「保存修订被拒：」加第一条原因的事实，阶段另有 reasons 列出全部原因的事实（见 rejection_reasons）。
  拒绝原因分两层：事实（改了什么、为什么不行，面向人）与指引（接下来该怎么做，只给助手）；摘要与展开都只用事实。
· 工作编号：写成「w-{那句用户的话的会话条目编号}」。刷新时从会话文件算，并把这次工作里的回复的 work_id 补成同一个；
  实时推送时执行者看护在那句话并入会话之后也改用这个编号（executor.py），所以刷新前后同一次工作的编号一致。
  修订日志按它把修订归到工作，前端据此在回复底部写「产生了修订 N」。
· 理解为：执行者对触发这次工作的那句话写下的理解（agent 侧记在任务库的 USER_INTENT_RECORDED 事件与对话行为表里），
  拼成一行「理解为：……」，放在摘要的 understanding 一项里，前端显示在「助手做了 N 步」之前。见 understanding_lines。
"""

from __future__ import annotations

import functools
import json
import re
from pathlib import Path

from taskwright_server.service import clock

REPLY_TOOL = "reply"
#: 这一轮只记了 USER_INTENT_INVALID、还没有一份有效理解时，「理解为」那一行的说法。
INTENT_INVALID_TEXT = "助手的理解没有按格式写，正在重写"
#: 把握的三档，按从低到高排；「理解为」那一行取各条里最低的一档，高时不括注。
CONFIDENCE_ORDER = ("low", "medium", "high")
CONFIDENCE_NOTE = {"low": "（把握低）", "medium": "（把握中）", "high": ""}
OP_WORDS = {"add": "新增", "update": "修改", "delete": "删除", "restore": "恢复"}
SAVE_REJECTED_HEAD = "这次「保存修订」什么都没有写入"
SAVE_REJECTED_TAIL = "\n请把这些地方改正之后"


#: 拒绝正文里每个操作那一行开头的标签，例如「操作 1（修改，条目 TBD-001）：」；事实不带它。
OP_LABEL = re.compile(r"^操作 \d+(?:（[^）]*）)?：")
#: 指引那一行的开头（agent/src/lib/save_revision.ts 的 GUIDANCE_PREFIX）。
GUIDANCE_PREFIX = "怎么办："


def rejection_parts(details: dict | None, text: str) -> list[dict]:
    """保存修订被拒时逐条的原因，一个操作一条，每条 {fact, guidance}。

    保存修订拒绝时是抛出错误，pi 给的工具结果里 details 是空的，原因只在结果正文里：
    开头一句「这次「保存修订」什么都没有写入，因为有 N 个操作不对：」，下面每个操作一段：
    「- 操作 N（……）：事实」，下一行「  怎么办：指引」（没有指引的只有第一行），最后一句「请把这些地方改正之后……」。
    事实去掉「操作 N（……）：」这个标签；早先版本的正文没有指引一行，整行（去掉标签）当作事实。
    details 里已经带了 reasons 的（实时推送时 executor 先算好）直接用。不是这种正文时返回空列表。
    """
    given = (details or {}).get("reasons")
    if isinstance(given, list) and given:
        return [one if isinstance(one, dict) else {"fact": str(one), "guidance": ""} for one in given]
    if not text.startswith(SAVE_REJECTED_HEAD):
        return []
    body = text.split("\n", 1)[1] if "\n" in text else ""
    body = body.split(SAVE_REJECTED_TAIL, 1)[0]
    out = []
    for block in re.split(r"(?:^|\n)- ", body):
        if not block.strip():
            continue
        lines = block.split("\n")
        guidance = next((line.strip()[len(GUIDANCE_PREFIX):] for line in lines[1:] if line.strip().startswith(GUIDANCE_PREFIX)), "")
        out.append({"fact": OP_LABEL.sub("", lines[0].strip()), "guidance": guidance})
    return out


def rejection_reasons(details: dict | None, text: str) -> list[str]:
    """保存修订被拒时逐条原因的事实（给人看的那一层），一个操作一条。"""
    return [one["fact"] for one in rejection_parts(details, text)]


def result_text(result: dict) -> str:
    """工具结果正文里的文字部分，连成一段。"""
    content = result.get("content")
    if isinstance(content, str):
        return content
    return "\n".join(part.get("text") or "" for part in content or [] if isinstance(part, dict) and part.get("type") == "text")


def read_kind(path: str, definition: dict) -> tuple[str, str]:
    """读的是什么：（种类, 显示的名字）。种类用来判断相邻两次读能不能合成一句。"""
    name = Path(path).name
    materials = definition.get("材料目录") or "inputs/"
    if ".pi/skills/" in path or path.endswith("SKILL.md"):
        return "方法说明", "方法说明"
    if any(path.endswith(r) or r in path for r in definition.get("领域规矩") or []):
        return "领域规矩", f"《{name}》"
    if "task-definitions/" in path:
        return "任务定义", "任务定义"
    if f"/{materials}" in path or path.startswith(materials):
        return "材料", f"《{name}》"
    return "文件", f"《{name}》"


def step_text(tool: str, args: dict, done: bool, failed: bool, details: dict | None, definition: dict) -> str:
    """一次工具调用写成一句话：进行中、做完、失败三种说法。实时的 step 行与过程摘要共用。"""
    if tool == "read":
        kind, name = read_kind(str(args.get("path") or ""), definition)
        what = name if kind in ("方法说明", "任务定义") else f"{'领域规矩' if kind == '领域规矩' else kind}{name}"
        return f"读{what}没有读成" if failed else (f"读了{what}" if done else f"正在读{what}")
    if tool == "ls":
        return "看目录没有看成" if failed else ("看了目录" if done else "正在看目录")
    if tool == "save_revision":
        if failed:
            reasons = rejection_reasons(details, "")
            if not reasons:
                return "保存修订被拒，助手正在照原因改"
            first = reasons[0].split("\n", 1)[0]
            more = f"（还有 {len(reasons) - 1} 条）" if len(reasons) > 1 else ""
            return f"保存修订被拒：{first}{more}"
        if not done:
            return "正在保存修订"
        ops = (details or {}).get("operations") or []
        grouped: dict[str, list[str]] = {}
        for op in ops:
            grouped.setdefault(f"{OP_WORDS.get(op.get('op'), op.get('op'))}{op.get('collection')}", []).append(op.get("item"))
        parts = [f"{k} {len(v)} 个（{v[0] if len(v) == 1 else v[0] + ' 到 ' + v[-1]}）" for k, v in grouped.items()]
        return f"写好并保存了修订 {(details or {}).get('revision_no')}：" + "；".join(parts)
    if tool == "get_item":
        item = args.get("item_id") or ""
        return f"查看条目 {item} 没有成" if failed else (f"查看了条目 {item}" if done else f"正在查看条目 {item}")
    if tool == "get_task_status":
        return "查看任务状态没有成" if failed else ("查看了任务状态" if done else "正在查看任务状态")
    if tool == "complete_task":
        return "完成任务被拒，完成条件还没满足" if failed else ("把任务标为已完成" if done else "正在完成任务")
    if tool == "request_review":
        if failed:
            return "请评审者评审没有做成"
        if not done:
            return "正在请评审者评审"
        results = (details or {}).get("results") or []
        bad = sum(1 for r in results if r.get("status") == "不合规")
        return f"评审了 {len(results)} 个条目，{bad} 个不合规"
    if tool == REPLY_TOOL:
        return "回复的形式不对，助手正在改" if failed else ("说完了" if done else "正在组织回复")
    return f"调用 {tool} 失败" if failed else (f"调用了 {tool}" if done else f"正在调用 {tool}")


def stages(calls: list[dict], definition: dict) -> list[dict]:
    """把一次工作的全部工具调用合成阶段。calls 每项是 {tool, args, failed, details}，按先后排。

    保存修订被拒的阶段多一项 reasons：全部原因（字符串列表），前端在原因多于一条时让这一行可以展开。
    """
    out: list[dict] = []
    last_key = None
    for c in calls:
        tool, args, failed = c["tool"], c.get("args") or {}, bool(c.get("failed"))
        if failed:
            key = None
            text = step_text(tool, args, True, True, c.get("details"), definition)
            reasons = rejection_reasons(c.get("details"), "") if tool == "save_revision" else []
            if reasons:
                out.append({"text": text, "count": 1, "names": [], "_key": key, "reasons": reasons})
                last_key = key
                continue
        elif tool == "read":
            kind, name = read_kind(str(args.get("path") or ""), definition)
            key = ("read", kind)
            if last_key == key and kind in ("材料", "领域规矩", "文件"):
                out[-1]["names"].append(name)
                out[-1]["count"] += 1
                label = "领域规矩" if kind == "领域规矩" else kind
                out[-1]["text"] = f"读了{label}" + "、".join(out[-1]["names"])
                continue
            text = step_text(tool, args, True, False, c.get("details"), definition)
            out.append({"text": text, "count": 1, "names": [name], "_key": key})
            last_key = key
            continue
        elif tool in ("ls", "get_task_status", REPLY_TOOL):
            key = (tool,)
            if last_key == key:
                out[-1]["count"] += 1
                continue
            text = "组织并发出了回复" if tool == REPLY_TOOL else step_text(tool, args, True, False, c.get("details"), definition)
        else:
            key = None
            text = step_text(tool, args, True, False, c.get("details"), definition)
        out.append({"text": text, "count": 1, "names": [], "_key": key})
        last_key = key
    return [{"text": s["text"], "count": s["count"], **({"reasons": s["reasons"]} if s.get("reasons") else {})} for s in out]


#: 理解格式的 schema：用户行为各功能的中文名只写在这里（$defs.user_function 的 x-names），这里不另抄一份。
INTENT_SCHEMA_PATH = Path(__file__).resolve().parents[3] / "agent" / "prompts" / "schemas" / "user_intent.schema.json"


@functools.cache
def function_names() -> dict[str, str]:
    """用户行为各功能的中文名，键是英文码，取自理解格式的 schema。读不到时为空，这一行只写摘要。"""
    try:
        schema = json.loads(INTENT_SCHEMA_PATH.read_text(encoding="utf-8"))
        return dict(schema["$defs"]["user_function"]["x-names"])
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def act_text(act: dict) -> str:
    """一条用户行为在「理解为」一行里的写法：「中文名（英文码）摘要」，例如「同意（affirm）UC-001、UC-002 的当前修订」。"""
    summary = str(act.get("summary") or "").strip()
    code = act.get("function")
    name = function_names().get(code) if code else None
    return f"{name}（{code}）{summary}" if name else summary


def understanding_text(acts: list[dict]) -> str | None:
    """一份理解写成一行：各条用户行为按记录顺序写成「中文名（英文码）摘要」，用「；」连起来，把握取最低的一档，中或低时括注。"""
    summaries = [act_text(a) for a in acts if str(a.get("summary") or "").strip()]
    if not summaries:
        return None
    levels = [a.get("confidence") for a in acts if a.get("confidence") in CONFIDENCE_ORDER]
    lowest = min(levels, key=CONFIDENCE_ORDER.index) if levels else "high"
    return "理解为：" + "；".join(summaries) + CONFIDENCE_NOTE[lowest]


def understanding_lines(task_dir: Path | None, session_id: str) -> dict[str, str | None]:
    """这条会话里每句用户的话（按会话条目编号）对应的「理解为」那一行。

    从任务库的事件表读：这句话有 USER_INTENT_RECORDED 时拼理解（事件内容里的各条行为，缺把握时到对话行为表里按编号查）；
    那条事件是界面合成的（origin 为 ui，点卡片、「这几条都看过了」「先不管」之后替用户发的话）时这句话不显示这一行，值为 None；
    只有 USER_INTENT_INVALID 时写 INTENT_INVALID_TEXT。没有库、没有这两种事件的旧库，返回空字典。只读，不改任何东西。
    """
    if task_dir is None:
        return {}
    from taskwright_server.service import library
    conn = library.open_ro(Path(task_dir))
    if conn is None:
        return {}
    out: dict[str, str | None] = {}
    try:
        rows = conn.execute("SELECT name, payload FROM event WHERE session_id = ? AND name IN ('USER_INTENT_RECORDED', 'USER_INTENT_INVALID') "
                            "ORDER BY seq", (session_id,)).fetchall()
        has_acts = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dialogue_act'").fetchone() is not None
        for name, payload in rows:
            data = library._json(payload) or {}
            entry = data.get("user_entry")
            if not entry:
                continue
            if name == "USER_INTENT_INVALID":
                out.setdefault(entry, INTENT_INVALID_TEXT)
                continue
            if data.get("origin") == "ui":
                out[entry] = None
                continue
            acts = [dict(a) for a in data.get("acts") or [] if isinstance(a, dict)]
            for act in acts:
                if act.get("confidence") is None and has_acts and act.get("act_id"):
                    found = conn.execute("SELECT confidence FROM dialogue_act WHERE session_id = ? AND act_id = ?",
                                         (session_id, act["act_id"])).fetchone()
                    act["confidence"] = found[0] if found else None
            out[entry] = understanding_text(acts)
    except Exception:       # 读不出来只是少这一行，不影响摘要
        return out
    finally:
        conn.close()
    return out


def _is_fallback(entry: dict, fallback_text: str, text_of) -> bool:
    m = entry.get("message") or {}
    return m.get("role") == "user" and text_of(m.get("content")) == fallback_text


def works_from_entries(path_entries: list[dict], definition: dict, fallback_text: str, text_of) -> list[dict]:
    """从当前分支上的会话条目切出每一次工作，算出过程摘要。

    返回的每项：work_id、user_message_id、reply_ids（这次工作里的回复所在的会话条目编号）、call_ids（这次工作里全部工具调用的
    调用编号，修订日志据此把一次修订归到产生它的那次工作）、at、seconds、step_count、stages。
    没有调用过工具、也没有回复的那一段不算一次工作（例如用户说话之后 pi 还没来得及应答）。
    """
    results: dict[str, dict] = {}
    for e in path_entries:
        m = e.get("message") or {}
        if e.get("type") == "message" and m.get("role") == "toolResult":
            results[m.get("toolCallId", "")] = m
    works: list[dict] = []
    current: dict | None = None

    def close():
        if current and (current["calls"] or current["reply_ids"]):
            start = clock.parse_utc_iso(current["start"])
            end = clock.parse_utc_iso(current["end"])
            seconds = round(end - start, 1) if start is not None and end is not None else None
            works.append({"work_id": f"w-{current['user_message_id']}", "user_message_id": current["user_message_id"],
                          "reply_ids": current["reply_ids"], "call_ids": current["call_ids"], "at": clock.from_utc_iso(current["end"]), "seconds": seconds,
                          "step_count": len(current["calls"]), "stages": stages(current["calls"], definition)})

    for e in path_entries:
        if e.get("type") != "message":
            continue
        m = e.get("message") or {}
        role = m.get("role")
        if role == "user" and not _is_fallback(e, fallback_text, text_of):
            close()
            current = {"user_message_id": e.get("id"), "start": e.get("timestamp"), "end": e.get("timestamp"), "calls": [], "reply_ids": [], "call_ids": []}
            continue
        if current is None:
            continue
        current["end"] = e.get("timestamp") or current["end"]
        if role != "assistant":
            continue
        for part in m.get("content") or []:
            if not (isinstance(part, dict) and part.get("type") == "toolCall"):
                continue
            result = results.get(part.get("id")) or {}
            failed = bool(result.get("isError"))
            current["call_ids"].append(part.get("id"))
            details = result.get("details") or {}
            if failed and part.get("name") == "save_revision":
                details = {**details, "reasons": rejection_parts(details, result_text(result))}
            current["calls"].append({"tool": part.get("name") or "", "args": part.get("arguments") or {}, "failed": failed,
                                     "details": details})
            if part.get("name") == REPLY_TOOL and result and not failed:
                current["reply_ids"].append(e.get("id"))
    close()
    return works
