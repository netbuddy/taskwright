"""系统健康：核对运行这一套东西本身是不是正常工作，与任务内容无关。

「系统」指托着执行者跑起来的那一层——启动 pi、装扩展、转话、归档、看护的那些代码。

每一项检查都写明依据在哪；取不到依据的一律给「未知」，并写清楚缺的是哪一条事实、
现在有没有被记在别处、建议由谁去补记。这里不做任何推断：
比如「会话里出现过某个工具的执行事件」不等于「那个扩展加载成功了」，所以不能拿前者当后者的依据。
"""

from __future__ import annotations

from taskwright_observatory.shared import UNKNOWN, local_time

#: 本仓那个只读小扩展报工具清单时用的状态栏键名。它有自己单独的一项检查，
#: 所以不要再混进「扩展打出的状态文字」那一项里。
ACTIVE_TOOLS_STATUS_KEY = "taskwright-active-tools"

OK, WARN, ERR, UNK = "正常", "要注意", "不正常", "未知"


def _item(title, verdict, note, source="", missing="", detail=None):
    return {"检查项": title, "结论": verdict, "说明": note, "来源": source,
            "缺什么": missing, "明细": detail or []}


def _launches_of(sessions: list[dict]) -> list[dict]:
    return [launch for session in sessions for launch in session["启动"]]


def _calls_of(session: dict) -> list[dict]:
    """一条会话里按先后排开的全部工具调用。"""
    return [call for one in session["运行"] for turn in one["轮"] for call in turn["工具调用"]]


def _is_plain_status(request: dict) -> bool:
    """这条界面请求是不是一条普通的状态栏文字。报工具清单那一条另有专项检查，不算在内。"""
    return (request["方法"] == "setStatus" and bool(request["文字"])
            and request.get("状态键") != ACTIVE_TOOLS_STATUS_KEY)


def loading_items(sessions: list[dict]) -> list[dict]:
    """一、加载与配置。"""
    launches = _launches_of(sessions)
    items: list[dict] = []

    recorded = [l for l in launches if l["后端补记"]["有没有"] and l["后端补记"]["启动"]]
    if not recorded:
        items.append(_item(
            "启动 pi 时两个扩展各自解析到了哪个文件",
            UNK,
            "这些会话的归档里没有记下启动时把扩展解析到了哪个文件，所以说不出扩展有没有加载成功。"
            "pi 的标准输出里本来就不带这件事，后端当时也只把它打在终端上，没有落盘。",
            "没有可用的来源",
            "缺的是「后端解析出的扩展文件路径与那个文件在不在」这一条事实。"
            "它现在只出现在当时的终端输出里，没有存成文件。"
            "建议由后端在启动时把它写进归档旁边的后端补记文件。",
        ))
    else:
        lines = []
        missing = []
        for launch in recorded:
            parts = []
            for one in (launch["后端补记"]["启动"].get("扩展") or []):
                name = one.get("名字", UNKNOWN)
                where = one.get("解析到的文件", "") or one.get("文件", "")
                exists = bool(one.get("文件在不在", one.get("加载")))
                if not exists:
                    missing.append((launch["归档文件"], name))
                parts.append(f"扩展「{name}」解析到的是 {where or '（没有解析到文件）'}"
                             f"，那个文件{'在' if exists else '不在'}")
            if parts:
                lines.append(f"归档 {launch['归档文件']} 这一次启动：" + "；".join(parts) + "。")
        items.append(_item(
            "启动 pi 时两个扩展各自解析到了哪个文件",
            OK if lines and not missing else (WARN if missing else UNK),
            (f"这个范围里一共有 {len(lines)} 次 pi 进程启动，每一次解析到的文件都列在下面。"
             "这里说的只是「后端把扩展解析到了哪个文件、那个文件在不在」，"
             "不等于 pi 真的把它加载起来了——那要看下面一项。")
            if lines else "后端补记里没有写扩展这一项。",
            "后端补记文件里「启动」那一条",
            detail=lines,
        ))
        failed = [(l["归档文件"], line) for l in recorded
                  for line in l["后端补记"]["标准错误"] if "Failed to load extension" in line]
        crashed = [l for l in recorded
                   if (l["后端补记"]["退出"] or {}).get("退出码") not in (0, None)]
        items.append(_item(
            "pi 有没有真的把这两个扩展加载起来",
            ERR if failed else (WARN if crashed else OK),
            ("pi 的标准错误里有加载失败的行：" + "；".join(f"归档 {f}：{line}" for f, line in failed)
             if failed else
             ("pi 的标准错误里没有加载失败的行，但有 " + str(len(crashed)) +
              " 次启动的退出码不是 0，要查。" if crashed else
              "pi 的标准错误里没有「Failed to load extension」这样的行，退出码也都是 0，"
              "所以没有扩展在加载时出事。")),
            "后端补记文件里「标准错误」与「退出」两类条目",
        ))

    statuses = []
    for session in sessions:
        for one in session["运行"]:
            for request in one["界面请求"]:
                if _is_plain_status(request):
                    statuses.append(request["文字"])
        for launch in session["启动"]:
            for request in launch.get("未归到任何一次运行的界面请求", []):
                if _is_plain_status(request):
                    statuses.append(request["文字"])
    if statuses:
        wording = sorted(set(statuses))
        items.append(_item(
            "观测插件在界面上打出的状态文字",
            OK,
            f"事件流里一共有 {len(statuses)} 条状态栏请求，出现过的状态文字是："
            + "、".join(f"「{w}」" for w in wording) + "。这几条是插件自己报的状态，不是别处推出来的。",
            "pi 事件流里 type 为 extension_ui_request、method 为 setStatus 的那些行",
        ))
    else:
        items.append(_item(
            "观测插件在界面上打出的状态文字",
            UNK,
            "这些会话的事件流里一条状态栏请求也没有，所以说不出插件当时是什么状态。",
            "pi 事件流",
            "缺的是插件自报的状态文字。它只在插件真的加载起来时才会出现。",
        ))

    items.append(active_tools_item(launches))

    models = sorted({str((launch.get("后端补记", {}).get("启动") or {}).get("模型") or "")
                     for launch in launches} - {""})
    if models:
        items.append(_item("这些会话用的模型", OK, "用的模型是：" + "、".join(models) + "。",
                           "后端补记文件里「启动」那一条"))
    return items


