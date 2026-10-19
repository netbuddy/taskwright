// 「文档原文」来源的摘录在出处那一份材料里找不到时，到材料目录第一层的其余材料里逐字找：在另一份 Word 材料、另一份 PDF 材料里
// 找到时，拒绝文字说出在哪一份的哪一处并给出改写后的出处；哪里都没有时，才是「逐字一致、不要改写」那一句。

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, callIn, count, makeWorkspace } from "./helpers.ts";

/** Word 材料的 Markdown 投影：每段一行，行首是段落号。 */
const docxProjection = (name: string, paragraphs: string[]) => [
  "<!--",
  `由 ${name} 生成，供助手阅读。段落总数：${paragraphs.length}。`,
  "-->",
  "",
  ...paragraphs.flatMap((text, i) => [`[p${i + 1}] ${text}`, ""]),
].join("\n");

const PDF_PROJECTION = [
  "<!--",
  "由 办法.pdf 生成，供助手阅读。页数：2。块总数：3。",
  "-->",
  "",
  "[p1-1] 第一条 买家申请退款的，",
  "",
  "[p2-1] 第二条 退款金额按原路退回。",
  "",
  "[p2-2] 第三条 运费由卖家承担。",
  "",
].join("\n");

/** 材料目录里有两份 Word 材料与一份 PDF 材料；Word 与 PDF 本身只是占位，核对读的是投影。 */
function workspace(): string {
  const dir = makeWorkspace(undefined, { material: false });
  mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(join(dir, "inputs/初稿.docx"), "占位");
  writeFileSync(join(dir, "inputs/初稿.docx.md"), docxProjection("初稿.docx", ["一、背景", "平台提供退款功能。"]), "utf-8");
  writeFileSync(join(dir, "inputs/申请书.docx"), "占位");
  writeFileSync(join(dir, "inputs/申请书.docx.md"), docxProjection("申请书.docx", ["一、立项理由", "退款须在三个工作日内到账。"]), "utf-8");
  writeFileSync(join(dir, "inputs/办法.pdf"), "%PDF-1.4 占位");
  writeFileSync(join(dir, "inputs/办法.pdf.md"), PDF_PROJECTION, "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

const refused = (dir: string, locator: string, excerpt: string): string => {
  try {
    saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "不该存上", 步骤: ["照办"] }, sources: [{ kind: "文档原文", locator, excerpt }] }] });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("没有被拒绝");
};

/** 整段拒绝文字：开头一句、说这一条操作的一行、怎么办一行、结尾一句。 */
const whole = (fact: string, guide: string) =>
  `这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n- 操作 1（新增，集合「用例」）：新增到「用例」的条目：${fact}\n  怎么办：${guide}\n请把这些地方改正之后，把整批操作重新提交一次。`;

test("摘录在另一份 Word 材料里：说出在哪一份第几段，指引写改写后的出处", () => {
  const dir = workspace();
  const before = count(dir, "revision");
  assert.equal(refused(dir, "inputs/初稿.docx#p2", "退款须在三个工作日内到账。"), whole(
    "第 1 条来源的摘录「退款须在三个工作日内到账。」在 初稿.docx 第 2 段里找不到；这段文字在《申请书.docx》第 2 段。",
    "出处改写成 inputs/申请书.docx#p2。"));
  assert.equal(count(dir, "revision"), before);
});

test("摘录在另一份 PDF 材料里：说出在哪一份第几页第几块，指引写改写后的出处", () => {
  const dir = workspace();
  assert.equal(refused(dir, "inputs/初稿.docx#p2", "运费由卖家承担"), whole(
    "第 1 条来源的摘录「运费由卖家承担」在 初稿.docx 第 2 段里找不到；这段文字在《办法.pdf》第 2 页第 2 块。",
    "出处改写成 inputs/办法.pdf#p2-2。"));
});

test("摘录哪一份材料里都没有：仍是逐字一致、不要改写的那一句", () => {
  const dir = workspace();
  assert.equal(refused(dir, "inputs/办法.pdf#p1-1", "退款须在五个工作日内到账"), whole(
    "第 1 条来源的摘录「退款须在五个工作日内到账」在 办法.pdf 第 1 页第 1 块里找不到。",
    "摘录必须与材料原文逐字一致，包括标点；不要自行补标点或改写；摘录必须逐字抄自那一块的文字（不带行首方括号里的页与块），不要跳句拼接或改字；引了材料几处就写几条来源，每条各写页与块。"));
});

test("文本材料里找不到、在好几份材料里都有：列出各处，指引写第一处并请按上下文确认", () => {
  const dir = workspace();
  writeFileSync(join(dir, "inputs/纪要.md"), "会上说：退款须在三个工作日内到账。\n", "utf-8");
  writeFileSync(join(dir, "inputs/补充.md"), "补充说明。\n", "utf-8");
  assert.equal(refused(dir, "inputs/补充.md", "退款须在三个工作日内到账"), whole(
    "第 1 条来源的摘录「退款须在三个工作日内到账」在 补充.md 里找不到；这段文字在《申请书.docx》第 2 段、《纪要.md》。",
    "出处改写成 inputs/申请书.docx#p2；这段文字有好几处，请按上下文确认是其中哪一处，出处写那一处。"));
});
