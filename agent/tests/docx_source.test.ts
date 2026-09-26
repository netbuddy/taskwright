// Word 材料作来源：出处要带段落号，摘录对着投影里那一段核对（lib/docx_source.ts 与 save_revision 的 .docx 分支）。
// 夹具是 examples/library-lending/requirements-styled.docx，连同现生成的 Markdown 投影（或 0.2 的纯文本投影）由 helpers.ts 的 putSampleDocx 放进任务目录。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { placeExcerpt, projectionParagraphs } from "../src/lib/docx_source.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SAMPLE_DOCX, callIn, count, makeWorkspace, projection, putSampleDocx, query } from "./helpers.ts";

const DOCX = SAMPLE_DOCX;

function workspaceWithDocx(legacy = false): string {
  const dir = makeWorkspace();
  putSampleDocx(dir, legacy);
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
    { kind: "文档原文", locator: `${DOCX}.md`, excerpt: "逾期的每本每天罚款一角" },
    docxSource(37, "名下有逾期未还图书的，不能再借"),
    docxSource(76, "逾期的每本每天罚款两角"),
    { kind: "文档原文", locator: `${DOCX}.txt`, excerpt: "逾期的每本每天罚款一角" },
  ]);
  // 拒绝的文字先逐条列出哪里不对，再在「怎么办」里逐条写改法
  assert.match(message, /第 1 条来源的出处 inputs\/requirements-styled\.docx 没有写段落号；/);
  assert.match(message, /第 2 条来源的出处写的是第 999 段，requirements-styled\.docx 一共只有 114 段；/);
  assert.match(message, /第 3 条来源的出处 inputs\/requirements-styled\.docx\.md 是由 Word 文件生成的投影，不是材料本身；/);
  assert.match(message, /第 6 条来源的出处 inputs\/requirements-styled\.docx\.txt 是由 Word 文件生成的投影，不是材料本身。/);
  assert.match(message, /第 4 条来源的摘录「名下有逾期未还图书的，不能再借」在 requirements-styled\.docx 第 37 段·表 1 行 1 列 2里找不到，它在第 28 段；/);
  assert.match(message, /第 5 条来源的摘录「逾期的每本每天罚款两角」在 requirements-styled\.docx 第 76 段里找不到；/);
  assert.match(message, /怎么办：Word 材料的出处要写段落号，例如 inputs\/requirements-styled\.docx#p12；段落号见 requirements-styled\.docx\.md 里每段前面方括号中的 p 加数字（例如 \[p12\]）/);
  assert.match(message, /出处写 Word 文件加段落号，例如 inputs\/requirements-styled\.docx#p12；出处改写成 inputs\/requirements-styled\.docx#p28；摘录必须与材料原文逐字一致，包括标点；不要自行补标点或改写；摘录必须逐字抄自那一段的正文（不带段落号、编号与 #、- 这些标记）/);
  assert.equal(count(dir, "item_source"), before);
});

test("一条来源只放一段连续的原文：用空行放进不相邻的两处时拒绝，提示引几处写几条来源；分成两条、各写段落号就通过", () => {
  const dir = workspaceWithDocx();
  const before = count(dir, "item_source");
  const message = rejection(dir, [docxSource(76, "逾期的每本每天罚款一角\n\n系统要能每分钟处理至少 100 笔借还")]);
  assert.match(message, /第 1 条来源的摘录在 requirements-styled\.docx 的 p76 及其后 5 段里不是连续的一段原文。\n  怎么办：引了材料几处就写几条来源，每条各写段落号/);
  assert.doesNotMatch(message, /拆成/);
  assert.equal(count(dir, "item_source"), before, "不替执行者拆开，也不替它找第二处的位置");
  saveRevision(callIn(dir), {
    operations: [addUseCase([docxSource(76, "逾期的每本每天罚款一角"), docxSource(91, "系统要能每分钟处理至少 100 笔借还")])],
  });
  assert.deepEqual(query<any>(dir, "SELECT position, locator, excerpt FROM item_source ORDER BY position").map((r) => [r.position, r.locator, r.excerpt]), [
    [1, `${DOCX}#p76`, "逾期的每本每天罚款一角"], [2, `${DOCX}#p91`, "系统要能每分钟处理至少 100 笔借还"],
  ]);
});

