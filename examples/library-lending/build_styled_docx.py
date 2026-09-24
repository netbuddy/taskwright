"""Build requirements-styled.docx and its style checklist from scratch.

The .docx is a longer, fictional version of requirements.md that uses a wide range of Word features, so that
paragraph counting can be checked against real Word structure: heading levels, mixed inline formatting, two-level
lists, merged and nested tables, inline and floating pictures, a text box, footnote and endnote, hyperlink, bookmark
and cross-reference, page and section breaks, header and footer, a table-of-contents field, a comment and tracked
changes.

python-docx builds what it can; the rest is written as WordprocessingML directly. After saving, the script reads
document.xml back and writes the checklist (requirements-styled.样式清单.md) with a numbered list of every w:p and
w:tc, so the checklist always matches the file.

Usage (python-docx and Pillow installed):

    python3 examples/library-lending/build_styled_docx.py
"""

from __future__ import annotations

import copy
import datetime as dt
import io
import subprocess
import zipfile
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_COLOR_INDEX
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Mm, Pt, RGBColor
from lxml import etree
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "requirements-styled.docx"
CHECKLIST = HERE / "requirements-styled.样式清单.md"

AUTHOR = "示例审阅人"
WHEN = "2026-09-01T09:00:00Z"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {
    "w": W,
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "v": "urn:schemas-microsoft-com:vml",
}

# ───────────── the checklist, filled in while building ─────────────

records: list[tuple[str, str, str, str]] = []  # (where, first words, style, how it is made)
where = "封面"


def log(first: str, style: str, how: str) -> None:
    records.append((where, first[:14], style, how))


# ───────────── pictures ─────────────

def font(size: int) -> ImageFont.ImageFont:
    try:
        path = subprocess.run(["fc-match", "-f", "%{file}", "Noto Sans CJK SC"], capture_output=True, text=True, check=True).stdout
        return ImageFont.truetype(path, size)
    except Exception:  # no fontconfig or no CJK font: the boxes still show, the labels may not
        return ImageFont.load_default()


def flowchart_png() -> io.BytesIO:
    """借书流程：四个方框加箭头。"""
    steps = ["读者刷借书证", "扫描图书条码", "系统核对上限", "登记借阅记录"]
    img = Image.new("RGB", (1200, 220), "white")
    d = ImageDraw.Draw(img)
    f = font(30)
    for i, s in enumerate(steps):
        x = 20 + i * 295
        d.rounded_rectangle([x, 60, x + 240, 160], radius=18, fill="#e9effc", outline="#2563eb", width=4)
        w = d.textlength(s, font=f)
        d.text((x + 120 - w / 2, 92), s, fill="#0d0d0d", font=f)
        if i < len(steps) - 1:
            d.line([x + 244, 110, x + 290, 110], fill="#2563eb", width=5)
            d.polygon([(x + 290, 110), (x + 276, 100), (x + 276, 120)], fill="#2563eb")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)
    return buf


def timeline_png() -> io.BytesIO:
    """预约保留期：三个色块。"""
    img = Image.new("RGB", (600, 360), "white")
    d = ImageDraw.Draw(img)
    f = font(30)
    blocks = [("图书上架", "#e7f4eb", "#15803d"), ("保留 3 天", "#fdf3e0", "#b45309"), ("取消预约", "#fbeeee", "#b91c1c")]
    for i, (s, fill, line) in enumerate(blocks):
        y = 20 + i * 112
        d.rectangle([30, y, 570, y + 92], fill=fill, outline=line, width=4)
        w = d.textlength(s, font=f)
        d.text((300 - w / 2, y + 28), s, fill=line, font=f)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)
    return buf


# ───────────── small XML helpers ─────────────

def el(tag: str, **attrs: str):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn(k), v)
    return e


def run_el(text: str, *, delete: bool = False):
    r = el("w:r")
    t = el("w:delText" if delete else "w:t")
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    t.text = text
    r.append(t)
    return r


def add_field(paragraph, instr: str, result: str) -> None:
    """复杂域：begin、域代码、separate、显示结果、end，各是一个 w:r。"""
    p = paragraph._p
    p.append(_fld("begin"))
    r = el("w:r")
    it = el("w:instrText")
    it.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    it.text = f" {instr} "
    r.append(it)
    p.append(r)
    p.append(_fld("separate"))
    p.append(run_el(result))
    p.append(_fld("end"))


def _fld(kind: str):
    r = el("w:r")
    r.append(el("w:fldChar", **{"w:fldCharType": kind}))
    return r


def set_num(paragraph, num_id: int, level: int) -> None:
    num_pr = paragraph._p.get_or_add_pPr().get_or_add_numPr()
    num_pr.get_or_add_ilvl().val = level
    num_pr.get_or_add_numId().val = num_id


def east_asian(style, name: str) -> None:
    rpr = style.element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = el("w:rFonts")
        rpr.insert(0, fonts)
    fonts.set(qn("w:eastAsia"), name)


# ───────────── numbering definitions ─────────────

HEADING_NUM, BULLET_NUM, STEPS_NUM, STEPS_RESTART_NUM = 50, 51, 52, 53


