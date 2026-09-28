/**
 * 位置表（lib/docx_locations.ts）与页面现有推导逐段比较用的小 Word 文件，内容是与任何材料无关的中性文字。
 * 文件存在 web/src/test/fixtures/ 下（前端比较测试在模拟浏览器里用排版库画它们），由 fixtures/build_location_docx.mts 按这里的定义写出；
 * docx_locations.test.ts 核对存着的文件与这里现造的逐字节相同，改了定义要重新生成。
 *
 * 现在只有与标题、编号有关的样例（页码部分暂缓）：
 * - loc-numbering.docx：标题带十进制、中文数字、罗马数字、项目符号几种自动编号；编号写在段落里或样式里；
 *   有 w:startOverride 与法律式编号（w:isLgl）。标题文字与投影的标题行相同，任何格式的编号都写。
 * - loc-style-no-level.docx：编号写在样式里、样式没写级别（w:ilvl）。投影按第 0 级数；页面现有的推导遇到它会出错，整份画不出来。
 * - loc-hidden.docx：排版库不画的段落（w:customXml 里的、单元格里内容控件中的），其中一段是标题；位置表照记这个标题，页面看不到它。
 * 同一目录还存着这两份、三份标题样例与主样例的位置表（locationTableFixtures），前端比较测试读它们。
 */

import { makeDocx } from "./helpers.ts";

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** 一个文字块：字、分页标记、分页符等按顺序写好的内部 XML。 */
const r = (inner: string) => `<w:r>${inner}</w:r>`;
const t = (text: string) => `<w:t xml:space="preserve">${text}</w:t>`;
/** 一段：pPr 的内容（可空）与段落的直接子节点。 */
const p = (ppr: string, ...children: string[]) => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${children.join("")}</w:p>`;
/** 只有一个文字块的普通段落。 */
const text = (s: string, ppr = "") => p(ppr, r(t(s)));
const style = (id: string) => `<w:pStyle w:val="${id}"/>`;
const num = (numId: number | null, ilvl: number | null) =>
  `<w:numPr>${ilvl !== null ? `<w:ilvl w:val="${ilvl}"/>` : ""}${numId !== null ? `<w:numId w:val="${numId}"/>` : ""}</w:numPr>`;
const cell = (...paras: string[]) => `<w:tc>${paras.join("")}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const table = (...rows: string[]) => `<w:tbl><w:tblPr/>${rows.join("")}</w:tbl>`;
/** 正文末尾的分节：A4 纸。 */
const SECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';

/** 样式表：每项是 [样式编号, 样式名, 上级样式编号, 段落属性（可空）]。 */
function styles(list: [string, string, string | null, string][]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:styles ${NS}>${list.map(([id, name, basedOn, ppr]) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ""}${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}</w:style>`).join("")}</w:styles>`;
}

const STYLES = styles([
  ["Normal", "Normal", null, ""],
  ["Heading1", "heading 1", "Normal", '<w:outlineLvl w:val="0"/>'],
  ["Heading2", "heading 2", "Normal", '<w:outlineLvl w:val="1"/>'],
]);

/** 一级编号：格式、级别文字、起始值，是否法律式编号（w:isLgl）。 */
type Lvl = [string, string, number, boolean?];
/** 编号定义：每项是 [numId, abstractNumId, 各级, 按级别覆盖的起始值（w:startOverride）]；同一个 abstractNum 可以被几套编号共用。 */
function numbering(abstracts: [number, Lvl[]][], nums: [number, number, Record<number, number>?][]): string {
  const a = abstracts.map(([id, levels]) => `<w:abstractNum w:abstractNumId="${id}">${levels.map(([fmt, lvlText, start, legal], i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/>${legal ? "<w:isLgl/>" : ""}<w:lvlText w:val="${lvlText}"/></w:lvl>`).join("")}</w:abstractNum>`).join("");
  const n = nums.map(([id, abstract, overrides]) => `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/>${Object.entries(overrides ?? {}).map(([il, v]) =>
    `<w:lvlOverride w:ilvl="${il}"><w:startOverride w:val="${v}"/></w:lvlOverride>`).join("")}</w:num>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${NS}>${a}${n}</w:numbering>`;
}

const app = (name: string) => `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${name}</Application></Properties>`;

/** Word 与 docx-preview 都能打开的部件：内容类型、关系、样式表，按需加编号与文件属性。 */
function docx(body: string, extra: { styles?: string; numbering?: string; application?: string } = {}): Buffer {
  const overrides = [
    ["/word/document.xml", "wordprocessingml.document.main+xml"],
    ["/word/styles.xml", "wordprocessingml.styles+xml"],
    ...(extra.numbering ? [["/word/numbering.xml", "wordprocessingml.numbering+xml"]] : []),
  ];
  const rels = [
    ["styles", "styles.xml"],
    ...(extra.numbering ? [["numbering", "numbering.xml"]] : []),
  ];
  const parts: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`).join("")
      + (extra.application ? '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' : "")
      + "</Types>",
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + (extra.application ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' : "")
      + "</Relationships>",
    "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + rels.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")
      + "</Relationships>",
    "word/styles.xml": extra.styles ?? STYLES,
  };
  if (extra.numbering) parts["word/numbering.xml"] = extra.numbering;
  if (extra.application) parts["docProps/app.xml"] = app(extra.application);
  return makeDocx(body, parts);
}

const H1 = style("Heading1");
const H2 = style("Heading2");

