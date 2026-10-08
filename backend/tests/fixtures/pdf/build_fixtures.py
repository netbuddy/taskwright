#!/usr/bin/env python3
"""生成 PDF 材料投影的测试样本（backend/tests/pdf_projection.test.ts 用），写在本文件所在的目录里。

样本是提交进仓库的，测试直接读它们；只有要改样本时才需要运行本脚本。运行要另备的东西（都不是本仓库的依赖）：

  - Python 3.12 与三个包：reportlab 5.0.1、pikepdf 10.16.0、pillow 12.3.0
    （例如 uv venv /tmp/pdf-fixtures && uv pip install --python /tmp/pdf-fixtures/bin/python reportlab==5.0.1 pikepdf==10.16.0 pillow==12.3.0）
  - 字体 Droid Sans Fallback（DroidSansFallbackFull.ttf，许可证 Apache License 2.0；Debian 与 Ubuntu 的 fonts-droid-fallback 包）。
    quirks.pdf 里嵌入了它的一个子集（用到的三十几个字）。字体不在缺省路径时用 --font 指出。
  - 可选：LibreOffice（命令 soffice）。带 --word 时把 web/src/test/fixtures/loc-numbering.docx 转成 from-word.pdf；
    转出的文件里嵌着本机字体的子集，换一台机器结果不会逐字节相同，所以不带 --word 时不动这一份。

用法：python3 build_fixtures.py [--font <ttf 文件>] [--word]

各样本的用意（文字内容同时写进 expected.json，测试对着它核对）：
  multipage.pdf   三页中文，不嵌入字体（要靠字符映射表才读得出字）；每页有页眉页脚；段落首行缩进；带两级书签目录。
  two-column.pdf  一页两栏（栏很窄，两栏挨得近），一个段落从左栏底排到右栏顶。
  table.pdf       一张三列的表格，前后各一段。
  scanned.pdf     三页：第 1 页有正文，第 2 页只有页眉与一张图，第 3 页只有一张图。
  quirks.pdf      文字层里的两种毛病：常用汉字写成部首字符（文件里「字形到 Unicode」的对照表被改写过）；字与字之间被撑开。
  english.pdf     英文，左对齐不排满；有一处行末断词的连字符；用标准字体（不嵌入）。
  locked.pdf      设了打开口令。
  from-word.pdf   由 Word 文件经 LibreOffice 转出（嵌入字体的子集）。
"""

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pikepdf
from PIL import Image, ImageDraw
from reportlab.lib import pdfencrypt
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
A4 = (595.276, 841.89)
SONG = "STSong-Light"   # 不嵌入：文件里只写字体名与预定义的字符映射表 UniGB-UCS2-H
SIZE = 12
LEAD = 20
LEFT = 72


def new_canvas(name, **kw):
    # invariant=1：创建时间与文件标识固定，同样的输入生成的文件逐字节相同。
    return canvas.Canvas(str(HERE / name), pagesize=A4, invariant=1, **kw)


def paragraph(c, text, y, left=LEFT, per_line=36, indent=2):
    """从 y 起画一个首行缩进的段落（全是全角字，每个字 12 点宽），返回下一行的 y。"""
    first = per_line - indent
    lines = [text[:first]] + [text[i:i + per_line] for i in range(first, len(text), per_line)]
    assert len(lines) < 2 or len(lines[-1]) <= per_line - 3, f"段落的最后一行要比满行短三个字以上：{text[:10]}"
    for k, line in enumerate(lines):
        c.drawString(left + (indent * SIZE if k == 0 else 0), y, line)
        y -= LEAD
    return y


def running(c, page):
    c.setFont(SONG, 10)
    c.drawString(LEFT, 806, HEADER)
    c.drawString(280, 40, f"第 {page} 页")
    c.setFont(SONG, SIZE)


