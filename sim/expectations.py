"""评测的「至少应有」清单：每份材料一张，写明读透这份材料至少应当整理出哪些主题页、例外、问题与条目。

清单是下限：少于这些算没读透，多于这些不扣分。核对只看关键词，不用模型当裁判。清单里每一组是同义的几种写法，
出现任何一种就算这一组命中（与判定程序核对接受底线时的判法相同，用的是同一个函数）。

清单文件的各节与核对的地方：
- 「总体分析」：下面按种类分小节（流程页、角色页、概念页……），每组对着在用的主题页的标题与别名找。小节名里的种类不作
  命中条件（助手贴的标签可以与清单分的不同），结果里带命中的那一页实际贴的标签，供人看。
- 「例外」：下面按流程分小节，小节名是流程的名字。先找这个流程的页（标题或别名里有这个名字或它在「流程页」里的同义写法；
  找到的页里有贴了「流程」标签的就只看这些），再在这些页的全部例子里找每一组。结果里另带「以例外开头」：命中的例子里有没有
  以「例外：」开头的，只显示，不计入命中。
- 「问题」：对着问题条目的「事项」找。
- 「功能用例」：对着用例名称找。
- 「非功能需求」「约束」：对着类别与需求语句找。
"""

from __future__ import annotations

import json
from pathlib import Path

from sim.judge import groups_hit
from sim.lamps import EXCEPTION_PREFIX, F_ALIASES, F_EXAMPLES, F_STATUS, F_TAGS, F_TITLE, DEPRECATED, OVERALL, _fields, _texts

SECTION_OVERALL = "总体分析"
SECTION_EXCEPTIONS = "例外"
FLOW_SUBSECTION = "流程页"
FLOW_TAG = "流程"
#: 这几个集合对着哪些字段找；没有列出的集合对着第一个字段找。
FIELDS_OF = {"问题": ("事项",), "功能用例": ("用例名称",), "非功能需求": ("类别", "需求语句"), "约束": ("类别", "需求语句")}


def load(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _hit(group: list[str], text: str) -> str | None:
    hits = groups_hit([group], text)
    return hits[0] if hits else None


def _names(page: dict) -> list[str]:
    fields = _fields(page)
    title = fields.get(F_TITLE)
    return [w.strip() for w in [title if isinstance(title, str) else "", *_texts(fields.get(F_ALIASES))] if w.strip()]


def _row(section: str, group: list[str], found: list[tuple[str, str]], **extra) -> dict:
    return {"部分": section, "组": list(group), "命中": bool(found), "命中的词": found[0][1] if found else None,
            "命中的条目编号": [item_id for item_id, _word in found], **extra}


def check(expect: dict, task: dict) -> list[dict]:
    """逐组核对。task 是 taskdb.read_workspace 读出的一个任务。每组一行：部分、组、命中与否、命中的词、命中的条目编号。"""
    items = [i for i in task.get("条目") or [] if i.get("在第几次修订删除") is None and i.get("当前内容")]
    pages = [i for i in items if i["所属集合"] == OVERALL and _fields(i).get(F_STATUS) != DEPRECATED]
    tags = {p["条目编号"]: _texts(_fields(p).get(F_TAGS)) for p in pages}
    rows: list[dict] = []
    for section, body in expect.items():
        if section == "说明":
            continue
        if section == SECTION_OVERALL:
            for subsection, groups in body.items():
                for group in groups:
                    found = [(p["条目编号"], word) for p in pages if (word := _hit(group, "\n".join(_names(p)))) is not None]
                    rows.append(_row(f"{section}·{subsection}", group, found, 页贴的标签={item_id: tags[item_id] for item_id, _w in found}))
        elif section == SECTION_EXCEPTIONS:
            flow_groups = (expect.get(SECTION_OVERALL) or {}).get(FLOW_SUBSECTION) or []
            for flow, groups in body.items():
                same = next((g for g in flow_groups if flow in g), [flow])
                mine = [p for p in pages if _hit(same, "\n".join(_names(p))) is not None]
                mine = [p for p in mine if FLOW_TAG in tags[p["条目编号"]]] or mine
                for group in groups:
                    found, prefixed = [], False
                    for p in mine:
                        hits = [(one, word) for one in _texts(_fields(p).get(F_EXAMPLES)) if (word := _hit(group, one)) is not None]
                        if hits:
                            found.append((p["条目编号"], hits[0][1]))
                            prefixed = prefixed or any(one.strip().startswith(EXCEPTION_PREFIX) for one, _word in hits)
                    rows.append(_row(f"{section}·{flow}", group, found, 以例外开头=prefixed, 流程的页=[p["条目编号"] for p in mine]))
        else:
            for group in body:
                found = []
                for item in items:
                    if item["所属集合"] != section:
                        continue
                    fields = _fields(item)
                    names = FIELDS_OF.get(section) or tuple(list(fields)[:1])
                    text = "\n".join(json.dumps(fields.get(n), ensure_ascii=False) if not isinstance(fields.get(n), str) else fields[n]
                                     for n in names if fields.get(n) is not None)
                    if (word := _hit(group, text)) is not None:
                        found.append((item["条目编号"], word))
                rows.append(_row(section, group, found))
    return rows


def group_label(group: list[str]) -> str:
    """一组关键词给人看的写法：同义的几种用斜线隔开。"""
    return "／".join(group)