def lvl(ilvl: int, fmt: str, text: str, left: int, hanging: int, pstyle: str | None = None, font_name: str | None = None) -> str:
    ps = f'<w:pStyle w:val="{pstyle}"/>' if pstyle else ""
    rpr = f'<w:rPr><w:rFonts w:ascii="{font_name}" w:hAnsi="{font_name}"/></w:rPr>' if font_name else ""
    return (f'<w:lvl w:ilvl="{ilvl}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/>{ps}<w:lvlText w:val="{text}"/>'
            f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{left}" w:hanging="{hanging}"/></w:pPr>{rpr}</w:lvl>')


def add_numbering(doc) -> None:
    numbering = doc.part.numbering_part.element
    abstracts = [
        # 标题的多级编号：1 / 1.1 / 1.1.1，经样式 Heading 1 到 3 挂上
        (50, "multilevel", [lvl(0, "decimal", "%1", 432, 432, "Heading1"), lvl(1, "decimal", "%1.%2", 576, 576, "Heading2"),
                            lvl(2, "decimal", "%1.%2.%3", 720, 720, "Heading3")]),
        (51, "hybridMultilevel", [lvl(0, "bullet", "•", 420, 420, font_name="Arial"), lvl(1, "bullet", "◦", 840, 420, font_name="Arial")]),
        (52, "hybridMultilevel", [lvl(0, "decimal", "%1.", 420, 420), lvl(1, "decimal", "%1.%2", 1000, 580)]),
    ]
    last_abstract = numbering.findall(qn("w:abstractNum"))[-1]
    for aid, kind, levels in reversed(abstracts):
        last_abstract.addnext(parse_xml(f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{aid}"><w:multiLevelType w:val="{kind}"/>{"".join(levels)}</w:abstractNum>'))
    for num_id, aid, override in [(HEADING_NUM, 50, ""), (BULLET_NUM, 51, ""), (STEPS_NUM, 52, ""),
                                  (STEPS_RESTART_NUM, 52, '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>')]:
        numbering.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{num_id}"><w:abstractNumId w:val="{aid}"/>{override}</w:num>'))
    for level, name in enumerate(["Heading 1", "Heading 2", "Heading 3"]):
        num_pr = doc.styles[name].element.get_or_add_pPr().get_or_add_numPr()
        num_pr.get_or_add_ilvl().val = level
        num_pr.get_or_add_numId().val = HEADING_NUM


# ───────────── footnotes and endnotes ─────────────

NOTES_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.{}+xml"


def notes_part(doc, kind: str, text: str) -> None:
    """footnotes.xml 或 endnotes.xml：两个分隔符（id -1、0）加一条注释（id 1）。"""
    tag = kind[:-1]  # footnote / endnote
    sep = (f'<w:{tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:{tag}>'
           f'<w:{tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:{tag}>')
    body = (f'<w:{tag} w:id="1"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>'
            f'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:{tag}Ref/></w:r>'
            f'<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> {text}</w:t></w:r></w:p></w:{tag}>')
    xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:{kind} {nsdecls("w")}>{sep}{body}</w:{kind}>'
    part = Part(PackURI(f"/word/{kind}.xml"), NOTES_CT.format(kind), xml.encode("utf-8"), doc.part.package)
    doc.part.relate_to(part, RT.FOOTNOTES if kind == "footnotes" else RT.ENDNOTES)


def note_ref(paragraph, kind: str) -> None:
    r = el("w:r")
    rpr = el("w:rPr")
    rpr.append(el("w:vertAlign", **{"w:val": "superscript"}))
    r.append(rpr)
    r.append(el(f"w:{kind}Reference", **{"w:id": "1"}))
    paragraph._p.append(r)


# ───────────── floating picture and text box ─────────────

def float_picture(paragraph, image: io.BytesIO, width: Cm, name: str) -> None:
    """先按行内图片加进去，再把 wp:inline 换成带文字环绕的 wp:anchor（靠右）。"""
    run = paragraph.add_run()
    inline = run.add_picture(image, width=width)._inline
    anchor = parse_xml(
        f'<wp:anchor {nsdecls("wp")} distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" '
        f'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
        f'<wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH>'
        f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV></wp:anchor>')
    anchor.append(copy.deepcopy(inline.find(qn("wp:extent"))))
    anchor.append(parse_xml(f'<wp:effectExtent {nsdecls("wp")} l="0" t="0" r="0" b="0"/>'))
    anchor.append(parse_xml(f'<wp:wrapSquare {nsdecls("wp")} wrapText="bothSides"/>'))
    doc_pr = copy.deepcopy(inline.find(qn("wp:docPr")))
    doc_pr.set("name", name)
    anchor.append(doc_pr)
    anchor.append(copy.deepcopy(inline.find(qn("wp:cNvGraphicFramePr"))))
    anchor.append(copy.deepcopy(inline.find(qn("a:graphic"))))
    inline.getparent().replace(inline, anchor)


def text_box(paragraph, lines: list[str]) -> None:
    """浮动文本框，照 Word 自己的存法：mc:AlternateContent 里 wps 文本框一份、VML 后备一份，两份各有同样的段落。"""
    def paras() -> str:
        return "".join(f'<w:p><w:pPr><w:spacing w:after="60"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">{t}</w:t></w:r></w:p>'
                       for t in lines)
    cx, cy = 2340000, 1260000  # EMU，约 6.5 × 3.5 厘米
    xml = (
        f'<w:r {nsdecls("w")}><mc:AlternateContent xmlns:mc="{NS["mc"]}">'
        f'<mc:Choice xmlns:wps="{NS["wps"]}" Requires="wps"><w:drawing>'
        f'<wp:anchor xmlns:wp="{NS["wp"]}" distT="45720" distB="45720" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" '
        f'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
        f'<wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH>'
        f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/>'
        f'<wp:docPr id="900" name="文本框 1"/><wp:cNvGraphicFramePr/>'
        f'<a:graphic xmlns:a="{NS["a"]}"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
        f'<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFF8E1"/></a:solidFill>'
        f'<a:ln w="9525"><a:solidFill><a:srgbClr val="B45309"/></a:solidFill></a:ln></wps:spPr>'
        f'<wps:txbx><w:txbxContent>{paras()}</w:txbxContent></wps:txbx>'
        f'<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"><a:noAutofit/></wps:bodyPr>'
        f'</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>'
        f'<mc:Fallback><w:pict><v:rect xmlns:v="{NS["v"]}" xmlns:w10="urn:schemas-microsoft-com:office:word" id="TextBox1" '
        f'style="position:absolute;margin-left:0;margin-top:0;width:184.25pt;height:99.2pt;z-index:251659264;mso-position-horizontal:right" '
        f'fillcolor="#fff8e1" strokecolor="#b45309"><v:textbox><w:txbxContent>{paras()}</w:txbxContent></v:textbox>'
        f'<w10:wrap type="square"/></v:rect></w:pict></mc:Fallback></mc:AlternateContent></w:r>')
    paragraph._p.append(parse_xml(xml))


# ───────────── the document ─────────────

def build() -> None:
    global where
    doc = Document()
    props = doc.core_properties
    props.author, props.last_modified_by, props.title = "示例作者", "示例作者", "学校图书馆借还书系统需求说明（示例材料）"
    props.created = props.modified = dt.datetime(2026, 9, 1, 9, 0, 0)
    props.revision = 1
    east_asian(doc.styles["Normal"], "宋体")
    doc.styles["Normal"].font.size = Pt(10.5)
    for name in ("Title", "Heading 1", "Heading 2", "Heading 3"):
        east_asian(doc.styles[name], "黑体")
    add_numbering(doc)
    notes_part(doc, "footnotes", "借书证在入学或入职时由图书馆统一办理，毕业或离职时注销。")
    notes_part(doc, "endnotes", "提醒的发送方式（短信、邮件或校园应用消息）另行确定。")

    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.left_margin = sec.right_margin = Cm(2.5)
    sec.top_margin = sec.bottom_margin = Cm(2.5)
    hp = sec.header.paragraphs[0]
    hp.text = "学校图书馆借还书系统需求说明（示例材料）"
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    records.append(("页眉", hp.text[:14], "页眉段落，右对齐", "section.header.paragraphs[0]，存在 header1.xml"))
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fp.add_run("第 ")
    add_field(fp, "PAGE", "1")
    fp.add_run(" 页，共 ")
    add_field(fp, "NUMPAGES", "5")
    fp.add_run(" 页")
    records.append(("页脚", "第 X 页，共 Y 页", "页脚段落，含 PAGE 与 NUMPAGES 域", "section.footer；域用 w:fldChar 与 w:instrText 手写，存在 footer1.xml"))

    # 封面：标题、居中、右对齐、目录域、分页符
    t = doc.add_heading("学校图书馆借还书系统需求说明", level=0)
    log(t.text, "文档标题（样式 Title）", "doc.add_heading(level=0)")
    p = doc.add_paragraph("示例材料 · 内容虚构，仅用于演示")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    log(p.text, "居中段落", "paragraph.alignment = CENTER")
    p = doc.add_paragraph("版本 0.3　　2026 年 9 月")
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    log(p.text, "右对齐段落", "paragraph.alignment = RIGHT")
    p = doc.add_paragraph()
    p.add_run("目录").bold = True
    log("目录", "加粗的普通段落（不用标题样式，免得被编进目录与编号）", "run.bold")
    p = doc.add_paragraph()
    add_field(p, 'TOC \\o "1-3" \\h \\z \\u', "（这里是目录域。在 Word 里右键选「更新域」即可生成目录。）")
    log("（这里是目录域", "目录域 TOC \\o \"1-3\" \\h \\z \\u，未更新", "w:fldChar begin/separate/end 与 w:instrText 手写")
    p.add_run().add_break(WD_BREAK.PAGE)
    log("（目录域段落末尾）", "分页符", "run.add_break(WD_BREAK.PAGE)，即 w:br w:type=\"page\"")

    # 1 概述
    where = "1 概述"
    h = doc.add_heading("概述", level=1)
    log(h.text, "一级标题（Heading 1，多级编号 1）", "doc.add_heading(level=1)；编号来自样式里的 w:numPr")
    p = doc.add_paragraph("我们学校图书馆现在用纸质登记簿记录借还，高峰期排队长、查询慢。本说明描述要替换它的借还书系统：读者凭借书证")
    note_ref(p, "footnote")
    p.add_run("借书、续借、还书、预约，系统自动登记并在到期前提醒。")
    p.paragraph_format.first_line_indent = Cm(0.74)
    log(p.text, "首行缩进两字的段落", "paragraph_format.first_line_indent")
    log("借书证", "脚注引用（脚注正文在 footnotes.xml）", "手写 w:footnoteReference w:id=\"1\"，另建 footnotes.xml 部件")

    p = doc.add_paragraph()
    p.add_run("系统")
    p.add_run("必须").bold = True
    p.add_run("在")
    p.add_run("开学第一周").italic = True
    p.add_run("的借还高峰稳定运行；原有的")
    p.add_run("纸质登记簿").font.strike = True
    p.add_run("停用后，历史记录要")
    p.add_run("一次性迁入").underline = True
    p.add_run("。")
    r = p.add_run("逾期未还")
    r.font.color.rgb = RGBColor(0xB9, 0x1C, 0x1C)
    p.add_run("的读者会被限制续借。罚款的缴纳方式")
    r = p.add_run("待定")
    r.font.highlight_color = WD_COLOR_INDEX.YELLOW
    p.add_run("，寒暑假借期")
    r = p.add_run("另行规定")
    shd = el("w:shd", **{"w:val": "clear", "w:color": "auto", "w:fill": "D9E2F3"})
    r._r.get_or_add_rPr().append(shd)
    p.add_run("。馆舍面积约 1200 m")
    p.add_run("2").font.superscript = True
    p.add_run("，馆藏编目采用第 5 版分类法（CLC")
    p.add_run("5").font.subscript = True
    p.add_run("），")
    r = p.add_run("全文约四千字，")
    r.font.size = Pt(8)
    r = p.add_run("请逐条核对。")
    r.font.size = Pt(14)
    log("系统必须在开学第一周", "行内混排：加粗、斜体、删除线、下划线、红字、黄色高亮、底纹、上标、下标、8 磅与 14 磅字号",
        "run.bold / italic / font.strike / underline / font.color.rgb / font.highlight_color / 手写 w:shd / font.superscript / font.subscript / font.size")

    p = doc.add_paragraph("学校现行的借阅管理办法见 ")
    rid = doc.part.relate_to("https://example.org/library/rules", RT.HYPERLINK, is_external=True)
    link = el("w:hyperlink", **{"r:id": rid})
    lr = run_el("图书馆借阅管理办法（示例网址）")
    lrpr = el("w:rPr")
    lrpr.append(el("w:color", **{"w:val": "0563C1"}))
    lrpr.append(el("w:u", **{"w:val": "single"}))
    lr.insert(0, lrpr)
    link.append(lr)
    p._p.append(link)
    p.add_run("，本说明与它冲突时以本说明为准。")
    log(p.text, "超链接（指向 https://example.org/library/rules）", "手写 w:hyperlink r:id，关系为外部 hyperlink")

    h = doc.add_heading("范围", level=2)
    log(h.text, "二级标题（Heading 2，编号 1.1）", "doc.add_heading(level=2)")
    p = doc.add_paragraph("本期只覆盖图书的借、还、续借、预约与罚款登记；电子资源、馆际互借不在本期范围内。")
    log(p.text, "普通段落", "doc.add_paragraph")

    h = doc.add_heading("术语", level=2)
    h._p.insert(1, el("w:bookmarkStart", **{"w:id": "10", "w:name": "_Ref_terms"}))
    h._p.append(el("w:bookmarkEnd", **{"w:id": "10"}))
    log(h.text, "二级标题，整段加书签 _Ref_terms", "手写 w:bookmarkStart / w:bookmarkEnd")
    p = doc.add_paragraph()
    p.add_run("逾期").bold = True
    p.add_run("：借期（含续借延长的部分）届满之日的次日起仍未归还。")
    log(p.text, "术语定义段落", "doc.add_paragraph，run.bold")
    p = doc.add_paragraph()
    p.add_run("预约保留期").bold = True
    p.add_run("：被预约的图书归还上架后，只为预约读者保留的那段时间。")
    log(p.text, "术语定义段落", "doc.add_paragraph，run.bold")

    # 2 读者与借阅规则
    where = "2 读者与借阅规则"
    h = doc.add_heading("读者与借阅规则", level=1)
    log(h.text, "一级标题（编号 2）", "doc.add_heading(level=1)")
    h = doc.add_heading("读者类型", level=2)
    log(h.text, "二级标题（编号 2.1）", "doc.add_heading(level=2)")
    for text, level in [("学生", 0), ("本科生：凭学生证办理借书证", 1), ("研究生：借阅上限与本科生相同", 1),
                        ("教职工", 0), ("在编教师", 1), ("外聘教师：借期与在编教师相同，上限另行规定", 1), ("校外读者：本期不开放", 0)]:
        p = doc.add_paragraph(text, style="List Paragraph")
        set_num(p, BULLET_NUM, level)
    log("学生", "项目符号列表，两级（• 与 ◦）", "List Paragraph 样式加手写 w:numPr（numId 51，ilvl 0/1）")

    h = doc.add_heading("借书流程", level=2)
    log(h.text, "二级标题（编号 2.2）", "doc.add_heading(level=2)")
    steps = [("读者在自助借还机或服务台刷借书证。", 0), ("逐本扫描图书条码。", 0), ("系统核对借阅上限与逾期情况：", 0),
             ("名下有逾期未还图书的，不能再借；", 1), ("超过上限的，只登记到上限为止。", 1), ("系统登记借阅记录并打印凭条。", 0)]
    for text, level in steps:
        p = doc.add_paragraph(text, style="List Paragraph")
        set_num(p, STEPS_NUM, level)
    p = doc.add_paragraph("凭条上写明每本书的应还日期；读者也可以在校园应用里查到同样的信息。", style="List Paragraph")
    p.paragraph_format.left_indent = Pt(21)
    log("读者在自助借还机", "编号列表，两级（1. 与 1.1）；最后一项含第二段（不带编号，缩进对齐）",
        "List Paragraph 加 w:numPr（numId 52）；续段只设左缩进 paragraph_format.left_indent")
    p = doc.add_paragraph()
    p.add_run().add_picture(flowchart_png(), width=Cm(15))
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    log("（图：借书流程）", "行内图片（wp:inline）", "run.add_picture")
    p = doc.add_paragraph("图 1  借书流程示意", style="Caption")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    log(p.text, "题注（样式 Caption）", "doc.add_paragraph(style=\"Caption\")")

    h = doc.add_heading("借阅上限", level=2)
    log(h.text, "二级标题（编号 2.3）", "doc.add_heading(level=2)")
    p = doc.add_paragraph("表 1 是各类读者的借阅上限。")
    log(p.text, "普通段落", "doc.add_paragraph")
    table = doc.add_table(rows=4, cols=4, style="Table Grid")
    rows = [("读者类型", "一次最多（本）", "借期（天）", "可续借次数"), ("学生", "5", "30", "1"), ("教师", "10", "30", "1"), ("校外读者", "—", "—", "—")]
    for i, row in enumerate(rows):
        for j, text in enumerate(row):
            cell = table.cell(i, j)
            cell.text = text
            if i == 0:
                cell.paragraphs[0].runs[0].bold = True
    table.rows[0]._tr.get_or_add_trPr().append(el("w:tblHeader"))
    log("读者类型 | 一次最多", "表 1：普通表格，首行是重复表头行", "doc.add_table(style=\"Table Grid\")；表头行手写 w:tblHeader")

    p = doc.add_paragraph("表 2 按学期与假期列出借期；同一类读者的几种情形合并在一格里。")
    log(p.text, "普通段落", "doc.add_paragraph")
    table = doc.add_table(rows=5, cols=4, style="Table Grid")
    data = [("读者类型", "细分", "借期（天）", ""), ("", "", "学期中", "寒暑假"), ("学生", "本科生", "30", "另行规定"),
            ("", "研究生", "30", "另行规定"), ("教职工", "在编与外聘教师", "30", "60")]
    for i, row in enumerate(data):
        for j, text in enumerate(row):
            if text:
                table.cell(i, j).text = text
    table.cell(0, 2).merge(table.cell(0, 3))          # 横向合并：借期（天）跨两列
    table.cell(0, 0).merge(table.cell(1, 0))          # 纵向合并：读者类型、细分跨两行表头
    table.cell(0, 1).merge(table.cell(1, 1))
    table.cell(2, 0).merge(table.cell(3, 0))          # 纵向合并：学生跨两行
    log("读者类型 | 细分 | 借期", "表 2：横向合并（借期跨两列，w:gridSpan）与纵向合并（读者类型、细分、学生，w:vMerge）",
        "table.cell(...).merge(...)，python-docx 写 w:gridSpan 与 w:vMerge")

    # 3 归还、罚款与预约
    where = "3 归还、罚款与预约"
    h = doc.add_heading("归还、罚款与预约", level=1)
    log(h.text, "一级标题（编号 3）", "doc.add_heading(level=1)")
    h = doc.add_heading("归还", level=2)
    log(h.text, "二级标题（多级编号 3.1）", "doc.add_heading(level=2)")
    p = doc.add_paragraph("读者还书")
    p._p.append(_ins("可以在自助借还机上办理，也可以"))
    p._p.append(_del("只能"))
    p.add_run("到服务台办理。还书时系统结清借阅记录；有预约的图书转入预约流程。")
    log("读者还书可以在自助", "修订标记：一处插入（w:ins）与一处删除（w:del）", "手写 w:ins / w:del，删除的字用 w:delText")

    h = doc.add_heading("逾期罚款", level=3)
    log(h.text, "三级标题（多级编号 3.1.1）", "doc.add_heading(level=3)")
    p = doc.add_paragraph("逾期的每本每天罚款一角，罚款最多不超过这本书的定价。")
    r = p.add_run("罚款怎样缴纳待定。")
    doc.add_comment(r, text="缴纳方式需要和财务处确认：服务台现金、校园卡扣款还是线上支付。", author=AUTHOR, initials="SL")
    log(p.text, "批注一条（挂在「罚款怎样缴纳待定。」上）；含糊表述「待定」", "doc.add_comment(run, text, author, initials)，python-docx 写 comments.xml")
    h = doc.add_heading("损坏与丢失", level=3)
    log(h.text, "三级标题（编号 3.1.2）", "doc.add_heading(level=3)")
    p = doc.add_paragraph("图书损坏或丢失时的赔偿办法另行规定；在规定出台前，由服务台登记情况并暂停该读者的借阅。")
    log(p.text, "含糊表述「另行规定」", "doc.add_paragraph")

    h = doc.add_heading("预约", level=2)
    log(h.text, "二级标题（编号 3.2）", "doc.add_heading(level=2)")
    p = doc.add_paragraph()
    float_picture(p, timeline_png(), Cm(4.5), "图片 预约保留期")
    p.add_run("被借走的书可以预约。书还回来以后，系统通知预约的读者，这本书为他保留 3 天，3 天内没来取就取消预约，"
              "图书转给下一位预约读者；没有下一位时放回书架。同一本书同时最多有 5 位读者在排队，排队顺序按预约时间先后。"
              "预约读者可以在保留期内随时取消预约，取消后不影响他以后再预约其他图书。")
    log("（浮动图片）被借走的书", "浮动锚定图片（wp:anchor，四周型环绕，靠右），与正文同一段", "先 run.add_picture，再把 wp:inline 换成手写的 wp:anchor 加 wp:wrapSquare")
    p = doc.add_paragraph()
    text_box(p, ["说明：保留期从图书归还上架时起算，", "按自然日计，节假日不顺延。"])
    p.add_run("预约成功后，读者在校园应用里能看到自己的排队位次。保留期内图书放在服务台后面的预约架上，"
              "只有凭该读者的借书证才能借出。保留期满未取的，系统记一次「预约未取」，一学期内累计三次的读者暂停预约资格 30 天。")
    log("（文本框）预约成功后", "浮动文本框（wps:wsp 带 wps:txbx，外加 VML 后备 v:textbox），里面两段说明", "手写 mc:AlternateContent（Choice 为 wps，Fallback 为 VML）")

    h = doc.add_heading("到期提醒", level=2)
    log(h.text, "二级标题（编号 3.3）", "doc.add_heading(level=2)")
    p = doc.add_paragraph("借期到期前 3 天，系统给读者发一次提醒")
    note_ref(p, "endnote")
    p.add_run("。已经续借过的图书同样提醒。")
    log(p.text, "尾注引用（尾注正文在 endnotes.xml）", "手写 w:endnoteReference w:id=\"1\"，另建 endnotes.xml 部件")

    # 分节：第二节横向
    where = "4 非功能需求（第二节，横向）"
    new = doc.add_section(WD_SECTION.NEW_PAGE)
    new.orientation = WD_ORIENT.LANDSCAPE
    new.page_width, new.page_height = Mm(297), Mm(210)
    records.append(("3 与 4 之间", "（分节符）", "分节符（下一页），第二节改横向；第一节的 w:sectPr 在 3.3 最后一段的 w:pPr 里",
                    "doc.add_section(WD_SECTION.NEW_PAGE)，section.orientation 与页面宽高互换"))
    h = doc.add_heading("非功能需求", level=1)
    log(h.text, "一级标题（编号 4）", "doc.add_heading(level=1)")
    p = doc.add_paragraph("表 3 列出性能、可用性与数据方面的要求。个别单元格里有多段文字与列表，「数据」一行的说明格里嵌着一张小表。")
    log(p.text, "普通段落", "doc.add_paragraph")
    table = doc.add_table(rows=4, cols=3, style="Table Grid")
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for j, text in enumerate(["类别", "要求", "说明"]):
        table.cell(0, j).text = text
        table.cell(0, j).paragraphs[0].runs[0].bold = True
    table.rows[0]._tr.get_or_add_trPr().append(el("w:tblHeader"))
    table.cell(1, 0).text = "性能"
    table.cell(1, 1).text = "开学第一周是借还高峰，系统要能每分钟处理至少 100 笔借还。"
    cell = table.cell(1, 2)
    cell.text = "「处理」指从扫描条码到打印凭条完成。"
    cell.add_paragraph("统计口径待定，先按以下两种情形测：")
    for text in ("只借不还的连续操作；", "借还交替的混合操作。"):
        set_num(cell.add_paragraph(text, style="List Paragraph"), BULLET_NUM, 0)
    table.cell(2, 0).text = "可用性"
    table.cell(2, 1).text = "开馆时间内系统可用；自助借还机断网时仍能借书，恢复后补传记录。"
    table.cell(2, 2).text = "断网时不能还书，只能借书。"
    table.cell(3, 0).text = "数据"
    table.cell(3, 1).text = "借阅记录保存五年；读者注销后个人信息按学校规定处理。"
    cell = table.cell(3, 2)
    cell.text = "各类记录的保存期限："
    inner = cell.add_table(rows=3, cols=2)
    inner.style = doc.styles["Table Grid"]
    for i, (a, b) in enumerate([("记录", "保存期限"), ("借阅记录", "五年"), ("罚款记录", "另行规定")]):
        inner.cell(i, 0).text, inner.cell(i, 1).text = a, b
    cell.add_paragraph("以上期限以学校档案管理规定为准。")
    log("类别 | 要求 | 说明", "表 3：单元格里多段与列表（性能行的说明格）", "cell.add_paragraph，列表段落加 w:numPr")
    log("记录 | 保存期限", "表 3 里的嵌套表格（数据行的说明格里）", "cell.add_table")

    # 5 待定事项
    where = "5 待定事项"
    h = doc.add_heading("待定事项", level=1)
    log(h.text, "一级标题（编号 5）", "doc.add_heading(level=1)")
    for text in ("寒暑假期间的借期另行规定。", "罚款的缴纳方式待定。", "「智能推荐图书」具体指什么，推荐依据和效果怎样验收，待定。"):
        p = doc.add_paragraph(text, style="List Paragraph")
        set_num(p, STEPS_RESTART_NUM, 0)
    log("寒暑假期间的借期", "第二个编号列表，重新从 1 编号", "新的 w:num（numId 53）引用同一个 abstractNum，带 w:lvlOverride/w:startOverride")
    p = doc.add_paragraph("「逾期」的定义见第 ")
    add_field(p, "REF _Ref_terms \\r \\h", "1.2")
    p.add_run(" 节。")
    log(p.text, "交叉引用（REF 域指向书签 _Ref_terms，显示标题编号）", "手写 REF 域，结果文字「1.2」")

    doc.save(OUT)


def _ins(text: str):
    e = el("w:ins", **{"w:id": "101", "w:author": AUTHOR, "w:date": WHEN})
    e.append(run_el(text))
    return e


def _del(text: str):
    e = el("w:del", **{"w:id": "102", "w:author": AUTHOR, "w:date": WHEN})
    e.append(run_el(text, delete=True))
    return e


# ───────────── read back and write the checklist ─────────────

def q(tag: str) -> str:
    prefix, name = tag.split(":")
    return f"{{{NS[prefix]}}}{name}"


def own_texts(p):
    """段落自己的 w:t：最近的那个 w:p 祖先就是它本身的，不含锚在它里面的文本框里的段落。"""
    for t in p.iter(q("w:t")):
        node = t.getparent()
        while node is not None and node.tag != q("w:p"):
            node = node.getparent()
        if node is p:
            yield t


def text_of(e) -> str:
    return "".join(t.text or "" for t in own_texts(e)).strip()


def deleted_of(e) -> str:
    return "".join(t.text or "" for t in e.iter(q("w:delText")))


def where_of(e, body) -> str:
    """段落或单元格所在的结构，从外到内：正文里第几张顶层表格、嵌套表、第几行第几格、文本框（wps 或 VML 后备）。"""
    chain = []
    node = e
    while node is not None and node is not body:
        chain.append(node)
        node = node.getparent()
    top = body.findall(q("w:tbl"))
    label = []
    for node in reversed(chain):
        if node.tag == q("w:tbl"):
            label.append(f"表 {top.index(node) + 1}" if node in top else "嵌套表")
        elif node.tag == q("w:tc"):
            tr = node.getparent()
            label.append(f"第 {tr.getparent().findall(q('w:tr')).index(tr) + 1} 行第 {tr.findall(q('w:tc')).index(node) + 1} 格")
        elif node.tag == q("wps:txbx"):
            label.append("文本框（wps）")
        elif node.tag == q("v:textbox"):
            label.append("文本框（VML 后备）")
    return "·".join(label) or "正文"


def cell_note(tc) -> str:
    tcpr = tc.find(q("w:tcPr"))
    notes = []
    if tcpr is not None:
        span = tcpr.find(q("w:gridSpan"))
        if span is not None:
            notes.append(f"横跨 {span.get(q('w:val'))} 列")
        vm = tcpr.find(q("w:vMerge"))
        if vm is not None:
            notes.append("纵向合并起点" if vm.get(q("w:val")) == "restart" else "纵向合并续格")
    return "，".join(notes)


def md_row(*cells) -> str:
    """表格的一行；单元格里的竖线要转义，否则会被当成分栏。"""
    return "| " + " | ".join(str(c).replace("|", "\\|") for c in cells) + " |"


def write_checklist() -> dict:
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
        doc = etree.fromstring(z.read("word/document.xml"))
        others = {n: etree.fromstring(z.read(n)) for n in names
                  if n.startswith("word/") and n.split("/")[-1].split(".")[0].rstrip("0123456789") in ("header", "footer", "footnotes", "endnotes", "comments")}
    body = doc.find(q("w:body"))
    rows = []
    for i, e in enumerate(body.iter(q("w:p"), q("w:tc")), start=1):
        kind = "w:tc" if e.tag == q("w:tc") else "w:p"
        first = text_of(e.find(q("w:p")) if kind == "w:tc" else e)
        extra = []
        if kind == "w:tc" and cell_note(e):
            extra.append(cell_note(e))
        if kind == "w:p":
            if e.find(f".//{q('wps:txbx')}") is not None:
                extra.append("这一段里锚着文本框，文本框里的段落紧跟在后面编号；对这一段取全部 w:t 会把文本框里的字（两份）也算进来")
            if e.find(f".//{q('wp:anchor')}/{q('a:graphic')}/{q('a:graphicData')}/{{http://schemas.openxmlformats.org/drawingml/2006/picture}}pic") is not None:
                extra.append("这一段里锚着浮动图片")
            if e.find(f".//{q('wp:inline')}") is not None:
                extra.append("行内图片")
            if e.find(f"{q('w:pPr')}/{q('w:sectPr')}") is not None:
                extra.append("本段带第一节的 w:sectPr")
            if deleted_of(e):
                extra.append(f"另有删除的字「{deleted_of(e)}」在 w:delText 里")
            if e.find(f".//{q('w:instrText')}") is not None:
                extra.append("含域：" + "".join(t.text for t in e.iter(q("w:instrText"))).strip())
        rows.append((i, kind, where_of(e, body), (first[:18] + ("…" if len(first) > 18 else "")) or "（空）", "；".join(extra)))

    pics = len(doc.findall(f".//{q('a:graphicData')}/{{http://schemas.openxmlformats.org/drawingml/2006/picture}}pic"))
    counts = {
        "document.xml 里全部 w:p": len(doc.findall(f".//{q('w:p')}")),
        "document.xml 里全部 w:tc": len(doc.findall(f".//{q('w:tc')}")),
        "正文顶层段落（body 的直接子 w:p）": len(body.findall(q("w:p"))),
        "正文顶层表格": len(body.findall(q("w:tbl"))),
        "全部表格（含嵌套）": len(doc.findall(f".//{q('w:tbl')}")),
        "图片（pic:pic）": pics,
        "其中行内图片（wp:inline）": len(doc.findall(f".//{q('wp:inline')}")),
        "节（w:sectPr）": len(doc.findall(f".//{q('w:sectPr')}")),
        "文本框里的段落（wps 一份）": len(doc.findall(f".//{q('wps:txbx')}//{q('w:p')}")),
        "文本框里的段落（VML 后备一份）": len(doc.findall(f".//{q('v:textbox')}//{q('w:p')}")),
    }

    out = ["# requirements-styled.docx 样式清单", "",
           "这份清单由 `build_styled_docx.py` 在生成 `requirements-styled.docx` 之后读回 `word/document.xml` 写出，与文件同步；不要手改，改了样本请重新运行脚本。",
           "样本是 `requirements.md` 的虚构扩写，内容与示例材料一致，并补了几处细节，用来覆盖 Word 的常见样式。", "",
           "## 一、样式清单（按文档顺序）", "",
           "「位置」写所在的章节；「开头」是那一处开头的几个字；「生成手段」写用的 python-docx 接口，或者直接写进去的 XML 元素。", "",
           "| 序 | 位置 | 开头 | 样式 | 生成手段 |", "|---|---|---|---|---|"]
    for n, (w, first, style, how) in enumerate(records, start=1):
        out.append(md_row(n, w, first, style, how))
    out += ["", "## 二、计数汇总", "", "| 项 | 数 |", "|---|---|"]
    out += [md_row(k, v) for k, v in counts.items()]
    out += ["", "## 三、document.xml 段落序号表", "",
            "按 `w:p` 与 `w:tc` 在 `word/document.xml` 里出现的先后（文档顺序，也就是 XML 前序遍历）统一编号：单元格 `w:tc` 先编号，里面的段落紧跟着编号；"
            "嵌套表格的单元格和段落夹在外层单元格的段落之间。「结构」一列里，「表 N」是正文里第 N 张顶层表格，行与格按 `w:tr` 与 `w:tc` 的实际个数数，"
            "被横向合并掉的列不占格，纵向合并的续格仍是一个 `w:tc`。",
            "", "| 序号 | 元素 | 结构 | 开头文字 | 说明 |", "|---|---|---|---|---|"]
    out += [md_row(*r) for r in rows]
    out += ["", "## 四、哪些段落不在 document.xml 主体里", "",
            "- **文本框里的段落在 document.xml 里，而且有两份。** 文本框锚在正文的一段里，照 Word 自己的存法写成 `mc:AlternateContent`："
            "`mc:Choice`（wps 文本框）里一份，`mc:Fallback`（VML 的 `v:textbox`）里再一份，内容相同。按 XML 数段落会把文本框的每一段数两次；"
            "Word 与大多数渲染器只显示其中一份。两边计数时要约定只数 `mc:Choice` 里的那份，或者都不数。",
            "- **浮动图片与浮动文本框本身不是段落**，它们是锚点所在那一段里的一个 `w:r`；那一段正文照常只算一段。",
            "- **脚注、尾注不在 document.xml 里**：正文里只有 `w:footnoteReference`、`w:endnoteReference` 两个引用，注释正文分别在 `word/footnotes.xml`、`word/endnotes.xml`；"
            "这两个部件还各有两段分隔符（id 为 -1 与 0）。",
            "- **页眉、页脚不在 document.xml 里**，分别在 `word/header1.xml`、`word/footer1.xml`；第二节沿用第一节的页眉页脚（链接到前一节），没有自己的部件。",
            "- **批注正文不在 document.xml 里**，在 `word/comments.xml`；正文里只有 `w:commentRangeStart`、`w:commentRangeEnd` 与 `w:commentReference`。",
            "- **修订标记**：插入的字（`w:ins` 里的 `w:t`）算在所在段落里；删除的字在 `w:delText` 里，不是 `w:t`，上面的表只取 `w:t`，删除的字另在「说明」列写出。",
            "- **第一节的 `w:sectPr` 挂在第一节最后一段的 `w:pPr` 里**，那一段仍是一个普通段落；第二节（也是最后一节）的 `w:sectPr` 是 `w:body` 的最后一个子元素，不在任何段落里。",
            "", "其他部件里的段落：", "", "| 部件 | 段落数 | 开头文字 |", "|---|---|---|"]
    for name, root in sorted(others.items()):
        ps = root.findall(f".//{q('w:p')}")
        out.append(md_row(f"`{name}`", len(ps), "；".join(text_of(p) or "（分隔符或空段）" for p in ps)))
    CHECKLIST.write_text("\n".join(out) + "\n", encoding="utf-8")
    return counts


if __name__ == "__main__":
    build()
    counts = write_checklist()
    print(f"wrote {OUT.name} and {CHECKLIST.name}")
    for k, v in counts.items():
        print(f"  {k}: {v}")
