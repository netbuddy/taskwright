/**
 * 标题级别识别（lib/docx_heading.ts）用的三份小 Word 文件，内容是与任何材料无关的中性文字。
 * 文件存在 web/src/test/fixtures/ 下（前端测试也用），由 fixtures/build_heading_docx.mts 按这里的定义写出；
 * docx_heading.test.ts 核对存着的文件与这里现造的逐字节相同，改了定义要重新生成。
 * - headings-by-name.docx：一级、二级标题只靠样式名（英文「heading 1」、中文「标题2」），样式里没有大纲级别；
 *   三级标题的样式在样式表里没有定义，只能靠样式编号「Heading3」；名为「Heading」「Table Heading」「Title」的样式不是标题。
 * - headings-inherited.docx：大纲级别写在被继承的上级样式里（隔一层、隔两层）；上级样式的大纲级别先于样式名；
 *   段落自身的大纲级别先于样式。（样式继承绕成环的情况 LibreOffice 打不开，只在 docx_heading.test.ts 里对函数直接测。）
 * - headings-body-level.docx：用了标题样式、但段落自身大纲级别写成 9 的段落不是标题；样式里写成 9 的也不是。
 */

import { makeDocx } from "./helpers.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** 样式表：每项是 [样式编号, 样式名, 上级样式编号, 大纲级别]，不写的项给 null。 */
function styles(list: [string, string | null, string | null, number | null][]): string {
  const one = ([id, name, basedOn, outline]: (typeof list)[number]) =>
    `<w:style w:type="paragraph" w:styleId="${id}">${name ? `<w:name w:val="${name}"/>` : ""}${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ""}`
    + `${outline !== null ? `<w:pPr><w:outlineLvl w:val="${outline}"/></w:pPr>` : ""}</w:style>`;
  return `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${list.map(one).join("")}</w:styles>`;
}

/** 一段：样式编号（null 为不写）、正文、段落自身的大纲级别（null 为不写）。 */
export const para = (style: string | null, text: string, outline: number | null = null) => {
  const ppr = [style ? `<w:pStyle w:val="${style}"/>` : "", outline !== null ? `<w:outlineLvl w:val="${outline}"/>` : ""].join("");
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;
};

const cell = (style: string, text: string) => `<w:tc>${para(style, text)}</w:tc>`;

/** Word 与 docx-preview 都能打开的最小部件：内容类型、两份关系、样式表。 */
function docx(body: string, styleXml: string): Buffer {
  return makeDocx(body, {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "word/styles.xml": styleXml,
  });
}

/** 文件名 → 字节。 */
export function headingFixtures(): Record<string, Buffer> {
  const byName = docx([
    para("Title", "园区植物养护说明"), // p1 名为 Title，不是标题
    para("Heading1", "1 概述"), // p2 一级：样式名 heading 1
    para("Normal", "本说明介绍园区内常见植物的日常养护。"),
    para("Normal", "养护工作由园区服务组负责。"),
    para("a3", "1.1 适用范围"), // p5 二级：样式名「标题2」
    para("Normal", "适用于园区内的草坪、灌木与乔木。"),
    para("Heading3", "1.1.1 例外"), // p7 三级：样式表里没有 Heading3，靠样式编号
    para("Normal", "临时摆放的盆栽不在此列。"),
    para("Heading1", "2 日常养护"), // p9 一级
    para("HeadingBase", "按季节安排养护内容"), // p10 名为 Heading（不带数字），不是标题
    para("Normal", "下表列出主要工作与频次。"),
    `<w:tbl><w:tr>${cell("TableHeading", "工作")}${cell("TableHeading", "频次")}</w:tr><w:tr>${cell("Normal", "浇水")}${cell("Normal", "每周两次")}</w:tr></w:tbl>`, // p12 到 p15
    para("Normal", "雨季适当减少浇水。"), // p16
  ].join(""), styles([
    ["Normal", "Normal", null, null],
    ["Title", "Title", "Normal", null],
    ["HeadingBase", "Heading", "Normal", null],
    ["Heading1", "heading 1", "HeadingBase", null],
    ["a3", "标题2", "HeadingBase", null],
    ["TableHeading", "Table Heading", "Normal", null],
  ]));

  const inherited = docx([
    para("Chapter", "1 总体安排"), // p1 一级：Chapter 没写，上级 ChapterBase 写了 0
    para("Normal", "全年的养护工作分四个季度安排。"),
    para("Section", "1.1 春季"), // p3 二级：隔两层（Section → SectionMid → SectionBase 写了 1）
    para("Normal", "春季以修剪与施肥为主。"),
    para("Heading3Custom", "1.2 夏季"), // p5 二级：样式名是 heading 3，但上级样式写了 1，大纲级别优先
    para("Normal", "夏季以浇水与防虫为主。"),
    para("Chapter", "1.2.1 防暑", 2), // p7 三级：段落自身写了 2，先于样式
    para("Normal", "高温时段不安排户外作业。"),
    para("Normal", "以上安排可按天气调整。"),
  ].join(""), styles([
    ["Normal", "Normal", null, null],
    ["ChapterBase", "章基础", "Normal", 0],
    ["Chapter", "章", "ChapterBase", null],
    ["SectionBase", "节基础", "Normal", 1],
    ["SectionMid", "节中间", "SectionBase", null],
    ["Section", "节", "SectionMid", null],
    ["Heading3Custom", "heading 3", "SectionBase", null],
  ]));

  const bodyLevel = docx([
    para("Heading1", "1 总则"), // p1 一级
    para("Normal", "本节说明一般要求。"),
    para("Heading1", "这一段取消了标题", 9), // p3 自身写了 9：不是标题
    para("Normal", "取消标题的段落按正文处理。"),
    para("BodyHeading", "样式写成正文级别的段落"), // p5 样式名 heading 2，样式里写了 9：不是标题
    para("Normal", "这一段也按正文处理。"),
    para("Heading1", "2 附则"), // p7 一级
    para("Normal", "本说明自发布之日起执行。"),
  ].join(""), styles([
    ["Normal", "Normal", null, null],
    ["Heading1", "heading 1", "Normal", 0],
    ["BodyHeading", "heading 2", "Normal", 9],
  ]));

  return { "headings-by-name.docx": byName, "headings-inherited.docx": inherited, "headings-body-level.docx": bodyLevel };
}
