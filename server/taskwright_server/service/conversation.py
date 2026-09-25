"""把 pi 会话文件（或 RPC 的 get_entries 返回的条目）拼成对话记录（docs/api.md §4.1 的 conversation）。

只取当前分支：从最后一个条目沿 parentId 回溯到根。message_id 就是会话条目的编号。呈现规则：

- 用户消息 → user_message。文字以「用户说：/」开头的，是后端给用户打的斜杠开头的字加的前缀，显示时去掉前缀；
  紧跟在 taskwright-ui-click 自定义消息后面、文字与它记的那句相同的，合成一条 origin 为 card_choice 的用户消息；
  文字与「确认之后通知执行者」的模板相符、并且紧跟在确认的 taskwright-user-edit 后面的，origin 为 ui_request。
- 「回复」工具一次成功的调用 → assistant_reply（via_reply_tool 为真，message_id 是那条助手消息的条目编号）；
  一段用户消息之后没有成功的回复、只有助手正文的，取这段里最后一条有正文的助手消息，via_reply_tool 为假。
- taskwright-user-edit → ui_action_noted；taskwright-task-status → system_note。
"""

from __future__ import annotations

import json
from pathlib import Path

from taskwright_server.service import clock

SLASH_PREFIX = "用户说："
UI_CLICK = "taskwright-ui-click"
USER_EDIT = "taskwright-user-edit"
TASK_STATUS = "taskwright-task-status"
REPLY_TOOL = "reply"
#: 卡片上点「这几条都看过了」之后，扩展按固定模板替用户发给执行者的那句话的开头（agent/src/lib/user_ops.ts 的 VIEWED_NOTICE_PREFIX）。
#: 早期版本的会话里是界面确认之后那句「我已经在界面上确认了：」，读旧会话时照样认。
NOTIFY_PREFIXES = ("我已经看过了：", "我已经在界面上确认了：")
#: 会带那句话的直接操作种类：现在是 mark_viewed，早期版本是 confirm。
NOTIFY_KINDS = ("mark_viewed", "confirm")

#: 「回复」工具的兜底扩展（agent/src/hooks/reply_fallback.ts 的 FALLBACK_TEXT）追加的那句固定文字。它在会话里是一条
#: 普通的用户消息，但不是用户说的：按固定文字认出，显示成系统说明。两边的文字要一起改。
FALLBACK_TEXT = "请用 reply 工具把要对用户说的话发出来"


def normalize_informs(informs) -> list[dict]:
    """回复里的告知一律整理成 {"text": …, "items": […]}（没有点名条目时不带 items）交给前端。
    旧的会话记录里一条告知是一句纯文字，新的是带 items 的对象；两种都认，认不出的丢掉。"""
    out = []
    for one in informs or []:
        if isinstance(one, str):
            out.append({"text": one})
        elif isinstance(one, dict) and isinstance(one.get("text"), str):
            items = [i for i in (one.get("items") or []) if isinstance(i, dict) and i.get("item_id")]
            out.append({"text": one["text"], **({"items": items} if items else {})})
    return out


def fallback_note_text(raw: str) -> str:
    return f"助手这次没有用回复工具说话，系统自动提醒了它一句：「{raw}」。这句不是你说的。"


def read_session_file(path: Path) -> list[dict]:
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def branch(entries: list[dict]) -> list[dict]:
    body = [e for e in entries if e.get("type") != "session" and e.get("id")]
    if not body:
        return []
    by_id = {e["id"]: e for e in body}
    out, cur = [], body[-1]
    while cur:
        out.append(cur)
        cur = by_id.get(cur.get("parentId"))
    return out[::-1]


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in (content or []) if isinstance(p, dict) and p.get("type") == "text")


def display_text(raw: str) -> str:
    """用户打的以斜杠开头的字，后端发给 pi 时前面加了「用户说：」；界面上仍显示原来打的字。"""
    return raw[len(SLASH_PREFIX):] if raw.startswith(SLASH_PREFIX + "/") else raw


