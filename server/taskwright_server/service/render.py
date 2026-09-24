"""生成文档：把用户选中的条目版本，按任务目录里的文档模板渲染成 Markdown（docs/api.md §4.3）。纯读取，不写库。

模板的写法（见起始文件 docs/templates/srs.md）：
- {{#每个 集合名}} … {{/每个}}：对这个集合里被选中的每个条目，把中间那段各渲染一遍；
- {{#没有 集合名}} … {{/没有}}：这个集合一个都没选中时才输出中间那段；
- {{编号}}、{{内容版本号}}、{{评审状态}}、{{确认状态}}、{{来源}}，以及任意字段名 {{字段名}}。

选到没有评审通过或没有确认记录的版本不拦，如实写进「评审状态」「确认状态」两处（例如「未评审」「未经用户确认」）。
文本列表逐项编号、用分号连起来；条目引用用顿号连起来；空字段写「（空）」。
"""

from __future__ import annotations

import re
from pathlib import Path

from taskwright_server.service.errors import ApiError
from taskwright_server.service.library import Library

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


def review_state(lib: Library, item_id: str, version_no: int) -> str:
    reviews = lib.reviews_of(item_id, version_no)
    if not reviews:
        return "未评审"
    return "评审通过" if reviews[-1]["verdict"] == "合规" else "评审不通过"


def confirm_state(lib: Library, item_id: str, version_no: int) -> str:
    records = lib.confirmations_of(item_id, version_no)
    if not records:
        return "未经用户确认"
    return "用户已确认" if records[-1]["accepted"] else "用户撤回了确认"


def sources_text(lib: Library, item_id: str, version_no: int) -> str:
    parts = []
    for s in lib.sources_of(item_id, version_no):
        where = f"，出处 {s['locator']}" if s["locator"] and s["kind"] != "执行者补充" else ""
        parts.append(f"{s['kind']}{where}（「{s['excerpt']}」）")
    return "；".join(parts) or "（没有登记来源）"


def render(task_dir: Path, lib: Library, selection: list[dict]) -> str:
    template_rel = lib.definition.get("文档模板") or "docs/templates/srs.md"
    template_path = Path(task_dir) / template_rel
    if not template_path.is_file():
        raise ApiError("bad_request", f"任务目录里没有文档模板 {template_rel}。")
    template = template_path.read_text(encoding="utf-8")
    chosen: dict[str, list[tuple[str, int]]] = {}
    for one in selection:
        item_id, no = one.get("item_id"), one.get("version_no")
        if not isinstance(item_id, str) or not isinstance(no, int):
            raise ApiError("bad_request", "selection 的每一项要写 {\"item_id\": 条目编号, \"version_no\": 整数}。")
        if lib.fields_of(item_id, no) is None:
            raise ApiError("bad_request", f"条目 {item_id} 没有第 {no} 版。")
        chosen.setdefault(lib.items[item_id]["collection"], []).append((item_id, no))
    for rows in chosen.values():
        rows.sort(key=lambda x: lib.items[x[0]]["serial"])

    def each(match: re.Match) -> str:
        collection, body = match.group(1).strip(), match.group(2)
        types = {f["名"]: f["类型"] for f in (lib.collections.get(collection) or {}).get("字段", [])}
        out = []
        for item_id, no in chosen.get(collection, []):
            fields = lib.fields_of(item_id, no) or {}
            special = {"编号": item_id, "内容版本号": str(no), "评审状态": review_state(lib, item_id, no),
                       "确认状态": confirm_state(lib, item_id, no), "来源": sources_text(lib, item_id, no)}

            def fill(m: re.Match) -> str:
                key = m.group(1).strip()
                return special[key] if key in special else value_text(fields.get(key), types.get(key, "文本"))
            out.append(FIELD.sub(fill, body))
        return "".join(out)

    def none(match: re.Match) -> str:
        return match.group(2) if not chosen.get(match.group(1).strip()) else ""

    return NONE.sub(none, EACH.sub(each, template))
