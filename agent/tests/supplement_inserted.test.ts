/**
 * 助手补充的来源要在 supports 里用 inserted 逐字列出补进正文的字（页面靠这几个字在正文里标出哪里是助手补的）：
 * 至少一处写了、每段都在那一处的正文里才保存；理由随意写，引号不再解析；别的来源不能写 inserted；
 * 问题条目、用户在界面上的修改、沿用下来的来源不核对。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const supplement = (excerpt: string, supports?: unknown[]) => ({ kind: "助手补充", excerpt, ...(supports ? { supports } : {}) });
/** 业务说明那一页上助手补充的来源行：[字段, 第几项, inserted 列]。 */
const rows = (dir: string) => query<{ field: string | null; field_index: number | null; inserted: string | null }>(dir,
  "SELECT field, field_index, inserted FROM item_source WHERE kind = '助手补充' AND item_id LIKE 'OA-%' ORDER BY revision_no, position, support_no")
  .map((one) => [one.field, one.field_index, one.inserted]);
const page = (sources: unknown[], fields: Record<string, unknown> = {}) => ({ op: "add", collection: "业务说明",
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

test("inserted 里的字逐字在它那一处的正文里：保存成功，存进来源表；理由里怎样用引号都可以", () => {
  const dir = workspace();
  assert.equal(refusal(dir, [page([supplement("材料只说「另行规定」，「保留期」是按高校图书馆常见的做法补的。",
    [{ field: "已经定下的", index: 1, inserted: ["保留期是 3 天"] }])])]), null);
  assert.deepEqual(rows(dir), [["已经定下的", 1, JSON.stringify(["保留期是 3 天"])]]);
  // 支持整个字段时，在这个字段的任何一项里出现就行；同一条来源的另一处可以不写 inserted。
  assert.equal(refusal(dir, [page([supplement("按常见做法补的。", [{ field: "已经定下的", inserted: ["3 天"] }, { field: "它是什么" }])], { 标题: "保留期" })]), null);
});

test("inserted 里的字不在那一处的正文里（差一个字、或者在别的一处）：拒绝，说出哪一段不在哪一处；什么都不写", () => {
  const dir = workspace();
  assert.equal(refusal(dir, [page([supplement("按常见做法补的。", [{ field: "已经定下的", index: 1, inserted: ["保留期是 5 天"] }])])]),
    "这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n" +
    "- 操作 1（新增，集合「业务说明」）：新增到「业务说明」的条目：「按常见做法补的。」（助手补充）写的补进正文的「保留期是 5 天」不在「已经定下的」第 2 项的正文里。\n" +
    "  怎么办：inserted 里每一段都要照那一处的正文一字不差地抄出你补进去的字，并在 supports 里写对是哪个字段的第几项；理由里怎样写都可以，不必用引号。\n" +
    "请把这些地方改正之后，把整批操作重新提交一次。");
  // 两段一段对一段不对：只说不对的那一段；字在第 2 项，写成了第 1 项也拒绝。
  const two = refusal(dir, [page([supplement("按常见做法补的。", [{ field: "已经定下的", index: 0, inserted: ["在架", "保留期"] }])])])!;
  assert.match(two, /写的补进正文的「保留期」不在「已经定下的」第 1 项的正文里/);
  assert.doesNotMatch(two, /「在架」不在/);
  assert.equal(count(dir, "item_version"), 0);
});

test("助手补充没有一处写 inserted、写成了别的形状、别的来源写了 inserted：都拒绝", () => {
  const dir = workspace();
  assert.equal(refusal(dir, [page([supplement("「保留期是 3 天」是我补的。", [{ field: "已经定下的", index: 1 }])])]),
    "这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n" +
    "- 操作 1（新增，集合「业务说明」）：新增到「业务说明」的条目：「「保留期是 3 天」是我补的。」（助手补充）没有写补进了正文的哪些字。\n" +
    "  怎么办：在 supports 里写明支持哪个字段（列表型字段写第几项），并用 inserted 逐字列出你补进那一处正文的字，例如 { \"field\": \"字段名\", \"inserted\": [\"补进去的字\"] }。\n" +
    "请把这些地方改正之后，把整批操作重新提交一次。");
  // 不写 supports（支持整个条目）也算没有写。
  assert.match(refusal(dir, [page([supplement("是我补的。")])])!, /（助手补充）没有写补进了正文的哪些字/);
  assert.match(refusal(dir, [page([supplement("是我补的。", [{ field: "已经定下的", index: 1, inserted: "保留期" }])])])!,
    /第 2 条来源的 supports 第 1 项的 inserted 应当是字符串数组/);
  assert.match(refusal(dir, [{ ...page([]), sources: [{ ...SOURCE, supports: [{ field: "它是什么", inserted: ["预约"] }] }] }])!,
    /第 1 条来源的 supports 写了 inserted；只有「助手补充」的来源写 inserted/);
});

test("不核对的三种：问题条目；用户在界面上的修改；助手修改时沿用下来的来源。助手修改时新给的来源照样核对", () => {
  const dir = workspace();
  // 问题条目的助手补充写的是发现了什么，不是补进正文的字。
  assert.equal(refusal(dir, [{ op: "add", collection: "问题", fields: { 事项: "闭馆日算不算在保留期内？", 状态: "未解决" },
    sources: [supplement("材料里只说「另行规定」，没有说闭馆日怎样算。")] }]), null);
  assert.equal(refusal(dir, [page([supplement("按常见做法补的。", [{ field: "已经定下的", index: 1, inserted: ["保留期是 3 天"] }])])]), null);
  // 用户在界面上改了别的字段：沿用下来的来源不核对，保存成功；inserted 跟着沿用下来。
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: "ui-op-inserted-1", kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 2 }], fields: { 别名: ["预约"] } });
  assert.deepEqual(rows(dir).map((one) => one[2]), [JSON.stringify(["保留期是 3 天"]), JSON.stringify(["保留期是 3 天"])]);
  // 助手改了那一条而不给新来源：沿用下来的来源不重新核对。
  assert.equal(refusal(dir, [{ op: "update", item: "OA-001", base_revision: 3, fields: { 已经定下的: ["只有在架的书才能预约取书。", "保留期是 5 天。"] } }]), null);
  // 助手修改时新给的助手补充照样核对，对的是改完之后的内容。
  assert.match(refusal(dir, [{ op: "update", item: "OA-001", base_revision: 4, fields: { 例子: ["小王周六预约了《算法导论》。"] },
    sources: [supplement("这个例子是我编的。", [{ field: "例子", index: 0, inserted: ["小李周六预约"] }])] }])!, /写的补进正文的「小李周六预约」不在「例子」第 1 项的正文里/);
  assert.equal(refusal(dir, [{ op: "update", item: "OA-001", base_revision: 4, fields: { 例子: ["小王周六预约了《算法导论》。"] },
    sources: [supplement("这个例子是我编的。", [{ field: "例子", index: 0, inserted: ["小王周六预约"] }])] }]), null);
});