HEADER = "借阅管理办法（样本）"
MULTIPAGE = [
    # 每页：书签（级别从 1 起）、标题、几个段落
    {"bookmarks": [(1, "第一章 总则")], "heading": "第一章 总则", "paragraphs": [
        "为了规范图书的借阅与归还，保护读者的权益，根据学校的有关规定，结合图书馆的实际情况，制定本办法。本办法适用于在校的学生、教职工以及经过登记的校外读者。",
        "读者凭借书证借书。借书证只限本人使用，不得转借他人；借书证遗失的，应当及时到服务台办理挂失，挂失之前造成的损失由读者本人承担。",
    ]},
    {"bookmarks": [(1, "第二章 借阅"), (2, "第一节 期限")], "heading": "第二章 借阅", "paragraphs": [
        "每位读者一次最多借五本，借期三十天。借期届满之前，读者可以在自助借还机上续借一次，续借的期限为十五天；已经被他人预约的图书不能续借。",
        "寒假与暑假期间到期的图书，归还的日期顺延到开学后的第七天。图书馆在到期前三天给读者发一次提醒，提醒不影响到期的日期。",
        "工具书、期刊的合订本以及标明仅供阅览的图书只能在馆内阅览，不外借。",
    ]},
    {"bookmarks": [(1, "第三章 归还")], "heading": "第三章 归还", "paragraphs": [
        "读者应当在到期之前归还图书。逾期归还的，每本每天收取罚款一角，罚款累计不超过这本图书的定价；罚款结清之前不能再借书。",
        "图书损坏或者丢失的，读者应当按照图书馆的规定赔偿。",
    ]},
]


def multipage():
    c = new_canvas("multipage.pdf")
    c.setFont(SONG, SIZE)
    for n, page in enumerate(MULTIPAGE, 1):
        running(c, n)
        for k, (level, title) in enumerate(page["bookmarks"]):
            key = f"b{n}-{k}"
            c.bookmarkPage(key)
            c.addOutlineEntry(title, key, level=level - 1)
        c.setFont(SONG, 16)
        c.drawString(LEFT, 740, page["heading"])
        c.setFont(SONG, SIZE)
        y = 700
        for text in page["paragraphs"]:
            y = paragraph(c, text, y)
        c.showPage()
    c.save()
    return {"header": HEADER, "pages": [{"heading": p["heading"], "paragraphs": p["paragraphs"], "bookmarks": p["bookmarks"]} for p in MULTIPAGE]}


TWO_COLUMN = {
    "title": "自助借还机使用说明",
    "a": "读者把借书证放在感应区，屏幕上显示读者的姓名与借出的图书。核对无误之后，选择借书或者还书。",
    # 这一段从左栏底排到右栏顶：b1 在左栏，b2 在右栏
    "b1": "借书时把图书逐本放到感应台上，屏幕上列出每本书的书名与应还的日期。读者确认之",
    "b2": "后，机器打印一张借书凭条，借书完成。",
    "c": "还书时把图书逐本放进还书口，屏幕上显示归还成功。有逾期罚款的，机器提示读者到服务台结清。",
}


def two_column():
    c = new_canvas("two-column.pdf")
    c.setFont(SONG, 16)
    c.drawCentredString(A4[0] / 2, 760, TWO_COLUMN["title"])
    c.setFont(SONG, SIZE)
    # 每栏 10 个字、120 点宽，两栏的左边只隔 132 点：比「横向跳开很远」的界限（12 个字宽）近，
    # 所以左栏底与右栏顶只能靠「往上跳」这一条分开。
    per = 10
    y = paragraph(c, TWO_COLUMN["a"], 700, left=LEFT, per_line=per)
    b1 = TWO_COLUMN["b1"]
    assert (len(b1) + 2) % per == 0, "左栏里的这一截要正好排满最后一行"
    first = per - 2
    lines = [b1[:first]] + [b1[i:i + per] for i in range(first, len(b1), per)]
    for k, line in enumerate(lines):
        c.drawString(LEFT + (2 * SIZE if k == 0 else 0), y, line)
        y -= LEAD
    right = LEFT + 132
    y = 700
    b2 = TWO_COLUMN["b2"]
    for line in [b2[i:i + per] for i in range(0, len(b2), per)]:   # 右栏顶上接着排，不缩进
        c.drawString(right, y, line)
        y -= LEAD
    paragraph(c, TWO_COLUMN["c"], y, left=right, per_line=per)
    c.showPage()
    c.save()
    return TWO_COLUMN


