/**
 * 助手补充的来源，理由里用直角引号引出的字要逐字出现在它支持的那几处正文里（页面靠这几个字在正文里标出哪里是助手补的）：
 * 不在就拒绝并说明；没有引号的不核对；问题条目、用户在界面上的修改、沿用下来的来源不核对。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, overallDefinition } from "./helpers.ts";

const supplement = (excerpt: string, supports?: unknown[]) => ({ kind: "助手补充", excerpt, ...(supports ? { supports } : {}) });
const page = (sources: unknown[], fields: Record<string, unknown> = {}) => ({ op: "add", collection: "总体分析",
  fields: { 标题: "预约取书", 它是什么: "读者对在架的书办预约。", 已经定下的: ["只有在架的书才能预约取书。", "保留期是 3 天。"], 状态: "在用", ...fields },
  sources: [{ ...SOURCE, supports: [{ field: "它是什么" }, { field: "已经定下的", index: 0 }] }, ...sources] });

function workspace(): string {
  const dir = makeWorkspace(overallDefinition());
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
function refusal(dir: string, operations: unknown[]): string | null {
  try {
    saveRevision(callIn(dir), { operations });
    return null;
  } catch (error) {
    assert.ok(error instanceof SaveRejected, String(error));
    return error.message;
  }
}

test("助手补充的理由里引出的字逐字在它支持的那一处：保存成功；引的与正文不一样、或者在别的一处：拒绝并说明", () => {
  const dir = workspace();
  // 引的字与正文差一个字。
  assert.match(refusal(dir, [page([supplement("「保留期是 5 天」是按高校图书馆常见的做法补的。", [{ field: "已经定下的", index: 1 }])])])!,
    /（助手补充）的理由里用直角引号引出的「保留期是 5 天」不在它支持的那几处正文里[^]*怎么办：[^]*理由里的直角引号只用来逐字引出你补进正文的那几个字：照正文一字不差地引/);
  // 引的字在正文里，但不在这条来源支持的那一处（标到了第 1 条，字在第 2 条）。
  assert.match(refusal(dir, [page([supplement("「保留期是 3 天」是按高校图书馆常见的做法补的。", [{ field: "已经定下的", index: 0 }]),
    supplement("等用户确认的一条。", [{ field: "已经定下的", index: 1 }])])])!, /引出的「保留期是 3 天」不在它支持的那几处正文里/);
  // 引了两段，一段对一段不对：只说不对的那一段。
  const two = refusal(dir, [page([supplement("「保留期」与「三天」是我补的。", [{ field: "已经定下的", index: 1 }])])])!;
  assert.match(two, /引出的「三天」不在它支持的那几处正文里/);
  assert.doesNotMatch(two, /引出的「保留期」/);
  assert.equal(count(dir, "item_version"), 0);
  // 一字不差：保存成功。支持整个字段时，在这个字段的任何一项里出现就行。
  assert.equal(refusal(dir, [page([supplement("「保留期是 3 天」是按高校图书馆常见的做法补的。", [{ field: "已经定下的", index: 1 }])])]), null);
  assert.equal(refusal(dir, [page([supplement("「3 天」是按高校图书馆常见的做法补的。", [{ field: "已经定下的" }])], { 标题: "保留期" })]), null);
});

test("没有写支持哪几处的助手补充：引出的字在这个条目任何一个字段里就行；理由里没有直角引号的不核对", () => {
  const dir = workspace();
  assert.match(refusal(dir, [page([supplement("「预留架」这个说法是我补的。")])])!, /引出的「预留架」不在这个条目的正文里/);
  assert.equal(refusal(dir, [page([supplement("「保留期是 3 天」是我补的，材料没有写。")])]), null);
  assert.equal(refusal(dir, [page([supplement("高校图书馆常见的做法，等用户确认。", [{ field: "已经定下的", index: 1 }])], { 标题: "保留期" })]), null);
});

test("不核对的三种：问题条目；用户在界面上的修改；助手修改时沿用下来的来源。助手修改时新给的来源照样核对", () => {
  const dir = workspace();
  // 问题条目的助手补充写的是发现了什么，引的是材料里的话，不是补进正文的字。
  assert.equal(refusal(dir, [{ op: "add", collection: "问题", fields: { 事项: "闭馆日算不算在保留期内？", 状态: "未解决" },
    sources: [supplement("材料里只说「另行规定」，没有说闭馆日怎样算。")] }]), null);
  assert.equal(refusal(dir, [page([supplement("「保留期是 3 天」是按高校图书馆常见的做法补的。", [{ field: "已经定下的", index: 1 }])])]), null);
  // 用户在界面上改了别的字段：沿用下来的来源不核对，保存成功。
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: "ui-op-quote-1", kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 2 }], fields: { 别名: ["预约"] } });
  // 助手改了它引过的那一条而不给新来源：沿用下来的来源不重新核对（结果里另有「改写了的内容上还留着原来的来源」的提醒）。
  assert.equal(refusal(dir, [{ op: "update", item: "OA-001", base_revision: 3, fields: { 已经定下的: ["只有在架的书才能预约取书。", "保留期是 5 天。"] } }]), null);
  // 助手修改时新给的助手补充照样核对，对的是改完之后的内容。
  assert.match(refusal(dir, [{ op: "update", item: "OA-001", base_revision: 4, fields: { 例子: ["小王周六预约了《算法导论》。"] },
    sources: [supplement("「小李周六预约」这个例子是我编的。", [{ field: "例子", index: 0 }])] }])!, /引出的「小李周六预约」不在它支持的那几处正文里/);
  assert.equal(refusal(dir, [{ op: "update", item: "OA-001", base_revision: 4, fields: { 例子: ["小王周六预约了《算法导论》。"] },
    sources: [supplement("「小王周六预约了《算法导论》。」这个例子是我编的。", [{ field: "例子", index: 0 }])] }]), null);
});