def active_tools_item(launches: list[dict]) -> dict:
    """实际发给模型的工具清单与启动配置里的白名单是不是一致。

    实际清单由 pi 进程里那个只读小扩展在会话开始时用 pi.getActiveTools() 取出来，
    经一条状态栏请求带到进程外，后端记进补记文件。RPC 本身没有读它的命令。
    """
    rows = []
    mismatched = []
    unknown = []
    for launch in launches:
        note = launch["后端补记"]["实际工具清单"]
        start = launch["后端补记"]["启动"] or {}
        whitelist = list(start.get("工具白名单") or [])
        if not note or not isinstance(note.get("工具"), list):
            unknown.append(launch["归档文件"])
            continue
        actual = [str(x) for x in note["工具"]]
        same = sorted(actual) == sorted(whitelist)
        if not same:
            mismatched.append((launch["归档文件"], whitelist, actual))
        rows.append(f"归档 {launch['归档文件']} 这一次启动：启动配置里的白名单是 "
                    f"{'、'.join(whitelist) or '（空）'}，实际激活的工具是 "
                    f"{'、'.join(actual) or '（空）'}，两份"
                    f"{'逐项相同' if same else '对不上'}。")
    if not rows:
        return _item(
            "实际发给模型的工具清单与启动配置里的白名单是否一致",
            UNK,
            "这些会话跑在「报工具清单」这件事做出来之前，归档里没有实际清单，所以下不了结论。",
            "没有可用的来源",
            "缺的是「这次实际激活的工具清单」。pi 的 RPC 没有读它的命令，"
            "只有进程内的扩展接口 pi.getActiveTools() 拿得到。"
            "本仓已经加了一个只读小扩展把它报出来，重跑一次就有了。",
        )
    verdict = ERR if mismatched else (WARN if unknown else OK)
    note = (f"这个范围里有 {len(rows)} 次 pi 进程启动取到了实际工具清单。"
            + ("两份清单每一次都逐项相同。" if not mismatched
               else f"其中 {len(mismatched)} 次对不上，要查。")
            + (f"另有 {len(unknown)} 次启动没有取到实际清单（那几次跑在这件事做出来之前）。"
               if unknown else ""))
    return _item(
        "实际发给模型的工具清单与启动配置里的白名单是否一致",
        verdict, note,
        "后端补记文件里「实际工具清单」那一条，来自进程内只读小扩展调用的 pi.getActiveTools()",
        detail=rows,
    )


