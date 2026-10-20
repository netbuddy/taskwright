/**
 * 保存修订里页的两条守卫（lib/save_revision.ts 的 pageGuard）：导语页只在编写文档里写；核读材料时立的页至少贴一个标签、至少有一项例子。
 * 都按这次传入的字段判，不以合并后的页为据；用户在界面上的操作不看位置。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { ACTOR_USER } from "../src/lib/db.ts";
import { CHAPTERS } from "../src/lib/overall_chapters.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { type Stage } from "../src/lib/stage.ts";
import { DEFINITION_PATH, SOURCE, UI_SESSION, enterStage, idleSessions, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const SESSION = "session-guard";
let calls = 0;
const call = (dir: string, actor?: string) => ({ workspaceDir: dir, sessionId: SESSION, callId: `call-guard-${++calls}`, ...(actor ? { actor } : {}) });

/** 业务说明带「导语所属章」一栏的任务，会话放在 stage。 */
function workspace(stage: Stage): string {
  const definition = overallDefinition() as any;
  definition.交付物.条目集合.find((one: any) => one.名称 === "业务说明").字段.push({ 名: "导语所属章", 类型: "枚举", 必填: false, 取值: CHAPTERS.map((one) => one.name) });
  const dir = makeWorkspace(definition);
  createTask(call(dir), { definition_path: DEFINITION_PATH });
  enterStage(dir, stage, [UI_SESSION, SESSION]);
  return dir;
}

const full = (title: string, more: Record<string, unknown> = {}) =>
  ({ 标题: title, 它是什么: `${title}的说明。`, 状态: "在用", 标签: ["概念"], 例子: [`小王办了${title}。`], ...more });
const add = (fields: Record<string, unknown>) => ({ op: "add", collection: "业务说明", fields, sources: [SOURCE] });
const revisionOf = (dir: string, item: string) => Number(query<any>(dir, "SELECT MAX(revision_no) AS n FROM item_version WHERE item_id = ?", item)[0].n);
const update = (dir: string, item: string, fields: Record<string, unknown>) => ({ op: "update", item, base_revision: revisionOf(dir, item), fields });

/** 保存被拒时的全文；没有被拒返回 null。 */
function refusal(dir: string, operations: unknown[], actor?: string): string | null {
  try {
    saveRevision(call(dir, actor), { operations });
    return null;
  } catch (error) {
    assert.ok(error instanceof SaveRejected, String(error));
    return error.message;
  }
}
const INTRO_FACT = "不能新立导语页，也不能改既有导语页（「导语所属章」有值的页）";

test("导语页：编写文档之外的五个阶段与空闲时，新增导语页都被拦，指引写明在编写文档时写、停用只改状态；编写文档里照常", () => {
  for (const stage of ["reading", "clarifying", "modeling", "writing"] as const) {
    const dir = workspace(stage);
    const text = refusal(dir, [add(full("业务流程导语", { 导语所属章: "业务流程" }))])!;
    assert.ok(text.includes(INTRO_FACT), text);
    assert.ok(text.includes("怎么办：导语页在编写文档时写；这一页讲的内容不填「导语所属章」照常立页。要停用一页既有导语页，只把它的「状态」改成「已废弃」，别的字段不动。"), text);
    assert.equal(query(dir, "SELECT 1 FROM item").length, 0);
  }
  // 评审确认阶段本来就不能新立页，报的是那一条。
  assert.match(refusal(workspace("reviewing"), [add(full("业务流程导语", { 导语所属章: "业务流程" }))])!, /这个阶段不能新立主题页/);
  const idle = workspace("clarifying");
  idleSessions(idle);
  assert.ok(refusal(idle, [add(full("业务流程导语", { 导语所属章: "业务流程" }))])!.includes(`现在在空闲，${INTRO_FACT}`));
  assert.equal(refusal(workspace("document"), [add(full("业务流程导语", { 导语所属章: "业务流程" }))]), null);
});

