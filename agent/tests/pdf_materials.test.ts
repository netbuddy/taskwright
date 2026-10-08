// PDF 材料在助手一侧：来源核对（出处写页与块、规范化之后逐字比、同一页里往后接块、不跨页）、任务现状消息与查询任务状态里的
// 页数、块数、没有文字的页与按块统计的未引用、知识库出处的拆法。

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { parseKnowledgeLocator } from "../src/lib/knowledge_locator.ts";
import { assemble } from "../src/lib/knowledge_search.ts";
import { buildPdfSegments, writePdfSegments } from "../src/lib/pdf_segments.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { SEGMENT_DEFAULTS } from "../src/lib/segments.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { listMaterials, materialsSentence, taskStatusMessage } from "../src/lib/task_status.ts";
import { DEFINITION_PATH, callIn, count, makeWorkspace, query } from "./helpers.ts";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
/** 「工」「日」写成康熙部首字符：文字层里常见的毛病，核对时要当成通用汉字。 */
const 工 = cp(0x2f2f);
const 日 = cp(0x2f47);

const PROJECTION = [
  "<!--",
  "由 办法.pdf 生成，供助手阅读。页数：4。块总数：6。",
  "-->",
  "",
  "> （页眉页脚）退款办法",
  "[p1-1] 第一条 买家申请退款的，",
  "",
  "[p1-2] 平台应当在两个" + 工 + "作" + 日 + "内答复。",
  "",
  "[p1-3] 汇 率 按 申 请 当 天 的 中 间 价 计 算。",
  "",
  "[p2-1] 第二条 退款金额按原路退回。",
  "",
  "[p2-2] 第三条 运费由卖家承担。",
  "",
  "[p3-0] （这一页没有文字，可能是扫描件）",
  "",
  "[p4-1] 第四条 本办法自发布之日起施行。",
  "",
].join("\n");

/** 一个任务目录：材料目录里有一份 PDF 材料的四个文件（PDF 本身只是占位，核对读的是投影）。 */
function workspace(): string {
  const dir = makeWorkspace(undefined, { material: false });
  mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(join(dir, "inputs/办法.pdf"), "%PDF-1.4 占位");
  writeFileSync(join(dir, "inputs/办法.pdf.md"), PROJECTION, "utf-8");
  writePdfSegments(join(dir, "inputs/办法.pdf.segments.json"), buildPdfSegments(PROJECTION, SEGMENT_DEFAULTS, "inputs/办法.pdf", "inputs/办法.pdf.md", []));
  writeFileSync(join(dir, "inputs/办法.pdf.locations.json"), "{}", "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

const add = (dir: string, name: string, locator: string, excerpt: string) =>
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["照办法办"] }, sources: [{ kind: "文档原文", locator, excerpt }] }] });
const refused = (dir: string, locator: string, excerpt: string): string => {
  try {
    add(dir, "不该存上", locator, excerpt);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("没有被拒绝");
};
const locators = (dir: string) => query<{ locator: string }>(dir, "SELECT locator FROM item_source WHERE kind = '文档原文' ORDER BY item_id, position").map((row) => row.locator);

test("PDF 来源核对：块内的摘录、部首字符与被撑开的字、同一页里往后接块都通过，存下的出处是规范写法", () => {
  const dir = workspace();
  add(dir, "申请", "inputs/办法.pdf#p1-1", "买家申请退款的");
  // 原文是部首字符，摘录写的是通用汉字；原文的字被撑开，摘录没有空格。
  add(dir, "答复", "inputs/办法.pdf#p1-2", "平台应当在两个工作日内答复。");
  add(dir, "汇率", "办法.pdf#p1-3", "汇率按申请当天的中间价计算");
  // 从第 1 块接到第 2 块。
  add(dir, "接块", "inputs/办法.pdf#p1-1", "买家申请退款的，平台应当在两个工作日内答复");
  assert.deepEqual(locators(dir), ["inputs/办法.pdf#p1-1", "inputs/办法.pdf#p1-2", "办法.pdf#p1-3", "inputs/办法.pdf#p1-1"]);
});

test("PDF 来源核对：改了字、块不对、跨页、块 0、没有写页与块、写成投影、页或块不存在，各有各的拒绝，什么都不写", () => {
  const dir = workspace();
  const before = count(dir, "revision");
  assert.match(refused(dir, "inputs/办法.pdf#p1-2", "平台应当在三个工作日内答复"), /摘录「平台应当在三个工作日内答复」在 办法\.pdf 第 1 页第 2 块里找不到[\s\S]*不带行首方括号里的页与块/);
  // 摘录在别的块里：只有一处时指给它。
  assert.match(refused(dir, "inputs/办法.pdf#p1-1", "运费由卖家承担"), /在 办法\.pdf 第 1 页第 1 块里找不到，它在第 2 页第 2 块[\s\S]*出处改写成 inputs\/办法\.pdf#p2-2/);
  // 有好几处：列出来请它确认。
  assert.match(refused(dir, "inputs/办法.pdf#p4-1", "退款"), /这段文字在第 1 页第 1 块、第 2 页第 1 块都有[\s\S]*请按上下文确认是哪一块/);
  // 接上下一页才对得上：跨页。
  assert.match(refused(dir, "inputs/办法.pdf#p1-3", "中间价计算。第二条 退款金额"), /摘录从 办法\.pdf 第 1 页第 3 块接到了后面的页，摘录不能跨页[\s\S]*一页写一条来源/);
  assert.match(refused(dir, "inputs/办法.pdf#p3-0", "这一页没有文字"), /第 3 页的块 0，那一行只是说明这一页没有文字，不能作出处/);
  assert.match(refused(dir, "inputs/办法.pdf", "退款金额按原路退回"), /出处 inputs\/办法\.pdf 没有写页与块[\s\S]*例如 inputs\/办法\.pdf#p3-2[\s\S]*\[p3-2\] 是第 3 页第 2 块/);
  assert.match(refused(dir, "inputs/办法.pdf#p12", "退款金额按原路退回"), /出处 inputs\/办法\.pdf#p12 里页与块的写法不对/);
  assert.match(refused(dir, "inputs/办法.pdf.md", "退款金额按原路退回"), /是由 PDF 文件生成的投影，不是材料本身[\s\S]*例如 inputs\/办法\.pdf#p3-2/);
  assert.match(refused(dir, "inputs/办法.pdf#p9-1", "退款"), /出处写的是第 9 页，办法\.pdf 一共只有 4 页/);
  assert.match(refused(dir, "inputs/办法.pdf#p2-7", "退款"), /出处写的是第 2 页第 7 块，办法\.pdf 的第 2 页只有 2 块/);
  assert.match(refused(dir, "inputs/没有.pdf#p1-1", "退款"), /不是任务目录里能读到的 PDF 材料（找不到由它生成的 没有\.pdf\.md）/);
  assert.equal(count(dir, "revision"), before);
});

test("知识库出处：PDF 文档写页与块，拆出文档名、页与块；Word 文档照旧", () => {
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.pdf#p3-2"), { library: "general", name: "规范.pdf", paragraph: null, page: 3, block: 2 });
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.pdf"), { library: "general", name: "规范.pdf", paragraph: null });
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.docx#p12"), { library: "general", name: "规范.docx", paragraph: 12 });
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.pdf.md"), { library: "general", name: "规范.pdf.md", paragraph: null });
});