def invariant_items(workspaces: list[dict], only: set[str] | None) -> list[dict]:
    """二、不变式核对：库里的数据与事件流水是不是一一对得上。

    新格式的库用 `taskwright_observatory.check_db` 核对，只读打开库。更早的旧格式（库里有 `slot` 表）
    本产品不提供核对，这样的库这一项给「未知」并说明原因。
    """

    from pathlib import Path
    from taskwright_observatory import check_db as current_check
    from taskwright_observatory import taskdb
    items: list[dict] = []
    for workspace in workspaces:
        if only is not None and workspace["任务目录"] not in only:
            continue
        path = Path(workspace["任务目录路径"]).expanduser()
        if workspace.get("格式") in (taskdb.FORMAT_MISSING, taskdb.FORMAT_EMPTY):
            continue
        if workspace.get("格式") == taskdb.FORMAT_CURRENT:
            # 新格式的库用 taskwright_observatory.check_db 核对，它同样只读打开库。
            try:
                for one in current_check.check(path):
                    items.append(_item(
                        f"任务目录「{workspace['任务目录']}」：{one['名目']}",
                        OK if one["通过"] else ERR,
                        "这一条核对通过了。" if one["通过"] else
                        "这一条核对没有通过：" + "；".join(one["不通过的行"]),
                        f"{workspace['任务目录路径']}/task.sqlite（python3 -m taskwright_observatory.check_db）"))
            except Exception as error:                  # noqa: BLE001 - 核对本身出错也如实说明
                items.append(_item(f"核对任务目录「{workspace['任务目录']}」的库", UNK,
                                   f"核对时出错了：{error}", workspace["任务目录路径"]))
            continue
        items.append(_item(f"核对任务目录「{workspace['任务目录']}」的库", UNK,
                           "这是更早的旧格式（库里有 slot 表），本产品不提供旧格式的核对。", workspace["任务目录路径"]))
    if not items:
        items.append(_item("库里的数据与事件流水是不是一一对得上", UNK,
                           "当前范围里没有对上任何任务目录，所以没有可核对的库。", "无"))
    return items


def gate_rows(sessions: list[dict]) -> list[dict]:
    """三、门禁统计：写入工具内部核对不过而拒绝这次调用的情况。

    「其后改正成功」的算法写在这里，界面上也照写一遍：
    一次调用被拒之后，同一条会话里再出现的下一次同名工具调用没有被拒，就算这一次改正成功了。
    范围是整条会话而不是一次运行，因为模型被拒之后常常先回过头问一句，
    真正改过来的那次调用落在下一次运行里。
    按拒绝原因归类时用的是工具返回的原文，不认任何写死的文案。
    """
    buckets: dict[str, dict] = {}
    for session in sessions:
        calls = _calls_of(session)
        for index, call in enumerate(calls):
            if call["是否被拒"] is not True:
                continue
            reason = (call["结果文字"] or "").strip() or "（工具没有给出原因）"
            later = [c for c in calls[index + 1:] if c["工具"] == call["工具"]]
            fixed = bool(later) and later[0]["是否被拒"] is False
            bucket = buckets.setdefault(reason, {
                "拒绝原因原文": reason, "发生次数": 0, "其后改正成功次数": 0, "涉及会话": []})
            bucket["发生次数"] += 1
            bucket["其后改正成功次数"] += int(fixed)
            if session["会话编号"] not in bucket["涉及会话"]:
                bucket["涉及会话"].append(session["会话编号"])
    return sorted(buckets.values(), key=lambda b: -b["发生次数"])