/** 文件名 → 字节。 */
export function locationFixtures(): Record<string, Buffer> {
  const numberingXml = numbering([
    [1, [["decimal", "%1", 1], ["decimal", "%1.%2", 1], ["decimal", "%1.%2.%3", 1]]],
    [2, [["chineseCounting", "第%1章", 1], ["decimal", "%1.%2", 1]]],
    [3, [["upperRoman", "%1.", 1]]],
    [4, [["bullet", "•", 1]]],
    [5, [["decimal", "%1", 3]]],
    [6, [["upperRoman", "%1", 1], ["decimal", "%1.%2", 1, true]]],
  ], [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 1, { 0: 7 }], [7, 6]]);
  const numberingStyles = styles([
    ["Normal", "Normal", null, ""],
    ["Heading1", "heading 1", "Normal", '<w:outlineLvl w:val="0"/>'],
    ["Heading2", "heading 2", "Normal", '<w:outlineLvl w:val="1"/>'],
    ["NumHeading1", "编号标题 1", "Heading1", num(1, 0)], // 编号写在样式里
    ["NumHeading2", "编号标题 2", "Heading2", num(1, 1)],
  ]);
  const field = (code: string, result: string) => r('<w:fldChar w:fldCharType="begin"/>') + r(`<w:instrText xml:space="preserve"> ${code} </w:instrText>`)
    + r('<w:fldChar w:fldCharType="separate"/>') + r(t(result)) + r('<w:fldChar w:fldCharType="end"/>');
  const numbered = docx([
    p(H1 + num(1, 0), r(t("总则"))), // 十进制：1 总则
    text("总则的正文。"),
    p(H2 + num(1, 1), r(t("适用范围"))), // 1.1 适用范围
    text("适用范围的正文。"),
    p(H1 + num(2, 0), r(t("中文编号的一章"))), // 中文数字：标题文字里不带编号
    p(H2 + num(2, 1), r(t("章下的一节"))), // 这一级的格式是十进制，引用了中文数字的上一级：一.1
    text("章下一节的正文。"),
    p(H1 + num(3, 0), r(t("罗马数字的一章"))), // 罗马数字：不带编号
    p(H2 + num(4, 0), r(t("带项目符号的标题"))), // 项目符号：不带
    p(style("NumHeading1"), r(t("编号来自样式的一章"))), // 编号写在样式里：接着第 1 套数下去，2
    p(style("NumHeading2"), r(t("编号来自样式的一节"))), // 2.1
    text("编号来自样式的正文。"),
    p(H2 + num(5, 0), r(t("起始值是三的标题"))), // 3
    p(H2 + num(0, 0), r(t("编号写成零的标题"))), // numId 为 0：没有编号
    p(H1 + num(6, 0), r(t("起始值被覆盖成七的一章"))), // w:startOverride：7
    p(H1 + num(7, 0), r(t("罗马数字的一章，下一级是法律式编号"))), // 罗马数字：不带
    p(H2 + num(7, 1), r(t("法律式编号的一节"))), // w:isLgl：上一级也写十进制，1.1
    p(H1, r(t("带")), `<w:hyperlink w:anchor="top">${r(t("超链接"))}</w:hyperlink>`, r(t("的标题"))), // 超链接里的字算进标题文字
    p(H1, r(t("带域结果的标题，第")), field("PAGE", "3"), r(t("页"))), // 域结果照常，域代码不算
    p(H1, r(t("带补充平面字符𠀋的标题"))),
    text("最后一段。"),
    SECT,
  ].join(""), { styles: numberingStyles, numbering: numberingXml, application: "Microsoft Office Word" });

  const styleNoLevel = docx([
    p(style("NumNoLevel"), r(t("样式里没写级别的标题"))), // 投影按第 0 级数：1
    text("正文。"),
    SECT,
  ].join(""), {
    styles: styles([["Normal", "Normal", null, ""], ["NumNoLevel", "heading 2", "Normal", num(1, null)]]),
    numbering: numbering([[1, [["decimal", "%1", 1]]]], [[1, 1]]),
    application: "Microsoft Office Word",
  });

  const hidden = docx([
    text("1 总则", H1),
    text("总则的正文。"),
    `<w:customXml w:element="note">${text("2 包在自定义标记里的一章", H1)}${text("包在自定义标记里的正文。")}</w:customXml>`, // 排版库不画这两段
    text("自定义标记之后的正文。"),
    table(row(cell(text("单元格里的字")), cell(`<w:sdt><w:sdtContent>${text("单元格里内容控件中的字")}</w:sdtContent></w:sdt>`, text("同一格里内容控件之后的字")))),
    `<w:sdt><w:sdtContent>${text("3 正文里内容控件中的一章", H1)}</w:sdtContent></w:sdt>`, // 正文里的内容控件照常画
    text("最后一段。"),
    SECT,
  ].join(""), { application: "Microsoft Office Word" });

  return { "loc-numbering.docx": numbered, "loc-style-no-level.docx": styleNoLevel, "loc-hidden.docx": hidden };
}

/** 前端比较测试要读的位置表：文件名 → 内容（与后端上传时写的一样，末尾带换行）。读文件与算位置表的函数由调用方给，这里不依赖它们。 */
export function locationTableFixtures(
  read: (path: string) => Buffer,
  table: (data: Buffer, rel: string) => unknown,
): Record<string, string> {
  const dir = new URL("../../web/src/test/fixtures/", import.meta.url).pathname;
  const sources: Record<string, Buffer> = {
    "requirements-styled.docx": read(new URL("../../examples/library-lending/requirements-styled.docx", import.meta.url).pathname),
    "headings-by-name.docx": read(dir + "headings-by-name.docx"),
    "headings-inherited.docx": read(dir + "headings-inherited.docx"),
    "headings-body-level.docx": read(dir + "headings-body-level.docx"),
    ...locationFixtures(),
  };
  return Object.fromEntries(Object.entries(sources).map(([name, bytes]) =>
    [`${name}.locations.json`, JSON.stringify(table(bytes, `inputs/${name}`), null, 2) + "\n"]));
}
