// 公式里缺属性的括号（m:d 没有 m:dPr）、横线（m:bar 没有 m:barPr）、分组字符（m:groupChr 没有 m:groupChrPr）：
// docx-preview 画它们时直接读属性对象，属性对象不存在时整份文件画不出来。model/docx.ts 的 fillMathProps 在交给排版库之前补上空的属性对象。
// 模拟浏览器画不了任何公式（缺少数学标记元素的样式对象），所以这里只断言解析树；画得出来在真实浏览器里验证。
// 样例在现有的标题样例上换掉正文现造，内容是中性文字。

import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseAsync } from "docx-preview";
import { RENDER_OPTIONS, fillMathProps, prepare } from "../model/docx";
import BY_NAME from "./fixtures/headings-by-name.docx?inline";
import SAMPLE from "../../../examples/library-lending/requirements-styled.docx?inline";

/* eslint-disable @typescript-eslint/no-explicit-any */
const bytesOf = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const base = (s: string) => `<m:e><m:r><m:t>${s}</m:t></m:r></m:e>`;
const para = (math: string) => `<w:p><w:r><w:t>公式：</w:t></w:r><m:oMath ${M}>${math}</m:oMath></w:p>`;

/** 把标题样例的正文换成 body，交给排版库解析。 */
async function parsed(body: string): Promise<any> {
  const zip = await JSZip.loadAsync(bytesOf(BY_NAME));
  const xml = await zip.file("word/document.xml")!.async("string");
  zip.file("word/document.xml", xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`));
  return parseAsync(await zip.generateAsync({ type: "uint8array" }), RENDER_OPTIONS);
}

/** 解析树里某种元素，按出现的先后。 */
const all = (e: any, type: string, out: any[] = []): any[] => {
  if (e.type === type) out.push(e);
  for (const c of e.children ?? []) all(c, type, out);
  return out;
};

/** 解析树写成文字（去掉指回上级的 parent，免得绕圈），比较补之前补之后用。 */
const snapshot = (d: any) => JSON.stringify(d.documentPart.body, (k, v) => (k === "parent" ? undefined : v));

describe("公式里缺属性的括号、横线、分组字符", () => {
  it("没写属性的补上空的属性对象；写了属性的不动；表格里的也补", async () => {
    const d = await parsed([
      para(`<m:d>${base("x+1")}</m:d>`),
      para(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr>${base("y")}</m:d>`),
      para(`<m:bar>${base("z")}</m:bar><m:bar><m:barPr><m:pos m:val="top"/></m:barPr>${base("z")}</m:bar>`),
      para(`<m:groupChr>${base("w")}</m:groupChr><m:groupChr><m:groupChrPr><m:chr m:val="⏟"/></m:groupChrPr>${base("w")}</m:groupChr>`),
      `<w:tbl><w:tr><w:tc>${para(`<m:d>${base("t")}</m:d>`)}</w:tc></w:tr></w:tbl>`,
    ].join(""));
    const body = d.documentPart.body;
    const before = all(body, "mmlDelimiter").map((e) => e.props);
    // 排版库解析出的样子：没写属性时没有属性对象
    expect(before).toEqual([undefined, { beginChar: "[", endChar: "]" }, undefined]);
    const kept = all(body, "mmlDelimiter")[1].props;
    prepare(d);
    expect(all(body, "mmlDelimiter").map((e) => e.props)).toEqual([{}, { beginChar: "[", endChar: "]" }, {}]);
    expect(all(body, "mmlDelimiter")[1].props).toBe(kept);
    expect(all(body, "mmlBar").map((e) => e.props)).toEqual([{}, { position: "top" }]);
    expect(all(body, "mmlGroupChar").map((e) => e.props)).toEqual([{}, { char: "⏟" }]);
  });

  it("页眉页脚与脚注尾注里的公式也补", () => {
    const d: any = {
      documentPart: { body: { type: "document", children: [] } },
      parts: [
        { rootElement: { type: "header", children: [{ type: "paragraph", children: [{ type: "mmlMath", children: [{ type: "mmlDelimiter", children: [] }] }] }] } },
        { notes: [{ type: "footnote", children: [{ type: "paragraph", children: [{ type: "mmlBar", children: [] }] }] }] },
      ],
    };
    fillMathProps(d);
    expect(all(d.parts[0].rootElement, "mmlDelimiter")[0].props).toEqual({});
    expect(all(d.parts[1].notes[0], "mmlBar")[0].props).toEqual({});
  });

  it("没有公式的文件，补属性这一步不改动解析树（主样例）", async () => {
    const d: any = await parseAsync(bytesOf(SAMPLE), RENDER_OPTIONS);
    const before = snapshot(d);
    fillMathProps(d);
    expect(snapshot(d)).toBe(before);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