def stderr_items(sessions: list[dict]) -> list[dict]:
    """四、pi 标准错误里的扩展报错。"""
    launches = _launches_of(sessions)
    recorded = [l for l in launches if l["后端补记"]["有没有"]]
    if not recorded:
        return [_item(
            "pi 标准错误里的扩展报错行数",
            UNK,
            "这些会话的归档里没有 pi 的标准错误。后端当时把标准错误收在内存里，"
            "只有 pi 挂掉时才打到终端上，正常跑完的那些会话就丢了。",
            "没有可用的来源",
            "缺的是 pi 标准错误的每一行。建议由后端一边读一边写进归档旁边的后端补记文件。",
        )]
    lines = [line for launch in recorded for line in launch["后端补记"]["标准错误"]]
    return [_item(
        "pi 标准错误里的扩展报错行数",
        OK if not lines else WARN,
        f"这些会话的标准错误一共 {len(lines)} 行。"
        + ("一行都没有，说明没有钩子在悄悄失败。" if not lines else
           "头几行是：" + " / ".join(lines[:3])),
        "后端补记文件里「标准错误」那些条",
    )]


def timing_items(sessions: list[dict]) -> list[dict]:
    """五、归档里有没有收到时刻。没有它就算不出每轮与每次工具调用花了多久。"""
    launches = _launches_of(sessions)
    if not launches:
        return [_item("归档里有没有记下每行的收到时刻", UNK,
                      "当前范围里没有归档文件。", "无")]
    with_time = [l for l in launches if l["有没有收到时刻"]]
    without = [l["归档文件"] for l in launches if not l["有没有收到时刻"]]
    return [_item(
        "归档里有没有记下每行的收到时刻",
        OK if not without else WARN,
        f"这个范围里 {len(launches)} 次 pi 进程启动，其中 {len(with_time)} 次有收到时刻索引。"
        + ("每一次都有，所以每轮耗时与每次工具调用耗时都算得出来。" if not without else
           f"另外 {len(without)} 次没有（那几次跑在这件事做出来之前），"
           f"它们的耗时在界面上显示「未知」。"),
        "归档旁边同名的 .times.jsonl 文件",
        detail=[f"归档 {name} 这一次启动没有收到时刻索引。" for name in without],
    )]


def startup_items(sessions: list[dict]) -> list[dict]:
    """六、pi 启动失败。"""
    failed = [s for s in sessions if s["启动失败"]]
    if not failed:
        return [_item("pi 启动失败的次数", OK, "当前范围里 pi 每一次都启动起来了，没有失败。",
                      "pi-events 目录下的归档文件")]
    items = []
    for session in failed:
        reason = session.get("启动失败原因") or UNKNOWN
        known = reason != UNKNOWN
        items.append(_item(
            f"运行「{session['归档名'][0]}」这一次 pi 没有启动起来",
            ERR if known else UNK,
            (f"失败原因的原文是：{reason}" if known else
             "归档里只有一个空文件，pi 一条事件都没有发出来，失败原因没有被记在任何文件里。"),
            session.get("归档文件", ""),
            "" if known else "缺的是 pi 的标准错误与退出码。建议由后端在 pi 退出时补记这两样。",
        ))
    return items