test("相邻两段连着引：摘录从出处那一段开始、延续到下一段，中间的空行只当空白，存成一条来源", () => {
  const dir = workspaceWithDocx();
  const outcome = saveRevision(callIn(dir), { operations: [addUseCase([docxSource(111, "寒暑假期间的借期另行规定。\n\n罚款的缴纳方式待定。")])] });
  assert.match(outcome.text, /新增了条目 UC-001/);
  assert.deepEqual(query<any>(dir, "SELECT locator, excerpt FROM item_source").map((r) => [r.locator, r.excerpt]),
    [[`${DOCX}#p111`, "寒暑假期间的借期另行规定。\n\n罚款的缴纳方式待定。"]]);
  // 同样两段，出处写成后一段：摘录不从那一段开始，拒绝并指出它从第 111 段开始。
  assert.match(rejection(workspaceWithDocx(), [docxSource(112, "寒暑假期间的借期另行规定。\n\n罚款的缴纳方式待定。")]),
    /第 1 条来源的摘录「寒暑假期间的借期另行规定。 罚款的缴纳方式待定。」在 requirements-styled\.docx 第 112 段里找不到，它在第 111 段/);
});

test("0.2 的任务只有纯文本投影 x.docx.txt：照旧核对；段落号的指引按旧格式写", () => {
  const dir = workspaceWithDocx(true);
  const outcome = saveRevision(callIn(dir), {
    operations: [addUseCase([docxSource(76, "逾期的每本每天罚款一角，罚款最多不超过这本书的定价。")])],
  });
  assert.match(outcome.text, /新增了条目 UC-001/);
  assert.match(rejection(dir, [docxSource(null, "逾期的每本每天罚款一角")]), /段落号见 requirements-styled\.docx\.txt 每行开头的「第 N 段」/);
});

test("Markdown 投影：编号、图片链接、表格里的转义都不算正文；摘录带着编号就找不到", () => {
  const paragraphs = projectionParagraphs(projection());
  assert.deepEqual(placeExcerpt(paragraphs, 75, "逾期罚款"), { kind: "in" });
  assert.deepEqual(placeExcerpt(paragraphs, 75, "3.1.1 逾期罚款"), { kind: "miss" });
  assert.deepEqual(placeExcerpt(paragraphs, 80, "被借走的书可以预约。"), { kind: "in" });
  assert.deepEqual(placeExcerpt(paragraphs, 80, "图 2"), { kind: "miss" });
  // 跨段：从第 27 段接到列表的下一项，中间的编号「3.1」不算正文
  assert.deepEqual(placeExcerpt(paragraphs, 27, "系统核对借阅上限与逾期情况：名下有逾期未还图书的"), { kind: "span", last: 28 });
});

test("摘录在材料里有好几处（表格整行错一位）：不替模型挑一段，按远近列出几处并带表格位置；只有一处时照旧指给它", () => {
  const dir = workspaceWithDocx();
  // 表 1 第 2 行是「[p40] 学生 | [p41] 5 | [p42] 30 | [p43] 1」，这里整行错后一位
  const message = rejection(dir, [docxSource(41, "学生"), docxSource(42, "5"), docxSource(44, "1")]);
  assert.match(message, /第 1 条来源的摘录「学生」在 requirements-styled\.docx 第 41 段·表 1 行 2 列 2里找不到；这段文字在[^；]*第 40 段·表 1 行 2 列 1[^；]*都有/);
  assert.match(message, /第 2 条来源的摘录「5」在 requirements-styled\.docx 第 42 段·表 1 行 2 列 3里找不到；这段文字在第 8 段、第 41 段·表 1 行 2 列 2、/);
  assert.match(message, /第 3 条来源的摘录「1」在 requirements-styled\.docx 第 44 段·表 1 行 3 列 1里找不到；这段文字在[^；]*第 43 段·表 1 行 2 列 4[^；]*等 \d+ 处都有/);
  assert.match(message, /怎么办：请按上下文确认是哪一段，出处写那一段的段落号/);
  // 不再给出单一的（错的）段落号
  assert.doesNotMatch(message, /出处改写成/);
  assert.doesNotMatch(message, /它在第/);
  assert.equal(count(dir, "item_source"), 0);
});

test("摘录出自文本框：拒绝，并说明文本框里的文字不能作出处", () => {
  const dir = workspaceWithDocx();
  const message = rejection(dir, [docxSource(81, "保留期从图书归还上架时起算，\n按自然日计，节假日不顺延。")]);
  assert.match(message, /第 1 条来源的摘录「保留期从图书归还上架时起算， 按自然日计，节假日不顺延。」在 requirements-styled\.docx 第 81 段里找不到；这段文字在文本框里，文本框里的文字不能作出处/);
  assert.match(message, /怎么办：请改引正文里说到同一件事的段落；正文里没有，就不要把这一处当作来源/);
  // 0.2 的纯文本投影里没有文本框的字：照旧只说找不到
  assert.doesNotMatch(rejection(workspaceWithDocx(true), [docxSource(81, "保留期从图书归还上架时起算")]), /文本框/);
});
