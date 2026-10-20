"""评测的灯：工作的六个阶段各自「算够」的判据，由程序从任务库算出来，一共二十一盏。

灯只说明这一段还差什么，不拦任何操作。这里按演练结束时库副本里的数据算；「阶段」只是分组名。产品记下阶段之后，
调用方可以用 compute 的 stage 参数只算某一个阶段的灯。

每盏灯的结果是四种之一：
- 通过；
- 未通过：「差的条目编号」列出差的页或条目；
- 不适用：这盏灯要看的那一类页或条目一个都没有（例如没有一页贴了「流程」标签），写「通过」会让空任务满分，所以单独记；
- 算不了：要用的数据取不到（例如本机没有 node），写明原因。
不适用与算不了都不计入通过率。

口径与产品相同的几样不在这里另写：待核实经命令行入口 agent/src/cli/overall_state.mts 取（agent 的 overallState）；
与图、规则冲突有关的七盏灯要扫图的 Mermaid 文本、要算规则表，看问题是否阻断下游、待定标记、各章导语与术语的五盏照产品的判法，
这十二盏（PRODUCT_LAMPS）整盏的结果也经这个入口从产品取（agent 的 stageLamps），
这里只把它的三种结果换成这里的说法；完成条件经观测台的 taskpage.check_completion 取（agent 的核对函数）。用户看没看过一页，照 agent/src/lib/overall_read.ts 的判法：
这一页当前所在的修订上，依据不是「界面修改」的确认标记里最近一条的态度是接受。

程序认不出的两处只算一半，说明里写明：「决定」页「写了为什么」认不出，只看有没有上级「目标」页；「用户明说先不归类」认不出，
只看有没有贴标签。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from taskwright_observatory import taskdb, taskpage

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_CLI = REPO_ROOT / "agent" / "src" / "cli" / "overall_state.mts"

#: 集合名与字段名，与任务类型定义、agent/src/lib/overall_analysis.ts 一致。
OVERALL = "业务说明"
QUESTIONS = "问题"
F_TITLE, F_ALIASES, F_EXAMPLES, F_TAGS, F_PARENT, F_STATUS = "标题", "别名", "例子", "标签", "上级主题", "状态"
DEPRECATED = "已废弃"
#: 写了这一项的页是那一章的导语页（编写文档阶段助手补写的）：不贴标签，不算未归类。
F_INTRO = "导语所属章"
#: 「例子」里一项以它开头的是例外（评测的「至少应有」清单核对例外时用）。
EXCEPTION_PREFIX = "例外："
#: 确认标记的依据里表示「用户亲手改」的那个词。
BASIS_EDIT = "界面修改"

STAGES = ("核读材料", "澄清", "整理建模", "写条目", "评审确认", "编写文档")

#: 二十一盏灯：阶段、键、说明。键与产品里按阶段算的灯用同一套名字。
LAMPS = (
    ("核读材料", "materials_cited", "只报数、不判：每份材料有没有被主题页或问题引用（与产品的这一盏相同，不算通过与否）。"),
    ("澄清", "tagged_pages_no_open_questions", "贴了标签的页没有挂着未解决的待澄清问题。"),
    ("澄清", "decisions_have_goal", "每个标签为「决定」的页有上级「目标」页（「写了为什么」程序认不出，只看上级目标页）。"),
    ("整理建模", "roles_in_context_and_use_cases", "每个标签为「角色」的页都画进了系统边界图与用例图。"),
    ("整理建模", "concepts_related_in_class", "每个标签为「概念」的页在对象关系图里至少有一条连线。"),
    ("整理建模", "flows_have_flowchart_with_branch", "每个标签为「流程」的页有一张以它为来源、带判断分叉的流程图。"),
    ("整理建模", "stateful_concepts_have_state", "每个说到状态的「概念」页有一张以它为来源的状态图（说没说到状态按字面认）。"),
    ("整理建模", "no_duplicate_titles", "没有两页的标题或别名相同。"),
    ("整理建模", "no_untagged_pages", "没有未归类的页（「用户明说先不归类」程序认不出，只看有没有贴标签）。"),
    ("整理建模", "rules_no_conflict", "各页「已经定下的」之间没有还没了结的规则冲突。"),
    ("写条目", "flows_backed_by_use_cases", "每个标签为「流程」或「场景」的页被至少一条功能用例依据（直接依据，或者依据一张以它为来源的图）。"),
    ("写条目", "basis_pages_viewed", "每条条目依据的页都是用户看过的。"),
    ("写条目", "basis_diagrams_viewed", "每条条目依据的图都是用户看过的。"),
    ("写条目", "no_pending_items", "没有待核实的条目。"),
    ("写条目", "no_blocking_questions", "没有未了结的阻断下游的问题。"),
    ("写条目", "no_pending_marks", "图、页与条目里没有标为待定的地方。"),
    ("评审确认", "reviews_no_open_findings", "评审没有未处理的发现。"),
    ("评审确认", "completion_met", "完成条件全部满足。"),
    ("编写文档", "chapters_have_intro", "业务说明里有内容的章都有导语。"),
    ("编写文档", "glossary_complete", "每个标签为「概念」的页都写了说明，而且不待核实。"),
    ("编写文档", "document_no_blocking_questions", "没有未了结的阻断下游的问题。"),
)

PASSED, FAILED, NOT_APPLICABLE, UNKNOWN = "通过", "未通过", "不适用", "算不了"
#: 只报数、不判的灯（产品里 REPORT_ONLY_LAMPS 那几盏）：结果写这个，不计入通过率，备注是报的数。
REPORT_ONLY = "只报数"

#: 整盏的结果从产品取的十二盏灯（命令行入口输出里的 lamps）：看图与规则表的七盏，看问题、待定标记、导语与术语的五盏。
PRODUCT_LAMPS = ("roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state",
                 "rules_no_conflict", "flows_backed_by_use_cases", "basis_diagrams_viewed",
                 "no_blocking_questions", "no_pending_marks", "chapters_have_intro", "glossary_complete", "document_no_blocking_questions")


def overall_facts(db_path: Path, task_id: str) -> tuple[dict | None, str]:
    """经命令行入口取待核实、提到、各页的情况与产品算出的十二盏灯。返回（结果, 取不到时的原因）。"""
    node = shutil.which("node")
    if not node:
        return None, "本机找不到 node，调不动 agent 里的计算函数。"
    try:
        done = subprocess.run([node, str(STATE_CLI), str(db_path), task_id], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, f"调用 agent 的计算函数时出错了：{error}"
    if done.returncode != 0:
        return None, "调用 agent 的计算函数时出错了：" + (done.stderr.strip().splitlines() or ["没有输出"])[-1]
    try:
        return json.loads(done.stdout), ""
    except json.JSONDecodeError:
        return None, "agent 的计算函数返回的不是 JSON。"


def _texts(value) -> list[str]:
    return [one for one in value if isinstance(one, str) and one.strip()] if isinstance(value, list) else []


def _refs(value) -> list[str]:
    """条目引用字段的值：条目编号的列表；早期写成一个编号的也认。"""
    if isinstance(value, str):
        return [value] if value.strip() else []
    return _texts(value)


def _fields(item: dict) -> dict:
    return (item.get("当前内容") or {}).get("字段") or {}


def _sources(item: dict) -> list[dict]:
    return (item.get("当前内容") or {}).get("来源") or []


def viewed_items(task: dict) -> set[str]:
    """用户看过的条目：当前所在的修订上，依据不是「界面修改」的确认标记里最近一条的态度是接受。"""
    current = {i["条目编号"]: (i.get("当前内容") or {}).get("修订号") for i in task.get("条目") or []}
    last: dict[str, str] = {}
    for mark in task.get("判读") or []:
        basis = mark.get("依据")
        if isinstance(basis, list) and any(isinstance(one, dict) and one.get("依据") == BASIS_EDIT for one in basis):
            continue
        for detail in mark.get("明细") or []:
            if current.get(detail["条目编号"]) == detail["修订号"]:
                last[detail["条目编号"]] = detail["态度"]
    return {item_id for item_id, attitude in last.items() if attitude == "接受"}


def is_intro(page: dict) -> bool:
    """这一页是不是某一章的导语页：「导语所属章」写了字。"""
    value = _fields(page).get(F_INTRO)
    return isinstance(value, str) and value.strip() != ""


def _lamp(stage: str, key: str, text: str, state: str, missing: list[str] | None = None, note: str = "", **extra) -> dict:
    return {"阶段": stage, "键": key, "说明": text, "结果": state, "通过": {PASSED: True, FAILED: False}.get(state),
            "差的条目编号": list(missing or []), "备注": note, **extra}


def compute(task: dict, facts: dict | None, materials: list[str], completion: list[dict] | None,
            stage: str | None = None, facts_problem: str = "", completion_problem: str = "") -> list[dict]:
    """算二十一盏灯。task 是 taskdb.read_workspace 读出的一个任务；facts 是 overall_facts 的结果（取不到时为 None）；
    materials 是材料的文件名；completion 是完成条件逐项核对的结果（取不到时为 None）。stage 给了就只算那个阶段的。"""
    items = [i for i in task.get("条目") or [] if i.get("在第几次修订删除") is None and i.get("当前内容")]
    collections = [c.get("名称") for c in (task.get("任务定义") or {}).get("集合") or []]
    pages = [i for i in items if i["所属集合"] == OVERALL]
    live = [p for p in pages if _fields(p).get(F_STATUS) != DEPRECATED]
    tags = {p["条目编号"]: _texts(_fields(p).get(F_TAGS)) for p in pages}
    tagged = lambda tag: [p for p in live if tag in tags[p["条目编号"]]]      # noqa: E731
    others = [i for i in items if i["所属集合"] != OVERALL]
    page_ids = {p["条目编号"] for p in pages}
    viewed = viewed_items(task)

    def result(key: str) -> tuple[str, list[str], str, dict]:
        if OVERALL not in collections:
            return NOT_APPLICABLE, [], "这个任务的任务定义里没有业务说明这个集合。", {}
        if key in PRODUCT_LAMPS:
            if facts is None:
                return UNKNOWN, [], facts_problem or "取不到产品算出的这盏灯。", {}
            lamp = (facts.get("lamps") or {}).get(key)
            if not isinstance(lamp, dict):
                return UNKNOWN, [], "产品没有给出这盏灯的结果。", {}
            state = {True: PASSED, False: FAILED}.get(lamp.get("ok"), NOT_APPLICABLE)
            return state, ([str(one) for one in lamp.get("items") or []] if state == FAILED else []), ("" if state == PASSED else str(lamp.get("summary") or "")), {}
        if key == "materials_cited":
            if not materials:
                return NOT_APPLICABLE, [], "这个任务没有材料。", {}
            cited = set()
            for item in items:
                if item["所属集合"] not in (OVERALL, QUESTIONS):
                    continue
                for source in _sources(item):
                    if source.get("种类") == "文档原文":
                        cited.add(str(source.get("出处") or "").split("#")[0].rsplit("/", 1)[-1])
            missing = [name for name in materials if name not in cited]
            note = f"材料 {len(materials)} 份，{len(materials) - len(missing)} 份有引用" + (f"；没有被引用的：{'、'.join(missing)}。" if missing else "。")
            return REPORT_ONLY, [], note, {"差的材料": missing}
        if key == "tagged_pages_no_open_questions":
            targets = [p for p in live if tags[p["条目编号"]]]
            if not targets:
                return NOT_APPLICABLE, [], "没有一页贴了标签。", {}
            open_on: dict[str, list[str]] = {}
            for item in items:
                fields = _fields(item)
                if item["所属集合"] == QUESTIONS and fields.get("种类") == "待澄清" and fields.get("状态") == "未解决":
                    for ref in _refs(fields.get("关联条目")):
                        open_on.setdefault(ref, []).append(item["条目编号"])
            missing = [p["条目编号"] for p in targets if p["条目编号"] in open_on]
            note = "；".join(f"{page} 挂着 {'、'.join(open_on[page])}" for page in missing)
            return (FAILED if missing else PASSED), missing, (note + "。" if note else ""), {}
        if key == "decisions_have_goal":
            targets = tagged("决定")
            if not targets:
                return NOT_APPLICABLE, [], "没有一页贴了「决定」标签。", {}
            goals = {p["条目编号"] for p in tagged("目标")}
            missing = [p["条目编号"] for p in targets if not any(ref in goals for ref in _refs(_fields(p).get(F_PARENT)))]
            return (FAILED if missing else PASSED), missing, "", {}
        if key == "no_duplicate_titles":
            if not live:
                return NOT_APPLICABLE, [], "业务说明里还没有在用的页。", {}
            owners: dict[str, list[str]] = {}
            for p in live:
                fields = _fields(p)
                words = {w.strip() for w in [fields.get(F_TITLE) if isinstance(fields.get(F_TITLE), str) else "", *_texts(fields.get(F_ALIASES))]}
                for word in words - {""}:
                    owners.setdefault(word, []).append(p["条目编号"])
            repeated = {word: ids for word, ids in owners.items() if len(ids) > 1}
            missing = sorted({one for ids in repeated.values() for one in ids})
            note = "；".join(f"「{word}」同时是 {'、'.join(ids)} 的标题或别名" for word, ids in sorted(repeated.items()))
            return (FAILED if missing else PASSED), missing, (note + "。" if note else ""), {}
        if key == "no_untagged_pages":
            if not live:
                return NOT_APPLICABLE, [], "业务说明里还没有在用的页。", {}
            # 导语页不贴标签，不算未归类（与产品的判法相同）。
            missing = [p["条目编号"] for p in live if not tags[p["条目编号"]] and not is_intro(p)]
            return (FAILED if missing else PASSED), missing, "", {}
        if key == "basis_pages_viewed":
            citing = {i["条目编号"]: [str(s.get("出处") or "").strip() for s in _sources(i)
                                      if s.get("种类") == "条目" and str(s.get("出处") or "").strip() in page_ids] for i in others}
            citing = {item_id: cited for item_id, cited in citing.items() if cited}
            if not citing:
                return NOT_APPLICABLE, [], "业务说明以外还没有条目依据主题页。", {}
            unseen = {item_id: sorted({page for page in cited if page not in viewed}) for item_id, cited in citing.items()}
            missing = [item_id for item_id, lacking in unseen.items() if lacking]
            note = "；".join(f"{item_id} 依据的 {'、'.join(unseen[item_id])} 用户还没看过" for item_id in missing)
            return (FAILED if missing else PASSED), missing, (note + "。" if note else ""), {}
        if key == "no_pending_items":
            requirements = [i for i in others if i["所属集合"] != QUESTIONS]      # 问题条目不算待核实的需求
            if not requirements:
                return NOT_APPLICABLE, [], "还没有需求条目。", {}
            if facts is None:
                return UNKNOWN, [], facts_problem or "取不到待核实的情况。", {}
            verification = facts.get("verification") or {}
            missing = [i["条目编号"] for i in requirements
                       if (verification.get(i["条目编号"]) or {}).get("pending_verification")
                       or (verification.get(i["条目编号"]) or {}).get("basis_pending")]
            return (FAILED if missing else PASSED), missing, "", {}
        if key == "reviews_no_open_findings":
            if not any(c.get("评审记录") for i in task.get("条目") or [] for c in i.get("修订内容") or []):
                return FAILED, [], "这个任务还没有评审过。", {}
            missing = []
            for item in items:
                now = item["当前内容"]
                reviews = now.get("评审记录") or []
                kept = any(not one.get("已撤销") for one in now.get("保留记录") or [])
                if reviews and reviews[-1].get("结论") == "不合规" and not kept:
                    missing.append(item["条目编号"])
            return (FAILED if missing else PASSED), missing, "", {}
        if key == "completion_met":
            if completion is None:
                return UNKNOWN, [], completion_problem or "取不到完成条件的核对结果。", {}
            unmet = [r for r in completion if (r.get("state") or ("met" if r.get("satisfied") else "unmet")) == "unmet"]
            missing = sorted({str(u.get("item")) for r in unmet for u in r.get("unmet") or [] if u.get("item")})
            note = "；".join(f"「{r.get('collection')}」{r.get('condition')}" for r in unmet)
            return (FAILED if unmet else PASSED), missing, ("还差：" + note + "。" if note else ""), {}
        raise KeyError(key)

    out = []
    for lamp_stage, key, text in LAMPS:
        if stage is not None and lamp_stage != stage:
            continue
        state, missing, note, extra = result(key)
        out.append(_lamp(lamp_stage, key, text, state, missing, note, **extra))
    return out


def lamps_for_sim(sim: Path, stage: str | None = None) -> dict:
    """一次演练的灯：读演练目录的库副本与材料目录。没有库副本时每盏都是算不了，原因写「这一遍没有库副本」。"""
    sim = Path(sim)
    db_dir = sim / "库副本"
    materials = sorted(p.name for p in (sim / "materials").glob("*")) if (sim / "materials").is_dir() else []
    tasks = taskdb.read_workspace(db_dir)["任务"] if (db_dir / taskdb.DB_NAME).is_file() else []
    if not tasks:
        reason = "这一遍没有库副本（演练没有跑完）。"
        return {"任务编号": None, "灯": [_lamp(s, k, t, UNKNOWN, [], reason) for s, k, t in LAMPS if stage in (None, s)]}
    task = tasks[0]
    db_path = db_dir / taskdb.DB_NAME
    facts, facts_problem = overall_facts(db_path, task["任务编号"])
    completion, completion_problem, _brief = taskpage.check_completion(db_path, task["任务编号"], task["任务定义"].get("完成条件") or {})
    return {"任务编号": task["任务编号"],
            "灯": compute(task, facts, materials, completion, stage, facts_problem, completion_problem)}