TABLE = {
    "before": "各类读者的借阅上限见下表。表中的借期从借出的当天起算，遇到法定节假日不顺延。",
    "rows": [["读者类型", "一次最多", "借期", "续借次数"], ["学生", "五本", "三十天", "一次"], ["教职工", "十本", "六十天", "两次"], ["校外读者", "两本", "十五天", "不能续借"]],
    "after": "校外读者办理借书证时需要交纳押金，退证时全额退还。",
}


def table():
    c = new_canvas("table.pdf")
    c.setFont(SONG, SIZE)
    y = paragraph(c, TABLE["before"], 740) - LEAD
    for row in TABLE["rows"]:
        for x, cell in zip((LEFT, 200, 320, 430), row):
            c.drawString(x, y, cell)
        y -= LEAD
    paragraph(c, TABLE["after"], y - LEAD)
    c.showPage()
    c.save()
    return TABLE


SCANNED = {"header": "读者意见登记表（扫描件样本）", "text": "下面两页是手写登记表的扫描件，没有可以读出的文字。"}


def picture():
    """一张不含任何文字信息的小图（几条灰色的横线），当作扫描出来的页面。"""
    img = Image.new("L", (240, 320), 245)
    draw = ImageDraw.Draw(img)
    for k in range(8):
        draw.line((20, 40 + k * 34, 220, 40 + k * 34), fill=120, width=2)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)
    return ImageReader(buf)


def scanned():
    c = new_canvas("scanned.pdf")
    c.setFont(SONG, 10)
    c.drawString(LEFT, 806, SCANNED["header"])
    c.setFont(SONG, SIZE)
    paragraph(c, SCANNED["text"], 740)
    c.showPage()
    c.setFont(SONG, 10)
    c.drawString(LEFT, 806, SCANNED["header"])      # 第 2 页：页眉加一张图
    c.drawImage(picture(), 100, 150, width=400, height=533)
    c.showPage()
    c.drawImage(picture(), 100, 150, width=400, height=533)   # 第 3 页：只有一张图
    c.showPage()
    c.save()
    return SCANNED


QUIRKS = {
    # 文件里这一行的「工、日、金、风」四个字被对照表写成部首字符 U+2F2F、U+2F47、U+2FA6、U+2EDB
    "radicals": "平台应当在两个工作日内答复，退款金额按原路退回，风险由平台承担。",
    "radical_code_points": {"工": 0x2F2F, "日": 0x2F47, "金": 0x2FA6, "风": 0x2EDB},
    # 这一行每个字单独画、字距撑开，读出来字与字之间带空格
    "spaced": "汇率按申请当天的中间价计算",
}


def quirks(font_path):
    pdfmetrics.registerFont(TTFont("Fallback", font_path))
    plain = HERE / "quirks.plain.pdf"
    c = canvas.Canvas(str(plain), pagesize=A4, invariant=1)
    c.setFont("Fallback", SIZE)
    c.drawString(LEFT, 740, QUIRKS["radicals"])
    for k, ch in enumerate(QUIRKS["spaced"]):
        c.drawString(LEFT + k * 17, 700, ch)        # 字宽 12、步距 17：每两个字之间空 5 点
    c.showPage()
    c.save()
    # 把「字形到 Unicode」的对照表（ToUnicode）里这四个字的编码换成部首字符的编码：字形没变，读出来的编码变了。
    pdf = pikepdf.open(plain)
    changed = 0
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Stream):
            continue
        text = obj.read_bytes().decode("latin-1")
        if "beginbfchar" not in text:
            continue
        for ch, radical in QUIRKS["radical_code_points"].items():
            text, k = re.subn("<%04X>" % ord(ch), "<%04X>" % radical, text, flags=re.I)
            changed += k
        obj.write(text.encode("latin-1"))
    assert changed == len(QUIRKS["radical_code_points"]), f"对照表里应当正好改 4 处，改了 {changed} 处"
    pdf.save(HERE / "quirks.pdf", static_id=True)
    pdf.close()
    plain.unlink()
    return QUIRKS


