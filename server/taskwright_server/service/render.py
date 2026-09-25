"""生成文档：对交付物的某一次修订整体导出，按任务目录里的文档模板渲染成 Markdown（docs/api.md §4.3）。纯读取，不写库。

用户选一个修订号（缺省是最新），可以只列其中的某几个条目；不再跨修订逐条目选内容。文档里的每个条目
是它在那次修订时的样子：修订号不大于 N 的最近一次改动（记作修订 K），那时已删除的条目不在里面。

模板的写法（见起始文件 docs/templates/srs.md）：
- {{#每个 集合名}} … {{/每个}}：对这个集合里被选中的每个条目，把中间那段各渲染一遍；
- {{#没有 集合名}} … {{/没有}}：这个集合一个都没选中时才输出中间那段；
- 每个条目里：{{编号}}、{{修订号}}（它的内容来自修订 K）、{{评审状态}}、{{确认状态}}、{{来源}}，以及任意字段名 {{字段名}}；
- 模板任何地方：{{文档修订号}}（这份文档按修订 N 生成）。

没有评审通过或没有确认标记的条目不拦，如实写进「评审状态」「确认状态」两处（「未评审」「未确认」）；
评审不通过而用户保留了写法的，评审状态写「评审不通过，用户保留（理由：……）」，没写理由时不带括号。
评审与确认是挂在「条目加修订」上的标记，这里看的是条目在修订 K 上有没有。
文本列表逐项编号、用分号连起来；条目引用用顿号连起来；空字段写「（空）」。
「用户的话」的出处在库里是「会话编号#消息编号」，文档里换成读者看得懂的说法（「会话「名称」里用户的第 N 句话」），
由调用方按会话记录算好传进来（words_locator）；算不出来时写「对话里用户说的话」，不把内部编号印进文档。
Word 材料（.docx）的出处在库里是「文件路径#p段落号」，文档里只写文件路径，读者凭摘录在 Word 里查找。
「用户直接修改」的出处在库里是界面操作编号（ui-op-…），文档里换成「用户在界面上的第 N 次修改（时刻）」：
N 按库里所有「用户直接修改」来源的操作编号、以写入它们的事件先后排序；算不出来时写「用户在界面上的修改」。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

from taskwright_server.service.errors import ApiError
from taskwright_server.service.library import Library, actor_word

EACH = re.compile(r"\{\{#每个 (.+?)\}\}\n?(.*?)\{\{/每个\}\}\n?", re.S)
NONE = re.compile(r"\{\{#没有 (.+?)\}\}\n?(.*?)\{\{/没有\}\}\n?", re.S)
FIELD = re.compile(r"\{\{(.+?)\}\}")


def value_text(value, field_type: str) -> str:
    if value is None or value == "" or value == []:
        return "（空）"
    if field_type == "条目引用" and isinstance(value, list):
        return "、".join(str(v) for v in value)
    if isinstance(value, list):
        return "；".join(f"{n}. {v}" for n, v in enumerate(value, 1))
    return str(value).replace("\n", " ")


def review_state(lib: Library, item_id: str, revision_no: int) -> str:
    """条目在修订 revision_no 上的评审标记：评审通过、评审不通过、评审不通过但用户保留了写法（带理由）、未评审。"""
    reviews = lib.reviews_of(item_id, revision_no)
    if not reviews:
        return "未评审"
    if reviews[-1]["verdict"] == "合规":
        return "评审通过"
    kept = lib.active_waiver(item_id, revision_no) if hasattr(lib, "active_waiver") else None
    if kept:
        return f"评审不通过，用户保留（理由：{kept['reason']}）" if kept.get("reason") else "评审不通过，用户保留"
    return "评审不通过"


#: 确认标记的依据在文档里的写法：已读、用户修改，其余（早期版本的界面点击与对话里的表态）都是用户明确确认的。
BASIS_WORDS = {"viewed": "已读", "ui_edit": "用户修改"}


def confirm_state(lib: Library, item_id: str, revision_no: int) -> str:
    """条目在修订 revision_no 上的确认标记：最近一条态度是接受就是已确认，括号里如实写依据。
    这次修订上没有标记、而用户看过更早的修订 N 时，如实写「用户最后看过修订 N，之后由助手改为修订 M」；
    都没有（或在这次修订上撤回了）是未确认。"""
    records = lib.confirmations_of(item_id, revision_no)
    if records and records[-1]["accepted"]:
        return f"已确认（{BASIS_WORDS.get(records[-1]['basis'], '明确确认')}）"
    if records:
        return "未确认"
    seen = [c["revision_no"] for c in lib.confirmations_of(item_id) if c["accepted"] and c["revision_no"] < revision_no]
    if not seen:
        return "未确认"
    v = lib.contents.get((item_id, revision_no)) or {}
    by = actor_word((lib.data["event_meta"].get(v.get("event_seq"), {}) or {}).get("actor", ""))
    return f"用户最后看过修订 {max(seen)}，之后{'由助手' if by == 'executor' else ''}改为修订 {revision_no}"


USER_WORDS = "用户的话"
USER_EDIT = "用户直接修改"
EXECUTOR_SUPPLEMENT = "执行者补充"
#: 来源种类在文档里的写法：库里的存储值「执行者补充」对读者写成「助手补充」，其余照存储值。
KIND_WORDS = {EXECUTOR_SUPPLEMENT: "助手补充"}


def edit_locator(lib: Library) -> Callable[[str], str | None]:
    """界面操作编号 → 「用户在界面上的第 N 次修改（时刻）」。编号与先后都取自库：来源行记着写入它的事件序号，事件行记着时刻。"""
    first_seq: dict[str, int] = {}
    for rows in lib.data.get("sources", {}).values():
        for one in rows:
            seq = one.get("事件序号")
            if one.get("种类") == USER_EDIT and one.get("出处") and isinstance(seq, int):
                first_seq[one["出处"]] = min(seq, first_seq.get(one["出处"], seq))
    order = {op: n for n, op in enumerate(sorted(first_seq, key=first_seq.get), 1)}
    meta = lib.data.get("event_meta", {})

    def locate(locator: str) -> str | None:
        n = order.get(locator)
        if n is None:
            return None
        at = (meta.get(first_seq[locator]) or {}).get("at") or ""
        when = at[:16].replace("T", " ")
        return f"用户在界面上的第 {n} 次修改（{when}）" if when else f"用户在界面上的第 {n} 次修改"

    return locate


def sources_text(lib: Library, item_id: str, revision_no: int, words_locator: Callable[[str], str | None] | None = None,
                 edits_locator: Callable[[str], str | None] | None = None) -> str:
    parts = []
    for s in lib.sources_of(item_id, revision_no):
        if s["kind"] == USER_WORDS:
            readable = words_locator(s["locator"]) if words_locator and s["locator"] else None
            where = f"，出处 {readable or '对话里用户说的话'}"
        elif s["kind"] == USER_EDIT:
            readable = edits_locator(s["locator"]) if edits_locator and s["locator"] else None
            where = f"，出处 {readable or '用户在界面上的修改'}"
        else:
            # Word 材料的出处在库里带段落号（inputs/x.docx#p37），段落号对读者没有用，文档里只写文件名。
            locator = re.sub(r"(\.docx)#p\d+$", r"\1", s["locator"] or "", flags=re.I)
            where = f"，出处 {locator}" if locator and s["kind"] != EXECUTOR_SUPPLEMENT else ""
        parts.append(f"{KIND_WORDS.get(s['kind'], s['kind'])}{where}（「{s['excerpt']}」）")
    return "；".join(parts) or "（没有登记来源）"


def document_request(body: dict) -> tuple[int | None, list[str] | None]:
    """从请求体取出（修订号, 条目筛选）。修订号不写就是最新；条目筛选不写就是那次修订时的全部条目。"""
    revision_no = body.get("revision_no")
    if revision_no is not None and (not isinstance(revision_no, int) or isinstance(revision_no, bool) or revision_no < 1):
        raise ApiError("bad_request", "revision_no 要写一个从 1 起的整数，或者不写（按最新修订生成）。")
    items = body.get("items")
    if items is not None and (not isinstance(items, list) or not all(isinstance(i, str) for i in items)):
        raise ApiError("bad_request", "items 要写条目编号的列表，或者不写（那次修订时的全部条目）。")
    return revision_no, items


def render(task_dir: Path, lib: Library, revision_no: int | None = None, items: list[str] | None = None,
           words_locator: Callable[[str], str | None] | None = None) -> str:
    template_rel = lib.definition.get("文档模板") or "docs/templates/srs.md"
    template_path = Path(task_dir) / template_rel
    if not template_path.is_file():
        raise ApiError("bad_request", f"任务目录里没有文档模板 {template_rel}。")
    template = template_path.read_text(encoding="utf-8")
    latest = lib.latest_revision()
    if latest == 0:
        raise ApiError("bad_request", "交付物还没有任何修订，没有东西可以生成。")
    doc_revision = revision_no or latest
    if doc_revision > latest:
        raise ApiError("bad_request", f"这个任务还没有修订 {doc_revision}，最新是修订 {latest}。")
    alive = dict(lib.alive_at(doc_revision))
    if items is not None:
        missing = [i for i in items if i not in alive]
        if missing:
            raise ApiError("bad_request", f"修订 {doc_revision} 时交付物里没有这些条目：{'、'.join(missing)}。", {"items": missing})
        alive = {i: alive[i] for i in items}
    edits = edit_locator(lib)
    chosen: dict[str, list[tuple[str, int]]] = {}
    for item_id, content_revision in alive.items():
        chosen.setdefault(lib.items[item_id]["collection"], []).append((item_id, content_revision))
    for rows in chosen.values():
        rows.sort(key=lambda x: lib.items[x[0]]["serial"])

    def each(match: re.Match) -> str:
        collection, body = match.group(1).strip(), match.group(2)
        types = {f["名"]: f["类型"] for f in (lib.collections.get(collection) or {}).get("字段", [])}
        out = []
        for item_id, no in chosen.get(collection, []):
            fields = lib.fields_of(item_id, no) or {}
            # 「内容版本号」是旧模板里的写法，按修订号填（任务目录里拷去的旧模板照样能用）。
            special = {"编号": item_id, "修订号": str(no), "内容版本号": str(no), "评审状态": review_state(lib, item_id, no),
                       "确认状态": confirm_state(lib, item_id, no), "来源": sources_text(lib, item_id, no, words_locator, edits)}

            def fill(m: re.Match) -> str:
                key = m.group(1).strip()
                return special[key] if key in special else value_text(fields.get(key), types.get(key, "文本"))
            out.append(FIELD.sub(fill, body))
        return "".join(out)

    def none(match: re.Match) -> str:
        return match.group(2) if not chosen.get(match.group(1).strip()) else ""

    return NONE.sub(none, EACH.sub(each, template)).replace("{{文档修订号}}", str(doc_revision))