def messages(entries: list[dict], session_id: str, definition: dict | None = None, task_dir: Path | None = None) -> list[dict]:
    """当前分支上的对话记录，按先后排。每次工作的过程摘要插在这次工作的回复之前，回复的 work_id 补上（见 work_summary.py）。
    给了任务目录时，摘要另带 understanding（「理解为」那一行，从任务库读）。"""
    path = branch(entries)
    out = _messages(path, session_id)
    return with_work_summaries(out, path, session_id, definition or {}, task_dir)


def with_work_summaries(out: list[dict], path: list[dict], session_id: str, definition: dict, task_dir: Path | None = None) -> list[dict]:
    """把从会话条目算出的过程摘要插进对话记录：放在这次工作第一条回复之前；这次工作没有回复时，放在下一句用户的话之前。"""
    from taskwright_server.service import work_summary
    understandings = work_summary.understanding_lines(task_dir, session_id)
    for work in work_summary.works_from_entries(path, definition, FALLBACK_TEXT, text_of):
        replies = set(work["reply_ids"])
        for m in out:
            if m["type"] == "assistant_reply" and m["message_id"] in replies:
                m["work_id"] = work["work_id"]
        summary = {"type": "work_summary", "session_id": session_id, "message_id": f"summary-{work['user_message_id']}",
                   "work_id": work["work_id"], "at": work["at"], "seconds": work["seconds"], "step_count": work["step_count"],
                   "stages": work["stages"], "understanding": understandings.get(work["user_message_id"])}
        ids = [m.get("message_id") for m in out]
        first_reply = next((i for i, m in enumerate(out) if m["type"] == "assistant_reply" and m["message_id"] in replies), None)
        if first_reply is None:
            start = ids.index(work["user_message_id"]) if work["user_message_id"] in ids else len(out) - 1
            first_reply = next((i for i in range(start + 1, len(out)) if out[i]["type"] == "user_message"), len(out))
        out.insert(first_reply, summary)
    return out


