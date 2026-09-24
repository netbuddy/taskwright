"""读归档目录：后端归档的 pi 原始事件流，加 pi 自己写的会话文件。

归档目录里有两个子目录：

    pi-events/<归档名>-<年月日>-<时分秒>.jsonl    后端把 pi 标准输出里的每一行原样抄下来的归档。
                                                   启动一次 pi 进程就有一个文件。
    pi-sessions/<归档名>/<时刻>_<会话编号>.jsonl   pi 自己写的会话文件。重启并接回原会话时，
                                                   pi 接着往同一个文件里写，所以一条会话只有一个。

每个归档文件旁边还有两份后端写的附带文件：`.backend.jsonl` 是后端补记（启动命令、实际工具清单、
后端发过哪几条提示、界面请求应答、标准错误、退出码），`.times.jsonl` 是收到时刻索引
（它的第 N 行对应归档的第 N 行）。

本模块把这些读成下面这几层，层的名字与 pi 官方文档里的名字一一对应：

    一次 pi 进程启动（这是后端的概念，不是 pi 的）
      会话 session（pi 的概念）
        一次运行 agent run（pi）：由一次提示 prompt 触发，从 agent_start 到 agent_settled
          轮 turn（pi）：从 turn_start 到 turn_end，一轮是一条助手响应加它引出的工具调用与结果
            模型请求 provider request（pi）：一轮平时一次，自动重试时一轮多次
            工具调用 tool call（pi）

有两处 pi 的概念在 RPC 模式（remote procedure call mode，远程过程调用模式：pi 不画界面，
改成按行收发 JSON）的事件流里拿不到。观测台自己数，并在界面上说明这是数出来的：

1. 轮号 turnIndex 只出现在扩展接口里（`docs/extensions.md` 第 607 行），RPC 的 turn_start 与
   turn_end 不带它（`docs/rpc.md` 第 913 到 927 行）。现在由进程内那个只读小扩展在每一轮开始时
   报出来，后端记进补记，所以新归档里的轮号是 pi 给的。早先的归档没有这一条，那些轮仍按
   turn_start 出现的先后从 0 起数，界面上会注明「这个轮号是观测台按先后数出来的，不是 pi 给的」。
2. before_provider_request 与 after_provider_response 这一对事件也只在扩展接口里有
   （`docs/extensions.md` 第 705、722 行）。观测台改数「带响应编号 responseId 的助手消息」：
   有响应编号就说明真的发生过一次模型响应。一次模型请求的起止，取这条助手消息的
   `message_start` 与 `message_end` 两行的收到时刻；一轮里出现不止一对，就说明这一轮里
   发生过不止一次模型请求（自动重试就是这样）。早先的归档里没有这两条消息事件，
   那时退回到从 `turn_end` 取这一次模型响应的事实，耗时显示「未知」。

本模块不认识任何具体的工具名、字段名与任务名，也不打开任何数据库。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from taskwright_observatory.shared import (
    UNKNOWN, epoch_from_iso, epoch_from_millis, shorten_home,
    text_of_content, tool_calls_of_content,
)

#: 归档文件名的样子：归档名在前，后面跟着后端给它加的年月日与时分秒。
ARCHIVE_NAME = re.compile(r"^(?P<run>.+)-(?P<date>\d{8})-(?P<time>\d{6})$")

#: 这几种界面请求是扩展在向人提问，pi 会一直等着回答，后端必须替人回一个，否则会话卡住。
DIALOG_METHODS = ("select", "confirm", "input", "editor")

#: 进程内那个只读小扩展在每一轮开始时报事实用的状态栏键名。三处是一份约定：
#: agent/src/hooks/report_to_backend.ts、server/taskwright_server/pi_session.py、这里。
TURN_STATUS_KEY = "taskwright-turn"

#: 读进来的每条事件上，观测台额外挂两个键：它在归档里的行号，与后端读到它的时刻。
#: 两个键都带下划线前缀，与 pi 自己的字段区分开。归档文件本身一个字都没有改。
LINE_KEY = "__行号"
RECEIVED_KEY = "__收到时刻"


def read_jsonl(path: Path) -> tuple[list[dict], list[str]]:
    """一行一行读一个 JSON 行文件。读不懂的行不当错误，原样收着一并交出去。"""
    records: list[dict] = []
    bad: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return records, bad
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            bad.append(line)
            continue
        if isinstance(value, dict):
            records.append(value)
        else:
            bad.append(line)
    return records, bad


def _shorten_paths(value):
    """后端补记里记的是本机的完整路径。界面上把家目录那一段换成波浪号，短一些也好读一些。"""
    if isinstance(value, str):
        return shorten_home(value)
    if isinstance(value, list):
        return [_shorten_paths(one) for one in value]
    if isinstance(value, dict):
        return {key: _shorten_paths(one) for key, one in value.items()}
    return value


#: 「展开看带过去的这几条消息」里最多列几条。再往前的不列，免得把整条会话抄一遍。
RECENT_MESSAGES = 5

#: pi 的三种消息角色在界面上怎么称呼。这三个词与概念对照页上的一致。
ROLE_NAMES = {"user": "用户消息", "assistant": "助手消息", "toolResult": "工具结果消息"}


def _message_summary(message: dict) -> dict:
    """把一条消息压成一行：谁说的，说了什么的开头。

    助手消息有时一个字也没有，只提出了几次工具调用，这时就如实写它提出了几次调用。
    """
    role = str(message.get("role") or "")
    text = text_of_content(message.get("content"))
    if not text:
        calls = tool_calls_of_content(message.get("content"))
        text = f"提出 {len(calls)} 个工具调用" if calls else ""
    return {"角色": ROLE_NAMES.get(role, role), "开头": text}


def _received(event: dict | None):
    """一条事件的收到时刻，也就是后端读到归档里这一行的时刻。取不到就是空值。"""
    if not event:
        return None
    return event.get(RECEIVED_KEY)


def _seconds_between(first, second) -> float | None:
    """两条事件的收到时刻相差几秒。任何一条没有收到时刻就返回空值，界面上显示「未知」。"""
    if not first or not second:
        return None
    start = first.get(RECEIVED_KEY)
    end = second.get(RECEIVED_KEY)
    if start is None or end is None:
        return None
    return round(end - start, 3)


# ───────────────────────── 一次 pi 进程启动 ─────────────────────────

def parse_archive_name(stem: str) -> tuple[str, float | None]:
    """从归档文件名里取出归档名与后端记下的启动时刻。对不上格式就只当它整个是归档名。"""
    match = ARCHIVE_NAME.match(stem)
    if not match:
        return stem, None
    import datetime as dt
    try:
        moment = dt.datetime.strptime(match["date"] + match["time"], "%Y%m%d%H%M%S")
    except ValueError:
        return match["run"], None
    return match["run"], moment.timestamp()


def read_launch(path: Path) -> dict:
    """读一个归档文件，连同它旁边那两份后端写的附带文件。

    早先跑的那些会话没有附带文件，所以取不到的一律写「未知」，不猜。
    """
    records, bad = read_jsonl(path)
    run_name, started_at = parse_archive_name(path.stem)
    notes, _ = read_jsonl(path.with_suffix(".backend.jsonl"))
    notes = [_shorten_paths(note) for note in notes]
    times, _ = read_jsonl(path.with_suffix(".times.jsonl"))
    by_line = {int(one.get("行号", 0)): one.get("收到时刻") for one in times}

    # 给每条事件挂上它的行号与收到时刻。归档文件本身没有改，这两个键只活在内存里。
    for number, record in enumerate(records, 1):
        record[LINE_KEY] = number
        record[RECEIVED_KEY] = by_line.get(number)

    session_id = ""
    session_file = ""
    for record in records:
        if record.get("type") == "response" and record.get("command") == "get_state":
            data = record.get("data") or {}
            session_id = session_id or str(data.get("sessionId") or "")
            session_file = session_file or str(data.get("sessionFile") or "")

    started_note = next((n for n in notes if n.get("记录") == "启动"), None)
    exit_note = next((n for n in notes if n.get("记录") == "退出"), None)
    tools_note = next((n for n in notes if n.get("记录") == "实际工具清单"), None)
    prompt_notes = [n for n in notes if n.get("记录") == "提示"]
    stderr_lines = [str(n.get("文字", "")) for n in notes if n.get("记录") == "标准错误"]
    answers = [n for n in notes if n.get("记录") == "界面请求应答"]
    knowledge_note = next((n for n in notes if n.get("记录") == "知识仓库摘要"), None)
    context_note = next((n for n in notes if n.get("记录") == "上下文文件"), None)
    skills_note = next((n for n in notes if n.get("记录") == "已加载的 skill"), None)

    return {
        "归档文件": path.name,
        "归档路径": shorten_home(str(path)),
        "归档名": run_name,
        "启动时刻": started_at,
        "事件行数": len(records),
        "有没有收到时刻": bool(by_line),
        "读不懂的行": bad,
        "会话编号": session_id,
        "会话文件": shorten_home(session_file),
        "事件": records,
        "后端补记": {
            "有没有": bool(notes),
            "启动": started_note,
            "退出": exit_note,
            "实际工具清单": tools_note,
            "提示": prompt_notes,
            "标准错误": stderr_lines,
            "界面请求应答": answers,
            # 下面三样是后端在启动时补记的；这件事做出来之前的归档没有它们，值是 None。
            "知识仓库摘要": knowledge_note,
            "上下文文件": context_note,
            "已加载的 skill": skills_note,
        },
    }


def scan_launches(archive_dir: Path) -> list[dict]:
    """把归档目录里 pi-events 下的每个归档文件都读成一次 pi 进程启动，按启动时刻排好。"""
    events_dir = Path(archive_dir) / "pi-events"
    if not events_dir.is_dir():
        return []
    launches = [read_launch(p) for p in sorted(events_dir.glob("*.jsonl"))
                if not p.name.endswith((".backend.jsonl", ".times.jsonl"))]
    launches.sort(key=lambda x: (x["启动时刻"] or 0.0, x["归档文件"]))
    return launches


# ───────────────────────── pi 自己的会话文件 ─────────────────────────

def read_session_file(path: Path) -> dict:
    """读 pi 的会话文件，取出会话编号与其中每一条消息的条目编号、角色、时刻。"""
    records, bad = read_jsonl(path)
    header = next((r for r in records if r.get("type") == "session"), {})
    messages = []
    customs = []
    name = ""
    for record in records:
        # 用户在产品网页里给会话起的名字记在 session_info 条目里，可以改好几次，取最后一次（与产品后端的取法相同）。
        if record.get("type") == "session_info" and record.get("name"):
            name = str(record["name"])
            continue
        if record.get("type") == "custom_message":
            # 扩展写进会话的自定义消息（例如打开会话时的任务现状消息）。交给模型时是用户角色，但不是人打的字。
            customs.append({
                "条目编号": str(record.get("id") or ""),
                "类型": str(record.get("customType") or ""),
                "时刻": epoch_from_iso(record.get("timestamp")),
                # 自定义消息的内容可以是一整段文字（扩展这样写），也可以是文字块列表。
                "文字": record["content"].strip() if isinstance(record.get("content"), str)
                        else text_of_content(record.get("content")),
            })
            continue
        if record.get("type") != "message":
            continue
        message = record.get("message") or {}
        messages.append({
            "条目编号": str(record.get("id") or ""),
            "角色": str(message.get("role") or ""),
            "时刻": epoch_from_iso(record.get("timestamp")),
            "文字": text_of_content(message.get("content")),
        })
    return {
        "会话编号": str(header.get("id") or ""),
        "会话文件": path.name,
        "会话文件路径": shorten_home(str(path)),
        "会话名": name,
        "归档名": path.parent.name,
        "开始时刻": epoch_from_iso(header.get("timestamp")),
        # pi 在会话文件头上记的当前工作目录，也就是这条会话所在的任务目录。
        "工作目录": str(header.get("cwd") or ""),
        "消息": messages,
        "自定义消息": customs,
        "读不懂的行": bad,
    }


def scan_session_files(archive_dir: Path) -> dict[str, dict]:
    """把 pi-sessions 下的会话文件都读一遍，按会话编号收起来。"""
    sessions_dir = Path(archive_dir) / "pi-sessions"
    if not sessions_dir.is_dir():
        return {}
    found: dict[str, dict] = {}
    for path in sorted(sessions_dir.glob("*/*.jsonl")):
        parsed = read_session_file(path)
        if parsed["会话编号"]:
            found[parsed["会话编号"]] = parsed
    return found


# ───────────────────────── 运行、轮、模型请求、工具调用 ─────────────────────────

#: 执行者对用户说话用的工具。与 agent 里「回复」工具的名字（REPLY_TOOL_NAME）是一份约定。
SPEAK_TOOLS = ("reply",)


def spoken_by_tool(call: dict) -> dict | None:
    """一次成功送达的「回复」：返回说的话（成文正文）、是否降级放行、它所在助手消息的会话条目编号。
    被拒的、没有执行结果的、不是说话工具的，返回 None。"""
    if call.get("工具") not in SPEAK_TOOLS or call.get("是否被拒") is not False:
        return None
    details = call.get("结果细节") or {}
    reply = details.get("reply") if isinstance(details.get("reply"), dict) else (call.get("参数") or {})
    return {"文字": str(reply.get("text") or ""), "回复": reply, "降级放行": bool(details.get("degraded")),
            "条目编号": details.get("message_id") or ""}


def speech_of_turn(turn: dict) -> dict | None:
    """这一轮执行者对用户说了什么：经「回复」工具说的优先；没有时取模型以 stop 收尾的正文。"""
    for call in reversed(turn.get("工具调用") or []):
        spoken = spoken_by_tool(call)
        if spoken and spoken["文字"].strip():
            return {**spoken, "来源": "回复工具"}
    requests = turn.get("模型请求") or []
    if turn.get("助手文字") and requests and requests[-1]["停止原因"] == "stop":
        return {"文字": turn["助手文字"], "回复": None, "降级放行": False, "条目编号": "", "来源": "模型正文"}
    return None

def _tool_call_record(call: dict, starts: dict, ends: dict) -> dict:
    """把模型发起的一次工具调用，与它的开始与结束两条执行事件合到一起。"""
    call_id = str(call.get("id") or "")
    start = starts.get(call_id)
    end = ends.get(call_id) or {}
    result = end.get("result") or {}
    texts = [b.get("text", "") for b in (result.get("content") or [])
             if isinstance(b, dict) and b.get("type") == "text"]
    has_end = "isError" in end
    return {
        "调用编号": call_id,
        "工具": str(call.get("name") or ""),
        "参数": call.get("arguments") if isinstance(call.get("arguments"), dict) else {},
        "有没有执行结果": has_end,
        "是否被拒": bool(end.get("isError")) if has_end else None,
        "结果文字": "\n".join(t for t in texts if t).strip(),
        # 工具返回的 details 原样留着：「回复」的整理后原文与是否降级放行（degraded）都在这里。
        "结果细节": result.get("details") if isinstance(result.get("details"), dict) else None,
        "耗时秒": _seconds_between(start, end),
        "开始收到时刻": _received(start),
        "结束收到时刻": _received(end),
        "归档行号": (end or start or {}).get(LINE_KEY),
        # 时间条上这一段画在第几条泳道上，由 assign_lanes 在这一轮读完之后填。
        "泳道": 1,
    }


def _provider_request(message: dict, start_event: dict | None, end_event: dict) -> dict:
    """从一条助手消息里取出这一次模型响应的事实，并算出它花了多久。

    pi 的 RPC 事件流里没有 before_provider_request 与 after_provider_response 这一对事件，
    所以观测台认的是助手消息上的响应编号 responseId：有它就说明真的发生过一次模型响应。

    耗时按后端收到这两行的时刻相减：`start_event` 是这条助手消息的 `message_start` 那一行，
    `end_event` 是它的 `message_end` 那一行。这是观测台按自己收到事件的时刻算出来的，
    不是模型服务自己报的耗时。早先的归档里没有这两条消息事件，`start_event` 就是空的，
    这时耗时显示「未知」，时间条上也不画这一段。
    """
    usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
    return {
        "响应编号": str(message.get("responseId") or ""),
        "模型": str(message.get("model") or ""),
        "供应方": str(message.get("provider") or ""),
        "接口": str(message.get("api") or ""),
        "停止原因": str(message.get("stopReason") or ""),
        "pi 给的原始停止原因": str(message.get("rawStopReason") or ""),
        "出错说明": str(message.get("errorMessage") or ""),
        "词元": usage,
        "助手消息时刻": epoch_from_millis(message.get("timestamp")),
        "开始收到时刻": _received(start_event),
        "结束收到时刻": _received(end_event),
        "耗时秒": _seconds_between(start_event, end_event),
        "开始行号": (start_event or {}).get(LINE_KEY),
        "归档行号": end_event.get(LINE_KEY),
        "耗时是怎么算的": "这条助手消息的 message_end 那一行的收到时刻，"
                          "减去它的 message_start 那一行的收到时刻。"
                          "收到时刻是后端读到归档里那一行的时刻，不是模型服务报的耗时。",
    }


def assign_lanes(calls: list[dict]) -> None:
    """给一轮里的几次工具调用排泳道：时间上重叠的排到不同泳道，不重叠的共用一条。

    时间条第一条泳道（编号 0）固定放模型请求，所以工具调用从第 1 条泳道起排。
    判重叠用的是收到时刻；取不到收到时刻的调用一律排在第 1 条泳道，不去猜它与谁并行。
    """
    placed: list[list[dict]] = []
    for call in calls:
        start, end = call.get("开始收到时刻"), call.get("结束收到时刻")
        if start is None or end is None:
            call["泳道"] = 1
            continue
        index = 0
        while True:
            row = placed[index] if index < len(placed) else None
            if row is None:
                placed.append([call])
                break
            if all(end <= other["开始收到时刻"] or other["结束收到时刻"] <= start
                   for other in row):
                row.append(call)
                break
            index += 1
        call["泳道"] = index + 1


def calls_are_parallel(calls: list[dict]) -> bool:
    """这一轮里有没有两次工具调用在时间上重叠。重叠就是并行执行。"""
    timed = [c for c in calls
             if c.get("开始收到时刻") is not None and c.get("结束收到时刻") is not None]
    for i, one in enumerate(timed):
        for other in timed[i + 1:]:
            if one["开始收到时刻"] < other["结束收到时刻"] and \
               other["开始收到时刻"] < one["结束收到时刻"]:
                return True
    return False


def build_runs(launches: list[dict]) -> list[dict]:
    """把一条会话名下几次 pi 进程启动的事件，摊成「一次运行 → 一轮 → 工具调用」。

    一次运行从 agent_start 到 agent_settled。中间的 agent_end 只是一次低层运行结束，
    其后还可能有自动重试、压缩后重试或续接排队消息，这些都算在同一次运行里
    （`docs/rpc.md` 第 863 到 865 行）。
    """
    runs: list[dict] = []
    # 发给模型的对话消息是整条会话累计的，跨 pi 进程启动也接着数（重启会接回原来的会话文件），
    # 所以这个计数放在最外面。它数的是事件流里角色为 user、assistant、toolResult 的消息，
    # 不含系统提示——系统提示不在事件流里。
    message_count = 0
    #: 最近几条对话消息的摘要，给界面上「展开看带过去的这几条消息」那一栏用。
    #: 只留最后几条，不把整条会话的原文再抄一遍。
    recent_messages: list[dict] = []
    for launch_index, launch in enumerate(launches):
        events = launch["事件"]
        starts = {str(e.get("toolCallId") or ""): e for e in events
                  if e.get("type") == "tool_execution_start"}
        ends = {str(e.get("toolCallId") or ""): e for e in events
                if e.get("type") == "tool_execution_end"}
        prompt_notes = list(launch["后端补记"]["提示"])
        prompt_seen = 0
        saw_prompt_response = any(e.get("type") == "response" and e.get("command") == "prompt"
                                  for e in events)

        current: dict | None = None
        pending_turn: dict | None = None
        pending_fact: dict | None = None
        pending_ui: list[dict] = []
        pending_request: dict | None = None      # 已经开头、还没有收尾的那条助手消息
        turn_requests: list[dict] = []           # 这一轮里已经收尾的几次模型请求
        turn_results: list[dict] = []            # 这一轮里回给模型的几条工具结果消息
        after_agent_end = False                  # 这次运行里是不是已经出现过一次 agent_end
        segment_hint: str | None = None          # agent_end 之后看到的续跑理由
        segment_reason: str | None = None        # 新一段低层运行的原因，挂到它的第一轮上
        errored_assistant = False                # 上一条收尾的助手消息是不是出错了
        for event in events:
            kind = event.get("type")

            if (kind == "extension_ui_request"
                    and str(event.get("statusKey") or "") == TURN_STATUS_KEY):
                # 小扩展在每一轮开始时报来的事实。它由扩展的 turn_start 处理函数发出，
                # 排在 pi 自己的 turn_start 事件之前，所以先收着，等下一条 turn_start 来了挂上去。
                try:
                    pending_fact = json.loads(str(event.get("statusText") or ""))
                except json.JSONDecodeError:
                    pending_fact = None
                continue

            if kind == "extension_ui_request":
                item = {
                    "方法": str(event.get("method") or ""),
                    "标题": str(event.get("title") or ""),
                    "文字": str(event.get("message") or event.get("statusText") or ""),
                    "状态键": str(event.get("statusKey") or ""),
                    "请求编号": str(event.get("id") or ""),
                    "要不要应答": str(event.get("method") or "") in DIALOG_METHODS,
                    "归档文件": launch["归档文件"],
                    "归档行号": event.get(LINE_KEY),
                }
                (current["界面请求"] if current is not None else pending_ui).append(item)
                continue

            if kind == "agent_start" and current is not None:
                # 同一次运行里的又一段低层运行。自动重试、压缩后重试、续接排队消息时，pi 调
                # agent.continue()，它走 runAgentLoopContinue，重新发 agent_start 与 turn_start，
                # 轮号 turnIndex 从 0 重编。一次运行到 agent_settled 才算完，所以这里既不另起
                # 一次运行，也不消耗后端补记里的下一条提示；只记下这一段是怎么开始的。
                segment_reason = segment_hint or "原因未知：agent_end 之后没有看到自动重试、压缩或排队的事件"
                if segment_reason == "自动重试" and errored_assistant:
                    # pi 在重试之前把出错的那条助手消息从消息列表里拿掉（agent-session.ts 的
                    # _prepareRetry：会话文件里留着，发给模型的列表里没有），所以带的消息少算一条。
                    message_count -= 1
                    if recent_messages:
                        recent_messages.pop()
                current["低层运行段"].append({
                    "第几段": len(current["低层运行段"]) + 1,
                    "原因": segment_reason,
                    "开始行号": event.get(LINE_KEY),
                    "收到时刻": _received(event),
                    "从第几轮起": len(current["轮"]) + 1,
                })
                segment_hint = None
                after_agent_end = False
                continue

            if kind == "agent_start":
                after_agent_end = False
                segment_hint = None
                segment_reason = None
                note = prompt_notes[prompt_seen] if prompt_seen < len(prompt_notes) else None
                prompt_seen += 1
                current = {
                    "运行序号": len(runs) + 1,
                    "启动序号": launch_index,
                    "归档文件": launch["归档文件"],
                    "开始行号": event.get(LINE_KEY),
                    "开始事件": event,
                    "提示": {
                        "原文": str((note or {}).get("原文") or ""),
                        "投递方式": str((note or {}).get("投递方式") or
                                        ("后端经 RPC 的 prompt 命令提交" if saw_prompt_response
                                         else UNKNOWN)),
                        "投递方式的依据": ("后端补记里的「提示」记录" if note else
                                          ("归档里有一条 command 为 prompt 的回应行"
                                           if saw_prompt_response
                                           else "归档里没有能说明触发方式的行")),
                        "用户消息条目编号": "",
                        "时刻": None,
                    },
                    "用户消息": [],
                    "轮": [],
                    "界面请求": list(pending_ui),
                    "被中止": False,
                    "自动重试": [],
                    "压缩": [],
                    "排队变化": [],
                    "助手最后说的话": "",
                    "助手最后一条消息的条目编号": "",
                    "耗时秒": None,
                    "开始收到时刻": _received(event),
                    "结束收到时刻": None,
                    "有没有收到时刻索引": launch["有没有收到时刻"],
                    "Langfuse 运行记录编号": "",
                    "各轮报来的运行记录编号一致吗": True,
                    "低层运行段": [{"第几段": 1, "原因": "由提示触发", "开始行号": event.get(LINE_KEY),
                                    "收到时刻": _received(event), "从第几轮起": 1}],
                }
                pending_ui = []
                continue

            if current is None:
                continue

            if kind == "turn_start":
                fact = pending_fact if isinstance(pending_fact, dict) else None
                pending_fact = None
                pi_index = fact.get("turnIndex") if fact else None
                turn_requests = []
                turn_results = []
                pending_request = None
                pending_turn = {
                    "自数轮号": len(current["轮"]),
                    "pi 给的轮号": pi_index if isinstance(pi_index, int) else None,
                    "Langfuse 运行记录编号": str((fact or {}).get("langfuseTraceId") or ""),
                    "pi 记的时间戳": (fact or {}).get("timestamp"),
                    "开始事件": event,
                    "开始行号": event.get(LINE_KEY),
                    "新一段低层运行的原因": segment_reason,
                }
                segment_reason = None
                continue

            if kind == "message_start":
                message = event.get("message") or {}
                role = str(message.get("role") or "")
                if role == "user":
                    text = text_of_content(message.get("content"))
                    first = not current["用户消息"]
                    current["用户消息"].append({
                        "文字": text,
                        "时刻": epoch_from_millis(message.get("timestamp")),
                        "归档行号": event.get(LINE_KEY),
                        "条目编号": "",
                        "这条是不是触发这次运行的那条": first,
                        # 插话（steer）或跟进（followUp）进来的用户消息，落在正在进行的那一轮里。
                        "落在第几轮": len(current["轮"]) + 1,
                        "收到时刻": _received(event),
                    })
                    if first:
                        current["提示"]["时刻"] = epoch_from_millis(message.get("timestamp"))
                        if not current["提示"]["原文"]:
                            current["提示"]["原文"] = text
                elif role == "assistant":
                    # 助手消息一开头，就是这一次模型请求的起点。这时还不知道模型会回什么，
                    # 只先记下这一行，等 message_end 来了再把事实填上。
                    pending_request = {"开始事件": event, "带的消息": message_count,
                                       "消息清单": list(recent_messages[-RECENT_MESSAGES:])}
                continue

            if kind == "message_end":
                message = event.get("message") or {}
                role = str(message.get("role") or "")
                if role == "assistant":
                    request = _provider_request(
                        message, (pending_request or {}).get("开始事件"), event)
                    request["带的消息（观测台数出来的）"] = (
                        pending_request or {}).get("带的消息", message_count)
                    request["最近几条消息"] = (pending_request or {}).get(
                        "消息清单", list(recent_messages[-RECENT_MESSAGES:]))
                    request["这一轮里的第几次"] = len(turn_requests) + 1
                    # pi 的一轮里只有一次模型请求（agent-loop.ts 的 runLoop 每轮只调一次
                    # streamAssistantResponse）。自动重试开的是新的一段低层运行，所以只有那一段
                    # 第一轮的请求才算自动重试。
                    request["是不是自动重试"] = bool(
                        pending_turn and pending_turn.get("新一段低层运行的原因") == "自动重试"
                        and not turn_requests)
                    turn_requests.append(request)
                    pending_request = None
                elif role == "toolResult":
                    turn_results.append({
                        "调用编号": str(message.get("toolCallId") or ""),
                        "工具": str(message.get("toolName") or ""),
                        "文字": text_of_content(message.get("content")),
                        "是不是出错": bool(message.get("isError")),
                        "收到时刻": _received(event),
                        "归档行号": event.get(LINE_KEY),
                    })
                if role == "assistant":
                    errored_assistant = str(message.get("stopReason") or "") == "error"
                if role in ("user", "assistant", "toolResult"):
                    message_count += 1
                    recent_messages.append(_message_summary(message))
                    del recent_messages[:-RECENT_MESSAGES]
                continue

            if kind == "turn_end":
                message = event.get("message") or {}
                turn = pending_turn or {"自数轮号": len(current["轮"]), "pi 给的轮号": None,
                                        "Langfuse 运行记录编号": "", "pi 记的时间戳": None,
                                        "开始事件": None, "开始行号": None}
                pending_turn = None
                calls = [_tool_call_record(c, starts, ends)
                         for c in tool_calls_of_content(message.get("content"))]
                assign_lanes(calls)
                if turn_requests:
                    requests = turn_requests
                else:
                    # 早先的归档里没有助手消息的 message_start 与 message_end 两条事件，
                    # 只能从 turn_end 取这一次模型响应的事实，起止时刻与耗时一律显示「未知」。
                    fallback = _provider_request(message, None, event)
                    fallback["带的消息（观测台数出来的）"] = message_count
                    fallback["最近几条消息"] = list(recent_messages[-RECENT_MESSAGES:])
                    fallback["这一轮里的第几次"] = 1
                    fallback["是不是自动重试"] = False
                    requests = [fallback]
                    message_count += 1      # 这条助手消息也算进后面几次请求带的消息里
                    recent_messages.append(_message_summary(message))
                    del recent_messages[:-RECENT_MESSAGES]
                for one in requests:
                    if one["停止原因"] == "aborted":
                        current["被中止"] = True
                results = turn_results or [
                    {"调用编号": c["调用编号"], "工具": c["工具"], "文字": c["结果文字"],
                     "是不是出错": c["是否被拒"] is True, "收到时刻": c["结束收到时刻"],
                     "归档行号": c["归档行号"]}
                    for c in calls if c["有没有执行结果"]]
                turn_requests = []
                turn_results = []
                pending_request = None
                pi_index = turn["pi 给的轮号"]
                current["轮"].append({
                    # 「轮号」是这一轮在这次运行里的位置，从 0 起，整次运行里接着数。平常它就等于
                    # pi 的 turnIndex；可一次运行里若又开了一段低层运行（自动重试之类），pi 的
                    # turnIndex 会从 0 重编，那时两者不同，界面上旁注 pi 给的那个。
                    "轮号": turn["自数轮号"],
                    "pi 给的轮号": pi_index,
                    "自数轮号": turn["自数轮号"],
                    "轮号是谁给的": "pi 给的" if pi_index is not None else "观测台按先后数出来的",
                    "给人读的序数": turn["自数轮号"] + 1,
                    "新一段低层运行的原因": turn.get("新一段低层运行的原因"),
                    "Langfuse 运行记录编号": turn["Langfuse 运行记录编号"],
                    "运行序号": current["运行序号"],
                    "助手文字": text_of_content(message.get("content")),
                    "模型请求": requests,
                    "工具调用": calls,
                    "工具调用是不是并行的": calls_are_parallel(calls),
                    "工具结果消息": results,
                    "工具结果条数": len(event.get("toolResults") or []),
                    "耗时秒": _seconds_between(turn.get("开始事件"), event),
                    "开始收到时刻": _received(turn.get("开始事件")),
                    "结束收到时刻": _received(event),
                    "归档文件": launch["归档文件"],
                    "开始行号": turn.get("开始行号"),
                    "结束行号": event.get(LINE_KEY),
                })
                continue

            if kind == "agent_end":
                after_agent_end = True
                continue

            if kind == "auto_retry_start" and after_agent_end:
                segment_hint = "自动重试"
            if kind == "compaction_start" and after_agent_end:
                segment_hint = segment_hint or "压缩后重试"
            if kind == "queue_update" and after_agent_end:
                segment_hint = segment_hint or "续接排队消息"

            if kind in ("auto_retry_start", "auto_retry_end"):
                current["自动重试"].append({
                    "事件": kind, "归档行号": event.get(LINE_KEY),
                    "内容": {k: v for k, v in event.items() if not k.startswith("__")}})
                continue

            if kind in ("compaction_start", "compaction_end"):
                current["压缩"].append({"事件": kind, "归档行号": event.get(LINE_KEY)})
                continue

            if kind == "queue_update":
                current["排队变化"].append({
                    "归档行号": event.get(LINE_KEY),
                    "内容": {k: v for k, v in event.items() if not k.startswith("__")}})
                continue

            if kind == "agent_settled":
                ids = [t["Langfuse 运行记录编号"] for t in current["轮"]
                       if t["Langfuse 运行记录编号"]]
                current["Langfuse 运行记录编号"] = ids[0] if ids else ""
                current["各轮报来的运行记录编号一致吗"] = len(set(ids)) <= 1
                # 执行者对用户说的话：经「回复」工具说的，或者模型以 stop 收尾的正文（回复工具启用之前）。
                spoken = [x for x in (speech_of_turn(t) for t in current["轮"]) if x]
                current["助手最后说的话"] = spoken[-1]["文字"] if spoken else ""
                current["助手最后说的话从哪来"] = spoken[-1]["来源"] if spoken else ""
                current["助手最后一条消息的条目编号"] = spoken[-1]["条目编号"] if spoken else ""
                current["耗时秒"] = _seconds_between(current.get("开始事件"), event)
                current["结束收到时刻"] = _received(event)
                # 这次运行的收尾原因，取最后一轮那次模型请求的停止原因。
                last = current["轮"][-1]["模型请求"][-1] if current["轮"] else {}
                current["停止原因"] = last.get("停止原因", "")
                current.pop("开始事件", None)
                runs.append(current)
                current = None
                continue

            if kind == "response" and event.get("command") == "abort" and event.get("success"):
                target = current or (runs[-1] if runs else None)
                if target is not None:
                    target["被中止"] = True

        if current is not None:            # pi 半路没了，这次运行没有收尾事件，也要留下来
            current.pop("开始事件", None)
            current.setdefault("停止原因", "")
            current["这次运行没有正常收尾"] = True
            runs.append(current)
        if pending_ui:
            launch["未归到任何一次运行的界面请求"] = pending_ui
    return runs


def attach_entry_ids(runs: list[dict], session_file: dict | None) -> None:
    """给每条用户消息与每次运行最后那条助手消息，挂上 pi 会话文件里的条目编号。

    对不上就留空，界面上显示「会话文件里对不上这条消息」，不编一个编号出来。
    """
    if not session_file:
        return
    users = [m for m in session_file["消息"] if m["角色"] == "user"]
    assistants = [m for m in session_file["消息"] if m["角色"] == "assistant" and m["文字"]]
    seen = 0
    for one in runs:
        for message in one["用户消息"]:
            if seen < len(users) and users[seen]["文字"] == message["文字"]:
                message["条目编号"] = users[seen]["条目编号"]
                if message["这条是不是触发这次运行的那条"]:
                    one["提示"]["用户消息条目编号"] = users[seen]["条目编号"]
            seen += 1
        matched = [m for m in assistants if m["文字"] == one["助手最后说的话"]]
        if one["助手最后说的话"] and len(matched) == 1 and not one.get("助手最后一条消息的条目编号"):
            one["助手最后一条消息的条目编号"] = matched[0]["条目编号"]


# ───────────────────────── 会话 ─────────────────────────

def build_sessions(archive_dir: Path) -> list[dict]:
    """扫一遍归档目录，给出全部会话，以及那几次没能启动起来的 pi。

    一条会话可能对应好几次 pi 进程启动：每打一次 /restart 就多一次。
    启动失败的那几次没有会话编号，单独列出来，不混进正常会话里。
    """
    launches = scan_launches(archive_dir)
    session_files = scan_session_files(archive_dir)

    grouped: dict[str, list[dict]] = {}
    failures: list[dict] = []
    for launch in launches:
        if launch["会话编号"]:
            grouped.setdefault(launch["会话编号"], []).append(launch)
        else:
            failures.append(launch)

    sessions: list[dict] = []
    for session_id, own in grouped.items():
        own.sort(key=lambda x: (x["启动时刻"] or 0.0, x["归档文件"]))
        runs = build_runs(own)
        session_file = session_files.get(session_id)
        attach_entry_ids(runs, session_file)
        turns = [t for r in runs for t in r["轮"]]
        requests = [q for t in turns for q in t["模型请求"]]
        calls = [c for t in turns for c in t["工具调用"]]
        rejected = [c for c in calls if c["是否被拒"] is True]
        times = [t for t in [r["提示"]["时刻"] for r in runs]
                 + [q["助手消息时刻"] for q in requests] if t]
        aborted = any(r["被中止"] for r in runs)
        sessions.append({
            "会话编号": session_id,
            "归档名": sorted({l["归档名"] for l in own}),
            "pi 进程启动次数": len(own),
            "是否重启过": len(own) > 1,
            "启动": [{k: v for k, v in l.items() if k != "事件"} for l in own],
            "会话文件": session_file["会话文件路径"] if session_file else "",
            "会话名": session_file["会话名"] if session_file else "",
            # 归档目录自己的名字。按任务分目录存归档时它就是任务目录名，会话文件缺失时拿它对任务（见 api.py）。
            "归档目录名": Path(archive_dir).name,
            "会话文件条目数": len(session_file["消息"]) if session_file else None,
            "扩展写入的消息": session_file.get("自定义消息", []) if session_file else [],
            "工作目录": session_file["工作目录"] if session_file else "",
            "开始时刻": min(times) if times else (own[0]["启动时刻"] if own else None),
            "结束时刻": max(times) if times else None,
            "运行": runs,
            "运行次数": len(runs),
            "轮数": len(turns),
            "模型请求次数": len(requests),
            "工具调用次数": len(calls),
            "被拒次数": len(rejected),
            "是否被中止过": aborted,
            "终态": "有过被中止的运行" if aborted else "正常结束",
            "启动失败": False,
        })

    for launch in failures:
        note = launch["后端补记"]
        reason = UNKNOWN
        if note["退出"]:
            reason = str(note["退出"].get("标准错误") or "").strip() or UNKNOWN
        elif note["标准错误"]:
            reason = "\n".join(note["标准错误"]).strip()
        sessions.append({
            "会话编号": "",
            "归档名": [launch["归档名"]],
            "pi 进程启动次数": 1,
            "是否重启过": False,
            "启动": [{k: v for k, v in launch.items() if k != "事件"}],
            "会话文件": "",
            "会话名": "",
            "归档目录名": Path(archive_dir).name,
            "会话文件条目数": None,
            "工作目录": "",
            "开始时刻": launch["启动时刻"],
            "结束时刻": launch["启动时刻"],
            "运行": [],
            "运行次数": 0,
            "轮数": 0,
            "模型请求次数": 0,
            "工具调用次数": 0,
            "被拒次数": 0,
            "是否被中止过": False,
            "终态": "pi 没有启动起来",
            "启动失败": True,
            "启动失败原因": reason,
            "归档文件": launch["归档文件"],
        })

    sessions.sort(key=lambda s: (s["开始时刻"] or 0.0))
    return sessions
