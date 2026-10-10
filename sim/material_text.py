"""取一份材料的文字，给驾驭程序（放进用户 agent 的系统提示）与判定程序（核对来源逐字）用。

文本材料（.md、.txt 等）按 UTF-8 读。Word 材料（.docx）取产品自己的文字版：经命令行入口 agent/src/cli/docx_projection.mts
带 --print 运行，它什么都不写，把文字版全文放在标准输出里。这样用户 agent 看到的就是助手读到的那一份，文字版怎样写只有
agent 里那一份代码。要用 node；找不到 node 或者那份文件不是合法的 Word 文件时抛 MaterialError，原因是给人看的一句话。

文字版的样子（agent/src/lib/docx_markdown.ts）：开头一段给助手看的说明（HTML 注释），之后每段一行，方括号里的 p 加数字
（例如 [p12]）是段落号，它右边到行尾是这一段的正文；表格按行写，一格里可以有几个段落号。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROJECTION_CLI = REPO_ROOT / "agent" / "src" / "cli" / "docx_projection.mts"

#: 文字版开头给助手看的那段说明。
LEADING_NOTE = re.compile(r"\A\s*<!--.*?-->\s*", re.S)
#: 段落号。
PARAGRAPH_MARK = re.compile(r"\[p\d+\]")


class MaterialError(RuntimeError):
    """材料的文字取不出来。"""


def is_docx(path: Path | str) -> bool:
    return str(path).lower().endswith(".docx")


def docx_text_version(path: Path) -> str:
    """一份 Word 材料的文字版全文（带开头的说明与段落号）。"""
    node = shutil.which("node")
    if node is None:
        raise MaterialError(f"在 PATH 里找不到 node，取不了 {Path(path).name} 的文字版。")
    try:
        done = subprocess.run([node, str(PROJECTION_CLI), "--docx", str(path), "--rel", f"inputs/{Path(path).name}", "--print"],
                              cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MaterialError(f"取 {Path(path).name} 的文字版时出错了：{error}") from None
    try:
        out = json.loads(done.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        raise MaterialError(f"取 {Path(path).name} 的文字版时出错了：" + ((done.stderr.strip().splitlines() or ["没有输出"])[-1])) from None
    if not out.get("ok"):
        raise MaterialError(f"取不了 {Path(path).name} 的文字版：{out.get('error') or '没有给原因'}")
    return out.get("markdown") or ""


def material_text(path: Path) -> str:
    """给人读的材料文字：文本材料是原文；Word 材料是文字版去掉开头那段给助手看的说明（段落号留着）。"""
    path = Path(path)
    if is_docx(path):
        return LEADING_NOTE.sub("", docx_text_version(path), count=1)
    return path.read_text(encoding="utf-8")


def paragraphs_joined(text_version: str) -> str:
    """把 Word 材料的文字版里各段的正文按先后接成一串（段落号、标题与列表的记号、表格的竖线都不要）。
    助手引 Word 材料时摘录可以从一段跨到相邻的后几段，核对来源逐字时对着这一串找。"""
    parts = []
    for line in LEADING_NOTE.sub("", text_version, count=1).splitlines():
        pieces = PARAGRAPH_MARK.split(line)
        for piece in pieces[1:]:           # 第一段是段落号左边的记号与编号，不是正文
            parts.append(piece.strip().rstrip("|").strip())
    return "".join(parts)


def material_for_check(path: Path) -> str:
    """核对来源逐字时用的材料文字：文本材料是原文；Word 材料是各段正文接成的一串。"""
    path = Path(path)
    if is_docx(path):
        return paragraphs_joined(docx_text_version(path))
    return path.read_text(encoding="utf-8")


def read_names(name: str) -> tuple[str, ...]:
    """助手读这份材料时会读到的文件名：Word 材料读的是旁边的文字版（文件名后面加 .md）。"""
    return (name, name + ".md") if is_docx(name) else (name,)
