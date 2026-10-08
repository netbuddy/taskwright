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

test("任务现状消息与查询任务状态：PDF 材料列页数、块数、没有文字的页与读法；未引用按块统计，接了几块的来源那几块都算引用过", () => {
  const dir = workspace();
  const files = listMaterials(dir, "inputs/").files.map((f) => f.path);
  assert.deepEqual(files, ["inputs/办法.pdf", "inputs/办法.pdf.md", "inputs/办法.pdf.segments.json"], "位置表不列");
  const fresh = taskStatusMessage(dir, { hasUserMessage: false, hasStatusMessage: false, lastMessageAt: null }, "s")!;
  assert.match(fresh.text, /其中 inputs\/办法\.pdf 是 PDF 文件，请读由它生成的投影 inputs\/办法\.pdf\.md（每块一行，行首方括号里是页与块）；引用它作来源时，出处写 PDF 文件加页与块，例如 inputs\/办法\.pdf#p3-2。/);
  assert.match(fresh.text, /inputs\/办法\.pdf 共 4 页、6 块，其中第 3 页没有文字，分段清单按页，见 inputs\/办法\.pdf\.segments\.json。/);
  assert.deepEqual((fresh.details.materials as { citations: unknown[] }).citations, [{ path: "inputs/办法.pdf", pages: 4, units: 6, no_text_pages: [3], uncited: 6 }]);
  assert.doesNotMatch(materialsSentence({ dir: "inputs/", files: [{ path: "inputs/a.md", bytes: 3, modifiedAt: 0 }] }), /PDF/);

  add(dir, "接块", "inputs/办法.pdf#p1-1", "买家申请退款的，平台应当在两个工作日内答复");
  add(dir, "运费", "inputs/办法.pdf#p2-2", "运费由卖家承担");
  const status = getTaskStatus(dir, "s");
  assert.match(status.text, /inputs\/办法\.pdf（读 inputs\/办法\.pdf\.md）：共 4 页、6 块，第 3 页没有文字，还有 3 块没有被任何条目引用。/);
  assert.match(status.text, /第 1 段 第 1–4 页（第 \d+–\d+ 行）：6 块，被 2 个条目引用，3 块没有引用。/);
  const facts = (status.details as { materials: Record<string, unknown>[] }).materials[0];
  assert.deepEqual([facts.kind, facts.pages, facts.units, facts.no_text_pages, facts.uncited], ["pdf", 4, 6, [3], 3]);
});

test("知识库出处：PDF 文档写页与块，拆出文档名、页与块；Word 文档照旧", () => {
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.pdf#p3-2"), { library: "general", name: "规范.pdf", paragraph: null, page: 3, block: 2 });
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.pdf"), { library: "general", name: "规范.pdf", paragraph: null });
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.docx#p12"), { library: "general", name: "规范.docx", paragraph: 12 });
  assert.deepEqual(parseKnowledgeLocator("knowledge/general/规范.pdf.md"), { library: "general", name: "规范.pdf.md", paragraph: null });
});

test("查找知识库的结果：PDF 文档的片段写第几页第几块，正文逐块带页与块，出处教它写页与块", () => {
  const hit = {
    score: 0.8, score_kind: "semantic", rank_semantic: 1, rank_keyword: 2, library: "general", library_name: "通用知识库", name: "规范.pdf", index: 3, title: null,
    first_paragraph: null, last_paragraph: null, first_line: null, last_line: null, first_unit: { page: 3, block: 2 }, last_unit: { page: 3, block: 4 }, partial: false,
    text: "第二条 逾期的处理。\n逾期每册每天罚款 0.5 元。\n读者类别  借期  册数", locator: "knowledge/general/规范.pdf", body: null, paragraphs: null, table: null, header: null,
    units: [{ page: 3, block: 2, text: "第二条 逾期的处理。" }, { page: 3, block: 3, text: "逾期每册每天罚款 0.5 元。" }, { page: 3, block: 4, text: "读者类别  借期  册数" }],
  };
  const { text } = assemble("查到 1 个片段。", [hit as never], false);
  assert.match(text, /位置：第 3 页第 2 到 4 块\n/);
  assert.match(text, /引用时出处写：knowledge\/general\/规范\.pdf#p页-块（写摘录所在那一块的页与块，例如 knowledge\/general\/规范\.pdf#p3-2）/);
  assert.match(text, /正文（每行是一块，开头方括号里是这一块的页与块，摘录不带它；表格的一行是一块，各格之间隔着空格）：\n<<<原文开始\n\[p3-2\] 第二条 逾期的处理。\n\[p3-3\] 逾期每册每天罚款 0\.5 元。\n\[p3-4\] 读者类别  借期  册数\n原文结束>>>/);
  const one = assemble("查到 1 个片段。", [{ ...hit, last_unit: { page: 3, block: 2 }, units: hit.units.slice(0, 1) } as never], false).text;
  assert.match(one, /位置：第 3 页第 2 块\n/);
});
