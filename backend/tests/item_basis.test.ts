/**
 * 依据另一个条目的来源在接口里的样子：引用时对方的修订号、对方现在的修订号、依据的现状（已变、已删）；
 * 每个条目的「被谁依据」。都由读库时现算，不存库。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as library from "../src/library.ts";
import { makeTypedTask, tempDir } from "./helpers.ts";

const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "读者凭口令登录。" };
const note = (title: string, content: string) => ({ op: "add", collection: "领域说明", fields: { 标题: title, 内容: content, 类别: "术语" }, sources: [SOURCE] });
const cite = (locator: string, excerpt: string, field = "基本流程") => ({ kind: "条目", locator, excerpt, supports: [{ field }] });

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeTypedTask(join(tmp, "basis"), "srs-authoring", { "材料.md": "读者凭口令登录。" }, [
    // 修订 1：三条领域说明。
    [note("口令", "读者登录时输入的一串字符"), note("读者", "办了借书证的人"), note("借书证", "读者的凭证")],
    // 修订 2：UC-001 依据 DN-001（两条来源都指它）与 DN-002；UC-002 依据 DN-003。
    [{ op: "add", collection: "功能用例", fields: { 用例名称: "登录", 用例功能: "读者登录系统。", 参与者: ["读者"], 基本流程: ["输入口令"] },
      sources: [SOURCE, cite("DN-001", "读者登录时输入的一串字符"), cite("DN-001", "口令", "用例名称"), cite("DN-002", "办了借书证的人", "参与者")] },
    { op: "add", collection: "功能用例", fields: { 用例名称: "办证", 用例功能: "读者办借书证。", 参与者: ["读者"], 基本流程: ["填表"] },
      sources: [SOURCE, cite("DN-003", "读者的凭证")] }],
    // 修订 3：DN-001 改了内容；DN-003 删除；约束 CON-001 依据 UC-001。
    [{ op: "update", item: "DN-001", base_revision: 1, fields: { 内容: "读者登录时输入的一串字符，至少八位" } },
      { op: "delete", item: "DN-003", base_revision: 1 },
      { op: "add", collection: "约束", fields: { 类别: "安全", 句式类型: "普遍型", 需求语句: "口令输错三次后锁定账号。" }, sources: [{ kind: "条目", locator: "UC-001", excerpt: "读者登录系统。" }] }],
    // 修订 4：UC-002 改了别的字段，来源沿用。
    [{ op: "update", item: "UC-002", base_revision: 2, fields: { 用例功能: "读者到服务台办借书证。" } }],
  ]);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const items = () => new Map(library.taskSnapshot(ws)[1]!.items.map((one) => [one.item_id, one]));
const basis = (sources: library.SourceView[]) => sources.filter((one) => one.kind === "条目")
  .map((one) => [one.locator, one.depends_revision, one.current_revision, one.stale]);

test("依据已变：被依据的条目现在的修订号大于引用时记下的修订号就标 changed，没有改过的是 null", () => {
  const uc = items().get("UC-001")!;
  assert.deepEqual(basis(uc.sources), [["DN-001", 1, 3, "changed"], ["DN-001", 1, 3, "changed"], ["DN-002", 1, 1, null]]);
  assert.deepEqual(basis(items().get("CON-001")!.sources), [["UC-001", 2, 2, null]]);
});

test("被依据的条目已经删除：标 deleted，现在的修订号为 null；这条来源沿用到后来的修订也一样", () => {
  const uc = items().get("UC-002")!;
  assert.equal(uc.revision_no, 4);
  assert.deepEqual(basis(uc.sources), [["DN-003", 1, null, "deleted"]]);
});

test("别的种类的来源不带这三项", () => {
  const first = items().get("UC-001")!.sources[0];
  assert.deepEqual(Object.keys(first).sort(), ["excerpt", "kind", "locator", "supports"]);
});

test("被谁依据：列出依据它的条目与各自当前的修订号，一个条目有几条来源都依据它时只列一次；没有的是空列表", () => {
  const all = items();
  assert.deepEqual(all.get("DN-001")!.depended_by, [{ element_kind: "条目", id: "UC-001", revision_no: 2 }]);
  assert.deepEqual(all.get("DN-002")!.depended_by, [{ element_kind: "条目", id: "UC-001", revision_no: 2 }]);
  assert.deepEqual(all.get("UC-001")!.depended_by, [{ element_kind: "条目", id: "CON-001", revision_no: 3 }]);
  assert.deepEqual(all.get("UC-002")!.depended_by, []);
  assert.deepEqual(all.get("CON-001")!.depended_by, []);
});

test("条目在各次修订下的来源也带依据的现状，按对方现在的样子算", () => {
  const revisions = library.libraryOf(ws).revisionsView("UC-002");
  assert.deepEqual(revisions.map((one) => [one.revision_no, basis(one.sources)]),
    [[2, [["DN-003", 1, null, "deleted"]]], [4, [["DN-003", 1, null, "deleted"]]]]);
});
