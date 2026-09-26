// Word 材料作来源：出处要带段落号，摘录对着文本投影里那一段核对（lib/docx_source.ts 与 save_revision 的 .docx 分支）。
// 夹具是 examples/library-lending/requirements-styled.docx，连同现生成的投影由 helpers.ts 的 putSampleDocx 放进任务目录。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { findParagraph, placeExcerpt, projectionParagraphs } from "../src/lib/docx_source.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SAMPLE_DOCX, callIn, count, makeWorkspace, projection, putSampleDocx, query } from "./helpers.ts";

const DOCX = SAMPLE_DOCX;

function workspaceWithDocx(): string {
  const dir = makeWorkspace();
  putSampleDocx(dir);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

const addUseCase = (sources: unknown[], name = "缴纳逾期罚款") => ({
  op: "add", collection: "用例", fields: { 名称: name, 步骤: ["读者缴费"] }, sources,
});
const docxSource = (paragraph: number | null, excerpt: string) =>
  ({ kind: "文档原文", locator: paragraph === null ? DOCX : `${DOCX}#p${paragraph}`, excerpt });

const rejection = (dir: string, sources: unknown[]): string => {
  try {
    saveRevision(callIn(dir), { operations: [addUseCase(sources)] });
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};

test("投影的段落与样本一致：114 段；段内、跨段、找不到、表格单元格四种位置", () => {
  const paragraphs = projectionParagraphs(projection());
  assert.equal(paragraphs.length, 114);
  assert.deepEqual(placeExcerpt(paragraphs, 76, "逾期的每本每天罚款一角，罚款最多不超过这本书的定价。"), { kind: "in" });
  assert.deepEqual(placeExcerpt(paragraphs, 111, "寒暑假期间的借期另行规定。罚款的缴纳方式待定。"), { kind: "span", last: 112 });
  assert.deepEqual(placeExcerpt(paragraphs, 37, "名下有逾期未还图书的，不能再借"), { kind: "miss" });
  assert.deepEqual(placeExcerpt(paragraphs, 91, "系统要能每分钟处理至少 100 笔借还"), { kind: "in" });
  // 空白不参与比较：摘录里多写或少写空格、换行都不影响
  assert.deepEqual(placeExcerpt(paragraphs, 91, "系统要能每分钟处理至少100笔\n借还"), { kind: "in" });
  // 从第 112 段起算，摘录的开头不在第 112 段里，不算跨段
  assert.deepEqual(placeExcerpt(paragraphs, 112, "寒暑假期间的借期另行规定。罚款的缴纳方式待定。"), { kind: "miss" });
  assert.equal(findParagraph(paragraphs, "名下有逾期未还图书的，不能再借", 37), 28);
  assert.equal(findParagraph(paragraphs, "这句话不在材料里"), null);
});

test("出处带段落号、摘录在那一段里：通过，库里存「文件#p段落号」；跨段的摘录也通过", () => {
  const dir = workspaceWithDocx();
  const outcome = saveRevision(callIn(dir), {
    operations: [
      addUseCase([docxSource(76, "逾期的每本每天罚款一角，罚款最多不超过这本书的定价。")]),
      addUseCase([docxSource(111, "寒暑假期间的借期另行规定。罚款的缴纳方式待定。")], "待定事项"),
      addUseCase([docxSource(91, "系统要能每分钟处理至少 100 笔借还")], "借还高峰"),
    ],
  });
  assert.match(outcome.text, /新增了条目 UC-003/);
  assert.deepEqual(query<any>(dir, "SELECT item_id, locator FROM item_source ORDER BY item_id").map((r) => [r.item_id, r.locator]), [
    ["UC-001", `${DOCX}#p76`], ["UC-002", `${DOCX}#p111`], ["UC-003", `${DOCX}#p91`],
  ]);
});

test("出处不带段落号、段落号越界、写成投影文件、摘录不在那一段：整批拒绝，逐条说明怎么改", () => {
  const dir = workspaceWithDocx();
  const before = count(dir, "item_source");
  const message = rejection(dir, [
    docxSource(null, "逾期的每本每天罚款一角"),
    docxSource(999, "逾期的每本每天罚款一角"),
    { kind: "文档原文", locator: `${DOCX}.txt`, excerpt: "逾期的每本每天罚款一角" },
    docxSource(37, "名下有逾期未还图书的，不能再借"),
    docxSource(76, "逾期的每本每天罚款两角"),
  ]);
  // 拒绝的文字先逐条列出哪里不对，再在「怎么办」里逐条写改法
  assert.match(message, /第 1 条来源的出处 inputs\/requirements-styled\.docx 没有写段落号；/);
  assert.match(message, /第 2 条来源的出处写的是第 999 段，requirements-styled\.docx 一共只有 114 段；/);
  assert.match(message, /第 3 条来源的出处 inputs\/requirements-styled\.docx\.txt 是由 Word 文件生成的文本，不是材料本身；/);
  assert.match(message, /第 4 条来源的摘录「名下有逾期未还图书的，不能再借」在 requirements-styled\.docx 第 37 段里找不到，它在第 28 段；/);
  assert.match(message, /第 5 条来源的摘录「逾期的每本每天罚款两角」在 requirements-styled\.docx 第 76 段里找不到。/);
  assert.match(message, /怎么办：Word 材料的出处要写段落号，例如 inputs\/requirements-styled\.docx#p12；段落号见 requirements-styled\.docx\.txt 每行开头的「第 N 段」/);
  assert.match(message, /出处写 Word 文件加段落号，例如 inputs\/requirements-styled\.docx#p12；出处改写成 inputs\/requirements-styled\.docx#p28；摘录必须与材料原文逐字一致，包括标点；不要自行补标点或改写；摘录必须逐字抄自那一段里的文字/);
  assert.equal(count(dir, "item_source"), before);
});

test("摘录用空行隔开不相邻的两处：拆成两条来源，第二条记它自己所在的段落号", () => {
  const dir = workspaceWithDocx();
  const outcome = saveRevision(callIn(dir), {
    operations: [addUseCase([docxSource(76, "逾期的每本每天罚款一角\n\n系统要能每分钟处理至少 100 笔借还")])],
  });
  assert.match(outcome.text, /第 1 条来源的摘录按空行拆成了 2 条来源/);
  assert.deepEqual(query<any>(dir, "SELECT locator, excerpt FROM item_source ORDER BY position").map((r) => [r.locator, r.excerpt]), [
    [`${DOCX}#p76`, "逾期的每本每天罚款一角"], [`${DOCX}#p91`, "系统要能每分钟处理至少 100 笔借还"],
  ]);
  // 第一段不在出处写的那一段里：拒绝，并指出它在哪一段
  const message = rejection(workspaceWithDocx(), [docxSource(91, "逾期的每本每天罚款一角\n\n系统要能每分钟处理至少 100 笔借还")]);
  assert.match(message, /第 1 条来源的第 1 段摘录「逾期的每本每天罚款一角」在 requirements-styled\.docx 第 91 段里找不到，它在第 76 段/);
});