def _messages(path: list[dict], session_id: str) -> list[dict]:
    results: dict[str, dict] = {}
    for e in path:
        if e.get("type") == "message" and (e.get("message") or {}).get("role") == "toolResult":
            m = e["message"]
            results[m.get("toolCallId", "")] = m
    out: list[dict] = []
    pending_click: dict | None = None
    last_confirm: dict | None = None
    segment_replied = True
    segment_last_text: dict | None = None

    def close_segment():
        # 一段用户消息之后没有成功的回复：取这段最后一条有正文的助手消息作兜底回复。
        nonlocal segment_last_text
        if not segment_replied and segment_last_text is not None:
            position = segment_last_text.pop("_pos")
            out.insert(position, segment_last_text)     # 放回它在分支上的位置，不排到后来的界面操作后面
        segment_last_text = None

    for e in path:
        kind = e.get("type")
        at = clock.from_utc_iso(e.get("timestamp"))
        if kind == "custom_message":
            ctype = e.get("customType")
            details = e.get("details") or {}
            if ctype == UI_CLICK:
                pending_click = e
            elif ctype == USER_EDIT:
                seqs = details.get("event_seqs") or []
                out.append({"type": "ui_action_noted", "session_id": session_id, "message_id": e["id"], "at": at,
                            "text": text_of(e.get("content")), "event_seq": seqs[0] if seqs else None,
                            "undoable": bool(details.get("undoable")), "op_id": details.get("op_id"),
                                                  "revision_no": details.get("revision_no"),
                            "kind": details.get("kind"), "review": details.get("review")})
                last_confirm = e if details.get("kind") in NOTIFY_KINDS else None
            elif ctype == TASK_STATUS:
                out.append({"type": "system_note", "session_id": session_id, "message_id": e["id"], "at": at,
                            "text": text_of(e.get("content"))})
            continue
        if kind != "message":
            continue
        m = e.get("message") or {}
        role = m.get("role")
        if role == "user" and text_of(m.get("content")) == FALLBACK_TEXT:
            # 兜底追加的那句：不算用户的话，也不结束这一段（之后那条回复仍是对前面那句用户的话的回答）。
            out.append({"type": "system_note", "session_id": session_id, "message_id": e["id"], "at": at,
                        "text": fallback_note_text(FALLBACK_TEXT)})
            continue
        if role == "user":
            close_segment()
            segment_replied = False
            raw = text_of(m.get("content"))
            origin, annotation = "typed", None
            click_details = (pending_click or {}).get("details") or {}
            if pending_click is not None and click_details.get("text") == raw:
                origin = "card_choice"
                annotation = {"reply_message_id": click_details.get("reply_entry"), "option_key": click_details.get("option_key"),
                              "option_text": click_details.get("option_text"), "click_message_id": pending_click["id"]}
            elif last_confirm is not None and raw.startswith(NOTIFY_PREFIXES):
                origin = "ui_request"
            pending_click = None
            last_confirm = None
            out.append({"type": "user_message", "session_id": session_id, "message_id": e["id"], "at": at,
                        "text": display_text(raw), "origin": origin, "annotation": annotation, "queued": False})
        elif role == "assistant":
            calls = [p for p in (m.get("content") or []) if isinstance(p, dict) and p.get("type") == "toolCall"]
            for call in calls:
                if call.get("name") != REPLY_TOOL:
                    continue
                result = results.get(call.get("id"))
                if result is None or result.get("isError"):
                    continue
                args = call.get("arguments") or {}
                details = result.get("details") or {}
                if details.get("degraded"):
                    # 连续被拒到上限之后放行的纯文字回复：只取成文正文，不画卡片。
                    reply = details.get("reply") or {}
                    args = {"informs": [], "act": None, "text": reply.get("text") or args.get("text") or ""}
                out.append({"type": "assistant_reply", "session_id": session_id, "message_id": e["id"], "at": at,
                            "work_id": None, "via_reply_tool": True, "informs": normalize_informs(args.get("informs")),
                            "act": args.get("act"), "text": args.get("text") or "",
                            "degraded": bool(details.get("degraded"))})
                segment_replied = True
            body = text_of(m.get("content")).strip()
            if body and not calls:
                segment_last_text = {"type": "assistant_reply", "session_id": session_id, "message_id": e["id"], "at": at,
                                     "work_id": None, "via_reply_tool": False, "informs": [], "act": None, "text": body,
                                     "_pos": len(out)}
    close_segment()
    return out


def page(all_messages: list[dict], before: str | None = None, limit: int = 100) -> dict:
    """取一段对话：before 给了就取它之前的 limit 条，否则取最近的 limit 条。"""
    items = all_messages
    if before:
        ids = [m["message_id"] for m in items]
        items = items[: ids.index(before)] if before in ids else items
    chosen = items[-limit:] if limit > 0 else []
    return {"messages": chosen, "has_earlier": len(items) > len(chosen), "earliest_id": chosen[0]["message_id"] if chosen else None}


def session_info(path: Path) -> dict:
    """会话列表里的一行：编号、名字（会话文件里最后一条 session_info 的名字）、开始时刻、最近活动、消息条数。"""
    entries = read_session_file(path)
    header = next((e for e in entries if e.get("type") == "session"), {})
    name = None
    last = header.get("timestamp")
    count = 0
    for e in entries:
        if e.get("type") == "session_info" and e.get("name"):
            name = e["name"]
        if e.get("type") in ("message", "custom_message"):
            last = e.get("timestamp") or last
            if e.get("type") == "message" and (e.get("message") or {}).get("role") in ("user", "assistant"):
                count += 1
    return {"session_id": header.get("id", ""), "name": name, "started_at": clock.from_utc_iso(header.get("timestamp")),
            "last_active_at": clock.from_utc_iso(last), "message_count": count, "file": str(path)}