ENGLISH = {
    "first": "The assistant checks every item against the rules before asking for confirmation. Results are recorded, and a rejected wording can be kept when the reader gives a reason.",
    "second": "Sources are verified word for word.",
    "third": "A source names the page and the block it was taken from, so that the reader can open the material at that place.",
    "hyphenated": ("confirmation", "confir-", "mation"),
}


def wrap(words, width, font="Helvetica", size=SIZE):
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if cur and pdfmetrics.stringWidth(trial, font, size) > width:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    return lines + [cur]


def english():
    whole, head, tail = ENGLISH["hyphenated"]
    words = ENGLISH["first"].replace(whole, f"{head}\x00{tail}").split(" ")
    # 找一个行宽，让断开的那个词的前半截正好落在行末（后半截排到下一行），别的行照常折行。
    for width in range(250, 420):
        tokens = [t for w in words for t in w.split("\x00")]
        lines = wrap(tokens, width)
        if any(line.endswith(head) for line in lines[:-1]) and pdfmetrics.stringWidth(lines[-1], "Helvetica", SIZE) < width - 80:
            break
    else:
        raise SystemExit("没有找到合适的行宽")
    c = new_canvas("english.pdf")
    c.setFont("Helvetica", SIZE)
    y = 740
    for line in lines + [ENGLISH["second"]] + wrap(ENGLISH["third"].split(" "), width):   # 三段之间不空行，行距相同
        c.drawString(LEFT, y, line)
        y -= 16
    c.showPage()
    c.save()
    return {**ENGLISH, "first_lines": lines}


def locked():
    c = new_canvas("locked.pdf", encrypt=pdfencrypt.StandardEncryption("open-sesame", canPrint=0))
    c.setFont("Helvetica", SIZE)
    c.drawString(LEFT, 740, "This file needs a password.")
    c.showPage()
    c.save()


def from_word():
    soffice = shutil.which("soffice")
    if not soffice:
        raise SystemExit("--word 要用 LibreOffice（命令 soffice），本机没有找到")
    source = HERE.parents[3] / "web" / "src" / "test" / "fixtures" / "loc-numbering.docx"
    with tempfile.TemporaryDirectory() as tmp:
        # 用临时的配置目录，不碰使用者自己的 LibreOffice 配置。
        subprocess.run([soffice, "--headless", f"-env:UserInstallation=file://{tmp}/profile", "--convert-to", "pdf", "--outdir", tmp, str(source)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        shutil.copyfile(Path(tmp) / "loc-numbering.pdf", HERE / "from-word.pdf")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--font", default="/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", help="Droid Sans Fallback 的 ttf 文件")
    parser.add_argument("--word", action="store_true", help="同时用 LibreOffice 重新生成 from-word.pdf")
    args = parser.parse_args()
    if not Path(args.font).is_file():
        raise SystemExit(f"找不到字体文件 {args.font}；用 --font 指出 DroidSansFallbackFull.ttf 的位置")
    pdfmetrics.registerFont(UnicodeCIDFont(SONG))
    expected = {"multipage": multipage(), "two_column": two_column(), "table": table(), "scanned": scanned(), "quirks": quirks(args.font), "english": english()}
    locked()
    if args.word:
        from_word()
    (HERE / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for f in sorted(HERE.glob("*.pdf")):
        print(f"{f.name}: {f.stat().st_size} 字节")


if __name__ == "__main__":
    sys.exit(main())