def langfuse_items(sessions: list[dict], link_status: dict | None) -> list[dict]:
    """六、到 Langfuse 的链接能给到哪一级。

    第一级是直达那条运行记录，不用密钥，只要归档里带出了运行记录编号就有。
    第二级是直达某一次模型请求或某一次工具调用，要配 Langfuse 密钥，由观测台读一次它的接口得出。
    """
    status = link_status or {}
    state = status.get("状态", UNKNOWN)
    verdict = {"可达": OK, "未配密钥": WARN, "还没试过": UNK,
               "不可达": ERR, "未配": WARN}.get(state, UNK)
    items = [_item(
        f"到 Langfuse 的链接现在能给到哪一级（{state}）",
        verdict,
        str(status.get("说明", "说不出来。")),
        f"观测台的链接模块；服务地址 {status.get('服务地址', '未知')}，"
        f"项目标识 {status.get('项目标识', '未知')}",
        "" if state in ("可达", "未配密钥") else
        "缺的是能读 Langfuse 的密钥，或者是到 Langfuse 的网络。第二级链接因此退回第一级。",
    )]

    runs_with_id = [one for session in sessions for one in session["运行"]
                    if one.get("Langfuse 运行记录编号")]
    runs_all = [one for session in sessions for one in session["运行"]]
    inconsistent = [one for one in runs_all if not one.get("各轮报来的运行记录编号一致吗", True)]
    if not runs_all:
        items.append(_item("每次运行有没有带出 Langfuse 运行记录编号", UNK,
                           "当前范围里没有任何一次运行。", "无"))
    else:
        items.append(_item(
            "每次运行有没有带出 Langfuse 运行记录编号",
            OK if len(runs_with_id) == len(runs_all) and not inconsistent else WARN,
            f"当前范围里一共 {len(runs_all)} 次运行，其中 {len(runs_with_id)} 次带出了运行记录编号。"
            + ("每一次都带出来了，所以第一级链接全都有。"
               if len(runs_with_id) == len(runs_all) else
               f"另外 {len(runs_all) - len(runs_with_id)} 次没有带出来"
               f"（那几次跑在这件事做出来之前），它们只给会话页链接。")
            + (f"另有 {len(inconsistent)} 次运行的各轮报来的编号不一致，要查。" if inconsistent else ""),
            "后端补记里「本轮事实」那些条，来自进程内只读小扩展读的环境变量 "
            "LANGFUSE_PI_PARENT_TRACE_ID",
        ))

    with_pi_index = [turn for session in sessions for one in session["运行"] for turn in one["轮"]
                     if turn.get("pi 给的轮号") is not None]
    all_turns = [turn for session in sessions for one in session["运行"] for turn in one["轮"]]
    if all_turns:
        items.append(_item(
            "轮号是 pi 给的还是观测台数出来的",
            OK if len(with_pi_index) == len(all_turns) else WARN,
            f"当前范围里一共 {len(all_turns)} 轮，其中 {len(with_pi_index)} 轮的轮号是 pi 给的。"
            + ("每一轮都是 pi 给的。" if len(with_pi_index) == len(all_turns) else
               f"另外 {len(all_turns) - len(with_pi_index)} 轮的轮号是观测台按 turn_start 的先后"
               f"数出来的（那些归档跑在这件事做出来之前），界面上逐轮注明了。"),
            "后端补记里「本轮事实」那些条",
        ))
    return items


def build_health(sessions: list[dict], workspaces: list[dict],
                 touched_workspaces: set[str] | None,
                 link_status: dict | None = None) -> dict:
    """把上面几组检查合成一页。sessions 已经按当前范围筛过了。"""
    return {
        "分组": [
            {"标题": "一、加载与配置", "项": loading_items(sessions)},
            {"标题": "六、到 Langfuse 的链接", "项": langfuse_items(sessions, link_status)},
            {"标题": "二、不变式核对", "项": invariant_items(workspaces, touched_workspaces)},
            {"标题": "四、pi 标准错误与归档完整性",
             "项": stderr_items(sessions) + timing_items(sessions)},
            {"标题": "五、pi 启动失败", "项": startup_items(sessions)},
        ],
        "门禁": {
            "说明": "「门禁」指写入工具内部的核对：核对不过就拒绝这次调用，并把原因文字交还给模型。"
                    "「其后改正成功」的算法是：一次调用被拒之后，同一条会话里再出现的下一次同名"
                    "工具调用没有被拒，就算这一次改正成功了。算的是整条会话而不是一次运行，"
                    "因为模型被拒之后常常先回过头问一句，真正改过来的那次调用落在下一次运行里。"
                    "拒绝原因按工具返回的原文归类，观测台不认任何写死的文案。",
            "行": gate_rows(sessions),
        },
        "统计": {
            "会话数": len([s for s in sessions if not s["启动失败"]]),
            "pi 进程启动次数": sum(s["pi 进程启动次数"] for s in sessions),
            "运行次数": sum(s["运行次数"] for s in sessions),
            "轮数": sum(s["轮数"] for s in sessions),
            "模型请求次数": sum(s["模型请求次数"] for s in sessions),
            "工具调用次数": sum(s["工具调用次数"] for s in sessions),
            "被拒次数": sum(s["被拒次数"] for s in sessions),
            "最早一次": local_time(min((s["开始时刻"] for s in sessions if s["开始时刻"]),
                                       default=None)),
        },
    }
