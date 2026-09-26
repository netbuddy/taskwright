"""任务页：把一个任务（或一条会话）按运行排成一张流程表，外加交付物看板与知识的使用。

流程的单位是运行（pi 的 agent run）：用户的一句话，加上助手为这句话做的全部轮（agent_start 到 agent_settled）。
每次运行一行，写明用户那句话、开始时刻、轮数、工具调用次数、保存修订次数、被拒次数、耗时，以及助手这次运行最后
对用户说的话（助手应答，完整不截断）与它做的关键动作；点开一行看这次运行的各轮，每轮再点开看模型请求与工具调用的原始记录。
用户在网页上直接改交付物（不经过助手，不产生运行）与扩展写进会话的任务现状，按时刻各占一行。跨会话的任务
按会话分段。「需要注意」「交付物看板」「知识的使用」「知识仓库」「助手应答」「关键动作」都是观测台自己的呈现用语，
不是 pi 的概念，登记在概念对照页。

下面「零」到「四」节里还留着按轮归类的判定函数（classify_turn、build_stages 等，读同目录下的 stage_rules.json）：
路径归类仍用来认材料文件、执行方法与领域规矩（页头的材料文件、指导、知识的使用），整轮的归类本页已经不再输出，
那几个函数留待后端改写时一并清理。

本模块只读：输入是读取接口已经拼好的会话详情与任务详情，另外只读三样东西——任务目录里的任务定义文件与执行方法
文件（给页面显示原文）、任务目录的文件清单（归档没有记下知识仓库摘要时退而列出现有文件）、任务数据库
（经 agent 的核对函数核对完成条件，库以只读方式打开）。
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from taskwright_observatory import dialogue, taskdb
from taskwright_observatory.diffs import diff_list, diff_text

HERE = Path(__file__).resolve().parent
RULES_FILE = HERE / "stage_rules.json"
CHECK_SCRIPT = HERE.parents[1] / "agent" / "src" / "cli" / "check_completion.mts"
#: 「回复」怎样排成几行给人看，只在 agent 里写一份（终端界面与终端客户端也用它），这里经它的命令行入口调用。
RENDER_SCRIPT = HERE.parents[1] / "agent" / "src" / "cli" / "render.mts"

#: 排好的几行按（调用编号, 被拒没有）记下来，同一次调用不重复起 Node 子进程。
_RENDERED: dict[tuple[str, bool], list[str] | None] = {}


def render_reply_lines(call: dict) -> list[str] | None:
    """把一次「回复」调用排成几行：合格的是告知、向用户要的回应、成文的话；被拒的是拒绝原因。调不动时返回 None。"""
    rejected = call.get("是否被拒") is True
    key = (str(call.get("调用编号") or ""), rejected)
    if key[0] and key in _RENDERED:
        return _RENDERED[key]
    node = shutil.which("node")
    lines = None
    if node and RENDER_SCRIPT.is_file():
        payload = {"tool": call.get("工具"), "is_error": rejected, "text": call.get("结果文字") or "",
                   "details": call.get("结果细节") or {}, "args": call.get("参数") or {}}
        try:
            done = subprocess.run([node, str(RENDER_SCRIPT)], input=json.dumps(payload, ensure_ascii=False),
                                  capture_output=True, text=True, timeout=30)
            parsed = json.loads(done.stdout) if done.returncode == 0 else None
            lines = parsed if isinstance(parsed, list) else None
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            lines = None
    if key[0]:
        _RENDERED[key] = lines
    return lines

#: 知识仓库里的文件按路径归成几种，只为分组显示；任务定义里登记了的路径优先按登记的来。
KIND_BY_PREFIX = [(".pi/skills/", "执行方法（skill）"), ("docs/domain-knowledge/", "领域规矩文档"),
                  ("docs/task-definitions/", "任务定义"), ("docs/templates/", "文档模板"),
                  ("docs/execution-plans/", "执行计划")]

#: 知识的使用的四种归类。
USE_READ = "助手按需读过"
USE_TOOL = "工具读过"
USE_PROMPT = "启动时放进了系统提示"
USE_NONE = "这次没有用到"

NOT_RECORDED = "这条归档没有记下"



def source_view(s: dict) -> dict:
    """一条来源给页面的样子：种类、出处、摘录，加上它支持哪几处（一句话），以及「用户的话」拆开的会话出处。

    「用户的话」的出处是「会话编号#会话条目编号」，页面据此链到那条会话并定位到那条用户消息。
    """
    return {"种类": s.get("种类"), "出处": s.get("出处"), "摘录": s.get("摘录"),
            "支持": taskdb.support_text(s.get("支持") or []), "对话出处": s.get("对话出处")}

def load_rules() -> dict:
    return json.loads(RULES_FILE.read_text(encoding="utf-8"))


# ───────────────────────── 小工具 ─────────────────────────

def clock(epoch) -> str:
    if not epoch:
        return ""
    return _dt.datetime.fromtimestamp(float(epoch)).strftime("%H:%M:%S")


def plain(text) -> str:
    text = re.sub(r"\*\*", "", str(text or ""))
    text = re.sub(r"(?m)^[-*]\s+", "", text)
    return re.sub(r"\s*\n+\s*", " ／ ", text).strip()


def shorten(text, limit: int = 120) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def basename(path) -> str:
    return str(path).rstrip("/").split("/")[-1]


def first_sentence(text) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    cut = re.split(r"[。；\n]", text)
    return (cut[0] + "。") if cut and cut[0] else text


def relative_to_workspace(path, workspace_abs: str) -> str:
    """把工具参数里的路径换成相对任务目录的写法。模型给的路径可能是绝对路径、~ 开头或者 ./ 开头。"""
    text = str(path or "").strip()
    if not text:
        return ""
    if text.startswith("~"):
        text = os.path.expanduser(text)
    if workspace_abs and (text == workspace_abs or text.startswith(workspace_abs.rstrip("/") + "/")):
        text = text[len(workspace_abs.rstrip("/")) + 1:]
    while text.startswith("./"):
        text = text[2:]
    return text


# ───────────────────────── 零、归类声明 ─────────────────────────

def declaration(rules: dict, source: dict | None, who: str, where_from: dict) -> dict:
    """拼出这一次要用的归类声明。source 是从任务定义里读出来的几项，没有就是 None。"""
    source = source or {}
    template = source.get("文档模板") or ""
    return {
        "这份声明是给谁用的": who,
        "路径归类": {
            "执行方法": [source["执行方法"]] if source.get("执行方法") else [],
            "领域规矩": [x for x in (source.get("领域规矩") or []) if isinstance(x, str)],
            "材料目录": [source.get("材料目录") or taskdb.DEFAULT_MATERIALS_DIR],
            "文档模板": [template] if template else [],
        },
        "路径归类对应的阶段": dict(rules["路径归类对应的阶段"]),
        "路径归不上类时叫什么": rules["路径归不上类时叫什么"],
        "工具对应的阶段": dict(rules["工具对应的阶段"]),
        "按路径归类来判的工具": list(rules["按路径归类来判的工具"]),
        "异常判据": dict(rules["异常判据"]),
        "每一项是从哪里来的": where_from,
    }


def declaration_for(index, task_key: str | None, workspace_abs: str, rules: dict) -> tuple[dict, str]:
    """按任务取归类声明，返回（声明, 页头要注明的一句话）。"""
    defaults_note = ("异常判据的阈值等其余几项是观测台自己带的默认值，放在观测台的 stage_rules.json 里。")
    task = index.tasks.get(task_key) if task_key else None
    if task and task.get("格式") == taskdb.FORMAT_CURRENT:
        definition = task["新库"]["任务定义"]
        path = task["新库"]["任务定义文件"]
        materials = ("任务定义里没有写「材料目录」，用的是缺省值 inputs/。"
                     if definition.get("材料目录是不是缺省值") else "「材料目录」是任务定义里写的。")
        decl = declaration(rules, definition, definition.get("任务名") or "未知的任务",
                           {"执行方法、领域规矩、文档模板、材料目录":
                            f"从任务定义 {path} 里读来的（库里存着创建任务那一刻的原文快照）。{materials}",
                            "其余几项": defaults_note})
        return decl, ""
    if task:
        path = task.get("任务定义文件") or "（任务里没有登记任务定义文件）"
        why = (f"这个任务的库是旧格式。它的任务定义文件 {path} 里登记的是槽位、做法的分步列表与交付物说明，"
               "没有执行方法、领域规矩与材料目录，按不出路径归类，所以这一次用的是观测台自己带的默认声明。")
        decl = declaration(rules, None, "观测台自己带的默认声明", {"全部": why})
        return decl, (f"这个任务的库是旧格式：任务定义文件 {path} 里没有登记执行方法路径与材料目录，"
                      "材料文件、执行方法与领域规矩是按观测台自己带的默认归类声明认的。")
    folder = Path(workspace_abs) / "docs" / "task-definitions" if workspace_abs else None
    found = sorted(folder.glob("*.json")) if folder and folder.is_dir() else []
    if len(found) == 1:
        try:
            parsed = taskdb.parse_definition(found[0].read_text(encoding="utf-8"))
        except OSError:
            parsed = None
        if parsed:
            rel = f"docs/task-definitions/{found[0].name}"
            decl = declaration(rules, parsed, parsed.get("任务名") or "未知的任务",
                               {"执行方法、领域规矩、文档模板、材料目录":
                                f"这条会话所在的任务目录里还没有任务记录，这几项是按任务目录里唯一的一份任务定义 {rel} 猜的。",
                                "其余几项": defaults_note})
            return decl, ("这条会话所在的任务目录里还没有任务记录，判不出用的是哪一份归类声明；材料文件、执行方法与领域规矩"
                          f"是按任务目录里唯一一份任务定义（{found[0].name}）猜的。")
    why = ("这条会话所在的任务目录里还没有任务记录，任务目录里的任务定义也不止一份或者一份都没有，"
           "判不出用的是哪一份，所以用观测台自己带的默认声明。")
    decl = declaration(rules, None, "观测台自己带的默认声明", {"全部": why})
    return decl, ("这条会话所在的任务目录里还没有任务记录，判不出用的是哪一份归类声明；"
                  "材料文件、执行方法与领域规矩是按观测台自己带的默认声明认的。")


def strip_dot_slash(path: str) -> str:
    """去掉路径开头的 ./（可能有好几个）。不能用 lstrip，那会把 .pi 开头的点也去掉。"""
    while path.startswith("./"):
        path = path[2:]
    return path


def path_class(rel: str, decl: dict) -> str | None:
    """一个相对任务目录的路径落在归类声明的哪一类里，落不进任何一类返回 None。"""
    groups = decl["路径归类"]
    for name in ("执行方法", "领域规矩", "文档模板"):
        for one in groups[name]:
            if one and rel == strip_dot_slash(one):
                return name
    for one in groups["材料目录"]:
        base = strip_dot_slash(one).rstrip("/")
        if base and (rel == base or rel.startswith(base + "/")):
            return "材料目录"
    return None


def classify_call(call: dict, decl: dict, rules: dict, workspace_abs: str) -> tuple[str, str]:
    """按声明判定一次工具调用属于哪一种阶段，返回（阶段名, 角色）。只看工具名、路径与成功失败。"""
    tool = call["工具"]
    if call.get("被拒"):
        return rules["被工具拒绝的轮叫什么"], "失败"
    if tool in decl["按路径归类来判的工具"]:
        rel = relative_to_workspace((call.get("参数") or {}).get("path"), workspace_abs)
        kind = path_class(rel, decl)
        if kind:
            return decl["路径归类对应的阶段"][kind], kind
        return decl["路径归不上类时叫什么"], "归不上类"
    mapped = decl["工具对应的阶段"].get(tool)
    if mapped:
        if tool in rules["写交付物的工具"]:
            return mapped, "写入"
        if tool in rules["建任务的工具"]:
            return mapped, "建任务"
        if tool in rules["列目录的工具"]:
            return mapped, "列目录"
        return mapped, "其他"
    return f"用了工具 {tool}", "其他"


def classify_turn(turn: dict, decl: dict, rules: dict, workspace_abs: str) -> tuple[str, str]:
    """一轮只属于一个阶段，按这一轮的第一个工具调用判。成功送达的「回复」算对用户说话。"""
    if turn["调用"]:
        first = turn["调用"][0]
        if first["工具"] in rules.get("对用户说话的工具", []) and not first["被拒"] and first.get("有没有执行结果", True):
            return rules["没有工具调用、说了话的轮叫什么"], "说话"
        return classify_call(first, decl, rules, workspace_abs)
    if (turn.get("正文") or "").strip():
        return rules["没有工具调用、说了话的轮叫什么"], "说话"
    return rules["没有工具调用、也没有说话的轮叫什么"], "沉默"


# ───────────────────────── 一、库里写下的变化，新旧两种格式归一成一种形状 ─────────────────────────

ACTION_NAME = {"add": "新增", "update": "修改", "delete": "删除"}


def group_sentence(ops: list[dict]) -> str:
    """多个操作按「动作＋集合」归组，写成一句完整的话。"""
    order, counts = [], {}
    for op in ops:
        key = (op["动作"], op.get("集合") or "条目")
        if key not in counts:
            order.append(key)
            counts[key] = 0
        counts[key] += 1
    return "，".join(f"{a}了 {counts[(a, g)]} 个{g}条目" for a, g in order) + "。"


def title_of(fields: dict | None, declared: list[dict]) -> str:
    """条目的标题：取集合声明里第一个字段的值。列表就用分号接起来。"""
    if not fields or not declared:
        return ""
    value = fields.get(declared[0]["名"])
    if isinstance(value, list):
        value = "；".join(str(x) for x in value)
    return shorten(value, 90) if value else ""


def field_change(name: str, kind: str, before, after) -> dict:
    """一个字段的改前改后，附上比对结果：文本逐字比，文本列表逐项比。"""
    row = {"字段": name, "类型": kind or "文本", "改前": before, "改后": after}
    if kind == "文本列表":
        row["步骤"] = diff_list(before if isinstance(before, list) else [],
                                after if isinstance(after, list) else [])
    elif kind in ("文本", "", None):
        row["段"] = diff_text("" if before is None else str(before), "" if after is None else str(after))
    return row


def normalize_new(change: dict, task: dict | None) -> dict:
    """新格式：读取接口给的「带来的变化」一条，裁成页面要画的形状。"""
    if change.get("种类") == "任务的变化":
        sets = change.get("集合") or []
        return {
            "类别": "任务的变化", "修订序号": None,
            "标题句": (f"助手创建了任务 {change.get('任务编号', '')}，任务名是「{change.get('任务名', '')}」，"
                       f"交付物分成 {len(sets)} 个条目集合：{'、'.join(sets)}。"),
            "标签": [change.get("任务编号")] if change.get("任务编号") else [],
            "操作": [], "事件": [],
            "任务": {"任务编号": change.get("任务编号"), "任务名": change.get("任务名"),
                     "集合": sets, "说明": change.get("说明", "")},
        }
    declared = {c["名称"]: c["字段"] for c in ((task or {}).get("任务定义") or {}).get("集合", [])}
    items = {i["条目编号"]: i for i in (task or {}).get("条目", [])}
    ops = []
    for one in change.get("变化") or []:
        action = ACTION_NAME.get(one.get("操作"), one.get("操作的中文名") or "修改")
        coll = one.get("所属集合") or (items.get(one.get("条目编号")) or {}).get("所属集合") or "条目"
        fields_declared = declared.get(coll, [])
        item = items.get(one.get("条目编号")) or {}
        after = taskdb.content_at(item, one.get("改后所在修订")) if item else None
        before = taskdb.content_at(item, one.get("改前所在修订")) if item else None
        last = (item.get("修订内容") or [None])[-1]
        title = title_of((after or before or last or {}).get("字段"), fields_declared)
        fields, changed = [], []
        for f in one.get("字段") or []:
            if "改前" in f or "改后" in f:
                changed.append(field_change(f["名"], f.get("类型"), f.get("改前"), f.get("改后")))
            else:
                fields.append({"名": f["名"], "类型": f.get("类型") or "文本", "值": f.get("值")})
        ops.append({
            "动作": action, "集合": coll, "条目编号": one.get("条目编号"), "条目标题": title,
            # 新格式只有修订号，没有条目版本号；显示用的文字直接给出，页面照着显示。
            "版本": [None, None],
            "版本变化": (f"修订 {one.get('改前所在修订')} → 修订 {one.get('改后所在修订')}" if action in ("修改", "恢复")
                         and one.get("改前所在修订") is not None else ""),
            "字段": fields, "变更": changed,
            "来源": [source_view(s) for s in (one.get("来源") or [])],
            "来源变了吗": bool(one.get("来源变了吗")),
            "在第几次修订删除": one.get("在第几次修订删除"),
        })
    rev = change.get("修订序号")
    return {
        "类别": "交付物的变化", "修订序号": rev, "旧库表": False,
        "标题句": (f"交付物形成修订 {rev}：" if rev is not None else "交付物有改动：") + group_sentence(ops),
        "标签": [o["条目编号"] for o in ops if o["条目编号"]],
        "操作": ops, "事件": [], "任务": None,
    }


def normalize_old(events: list[dict]) -> dict:
    """旧格式：库里只有「某个字段被改写」这一种变化。字段的改写内容很短，改前改后直接显示。"""
    ops, words = [], []
    for e in events:
        body = e.get("内容") or {}
        slot, old, new = body.get("slot"), body.get("old"), body.get("new")
        if old:
            ops.append({"动作": "修改", "集合": "任务的字段", "条目编号": slot, "条目标题": slot,
                        "版本": [None, None], "字段": [], "来源": [],
                        "变更": [field_change(slot, "文本", old, new)]})
            words.append(f"改写了「{slot}」这个字段")
        else:
            ops.append({"动作": "新增", "集合": "任务的字段", "条目编号": slot, "条目标题": slot,
                        "版本": [None, None], "字段": [{"名": slot, "类型": "文本", "值": new}],
                        "来源": [], "变更": []})
            words.append(f"第一次写下「{slot}」这个字段")
    return {
        "类别": "交付物的变化", "修订序号": None, "旧库表": True,
        "标题句": "，".join(words) + "。", "标签": [o["条目编号"] for o in ops if o["条目编号"]],
        "操作": ops, "事件": [], "任务": None,
    }


def excerpt_of(basis, item_id: str) -> str:
    """判读依据里这个条目的摘录，几段之间用分号连起。界面点击的确认没有摘录。"""
    if not isinstance(basis, list):
        return ""
    return "；".join(f"「{b.get('摘录')}」" for b in basis
                    if isinstance(b, dict) and b.get("条目") == item_id and b.get("摘录"))


def normalize_record(change: dict) -> dict:
    """确认标记与「完成任务」写下的记录：一句标题加几行「名目：内容」。确认标记由用户在界面上的操作写下（已读、界面修改、撤回），
    早期版本的库里还有由模型读用户原话登记的。"""
    if change.get("种类") == "任务的完成":
        return {"类别": "任务的完成", "修订序号": None, "标题句": change.get("说明", ""),
                "标签": [change.get("任务编号")] if change.get("任务编号") else [],
                "记录": [["任务", f"{change.get('任务编号', '')}「{change.get('任务名', '')}」"]],
                "操作": [], "事件": [], "任务": None}
    rows = change.get("明细") or []
    accepted = [r for r in rows if r.get("态度") == "接受"]
    records = []
    for r in rows:
        item, no = r.get("条目编号") or r.get("item_id"), r.get("修订号") or r.get("revision_no")
        attitude = r.get("态度") or "接受"
        quote = excerpt_of(change.get("依据"), item)
        records.append([f"{item}（修订 {no}）", attitude + (f"，依据是用户说的{quote}" if quote else "")])
    number = change.get("判读序号")
    head = (f"写下了第 {number} 条确认标记" if number is not None else "写下了一条确认标记") + \
           f"（依据：{change.get('依据种类', '')}）：{len(accepted)} 个条目算作确认，{len(rows) - len(accepted)} 个撤回了确认。"
    return {"类别": "确认记录", "修订序号": None, "标题句": head,
            "标签": [r[0].split(" ")[0] for r in records], "记录": [["说明", change.get("说明", "")], *records],
            "操作": [], "事件": [], "任务": None}


def model_calls_of(call: dict) -> list[dict]:
    """这次工具调用在工具里直接发起的模型调用（评审者；早期版本的库里还有登记确认时的调用），原样交给页面，提示与输出在抽屉里看全文。"""
    return [one for c in call.get("带来的变化") or [] if c.get("种类") == "工具里的模型调用" for one in c.get("调用") or []]


def rejections_of(call: dict) -> list[dict]:
    """这次工具调用被拒时库里 tool_rejection 表记下的拒绝记录（事实层、指引层、原因种类），原样交给页面。"""
    return [one for c in call.get("带来的变化") or [] if c.get("种类") == "工具的拒绝记录" for one in c.get("记录") or []]


def event_shape(e: dict) -> dict:
    return {k: e.get(k) for k in ("事件名", "事件序号", "来源", "发起方", "时刻")}


def changes_of(call: dict, index) -> list[dict]:
    """这次调用在库里写下的变化，归一成一个列表；什么都没写下时是空列表。"""
    out = []
    for one in call.get("带来的变化") or []:
        if one.get("种类") in ("确认的登记", "任务的完成"):
            block = normalize_record(one)
            block["事件"] = [event_shape(e) for e in (call.get("库里写下的事件") or [])]
            out.append(block)
            continue
        if one.get("种类") not in ("任务的变化", "交付物的变化"):
            continue
        task = (index.tasks.get(one.get("任务的键")) or {}).get("新库")
        block = normalize_new(one, task)
        block["事件"] = [event_shape(e) for e in (call.get("库里写下的事件") or [])]
        out.append(block)
    if out:
        return out
    events = [e for e in (call.get("库里写下的事件") or [])
              if isinstance(e.get("内容"), dict) and "slot" in e["内容"]]
    if events and call.get("是否被拒") is not True:
        block = normalize_old(events)
        rev = (call.get("产生的修订") or {}).get("修订序号")
        if rev is not None:
            block["修订序号"] = rev
            block["标题句"] = f"任务的数据形成修订 {rev}：" + block["标题句"]
        block["事件"] = [event_shape(e) for e in events]
        return [block]
    return []


# ───────────────────────── 二、一次调用、一次模型请求、一轮 ─────────────────────────

def arg_brief(call: dict, workspace_abs: str) -> str:
    args = call.get("参数") or {}
    if not isinstance(args, dict):
        return shorten(json.dumps(args, ensure_ascii=False), 80)
    if "path" in args:
        return relative_to_workspace(args["path"], workspace_abs) or str(args["path"])
    if "definition_path" in args:
        return str(args["definition_path"])
    if "field" in args:
        return f"字段「{args['field']}」"
    if isinstance(args.get("operations"), list):
        return f"带了 {len(args['operations'])} 个操作"
    return shorten(json.dumps(args, ensure_ascii=False), 80)


def replay_note(call: dict) -> str:
    """「保存修订」按调用编号判重：同一次调用重放时工具不再写入，结果细节里 replayed 为真。这时给一句说明，否则是空文字。"""
    details = call.get("结果细节") or {}
    if call.get("是否被拒") is not False or not isinstance(details, dict) or details.get("replayed") is not True:
        return ""
    return (f"这次调用的调用编号与之前一次相同（模型重试或 pi 重发），工具没有重复写入，交回的是第一次的结果"
            f"（修订 {details.get('revision_no')}）。它带来的改动画在第一次那里。")


def call_shape(call: dict, index, rules: dict, workspace_abs: str, run_offset: int) -> dict:
    replayed = replay_note(call)
    # 重放的那次与第一次共用调用编号，库里的事件会对到两次上；改动只画在第一次那里。
    written = [] if replayed else changes_of(call, index)
    rejected = call.get("是否被拒") is True
    fix = call.get("改正") or None
    unmatched = ""
    writer = call["工具"] in rules["写交付物的工具"] or call["工具"] in rules["建任务的工具"]
    if writer and not rejected and call.get("是否被拒") is False and not written and not replayed:
        unmatched = ("这次调用在库里找不到对应的记录：工具回的是接受，可是当前扫到的任务目录里没有这个调用编号写下的事件。"
                     "常见的原因是那个任务目录后来被重建过。观测台不猜它原来写下了什么。")
    return {
        "编号": call["调用编号"], "工具": call["工具"], "中文名": call.get("工具中文名", ""),
        "参数": call.get("参数") or {}, "参数摘要": arg_brief(call, workspace_abs),
        "相对路径": relative_to_workspace((call.get("参数") or {}).get("path")
                                          if isinstance(call.get("参数"), dict) else "", workspace_abs),
        "结果全文": call.get("结果文字") or "", "结果摘要": shorten(call.get("结果文字"), 160),
        "被拒": rejected, "有没有执行结果": call.get("是否被拒") is not None,
        "耗时秒": call.get("耗时秒"),
        "起止": [call.get("开始收到时刻"), call.get("结束收到时刻")],
        "泳道": call.get("泳道", 1), "链接": call.get("Langfuse 直达链接", ""),
        "改动": written, "有没有写入": bool(written), "对不上": unmatched, "模型调用": model_calls_of(call),
        "拒绝记录": rejections_of(call),
        "事件": [] if replayed else [event_shape(e) for e in (call.get("库里写下的事件") or [])],
        "修订序号": None if replayed else (call.get("产生的修订") or {}).get("修订序号"),
        "重放说明": replayed,
        "改正": ({"运行序号": fix.get("运行序号") + run_offset, "轮号": fix.get("轮号"),
                  "改正成功": bool(fix.get("改正成功")), "有没有再试": True}
                 if fix and fix.get("有没有再试") else
                 ({"有没有再试": False} if fix else None)),
        "要求到此为止": bool(call.get("要求到此为止")),
        "回复": reply_shape(call, rules),
    }


def reply_shape(call: dict, rules: dict) -> dict | None:
    """「回复」调用给页面的样子：排好的几行（与终端一致）、成文正文、是否降级放行、被拒的原因。不是回复返回 None。"""
    if call["工具"] not in rules.get("对用户说话的工具", []) or call.get("是否被拒") is None:
        return None
    rejected = call.get("是否被拒") is True
    details = call.get("结果细节") or {}
    reply = details.get("reply") if isinstance(details.get("reply"), dict) else (call.get("参数") or {})
    return {
        "被拒": rejected,
        "排版": render_reply_lines(call),
        "排版是怎么来的": "调用 agent 的排版函数（cli/render.mts），与终端界面、终端客户端显示的是同一份。",
        "成文的话": "" if rejected else str(reply.get("text") or ""),
        "告知": [] if rejected else list(reply.get("informs") or []),
        "主行为": None if rejected else reply.get("act"),
        "降级放行": bool(details.get("degraded")),
        "降级放行说明": ("这条回复没有按结构发出：「回复」连续被拒到上限，工具只放行了一段纯文字（degraded 为真）。"
                         if details.get("degraded") else ""),
        "被拒原因": (call.get("结果文字") or "") if rejected else "",
        "会话条目编号": details.get("message_id") or "",
    }


def request_shape(req: dict) -> dict:
    two = req.get("带的消息") or {}
    return {
        "模型": req.get("模型"), "供应方": req.get("供应方"), "接口": req.get("接口"),
        "停止原因": req.get("停止原因"), "原始停止原因": req.get("pi 给的原始停止原因"),
        "出错说明": req.get("出错说明", ""),
        "词元": {k: (req.get("词元") or {}).get(k)
                 for k in ("input", "output", "cacheRead", "reasoning", "totalTokens")},
        "耗时秒": req.get("耗时秒"), "耗时是怎么算的": req.get("耗时是怎么算的", ""),
        "响应编号": req.get("响应编号"),
        "带的消息": {k: two.get(k) for k in ("观测台数出来的", "取自 Langfuse 的", "两个数一样吗",
                                             "观测台是怎么数的", "Langfuse 是怎么数的")},
        "是不是自动重试": bool(req.get("是不是自动重试")),
        "链接": req.get("Langfuse 直达链接", ""),
        "最近几条消息": [{"角色": m.get("角色"), "开头": shorten(m.get("开头"), 110)}
                         for m in (req.get("最近几条消息") or [])][:4],
        "行": [req.get("开始行号"), req.get("归档行号")],
        "起止": [req.get("开始收到时刻"), req.get("结束收到时刻")],
    }


def steer_kind(text: str, run: dict) -> str:
    """一条中途进来的用户消息是插话还是跟进，看 pi 的排队变化事件里它排在哪一队。"""
    for change in run.get("排队变化") or []:
        body = change.get("内容") or {}
        if text in (body.get("followUp") or []):
            return "跟进（followUp）"
        if text in (body.get("steering") or []):
            return "插话（steer）"
    return "插话（steer）"


def is_understanding(text: str) -> bool:
    """这段助手文字是不是助手写的理解：```json 围栏开头，或者整段是一个带 acts 的 JSON 对象。只看形式，只用来给原文加标题；
    理解是不是记下了、合不合格，以任务库为准（dialogue.py），不看这里。"""
    body = text.strip()
    return body.startswith("```json") or (body.startswith("{") and '"acts"' in body)


def turn_shape(turn: dict, run: dict, index, rules: dict, workspace_abs: str, run_offset: int) -> dict:
    shaped = {
        "序数": turn["给人读的序数"], "轮号": turn.get("pi 给的轮号"),
        "轮号来源": turn.get("轮号是谁给的", ""),
        "耗时秒": turn.get("耗时秒"), "时刻": clock(turn.get("开始收到时刻")),
        "起止": [turn.get("开始收到时刻"), turn.get("结束收到时刻")],
        "行": [turn.get("开始行号"), turn.get("结束行号")],
        "归档文件": turn.get("归档文件", ""),
        "正文": turn.get("助手文字") or "",
        "请求": [request_shape(r) for r in (turn.get("模型请求") or [])],
        "调用": [call_shape(c, index, rules, workspace_abs, run_offset) for c in (turn.get("工具调用") or [])],
        "运行记录链接": turn.get("Langfuse 运行记录链接", ""),
        "插话": [],
        "自动重试说明": "",
        "正文从哪来": "模型正文" if (turn.get("助手文字") or "").strip() else "",
        # 这一轮的文字以助手写的理解（一段对话行为的 JSON）开头时，页面把这段原文标成「助手写的理解（原文）」。
        "正文是理解": is_understanding(turn.get("助手文字") or ""),
        "出错说明": [r["出错说明"] or "归档里没有写出错的原因" for r in (turn.get("模型请求") or [])
                     if r.get("停止原因") == "error"],
    }
    # 执行者经「回复」工具说的话，就是这一轮对用户说的话（说话一律经它）。
    for c in shaped["调用"]:
        if c.get("回复") and not c["回复"]["被拒"] and c["回复"]["成文的话"].strip():
            shaped["正文"] = c["回复"]["成文的话"]
            shaped["正文从哪来"] = "回复工具"
            shaped["回复"] = c["回复"]
    if any(r["是不是自动重试"] for r in shaped["请求"]):
        # 这是这次运行里第几次自动重试：按轮的先后数，pi 的 auto_retry_start 事件里有尝试序号与等待的毫秒数。
        retried = [t for t in run.get("轮") or [] if any(r.get("是不是自动重试") for r in t.get("模型请求") or [])]
        nth = next((i for i, t in enumerate(retried, 1) if t is turn), None)
        starts = [r.get("内容") or {} for r in run.get("自动重试") or [] if r.get("事件") == "auto_retry_start"]
        info = starts[nth - 1] if nth and nth <= len(starts) else {}
        which = f"第 {info.get('attempt', nth)} 次" if (info.get("attempt") or nth) else "一次"
        wait = f"，等了 {info['delayMs'] / 1000:g} 秒再试" if isinstance(info.get("delayMs"), (int, float)) else ""
        shaped["自动重试说明"] = (
            f"上一次模型请求出错了，pi 自动重试（pi 的概念：自动重试 auto retry），这是{which}{wait}。"
            "重试让 pi 重新开始了一段低层运行，它给的轮号 turnIndex 从 0 重新编；"
            f"观测台按这次运行接着数轮，所以这里是第 {shaped['序数']} 轮，而 turnIndex 是 {shaped['轮号']}。")
    for message in run.get("用户消息") or []:
        if message.get("这条是不是触发这次运行的那条"):
            continue
        if message.get("落在第几轮") == shaped["序数"]:
            shaped["插话"].append({
                "谁": "用户", "原文": message.get("文字", ""), "条目编号": message.get("条目编号", ""),
                "时刻": clock(message.get("收到时刻") or message.get("时刻")),
                "种类": steer_kind(message.get("文字", ""), run),
                "说明": ("这句话是在助手这次运行还没有结束时投进来的。pi 把它排进消息列表，"
                         "在这一轮开始时交给模型看；这次运行没有因此断成两段。"),
            })
    return shaped


# ───────────────────────── 三、一个阶段的那一句话与小步 ─────────────────────────

READ_LABEL = {"执行方法": "执行方法文件", "领域规矩": "领域规矩文档", "材料目录": "材料文件",
              "文档模板": "文档模板", None: "归类声明里归不上类的文件"}


def mixed_line(calls: list[dict], decl: dict) -> str:
    """一个阶段里的调用不止一种（同一轮里并行调用了不同的工具，或读了不同种类的文件）时，逐组如实写出来。"""
    groups: list[tuple[tuple, list[dict]]] = []
    for c in calls:
        if c["工具"] in decl["按路径归类来判的工具"]:
            key = ("读", path_class(c["相对路径"], decl))
        else:
            key = ("调用", c["工具"])
        for k, members in groups:
            if k == key:
                members.append(c)
                break
        else:
            groups.append((key, [c]))
    parts = []
    for (how, what), members in groups:
        names = []
        for c in members:
            name = basename(c["参数摘要"]) if how == "读" else (c["参数摘要"] or "（没有参数）")
            if name not in names:
                names.append(name)
        if how == "读":
            parts.append(f"读了{READ_LABEL[what]} {'、'.join(names)}")
        else:
            label = members[0].get("中文名") or what
            result = "；".join(shorten(c["结果全文"], 50) for c in members)
            parts.append(f"调用了「{label}」（{'、'.join(names)}），得到的是：{result}")
    return "助手" + "；同一个阶段里还".join(parts) + "。"


def one_line(role: str, turns: list[dict], decl: dict | None = None) -> str:
    calls = [c for t in turns for c in t["调用"]]
    names = [basename(c["参数摘要"]) for c in calls]
    if decl and role not in ("失败", "说话", "沉默") and calls:
        kinds = {("读", path_class(c["相对路径"], decl)) if c["工具"] in decl["按路径归类来判的工具"]
                 else ("调用", c["工具"]) for c in calls}
        if len(kinds) > 1:
            return mixed_line(calls, decl)
    if role == "执行方法":
        return f"助手读了执行方法文件 {'、'.join(names)} 的正文。"
    if role == "列目录":
        seen = "；".join(shorten(c["结果全文"], 60) for c in calls)
        return f"助手列了目录 {calls[0]['参数摘要'] or '（任务目录根目录）'} 里的文件，看到的是：{seen}。"
    if role == "材料目录":
        return f"助手读了材料文件 {'、'.join(names)} 的全文。"
    if role == "领域规矩":
        return f"助手读了归类声明里登记的 {len(calls)} 份领域规矩文档：{'、'.join(names)}。"
    if role == "文档模板":
        return f"助手读了文档模板 {'、'.join(names)}。"
    if role == "归不上类":
        return f"助手读了 {'、'.join(names)}，这几个路径在归类声明里归不上类。"
    if role == "建任务":
        for c in calls:
            for b in c["改动"]:
                if b["类别"] == "任务的变化":
                    return b["标题句"]
        return f"助手调用了「{calls[0].get('中文名') or calls[0]['工具']}」这个工具，库里没有留下任务。"
    if role == "写入":
        return write_line(calls)
    if role == "说话":
        return shorten(plain(turns[-1]["正文"]), 110)
    if role == "沉默":
        errored = [r for t in turns for r in t["请求"] if r["停止原因"] == "error"]
        if len(errored) == 1:
            reason = errored[0].get("出错说明") or "归档里没有写出错的原因"
            return f"这一轮的模型请求出错了，模型既没有说话，也没有调用工具。出错的说明是：{shorten(reason, 80)}"
        if errored:
            return (f"这里连着 {len(errored)} 次模型请求都出错了，模型既没有说话，也没有调用工具；"
                    "每一次的出错说明逐条列在下面。")
        return "这一轮模型既没有对用户说话，也没有调用任何工具。"
    return f"助手调用了 {calls[0]['工具']}，一共 {len(calls)} 次。"


#: 旧格式的库只有「任务的字段」一种东西，动作的读法与新格式不同。
OLD_ACTION_WORD = {"新增": "第一次写下", "修改": "改写", "删除": "删掉"}


def write_line(calls: list[dict]) -> str:
    """写交付物阶段的标题句：只说这一阶段一共做了什么——保存了几次，按动作与集合给出条目个数。
    条目的编号与标题留给展开后的小步。同一个条目在这一阶段里被同一种动作动了几次，只算一个。"""
    ops = [o for c in calls for b in c["改动"] if b["类别"] == "交付物的变化" for o in b["操作"]]
    if not ops:
        return f"助手调用了 {len(calls)} 次保存，库里没有留下任何改动。"
    old = any(b.get("旧库表") for c in calls for b in c["改动"])
    tally: dict[str, dict[str, set]] = {}
    for i, o in enumerate(ops):
        per_set = tally.setdefault(o["动作"], {})
        per_set.setdefault(o.get("集合") or "条目", set()).add(o.get("条目编号") or f"#{i}")
    parts = []
    for action in ["新增", "修改", "删除"] + [a for a in tally if a not in ACTION_NAME.values()]:
        if action not in tally:
            continue
        if old:
            count = sum(len(codes) for codes in tally[action].values())
            parts.append(f"{OLD_ACTION_WORD.get(action, action)} {count} 个字段")
        else:
            parts.append(action + "、".join(f"{coll} {len(codes)} 个" for coll, codes in tally[action].items()))
    empty = sum(1 for c in calls if not c["改动"])
    tail = f"；其中 {empty} 次没有在库里写下改动" if empty else ""
    return f"助手保存了 {len(calls)} 次：" + "；".join(parts) + tail + "。"


def fail_line(turns: list[dict]) -> str:
    calls = [c for t in turns for c in t["调用"] if c["被拒"]] or [c for t in turns for c in t["调用"]]
    reasons: dict[str, int] = {}
    for c in calls:
        text = str(c["结果全文"])
        key = ("文件不存在" if "ENOENT" in text else
               "路径是一个目录，不是文件" if "EISDIR" in text else first_sentence(text))
        reasons[key] = reasons.get(key, 0) + 1
    detail = "；".join(f"{k}（{v} 次）" for k, v in reasons.items())
    tool = calls[0].get("中文名") or calls[0]["工具"]
    if len(calls) == 1:
        return f"助手调用「{tool}」这个工具，被工具拒绝了。拒绝的原因是：{detail}"
    tools = {c["工具"] for c in calls}
    between = "这中间它没有再调用别的工具。" if len(tools) == 1 else ""
    return f"助手连着 {len(calls)} 次调用都被工具拒绝了，原因是：{detail}{between}"


def sub_steps(role: str, turns: list[dict]) -> list[dict]:
    steps = []
    calls = [(t, c) for t in turns for c in t["调用"]]
    if role == "写入":
        for t, c in calls:
            texts = [b["标题句"] for b in c["改动"]] or [c["对不上"] or "这一次保存没有在库里写下任何改动。"]
            steps.append({"文字": "".join(texts), "条目": [x for b in c["改动"] for x in b["标签"]],
                          "耗时秒": c["耗时秒"], "轮": t["序数"]})
    elif role in ("领域规矩", "材料目录", "归不上类", "文档模板", "执行方法") and len(calls) > 1:
        for t, c in calls:
            steps.append({"文字": f"读了 {basename(c['参数摘要'])}。", "条目": [],
                          "耗时秒": c["耗时秒"], "轮": t["序数"]})
    elif role == "失败":
        for i, (t, c) in enumerate(calls):
            state = "被拒绝了" if c["被拒"] else "成功了"
            steps.append({"文字": f"第 {i + 1} 次：{c.get('中文名') or c['工具']}，{c['参数摘要']}，{state}。",
                          "条目": [], "耗时秒": c["耗时秒"], "轮": t["序数"]})
    elif role == "沉默":
        errored = [(t, r) for t in turns for r in t["请求"] if r["停止原因"] == "error"]
        if len(errored) > 1:
            for i, (t, r) in enumerate(errored, 1):
                steps.append({"文字": f"第 {i} 次出错，在第 {t['序数']} 轮：{r.get('出错说明') or '归档里没有写出错的原因'}",
                              "条目": [], "耗时秒": r.get("耗时秒"), "轮": t["序数"]})
    elif len(calls) > 1:
        for t, c in calls:
            steps.append({"文字": f"{c.get('中文名') or c['工具']}：{c['参数摘要']}。", "条目": [],
                          "耗时秒": c["耗时秒"], "轮": t["序数"]})
    return steps


# ───────────────────────── 四、把一串运行摊成阶段 ─────────────────────────

def boot_text(launch_count: int, session_no: int, session_changed: bool, knowledge_change: str) -> str:
    if session_changed and session_no > 1:
        text = (f"这里开始这个任务的第 {session_no} 条会话：后端新启动了一个 pi 进程，开了一条新的会话"
                "（后端的概念：一次 pi 进程启动）。")
    elif launch_count == 1:
        text = ("这一项之前，后端把助手的 pi 进程启动了第 1 次（后端的概念：一次 pi 进程启动）。"
                "这是助手这条线上的一个节点，不是所有参与者的分界。")
    else:
        text = ("在这之前，助手的 pi 进程重启过一次，后端用原来的会话文件接回了同一条会话"
                "（后端的概念：一次 pi 进程启动）。")
    return text + knowledge_change


def parallel_suffix(main: str, turns: list[dict], decl: dict, rules: dict, workspace_abs: str) -> str:
    """阶段仍按每一轮的第一个调用判；同一轮里还有别的种类的调用时，把它们各自按同一份声明判出的阶段名接在后面，
    例如「了解方法，同时找材料」。被拒的并行调用不接（阶段行上另有被拒的标记）。只有一种时返回空串。"""
    others: list[str] = []
    for t in turns:
        for c in t["调用"][1:]:
            if c.get("被拒"):
                continue
            name, _ = classify_call(c, decl, rules, workspace_abs)
            if name != main and name not in others:
                others.append(name)
    return (rules["一轮里同时有别的种类的调用时阶段名的连接词"] + "、".join(others)) if others else ""


def build_stages(runs: list[dict], decl: dict, rules: dict, index, workspace_abs: str,
                 key_prefix: str) -> list[dict]:
    """按轮归类（本页已经不再输出，留待后端改写时清理）。runs 是按时间排好的运行，已经带上全局的运行序号与启动说明。"""
    stages = []

    for run in runs:
        run_no = run["运行序号"]
        prompt = run.get("提示") or {}
        say_id = f"say-{key_prefix}{run_no}"
        if prompt.get("原文"):
            stages.append({
                "参与者": "用户", "类型": "用户发话", "角色": "用户", "名称": "用户发话", "编号": say_id,
                "一句话": shorten(prompt["原文"], 90), "全文": prompt["原文"],
                "时刻": clock(prompt.get("时刻")), "运行序号": run_no,
                "模型耗时秒": None, "工具耗时秒": None, "结果": "正常", "被拒次数": 0,
                "小步": [], "条目": [], "轮": [], "启动说明": "", "触发": None,
                "消息来源": prompt.get("投递方式", "未知"),
                "消息来源的依据": prompt.get("投递方式的依据", ""),
                "条目编号": prompt.get("用户消息条目编号", ""),
                "时间条": None, "改正线索": None, "消息": [],
                "说明": "这一句话触发了助手的一次运行（agent run）。这个阶段属于用户，不属于助手。",
            })
        turns = run["轮"]
        for i, t in enumerate(turns):
            t["下一轮序数"] = turns[i + 1]["序数"] if i + 1 < len(turns) else None
            t["运行序号"] = run_no
        groups: list[dict] = []
        for t in turns:
            kind, role = classify_turn(t, decl, rules, workspace_abs)
            if groups and groups[-1]["kind"] == kind:
                groups[-1]["turns"].append(t)
            else:
                groups.append({"kind": kind, "role": role, "turns": [t]})

        for gi, group in enumerate(groups):
            kind, role, turns_here = group["kind"], group["role"], group["turns"]
            calls = [c for t in turns_here for c in t["调用"]]
            model_seconds = sum(r.get("耗时秒") or 0 for t in turns_here for r in t["请求"])
            tool_seconds = sum(c["耗时秒"] or 0 for c in calls)
            rejected = sum(1 for c in calls if c["被拒"])
            touched: list[str] = []
            for c in calls:
                for b in c["改动"]:
                    touched.extend(x for x in b["标签"] if x not in touched)
            failed = role == "失败"
            fix = next((c["改正"] for c in calls if c["被拒"] and c["改正"] and c["改正"].get("有没有再试")
                        and c["改正"].get("改正成功")), None)
            bar = run.get("时间条") or {}
            starts = [t["起止"][0] for t in turns_here if t["起止"][0]]
            ends = [t["起止"][1] for t in turns_here if t["起止"][1]]
            # 阶段的时间条只要这几轮各自的起止都有收到时刻就画得出来；这次运行整体的收尾对不上
            # （例如被中止）不妨碍画它里面的某个阶段。
            band = ({"能不能画": True, "起": min(starts), "止": max(ends)}
                    if len(starts) == len(turns_here) and len(ends) == len(turns_here) else
                    {"能不能画": False, "原因": bar.get("画不出的原因")
                     or "这几轮的开头或收尾在收到时刻索引里查不到，画不出时间条。"})
            stages.append({
                "参与者": "助手",
                "类型": "异常" if failed and len(calls) >= 3 else kind,
                "角色": role,
                "名称": (f"{calls[0].get('中文名') or calls[0]['工具']}被拒" if failed else kind)
                        + parallel_suffix(kind, turns_here, decl, rules, workspace_abs)
                        + error_count_suffix(role, turns_here),
                "编号": f"stage-{key_prefix}{run_no}-{gi}",
                "一句话": fail_line(turns_here) if failed else one_line(role, turns_here, decl),
                "全文": turns_here[-1]["正文"] if role == "说话" else "",
                "时刻": turns_here[0]["时刻"], "运行序号": run_no,
                "模型耗时秒": round(model_seconds, 1), "工具耗时秒": round(tool_seconds, 3),
                "结果": "失败" if failed else ("被拒" if rejected else "正常"),
                "被拒次数": rejected,
                "小步": sub_steps(role, turns_here), "条目": touched, "轮": turns_here,
                # pi 进程启动是执行者那条线上的一个节点，挂在这次运行的第一个执行者阶段上。
                "启动说明": run.get("启动说明", "") if gi == 0 else "",
                "触发": ({"编号": say_id, "谁": "用户", "原文": prompt.get("原文", ""),
                          "紧挨着吗": gi == 0} if prompt.get("原文") else None),
                "时间条": band, "改正线索": fix,
                "说明": (f"观测台把连着的、判定相同的几轮合并成一行；这一行是 {len(turns_here)} 轮合并出来的。"
                         if len(turns_here) > 1 else ""),
            })

    return stages


def error_count_suffix(role: str, turns: list[dict]) -> str:
    """「没有说话也没有调用工具」的阶段里模型请求出错了几次，写进阶段名，例如「（模型请求出错 2 次）」。"""
    if role != "沉默":
        return ""
    count = sum(1 for t in turns for r in t["请求"] if r["停止原因"] == "error")
    return f"（模型请求出错 {count} 次）" if count else ""


# ───────────────────────── 四之一、按运行排的流程 ─────────────────────────

#: 运行一行的「关键动作」只数这几个会改动任务或交付物的工具被接受的调用，按工具的中文名计次；被拒的另计一项。
KEY_ACTION_TOOLS = ("save_revision", "save_version", "create_task", "complete_task")
#: 页头与运行一行的「保存修订」按这个工具被接受的调用计数。
SAVE_TOOL = "save_revision"
#: 扩展消息那两种行的摘要取前多少个字。运行一行的用户那句话与助手应答都给完整的话，不截断。
EXT_BRIEF_CHARS = 80
#: 界面点击投进来的那句话与它触发的那次运行，开始时刻之差（运行减点击，单位秒）落在这个范围里就算对上。
CLICK_WINDOW = (-1.0, 5.0)
#: 扩展写进会话的自定义消息按类型分成几种行；没有登记的类型叫「扩展消息」。
EXT_KIND = {"taskwright-user-edit": "用户操作", "taskwright-task-status": "任务现状", "taskwright-ui-click": "界面点击"}
EXT_NOTE = {
    "用户操作": "用户在网页上直接做的操作（改交付物，或把条目标成看过），没有经过助手，所以不是一次运行；扩展把这件事记进了会话，助手下一次运行时会看到。",
    "任务现状": "扩展在会话开始（或续接）时写进会话的任务现状，不是用户打的字，也不是一次运行；助手下一次运行时会看到。",
    "界面点击": "用户在回复卡片上点了一个选项。这里对不上由它触发的那次运行，所以单独列一行。",
    "扩展消息": "扩展写进会话的一条自定义消息，不是用户打的字，也不是一次运行。",
}


def head_chars(text, limit: int) -> str:
    """取前 limit 个字，超出时在后面加省略号。空白先压成一个空格。"""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[:limit] + "…"


def accepted(call: dict) -> bool:
    """工具接受了这次调用：有执行结果，而且不是被拒。同一次调用的重放不算（工具没有再写入）。"""
    return call["有没有执行结果"] and not call["被拒"] and not call.get("重放说明")


def key_actions(calls: list[dict]) -> list[str]:
    """这次运行做的关键动作，例如「保存修订 2 次」「被拒 1 次」。没有就是空列表。"""
    counts: dict[str, int] = {}
    for c in calls:
        if c["工具"] in KEY_ACTION_TOOLS and accepted(c):
            name = c.get("中文名") or c["工具"]
            counts[name] = counts.get(name, 0) + 1
    out = [f"{name} {n} 次" for name, n in counts.items()]
    rejected = sum(1 for c in calls if c["被拒"])
    if rejected:
        out.append(f"被拒 {rejected} 次")
    return out


def run_row(run: dict) -> dict:
    """一次运行给页面的一行。run 的各轮已经过 turn_shape。"""
    no = run["运行序号"]
    prompt = run.get("提示") or {}
    calls = [c for t in run["轮"] for c in t["调用"]]
    said = (run.get("助手最后说的话") or "").strip()
    touched: list[str] = []
    for c in calls:
        for b in c["改动"]:
            touched.extend(x for x in b["标签"] if x not in touched)
    for i, t in enumerate(run["轮"]):
        t["下一轮序数"] = run["轮"][i + 1]["序数"] if i + 1 < len(run["轮"]) else None
        t["运行序号"] = no
    fix = next((c["改正"] for c in calls if c["被拒"] and c["改正"] and c["改正"].get("有没有再试")
                and c["改正"].get("改正成功")), None)
    bar = run.get("时间条") or {}
    return {
        "种类": "运行", "编号": f"run-{no}", "运行序号": no, "会话序号": run.get("会话序号", 1),
        "用户的话": prompt.get("原文", ""),
        "时刻": clock(prompt.get("时刻")), "时刻秒": prompt.get("时刻"),
        "消息来源": prompt.get("投递方式", "未知"), "消息来源的依据": prompt.get("投递方式的依据", ""),
        "条目编号": prompt.get("用户消息条目编号", ""),
        "轮数": len(run["轮"]), "工具调用次数": len(calls),
        "保存修订次数": sum(1 for c in calls if c["工具"] == SAVE_TOOL and accepted(c)),
        "被拒次数": sum(1 for c in calls if c["被拒"]),
        "耗时秒": run.get("耗时秒"),
        "模型耗时秒": round(sum(r.get("耗时秒") or 0 for t in run["轮"] for r in t["请求"]), 1),
        "工具耗时秒": round(sum(c["耗时秒"] or 0 for c in calls), 3),
        "有没有对用户说话": bool(said),
        "助手应答": said,
        "应答从哪来": run.get("助手最后说的话从哪来", ""),
        "关键动作": key_actions(calls),
        "由界面点击触发": "",
        "条目": touched, "轮": run["轮"], "启动说明": run.get("启动说明", ""),
        "时间条": ({"能不能画": True, "起": bar["起"], "止": bar["止"]} if bar.get("能不能画") else
                   {"能不能画": False, "原因": bar.get("画不出的原因") or "这次运行画不出时间条。"}),
        "改正线索": fix, "被中止": bool(run.get("被中止")),
        "没有正常收尾": bool(run.get("这次运行没有正常收尾")),
    }


def ext_row(message: dict, kind: str, session_id: str) -> dict:
    """扩展写进会话的一条自定义消息给页面的一行。"""
    text = message.get("文字", "")
    brief = re.sub(r"^(界面操作|界面点击)（不是用户打的字）：", "", text)
    brief = re.sub(r"^【[^】]*】", "", brief)
    return {"种类": kind, "编号": f"ext-{message.get('条目编号', '')}", "类型": message.get("类型", ""),
            "时刻": clock(message.get("时刻秒")), "时刻秒": message.get("时刻秒"),
            "原文": text, "摘要": head_chars(brief, EXT_BRIEF_CHARS), "说明": EXT_NOTE[kind],
            "条目编号": message.get("条目编号", ""), "会话编号": session_id}


def build_flow(details: list[dict], runs: list[dict]) -> list[dict]:
    """按会话分段的流程：每段是一条会话，段里的运行与扩展消息按时刻排。

    界面点击不单独成行，挂到它触发的那次运行上（开始时刻落在 CLICK_WINDOW 里、还没有挂过点击的第一次运行）；
    对不上的照实单独列一行。时刻缺失的扩展消息排在这一段末尾。
    """
    segments = []
    for session_no, detail in enumerate(details, 1):
        rows = [run_row(r) for r in runs if r.get("会话序号", 1) == session_no]
        others = []
        for m in sorted(detail.get("扩展写入的消息") or [], key=lambda x: x.get("时刻秒") or float("inf")):
            kind = EXT_KIND.get(m.get("类型"), "扩展消息")
            if kind == "界面点击" and m.get("时刻秒") is not None:
                hit = next((r for r in rows if not r["由界面点击触发"] and r["时刻秒"] is not None
                            and CLICK_WINDOW[0] <= r["时刻秒"] - m["时刻秒"] <= CLICK_WINDOW[1]), None)
                if hit:
                    hit["由界面点击触发"] = re.sub(r"^界面点击（不是用户打的字）：", "", m.get("文字", ""))
                    continue
            others.append(ext_row(m, kind, detail.get("会话编号", "")))
        merged = []
        for row in rows:
            if row["时刻秒"] is not None:
                while others and others[0]["时刻秒"] is not None and others[0]["时刻秒"] < row["时刻秒"]:
                    merged.append(others.pop(0))
            merged.append(row)
        merged.extend(others)
        segments.append({"会话序号": session_no, "会话编号": detail.get("会话编号", ""),
                         "会话名": detail.get("会话名", ""), "归档名": detail.get("归档名", ""),
                         "开始时刻": detail.get("开始时刻", ""), "运行次数": len(rows),
                         "Langfuse 链接": detail.get("Langfuse 链接", ""), "行": merged})
    return segments


def run_rows(flow: list[dict]) -> list[dict]:
    return [r for seg in flow for r in seg["行"] if r["种类"] == "运行"]


def build_alerts(rows: list[dict], decl: dict, task_closed_at: float | None = None) -> list[dict]:
    """需要注意：只列由事实直接得出的异常，每一条指向一次运行里的某一轮（去哪＝那一轮的锚点）。

    task_closed_at 是任务结束（完成或放弃）的时刻，没有结束为 None。被拒发生在它之后时，「之后没有再调用同一个工具」
    是合乎规矩的（已结束的任务本来就不能再写），只记一条轻的说明。
    """
    notes = []
    limit_streak = decl["异常判据"]["连着多少次工具调用都没有产生写入也没有对用户说话就算异常"]
    limit_turns = decl["异常判据"]["一次运行走多少轮算异常"]
    anchor = lambda no, turn_no: f"turn-{no}-{turn_no}"
    for row in rows:
        no, turns = row["运行序号"], row["轮"]
        streak: list[dict] = []
        best: list[dict] = []
        best_turn = None
        for t in turns:
            if (t["正文"] or "").strip():
                streak = []
            for c in t["调用"]:
                if c["有没有写入"] or (c.get("回复") and not c["回复"]["被拒"]):
                    streak = []
                    continue
                streak.append(c)
                if len(streak) > len(best):
                    best, best_turn = list(streak), t["序数"]
        if len(best) >= limit_streak:
            notes.append({"轻重": "重", "去哪": anchor(no, best_turn),
                          "文字": f"第 {no} 次运行里，助手连着 {len(best)} 次调用工具，一次也没有在库里写下任何东西，"
                                  f"这中间也没有对用户说过话。判据写在归类声明里：连着 {limit_streak} 次就算异常。"})
        if turns and not any((t["正文"] or "").strip() for t in turns):
            notes.append({"轻重": "重", "去哪": anchor(no, turns[-1]["序数"]),
                          "文字": f"第 {no} 次运行一直到结束都没有对用户说过一句话，"
                                  f"用户看不到它做了什么，也不知道它为什么停下来。"})
        if len(turns) > limit_turns:
            notes.append({"轻重": "轻", "去哪": anchor(no, turns[0]["序数"]),
                          "文字": f"第 {no} 次运行走了 {len(turns)} 轮（turn），"
                                  f"超过了归类声明里写的 {limit_turns} 轮。"})
        for t in turns:
            for r in t["请求"]:
                if r["停止原因"] == "length":
                    notes.append({"轻重": "重", "去哪": anchor(no, t["序数"]),
                                  "文字": f"第 {no} 次运行第 {t['序数']} 轮的模型输出被长度上限截断了。"})
        rejected = [(t, c) for t in turns for c in t["调用"] if c["被拒"]]
        if not rejected:
            continue
        last_turn, last = rejected[-1]
        fix = last.get("改正") or {}
        where = anchor(no, last_turn["序数"])
        head = f"第 {no} 次运行里有 {len(rejected)} 次调用被工具拒绝了"
        if fix.get("有没有再试") and fix.get("改正成功"):
            notes.append({"轻重": "轻", "去哪": where,
                          "文字": f"{head}，后来在第 {fix['运行序号']} 次运行的第 {fix['轮号'] + 1} 轮改对了。"})
        elif fix.get("有没有再试"):
            notes.append({"轻重": "重", "去哪": where,
                          "文字": f"{head}，最后一次之后再调用同一个工具仍然被拒绝。"})
        elif task_closed_at is not None and (last["起止"][0] or 0) >= task_closed_at:
            notes.append({"轻重": "轻", "去哪": where,
                          "文字": f"{head}；最后一次被拒时任务已经结束（{clock(task_closed_at)}），"
                                  f"已结束的任务不能再写，之后没有再调用同一个工具是合乎规矩的。"})
        else:
            notes.append({"轻重": "重", "去哪": where,
                          "文字": f"{head}，最后一次被拒之后，这条会话里再也没有调用过同一个工具。"})
    return notes


def build_guides(rows: list[dict], decl: dict) -> list[dict]:
    """助手读过的指导：成功读过的执行方法与领域规矩文件，按读的先后列出。"""
    guides = []
    for row in rows:
        for t in row["轮"]:
            for c in t["调用"]:
                if c["工具"] in decl["按路径归类来判的工具"] and not c["被拒"]:
                    kind = path_class(c["相对路径"], decl)
                    if kind in ("执行方法", "领域规矩"):
                        guides.append({"种类": kind, "文件": c["相对路径"],
                                       "时刻": clock(c["起止"][0]), "运行序号": row["运行序号"]})
    return guides


# ───────────────────────── 五、交付物看板 ─────────────────────────

def check_completion(db_path: Path, task_id: str, completion: dict) -> tuple[list[dict] | None, str, str]:
    """调用 agent 的核对函数逐条核对完成条件。返回（结果, 取不到时的原因, 概括句）。

    每项结果带 state：met（已满足）、unmet（还差）、empty（集合为空，这一条暂不需要核对）。
    概括句也由 agent 那一份函数写，与任务现状消息、查询任务状态工具、网页用同一种说法。"""
    node = shutil.which("node")
    if not node:
        return None, "本机找不到 node，调不动 agent 里的核对函数，完成条件无从核对。", ""
    if not completion:
        return [], "", ""
    try:
        done = subprocess.run([node, str(CHECK_SCRIPT), str(db_path), task_id,
                               json.dumps(completion, ensure_ascii=False)],
                              capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, f"调用 agent 的核对函数时出错了：{error}", ""
    if done.returncode != 0:
        return None, "调用 agent 的核对函数时出错了：" + (done.stderr.strip().splitlines() or ["没有输出"])[-1], ""
    try:
        out = json.loads(done.stdout)
    except json.JSONDecodeError:
        return None, "agent 的核对函数返回的不是 JSON。", ""
    return out.get("results") or [], "", out.get("brief") or ""


#: 完成条件在看板上的短语。看板按集合分组，集合名单独一行，下面每条只写短语。
#: 条件名是 agent 登记的那几个；这里没有登记的条件名照原样显示。
CONDITION_PHRASE = {
    "至少一个条目": "至少一个条目",
    "每个条目评审通过": "每个条目评审通过",
    "每个条目用户确认": "每个条目用户确认",
    "没有状态为未解决的条目": "没有未解决的条目",
}

#: 没有满足的条目不多于这个数时，把它们的编号逐个列出来；再多就只说个数。
LIST_UNMET_AT_MOST = 6


def condition_phrase(name: str) -> str:
    return CONDITION_PHRASE.get(name, name)


def cells_of(version: dict) -> dict:
    """评审与确认两个状态格。没有记录就是空心浅色格，不用红色。"""
    reviews = version.get("评审记录") or []
    confirms = version.get("确认记录") or []
    passed = any(r["结论"] == "合规" for r in reviews)
    accepted = any(r["态度"] == "接受" for r in confirms)
    return {
        "评审": "评审通过" if passed else ("评审过，没有通过" if reviews else "还没有这类记录"),
        "确认": "用户已确认" if accepted else ("用户没有接受" if confirms else "还没有这类记录"),
        "评审格": "ok" if passed else "", "确认格": "done" if accepted else "",
    }


def build_board_new(index, key: str, workspace_abs: str) -> dict:
    detail = index.current_task_detail(key)
    sets = []
    for coll in detail["集合"]:
        declared = coll["字段"]
        rows = []
        for item in coll["条目"]:
            cur = item["当前内容"] or {"字段": {}, "修订号": None, "来源": []}
            versions = []
            for v in item["修订内容"]:
                versions.append({
                    # 「版本号」只作页签的键；新格式里它就是修订号。显示用「标签」与「来历」。
                    "版本号": v["修订号"], "由第几次修订产生": v["修订号"],
                    "标签": f"修订 {v['修订号']}", "来历": f"条目在修订 {v['修订号']} 时的内容",
                    "字段": [{"名": f["名"], "类型": f["类型"], "值": v["字段"].get(f["名"])} for f in declared],
                    "来源": [source_view(s) for s in (v.get("来源") or [])],
                    **cells_of(v),
                })
            rows.append({
                "编号": item["条目编号"], "标题": title_of(cur["字段"], declared) or "（第一个字段是空的）",
                "版本": cur["修订号"], "所在": f"修订 {cur['修订号']}" if cur["修订号"] is not None else "",
                "来源条数": len(cur.get("来源") or []),
                "状态字段": cur["字段"].get("状态") or "",
                "已删除": item["在第几次修订删除"] is not None,
                "在第几次修订删除": item["在第几次修订删除"],
                "全部版本": versions, **cells_of(cur),
            })
        sets.append({"名称": coll["名称"], "前缀": coll["编号前缀"], "条目": rows,
                     "现有条目数": coll["现有条目数"]})
    db_path = Path(workspace_abs) / taskdb.DB_NAME
    results, why, brief = check_completion(db_path, detail["任务标识"], detail["完成条件"])
    checks = []
    if results is None:
        for coll_name, names in (detail["完成条件"] or {}).items():
            for name in names:
                checks.append({"集合": coll_name, "条件": condition_phrase(name), "满足": None, "状态": None, "说明": f"未知。{why}"})
    else:
        for r in results:
            unmet = [u["item"] for u in r.get("unmet") or [] if u.get("item")]
            more = (f"它们是：{'、'.join(unmet)}。" if unmet and len(unmet) <= LIST_UNMET_AT_MOST else "")
            checks.append({"集合": r["collection"], "条件": condition_phrase(r["condition"]),
                           "满足": r.get("state") == "met", "状态": r.get("state"),
                           "说明": r["summary"] + more})
    total = sum(s["现有条目数"] for s in sets)
    return {"集合": sets, "完成条件": checks, "总条目数": total, "格式": "新格式",
            "完成条件是怎么核对的": ("逐条调用 agent 里的核对函数（与「完成任务」工具的门禁用的是同一组函数），"
                                     "库以只读方式打开。" if results is not None else why),
            "概括": None, "完成条件说明": "", "完成条件概括": brief,
            "任务编号": detail["任务标识"], "任务名": detail["任务名"], "交付物名称": detail["交付物名称"],
            "状态": detail["状态"]}


def legacy_versions_of(task_detail: dict, slot: str) -> list[dict]:
    versions = [{"版本号": 0, "由第几次修订产生": None, "写入者": "初始化",
                 "字段": [{"名": slot, "类型": "文本", "值": ""}], "来源": [],
                 "评审": "还没有这类记录", "确认": "还没有这类记录", "评审格": "", "确认格": ""}]
    for rev in task_detail.get("修订") or []:
        if slot in (rev.get("改动字段") or []):
            versions.append({"版本号": rev.get("该字段第几版"), "由第几次修订产生": rev.get("修订序号"),
                             "写入者": rev.get("写入者"),
                             "字段": [{"名": slot, "类型": "文本", "值": (rev.get("快照") or {}).get(slot, "")}],
                             "来源": [], "评审": "还没有这类记录", "确认": "还没有这类记录",
                             "评审格": "", "确认格": ""})
    return versions


def build_board_old(task_detail: dict) -> dict:
    """旧格式的库没有条目集合，只有任务的几个字段。如实显示每个字段的当前值与改过几版。"""
    order = task_detail.get("字段顺序") or [f["字段"] for f in task_detail.get("字段现值") or []]
    now = {f["字段"]: f for f in task_detail.get("字段现值") or []}
    rows = []
    for name in order:
        cur = now.get(name) or {}
        rows.append({
            "编号": name, "标题": shorten(cur.get("值") or "（这个字段现在还是空的）", 90),
            "版本": cur.get("版本号", 0), "来源条数": 0, "状态字段": "", "已删除": False,
            "说明": (task_detail.get("字段说明") or {}).get(name, ""),
            "全部版本": legacy_versions_of(task_detail, name),
            "评审": "还没有这类记录", "确认": "还没有这类记录", "评审格": "", "确认格": "",
        })
    return {
        "集合": [{"名称": "任务的字段", "前缀": "没有编号前缀，旧格式的库按字段名索引", "条目": rows,
                  "现有条目数": len(rows)}],
        "完成条件": [], "总条目数": len(rows), "格式": "旧格式",
        "概括": (f"这个任务的库是旧格式：它没有条目集合，只有 {len(rows)} 个字段。"
                 f"下面逐个列出每个字段现在的值与它改过几版。"),
        "完成条件说明": (task_detail.get("完成条件") or {}).get("说明")
                        or "这个任务的库是旧格式，没有可以逐条核对的完成条件。",
        "完成条件是怎么核对的": "",
        "任务编号": task_detail.get("任务标识", ""), "任务名": task_detail.get("任务类型", ""),
        "交付物名称": "", "状态": task_detail.get("状态", ""),
    }


def fill_old_versions(rows: list[dict], task_detail: dict) -> None:
    """旧格式的库只记下「某个字段被改写」，版本号在任务的修订清单里，按调用编号对上。对不上就如实写。
    rows 是带「轮」的一串运行。"""
    by_call = {rev.get("调用编号"): rev for rev in task_detail.get("修订") or []}
    for row in rows:
        for t in row["轮"]:
            for c in t["调用"]:
                for b in c["改动"]:
                    if not b.get("旧库表"):
                        continue
                    rev = by_call.get(c["编号"])
                    if not rev:
                        b["对不上"] = "这次调用在库里找不到对应的修订记录，版本号对不上，这里不写第几版。"
                        continue
                    now = rev.get("该字段第几版")
                    for op in b["操作"]:
                        if now:
                            op["版本"] = [now - 1 if now > 1 else None, now]


# ───────────────────────── 六、知识的使用 ─────────────────────────

def kind_of(rel: str, decl: dict, platform: dict | None = None) -> str:
    if platform and rel in platform:
        return "平台执行方法（skill）"
    groups = decl["路径归类"]
    if rel in groups["执行方法"]:
        return "执行方法（skill）"
    if rel in groups["领域规矩"]:
        return "领域规矩文档"
    if rel in groups["文档模板"]:
        return "文档模板"
    for prefix, name in KIND_BY_PREFIX:
        if rel.startswith(prefix):
            return name
    return "其他文件"


def launch_facts(launches: list[dict]) -> dict:
    """几次启动各自补记的知识仓库摘要、上下文文件与已加载的 skill。"""
    snapshots = [(i, l.get("知识仓库摘要")) for i, l in enumerate(launches)]
    recorded = [(i, s) for i, s in snapshots if s]
    # 平台 skill 的路径是绝对路径，读归档时家目录被缩写成了 ~；展开回来，才能与 read 调用里的路径对上。
    key = lambda f: os.path.expanduser(f["路径"]) if f.get("来自") == "平台 skill" else f["路径"]
    digests: dict[str, list[tuple[int, str]]] = {}
    platform: dict[str, str] = {}
    for i, snap in recorded:
        for f in snap.get("文件") or []:
            digests.setdefault(key(f), []).append((i + 1, f.get("摘要值") or ""))
            if f.get("来自") == "平台 skill":
                platform[key(f)] = f.get("代码仓里的路径") or f["路径"]
    skills_note = next((l.get("已加载的 skill") for l in launches if l.get("已加载的 skill")), None)
    context_note = next((l.get("上下文文件") for l in launches if l.get("上下文文件")), None)
    return {"有没有摘要": bool(recorded), "摘要": digests, "几次启动": len(launches),
            "记下摘要的启动": [i + 1 for i, _ in recorded], "skill": skills_note, "平台 skill": platform, "上下文文件": context_note,
            "第一份摘要": recorded[0][1] if recorded else None}


def knowledge_changes_between(launches: list[dict]) -> dict[int, str]:
    """第 N 次启动与上一次启动相比，知识仓库有没有变。给启动节点那句话用。"""
    out: dict[int, str] = {}
    last = None
    for i, launch in enumerate(launches):
        snap = launch.get("知识仓库摘要")
        if not snap:
            last = None
            continue
        now = {f["路径"]: f.get("摘要值") for f in snap.get("文件") or []}
        if last is not None:
            changed = sorted(p for p in set(now) | set(last) if now.get(p) != last.get(p))
            out[i] = (f"与上一次启动相比，知识仓库里有 {len(changed)} 份文件变了：{'、'.join(changed[:5])}。"
                      if changed else "与上一次启动相比，知识仓库里的文件一份都没有变。")
        last = now
    return out


def build_knowledge(workspace_abs: str, rows: list[dict], decl: dict, facts: dict, rules: dict) -> dict | None:
    """rows 是带「运行序号」与「轮」的一串运行。"""
    root = Path(workspace_abs) if workspace_abs else None
    if facts["有没有摘要"]:
        files = sorted(facts["摘要"].keys())
        source_note = (f"文件清单与摘要值取自后端在启动时的补记（这一页的范围里一共 {facts['几次启动']} 次 pi 进程启动，"
                       f"其中第 {'、'.join(map(str, facts['记下摘要的启动']))} 次记下了摘要值）。")
    elif root and root.is_dir():
        files = []
        for sub in (".pi/skills", "docs"):
            base = root / sub
            if base.is_dir():
                files.extend(sorted(str(p.relative_to(root)) for p in base.rglob("*") if p.is_file()))
        source_note = (f"{NOT_RECORDED}知识仓库的摘要值（这条归档跑在后端补记这件事做出来之前），"
                       "下面的文件清单是观测台按任务目录现在的样子列的，那时的文件未必与现在一样。")
    else:
        return None

    read_by_agent: dict[str, dict] = {}
    read_by_tool: dict[str, str] = {}
    tool_reads = rules.get("会自己读文件的工具") or {}
    for row in rows:
        for turn in row["轮"]:
            for call in turn["调用"]:
                if call["被拒"]:
                    continue
                if call["工具"] in decl["按路径归类来判的工具"]:
                    got = read_by_agent.setdefault(call["相对路径"], {"次数": 0, "运行": [], "轮": []})
                    got["次数"] += 1
                    got["轮"].append(f"第 {row['运行序号']} 次运行第 {turn['序数']} 轮")
                    if row["运行序号"] not in got["运行"]:
                        got["运行"].append(row["运行序号"])
                elif call["工具"] in tool_reads:
                    arg = (call["参数"] or {}).get(tool_reads[call["工具"]]) if isinstance(call["参数"], dict) else None
                    if arg:
                        name = call.get("中文名") or call["工具"]
                        read_by_tool[relative_to_workspace(arg, workspace_abs)] = (
                            f"「{name}」这个工具在执行时自己读了它，助手没有用 read 读过它。")

    platform = facts.get("平台 skill") or {}
    shown = lambda rel: f"代码仓里的 {platform[rel]}" if rel in platform else rel
    skill_files: dict[str, str] = {}
    skills_note = facts["skill"]
    if skills_note and skills_note.get("取得到吗"):
        for s in skills_note.get("skill") or []:
            skill_files[relative_to_workspace(s.get("文件"), workspace_abs)] = s.get("名字", "")
    context_files: list[str] = []
    context_note = facts["上下文文件"]
    if context_note:
        context_files = [relative_to_workspace(p, workspace_abs) for p in
                         context_note.get("照 pi 的发现规则在磁盘上查到的") or []]

    out = []
    for rel in files:
        history = facts["摘要"].get(rel) or []
        values = sorted({d for _, d in history if d})
        digest = (values[0] if len(values) == 1 else
                  "；".join(f"第 {n} 次启动时是 {d}" for n, d in history) if values else NOT_RECORDED)
        in_prompt = rel in skill_files
        prompt_line = (f"pi 启动时把这个 skill（{skill_files[rel]}）的名字与描述放进了系统提示，正文没有放进去。"
                       if in_prompt else "")
        if rel in read_by_agent:
            got = read_by_agent[rel]
            runs_text = "、".join(str(n) for n in got["运行"])
            use, line, first_run = USE_READ, (f"助手在第 {runs_text} 次运行里读过它 {got['次数']} 次"
                                              f"（{'、'.join(got['轮'])}）。" + prompt_line), got["运行"][0]
        elif rel in read_by_tool:
            use, line, first_run = USE_TOOL, read_by_tool[rel] + prompt_line, None
        elif in_prompt:
            use, line, first_run = USE_PROMPT, prompt_line + "助手这一次没有用 read 读过它的正文。", None
        else:
            use, line, first_run = USE_NONE, "这一次从头到尾没有任何人读过它。", None
        out.append({"文件": shown(rel), "种类": kind_of(rel, decl, platform), "用法": use, "一句话": line,
                    "运行序号": first_run, "摘要值": digest, "变过吗": len(values) > 1})
    for rel in context_files:
        if rel not in files:
            out.insert(0, {"文件": rel, "种类": "上下文文件", "用法": USE_PROMPT,
                           "一句话": "按 pi 的发现规则，pi 启动时会把这份文件整份放进系统提示（后端推算，不是 pi 报告的）。",
                           "运行序号": None, "摘要值": NOT_RECORDED, "变过吗": False})
    counts = {k: sum(1 for r in out if r["用法"] == k) for k in (USE_READ, USE_TOOL, USE_PROMPT, USE_NONE)}

    if skills_note is None:
        skill_line = f"pi 这次实际加载了哪些 skill：{NOT_RECORDED}。"
    elif not skills_note.get("取得到吗"):
        skill_line = f"pi 这次实际加载了哪些 skill：取不到。原因是：{skills_note.get('为什么取不到', '未知')}"
    else:
        names = [f"{s.get('名字')}（{shown(relative_to_workspace(s.get('文件'), workspace_abs))}）"
                 for s in skills_note.get("skill") or []]
        skill_line = (f"pi 这次实际加载的 skill 有 {len(names)} 个：{'、'.join(names) or '一个都没有'}。"
                      f"这是后端启动时经 RPC 的 get_commands 问 pi 得到的。")
    if context_note is None:
        context_line = f"上下文文件（AGENTS.md 一类）：{NOT_RECORDED}。"
    else:
        found = context_note.get("照 pi 的发现规则在磁盘上查到的") or []
        context_line = (f"上下文文件（AGENTS.md 一类）：取不到 pi 实际加载的清单，{context_note.get('为什么取不到', '')}"
                        + (f"后端照 pi 的发现规则在启动那一刻查到 {len(found)} 份"
                           f"{'：' + '、'.join(found) if found else '，所以 pi 这次没有往系统提示里放任何上下文文件'}。"
                           if not context_note.get("命令行关掉了上下文文件吗") else
                           "启动命令带了 --no-context-files，pi 不加载任何上下文文件。"))
    return {
        "概括": (f"知识仓库里有 {len(files)} 份文件{f'（其中 {len(platform)} 份是代码仓里的平台 skill）' if platform else ''}：助手这次用 read 读了其中 {counts[USE_READ]} 份，"
                 f"工具自己读了 {counts[USE_TOOL]} 份，启动时只放进了系统提示、没有被读过正文的有 {counts[USE_PROMPT]} 份，"
                 f"还有 {counts[USE_NONE]} 份这一次没有用到。"),
        "文件": out, "来源说明": source_note, "skill": skill_line, "上下文文件": context_line,
    }


# ───────────────────────── 七、页头、概括句、末端 ─────────────────────────

def build_head(details: list[dict], board: dict | None, rows: list[dict], runs: list[dict], extra: dict) -> dict:
    """页头。rows 是流程里的运行行（带模型耗时、工具耗时与保存修订次数），runs 是带时间条的原始运行。"""
    starts, ends = [], []
    for run in runs:
        for turn in run["轮"]:
            if turn["起止"][0]:
                starts.append(float(turn["起止"][0]))
            if turn["起止"][1]:
                ends.append(float(turn["起止"][1]))
        bar = run.get("时间条") or {}
        if bar.get("起"):
            starts.append(float(bar["起"]))
        if bar.get("止"):
            ends.append(float(bar["止"]))
    spent = (max(ends) - min(starts)) if (starts and ends) else None
    model_seconds = sum(r["模型耗时秒"] or 0 for r in rows)
    tool_seconds = sum(r["工具耗时秒"] or 0 for r in rows)
    counts = {"运行次数": sum(d.get("运行次数", 0) for d in details), "轮数": sum(d.get("轮数", 0) for d in details),
              "工具调用次数": sum(d.get("工具调用次数", 0) for d in details),
              "保存修订次数": sum(r["保存修订次数"] for r in rows),
              "被拒次数": sum(d.get("被拒次数", 0) for d in details)}
    first = details[0]
    launch_model = next((l["后端补记启动"].get("模型") for d in details for l in d.get("启动") or []
                         if l.get("后端补记启动") and l["后端补记启动"].get("模型")), "") or "未知"
    return {
        "任务名": (board or {}).get("任务名", ""), "任务编号": (board or {}).get("任务编号", ""),
        "交付物名称": (board or {}).get("交付物名称", ""), "状态": (board or {}).get("状态", ""),
        "任务目录": (first.get("所在任务目录") or {}).get("任务目录", ""),
        "库的格式": (first.get("所在任务目录") or {}).get("库的格式", ""),
        # 跨会话时取第一个有开始时刻的与最后一个有结束时刻的：一次也没有运行过的会话没有结束时刻。
        "开始时刻": next((d["开始时刻"] for d in details if d.get("开始时刻")), ""),
        "结束时刻": next((d["结束时刻"] for d in reversed(details) if d.get("结束时刻")), ""),
        "会话数": len(details), **counts,
        "统计句": (f"{counts['运行次数']} 次运行、{counts['轮数']} 轮、{counts['工具调用次数']} 次工具调用、"
                   f"{counts['保存修订次数']} 次保存修订"
                   + (f"，其中 {counts['被拒次数']} 次调用被工具拒绝" if counts["被拒次数"] else "，没有调用被工具拒绝")),
        "pi 进程启动次数": sum(d.get("pi 进程启动次数", 1) for d in details),
        "总耗时秒": round(spent, 1) if spent is not None else None,
        "模型在想的秒数": round(model_seconds, 1), "工具在跑的秒数": round(tool_seconds, 2),
        "归档名": "、".join(d.get("归档名", "") for d in details),
        "终态": "、".join(sorted({d.get("终态", "未知") for d in details})),
        "模型": launch_model, **extra,
    }


def summary_sentence(head: dict, board: dict | None, rows: list[dict], scope: str) -> str:
    """页头概括句，按固定模板拼。rows 是流程里的运行行。"""
    parts = []
    if board and board["格式"] == "新格式":
        counts = "、".join(f"{s['名称']} {s['现有条目数']} 个" for s in board["集合"])
        unmet = sum(1 for c in board["完成条件"] if (c.get("状态") or ("met" if c["满足"] else "unmet")) == "unmet")
        parts.append(f"这份交付物现在有 {board['总条目数']} 个条目（{counts}）")
        if any(c["满足"] is None for c in board["完成条件"]):
            parts.append(f"任务定义写的 {len(board['完成条件'])} 条完成条件这一次核对不了")
        else:
            parts.append(f"要完成任务还差 {unmet} 项" if unmet else "完成条件都已满足")
    elif board:
        parts.append(f"这个任务的数据现在有 {board['总条目数']} 个字段")
        parts.append("这个任务的库是旧格式，没有可以逐条核对的完成条件")
    else:
        parts.append("这条会话所在的任务目录里还没有任务记录，所以没有交付物可看，完成条件也无从核对")
    if rows:
        last = rows[-1]["用户的话"]
        parts.append(f"助手一共运行了 {len(rows)} 次，最后一次运行由用户的「{head_chars(last, 30)}」触发"
                     if last else f"助手一共运行了 {len(rows)} 次")
    else:
        parts.append("助手一次也没有运行过")
    parts.append(f"{'这条会话' if head['会话数'] == 1 else '这几条会话'}的终态是「{head['终态']}」")
    return "；".join(parts) + "。"


def task_closed_at(task: dict | None) -> float | None:
    """新格式任务结束（完成或放弃）的时刻，换成与收到时刻同一种的秒数；没有结束或读不出来为 None。
    库里的结束时刻是本机本地时间，与后端收到事件的时刻出自同一台机器。"""
    ended = ((task or {}).get("新库") or {}).get("结束时刻")
    if not ended:
        return None
    try:
        return _dt.datetime.fromisoformat(str(ended)).timestamp()
    except ValueError:
        return None


def tail_state(runs: list[dict]) -> dict:
    """流程末端：如实写执行者最后说了什么，不替它判断在等什么。"""
    if not runs:
        return {"有没有说话": False, "引子": "这条会话里助手一次也没有运行过。", "原文": "", "补充": ""}
    last = runs[-1]
    said = (last.get("助手最后说的话") or "").strip()
    aborted = "这次运行是被中止的。" if last.get("被中止") else ""
    if said:
        how = "（经「回复」工具说的）" if last.get("助手最后说的话从哪来") == "回复工具" else ""
        return {"有没有说话": True, "引子": aborted + f"助手这次运行已经结束，它最后对用户说的话{how}是：", "原文": said,
                "补充": "它这段话里有没有提问题、提的是什么，现在只能靠人读这段正文；观测台不替它判断它在等什么。"}
    return {"有没有说话": False, "引子": aborted + "这次运行结束前，助手没有对用户说过任何话。", "原文": "",
            "补充": "归档里没有留下结束的原因，观测台只如实说它结束了，不判断是谁把它停的。"}


# ───────────────────────── 八、装配 ─────────────────────────

def skill_text(workspace_abs: str, decl: dict) -> dict:
    rel = (decl["路径归类"]["执行方法"] or [""])[0]
    path = Path(workspace_abs) / rel if (workspace_abs and rel) else None
    if path and path.is_file():
        try:
            return {"路径": rel, "原文": path.read_text(encoding="utf-8")}
        except OSError:
            pass
    return {"路径": rel, "原文": (f"（没有读到执行方法文件 {rel}。）" if rel
                                 else "（归类声明里没有登记执行方法文件。）")}


def assemble(index, details: list[dict], scope: str, key: str, task_key: str | None) -> dict:
    rules = load_rules()
    first = details[0]
    place = first.get("所在任务目录") or {}
    # 有任务时以任务所在的那个任务目录为准（库就在那里）；没有任务时取会话文件里记的工作目录。
    workspace_abs = ""
    if task_key:
        workspace_abs = os.path.expanduser(next((w["任务目录路径"] for w in index.workspaces
                                                 if w["任务目录"] == index.task_workspace.get(task_key)), ""))
    if not workspace_abs:
        workspace_abs = os.path.expanduser(place.get("任务目录路径") or "")
    decl, decl_note = declaration_for(index, task_key, workspace_abs, rules)
    task = index.tasks.get(task_key) if task_key else None

    # 各条会话的运行按时间接起来，运行序号在这一页的范围里从 1 起连续编。
    launches_all: list[dict] = []
    runs: list[dict] = []
    offset = 0
    launch_count = 0
    for session_no, detail in enumerate(details, 1):
        launches = detail.get("启动") or []
        launches_all.extend(launches)
        changes = knowledge_changes_between(launches)
        last_launch = None
        for one in detail.get("运行") or []:
            boot = ""
            if one.get("启动序号") != last_launch:
                launch_count += 1
                boot = boot_text(launch_count, session_no, last_launch is None,
                                 changes.get(one.get("启动序号", 0), ""))
                last_launch = one.get("启动序号")
            turns = [turn_shape(t, one, index, rules, workspace_abs, offset) for t in one.get("轮") or []]
            runs.append({**one, "运行序号": one["运行序号"] + offset, "会话序号": session_no,
                         "会话编号": detail.get("会话编号", ""), "轮": turns, "启动说明": boot})
        offset += len(detail.get("运行") or [])

    # 平台 skill 在代码仓里、不在任务目录里，任务定义也不登记它；它的文件按启动补记算作执行方法。
    for path in launch_facts(launches_all)["平台 skill"]:
        if path.endswith("SKILL.md") and path not in decl["路径归类"]["执行方法"]:
            decl["路径归类"]["执行方法"].append(path)
    flow = build_flow(details, runs)
    rows = run_rows(flow)
    dialogue_facts = attach_dialogue(flow, workspace_abs, task)
    notes = build_alerts(rows, decl, task_closed_at(task))
    guides = build_guides(rows, decl)
    board = None
    if task and task.get("格式") == taskdb.FORMAT_CURRENT:
        board = build_board_new(index, task_key, workspace_abs)
    elif task:
        legacy = index.task_detail(task_key)
        board = build_board_old(legacy)
        fill_old_versions(rows, legacy)

    facts = launch_facts(launches_all)
    for g in guides:
        g["摘要值"] = ((facts["摘要"].get(g["文件"]) or [(None, "")])[0][1] or NOT_RECORDED)
    head = build_head(details, board, rows, runs, {"声明说明": decl_note, "对话": dialogue_facts})
    materials_prefix = (decl["路径归类"]["材料目录"] or [""])[0].rstrip("/")
    head["材料文件"] = sorted({basename(c["相对路径"]) for r in rows for t in r["轮"] for c in t["调用"]
                               if c["工具"] in decl["按路径归类来判的工具"] and not c["被拒"]
                               and path_class(c["相对路径"], decl) == "材料目录"})
    head["材料目录"] = materials_prefix + "/"
    # 只有新库表的任务才有任务定义登记的材料目录；旧库表的任务与没有创建任务的会话用的是默认或猜的声明，
    # 「没有读到材料目录里的文件」这句话对它们不成立，页头整句不显示。
    head["材料目录是任务定义登记的"] = bool(task and task.get("格式") == taskdb.FORMAT_CURRENT)
    sessions = [{"会话编号": d.get("会话编号", ""), "会话名": d.get("会话名", ""), "归档名": d.get("归档名", ""),
                 "开始时刻": d.get("开始时刻", ""),
                 "Langfuse 链接": d.get("Langfuse 链接", "")} for d in details]
    langfuse_state = first.get("Langfuse 状态") or {}
    second_level = [(r.get("第二级链接") or {}) for r in runs]
    return {
        "范围": scope, "键": key, "任务的键": task_key or "",
        "页头": head, "需要注意": notes, "流程": flow, "看板": board, "指导": guides,
        "知识仓库": build_knowledge(workspace_abs, rows, decl, facts, rules),
        # 页面只要路径归类这一部分（认材料文件、执行方法与领域规矩），整份声明里其余几项是按轮归类用的。
        "归类声明": {k: decl[k] for k in ("这份声明是给谁用的", "路径归类", "每一项是从哪里来的")},
        "任务在不在": bool(board),
        "概括": summary_sentence(head, board, rows, scope), "末端": tail_state(runs),
        "执行方法": skill_text(workspace_abs, decl),
        "会话": sessions,
        "Langfuse": {"会话链接": first.get("Langfuse 链接", ""), "状态": langfuse_state,
                     "第二级链接取到了吗": all(s.get("取到了吗") for s in second_level) if second_level else False,
                     "第二级链接的说明": next((s.get("说明") for s in second_level if s.get("说明")), "")},
    }


def attach_dialogue(flow: list[dict], workspace_abs: str, task: dict | None) -> dict | None:
    """给流程里的每次运行挂上对话行为层（行的「对话行为」一项），返回页头的三个派生事实。
    数据只读地取自任务库的对话行为表（见 dialogue.py）；旧库、没有任务、库里没有这张表时什么都不挂，返回 None。"""
    if not task or task.get("格式") != taskdb.FORMAT_CURRENT or not workspace_abs:
        return None
    path = Path(workspace_abs) / taskdb.DB_NAME
    if not path.is_file():
        return None
    conn = taskdb.open_readonly(path)
    try:
        if not dialogue.has_dialogue(conn):
            return None
        task_id = task.get("任务标识") or ""
        for seg in flow:
            session = dialogue.read_session(conn, task_id, seg["会话编号"])
            ordinal = 0
            for row in seg["行"]:
                if row["种类"] != "运行":
                    continue
                ordinal += 1
                replies = [c["编号"] for t in row["轮"] for c in t["调用"] if c["工具"] == "reply"]
                row["对话行为"] = dialogue.run_layer(session, row.get("条目编号") or "", replies, ordinal)
        return dialogue.page_facts(conn, task_id, [seg["会话编号"] for seg in flow])
    finally:
        conn.close()


def page_for_session(index, session_id: str) -> dict:
    detail = index.session_detail(session_id)
    found = detail.get("提取出的任务") or []
    task_key = found[0]["任务的键"] if found else None
    page = assemble(index, [detail], "会话", session_id, task_key)
    if len(found) > 1:
        page["页头"]["声明说明"] = (page["页头"].get("声明说明") or "") + (
            f"这条会话写过 {len(found)} 个任务，看板显示的是第一个（{found[0]['任务的键']}）。")
    return page


def sessions_of_task(index, task_key: str) -> list[str]:
    """一个任务涉及哪几条会话（对法见 api.tasks_of_session），按开始时刻排。

    一次也没有运行过的会话不算：它只在会话列表里挂上任务，任务页不收，也不为它单独成段。
    """
    ids = []
    for session in index.sessions:
        if session["启动失败"] or not session.get("运行次数"):
            continue
        if any(t["任务的键"] == task_key for t in index.tasks_of_session(session)):
            ids.append(session["会话编号"])
    return ids


def page_for_task(index, task_key: str) -> dict:
    if task_key not in index.tasks:
        raise KeyError(task_key)
    ids = sessions_of_task(index, task_key)
    if not ids:
        raise LookupError(task_key)
    details = [index.session_detail(i) for i in ids]
    page = assemble(index, details, "任务", task_key, task_key)
    workspace = index.task_workspace.get(task_key, "")
    page["同任务目录里没有写过这个任务的会话"] = [
        {"会话编号": s["会话编号"], "会话名": s.get("会话名", ""), "归档名": "、".join(s["归档名"])}
        for s in index.sessions
        if not s["启动失败"] and s.get("运行次数") and s["会话编号"] not in ids
        and index.workspace_of_session(s).get("任务目录") == workspace]
    return page


def task_list(index) -> list[dict]:
    """任务列表：每个任务涉及几条会话，给顶部导航「任务」页用。"""
    rows = []
    for key, task in index.tasks.items():
        ids = sessions_of_task(index, key)
        new = task.get("新库") or {}
        rows.append({"任务的键": key, "任务目录": index.task_workspace.get(key, ""),
                     "任务编号": task.get("任务标识", ""),
                     "任务名": new.get("任务名") or task.get("任务类型", ""),
                     "库的格式": task.get("格式", ""), "状态": task.get("状态", ""),
                     "涉及会话": ids, "开始时刻": (new.get("开始时刻") or "").replace("T", " ")[:19]})
    return rows