test("导语页：编写文档里立的导语页，回到澄清后改内容、清掉导语那一栏都被拦；只改为已废弃放行；普通页改成导语页也被拦", () => {
  const dir = workspace("document");
  saveRevision(call(dir), { operations: [add(full("业务流程导语", { 导语所属章: "业务流程" })), add(full("借书"))] });
  enterStage(dir, "clarifying", [UI_SESSION, SESSION]);
  assert.ok(refusal(dir, [update(dir, "OA-001", { 它是什么: "这一章讲借书。" })])!.includes(INTRO_FACT));
  assert.ok(refusal(dir, [update(dir, "OA-001", { 导语所属章: "" })])!.includes(INTRO_FACT));
  assert.ok(refusal(dir, [update(dir, "OA-001", { 状态: "已废弃", 改看: ["OA-002"] })])!.includes(INTRO_FACT));
  assert.ok(refusal(dir, [update(dir, "OA-002", { 导语所属章: "角色" })])!.includes(INTRO_FACT));
  // 普通页照常改；把导语那一栏原样带上不算改它。
  assert.equal(refusal(dir, [update(dir, "OA-002", { 它是什么: "读者把书借走。" })]), null);
  assert.equal(refusal(dir, [update(dir, "OA-001", { 状态: "已废弃", 导语所属章: "业务流程" })]), null);
  assert.equal(JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id = 'OA-001' ORDER BY revision_no DESC LIMIT 1")[0].fields).状态, "已废弃");
});

test("核读材料：新立的页缺标签、缺例子、两样都缺都被拦并写明缺哪样；反例、例外也算例子；停用的页不查", () => {
  const dir = workspace("reading");
  const noTag = refusal(dir, [add(full("借书", { 标签: [] }))])!;
  assert.ok(noTag.includes("核读材料时立的页至少要贴一个「标签」、写一项「例子」（反例、例外也算），这一页缺「标签」。"), noTag);
  assert.ok(noTag.includes("怎么办：「标签」拿不准就贴最接近的一个，并在问题条目里记一句为什么拿不准；「例子」没有现成的，写材料里的一个具体情形或反例并给来源；材料里确实没有时，写一条你推断的情形，来源种类写「助手补充」并写理由（自动待核实）。"), noTag);
  const { 例子: _, ...noExample } = full("还书");
  assert.ok(refusal(dir, [add(noExample)])!.includes("这一页缺「例子」。"));
  assert.ok(refusal(dir, [add({ 标题: "续借", 它是什么: "续借的说明。", 状态: "在用" })])!.includes("这一页缺「标签」、「例子」。"));
  assert.equal(query(dir, "SELECT 1 FROM item").length, 0);
  assert.equal(refusal(dir, [add(full("借书", { 例子: ["反例：小王借的是期刊，不能外借。"] })), add(full("还书", { 例子: ["例外：书损坏了，转人工处理。"] }))]), null);
  assert.equal(refusal(dir, [add({ 标题: "旧规则", 它是什么: "旧规则的说明。", 状态: "已废弃" })]), null);
});

test("核读材料：只查这次传入的两个字段，不追溯旧页；把标签或例子清空被拦；别的阶段与用户在界面上的操作不查", () => {
  const dir = workspace("clarifying");
  // 澄清阶段立的页可以没有标签与例子。
  assert.equal(refusal(dir, [add({ 标题: "借书", 它是什么: "借书的说明。", 状态: "在用" }), add(full("还书"))]), null);
  enterStage(dir, "reading", [UI_SESSION, SESSION]);
  assert.equal(refusal(dir, [update(dir, "OA-001", { 它是什么: "读者把书借走。" })]), null, "旧页缺标签与例子不追溯");
  assert.ok(refusal(dir, [update(dir, "OA-002", { 标签: [] })])!.includes("这一页缺「标签」。"));
  assert.ok(refusal(dir, [update(dir, "OA-002", { 例子: [] })])!.includes("这一页缺「例子」。"));
  assert.equal(refusal(dir, [update(dir, "OA-002", { 标签: ["流程"] })]), null);
  // 用户的操作不看位置。
  assert.equal(refusal(dir, [add({ 标题: "预约", 它是什么: "预约的说明。", 状态: "在用" })], ACTOR_USER), null);
});
