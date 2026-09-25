"""Word 材料（.docx）的文本投影：上传 .docx 时在同一目录生成「文件名.docx.txt」，执行者读它，保存修订时逐字核对也对着它。

计数规则与 scripts/docx_paragraphs.mjs、材料区渲染后的回填相同，三处的段落号必须一致：
- 数 word/document.xml 里 w:body 下的每个 w:p，表格与嵌套表格里的段落也数，纵向合并续格里的空段落照数；
- 文本框里的段落（w:txbxContent，wps 一份与 VML 后备一份）不数；脚注、尾注、批注、页眉页脚在别的部件里，不读。
一段的文字是它自己的 w:t（插入的字算，删除的字在 w:delText 里不算，域代码在 w:instrText 里不算，锚在它里面的文本框的字不算）；
w:tab 写成制表符；w:br（分页、分栏除外）与 w:cr 是段内换行，投影里写成一个空格，保证一段一行。

投影每段一行，行首方括号里是段落号，表格里的段落另写位置（列按网格列数，横向合并的格子跨过的列算进去）：
    [第 37 段 · 表 1 行 1 列 2] 一次最多（本）
只用标准库，不引入 python-docx。
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SUFFIX = ".txt"
HEADER = ("# 由 {name} 生成，供助手阅读：每行是 Word 文件里的一段，行首方括号里是段落号，表格里的段落另写表、行、列。\n"
          "# 引用这份材料作来源时，出处写 {rel}#p段落号（例如 {rel}#p12），摘录逐字抄那一段里的文字，不带行首的方括号。\n")
LINE = re.compile(r"^\[第 (\d+) 段(?: · [^\]]*)?\] ?(.*)$")


def paragraphs(xml: bytes) -> list[dict]:
    """document.xml 里要数的段落：[{n, text, table}]，table 是从外到内的 [{table?, row, col}]（外层表写 table 序号）。"""
    root = ET.fromstring(xml)
    body = root.find(f"{W}body")
    out: list[dict] = []
    top_tables = 0

    def walk(el, tables: list[dict], para: dict | None, skip: bool) -> None:
        nonlocal top_tables
        for child in el:
            tag = child.tag
            if tag == f"{W}txbxContent":
                walk(child, tables, para, True)
            elif tag == f"{W}tbl":
                if skip:
                    walk(child, tables, para, skip)
                    continue
                if not tables:
                    top_tables += 1
                walk(child, tables + [{"index": top_tables if not tables else None, "row": 0, "col": 0, "next": 1}], para, skip)
            elif tag == f"{W}tr" and tables and not skip:
                t = tables[-1]
                t["row"] += 1
                t["col"], t["next"] = 0, 1
                walk(child, tables, para, skip)
            elif tag == f"{W}tc" and tables and not skip:
                t = tables[-1]
                t["col"] = t["next"]
                span = child.find(f"{W}tcPr/{W}gridSpan")
                t["next"] = t["col"] + int(span.get(f"{W}val", "1")) if span is not None else t["col"] + 1
                walk(child, tables, para, skip)
            elif tag == f"{W}p":
                own = {"text": [], "table": [({"table": t["index"]} if t["index"] else {}) | {"row": t["row"], "col": t["col"]} for t in tables]}
                walk(child, tables, own, skip)
                if not skip:
                    rec = {"n": len(out) + 1, "text": "".join(own["text"])}
                    if own["table"]:
                        rec["table"] = own["table"]
                    out.append(rec)
            elif para is not None and tag == f"{W}t":
                para["text"].append(child.text or "")
            elif para is not None and tag == f"{W}tab" and el.tag == f"{W}r":
                para["text"].append("\t")
            elif para is not None and tag in (f"{W}br", f"{W}cr") and el.tag == f"{W}r" and child.get(f"{W}type") not in ("page", "column"):
                para["text"].append("\n")
            else:
                walk(child, tables, para, skip)

    if body is not None:
        walk(body, [], None, False)
    return out


def table_label(table: list[dict]) -> str:
    """「表 3 行 4 列 3 · 嵌套表 行 1 列 1」，与 scripts/docx_paragraphs.mjs 的写法相同。"""
    return " · ".join(f"表 {t['table']} 行 {t['row']} 列 {t['col']}" if t.get("table") else f"嵌套表 行 {t['row']} 列 {t['col']}" for t in table)


def projection_text(data: bytes, rel: str) -> str:
    """.docx 的字节 → 投影全文。rel 是这份 .docx 相对任务目录的路径（写进开头的说明）。不是合法的 .docx 时抛 ValueError。"""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as e:
        raise ValueError("不是 Word 文件（.docx），或者文件已损坏") from e
    lines = [HEADER.format(name=rel.rsplit("/", 1)[-1], rel=rel)]
    for p in paragraphs(xml):
        where = f" · {table_label(p['table'])}" if p.get("table") else ""
        text = re.sub(r"[\r\n]", " ", p["text"])
        lines.append(f"[第 {p['n']} 段{where}] {text}\n")
    return "".join(lines)


def projection_path(docx: Path) -> Path:
    return docx.with_name(docx.name + SUFFIX)


def write_projection(docx: Path, rel: str) -> Path:
    """在 .docx 旁边写投影，返回投影的路径。"""
    target = projection_path(docx)
    target.write_text(projection_text(docx.read_bytes(), rel), encoding="utf-8")
    return target


def is_projection(name: str) -> bool:
    return name.lower().endswith(".docx" + SUFFIX)

