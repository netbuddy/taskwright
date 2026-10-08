/**
 * 「保存图」工具走完整条链路：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 流程：助手先整理出一个用例；用户说「把借书画成一张用例图」，助手交来的 Mermaid 文本括号没有闭合，工具经任务服务校验后退回，
 * 拒绝的话里有校验给的原因；助手改对了再存，图存成 D-001 的修订 1，来源是用户那句话与被画的用例；
 * 用户让它改图名，助手先用「查看条目」看这张图（拿到 Mermaid 文本与修订号），再用同一个工具带编号改，成了修订 2。
 * 图不占任务的修订序号；被拒的那一次记进了工具拒绝表；图的列表接口读得到。
 * 最后用户在页面上改这张图的 Mermaid 文本（界面操作 edit_diagram）：写错的被任务服务校验拦下；写对的成了修订 3、发起方是用户，
 * 会话里多一句界面操作的说明；页面看到的修订号过时了按修订号过时拒绝。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const ASK = "把借书画成一张用例图";
const GOOD = 'flowchart LR\n  reader(["读者"])\n  subgraph 自助借还系统\n    borrow(["UC-001 借书"])\n  end\n  reader --> borrow';
const BAD = 'flowchart LR\n  reader(["读者"]\n  reader --> borrow';
const SOURCES = [{ kind: "用户的话", excerpt: ASK }, { kind: "条目", locator: "UC-001" }];
const SCRIPT = {
  sequence: [
    { tool_calls: [{ id: "call-save", name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例",
      sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL }],
      fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } }] } }] },
    reply("整理好了一个用例。", "call-r1"),
    { tool_calls: [{ id: "call-d1", name: "save_diagram", arguments: { name: "读者用例", kind: "use_case", mermaid: BAD, note: "读者能做的事。", sources: SOURCES } }] },
    { tool_calls: [{ id: "call-d2", name: "save_diagram", arguments: { name: "读者用例", kind: "use_case", mermaid: GOOD, note: "读者能做的事。", sources: SOURCES } }] },
    reply("图画好了，是 D-001。", "call-r2"),
    { tool_calls: [{ id: "call-g", name: "get_item", arguments: { item_id: "D-001" } }] },
    { tool_calls: [{ id: "call-d3", name: "save_diagram", arguments: { diagram: "D-001", base_revision: 1, name: "读者借书" } }] },
    reply("图名改好了。", "call-r3"),
  ],
};

/** 假端点收到的请求里，最后一条消息是某次工具调用的结果的那一个：那条结果的文字。 */
function resultOf(requests: Dict[], callId: string): string {
  for (const one of requests) {
    const messages: Dict[] = one["请求体"].messages ?? [];
    const last = messages[messages.length - 1];
    if (last?.role === "tool" && last.tool_call_id === callId) return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  }
  return "";
}

test("助手画图：写错的 Mermaid 文本被校验退回，改对之后存成图；改图先看再改；图不占任务的修订序号；用户在页面上改图", { skip: NO_PI, timeout: 180000 }, async () => {
  await withStack(tmp, "diagram", SCRIPT, async ({ call, taskId, session, requests, db, send, action }) => {
    await send({ text: "把材料整理成需求规格说明。", client_id: "c-1" });
    await send({ text: `${ASK}。`, client_id: "c-2" });
    // 第一次被校验退回：拒绝的话里有固定的开头与校验给的原因（括号没有闭合，报在第 2 行附近）。
    const refused = resultOf(requests(), "call-d1");
    assert.match(refused, /这张图没有保存：Mermaid 文本没有通过校验。Mermaid 文本第 2/);
    assert.match(refused, /照上面说的改了再保存。/);
    assert.deepEqual(db("SELECT tool_name, reason_kind FROM tool_rejection"), [{ tool_name: "save_diagram", reason_kind: "input" }]);
    // 第二次存上了。
    assert.match(resultOf(requests(), "call-d2"), /已保存图 D-001「读者用例」（用例图），现在是修订 1。[\s\S]*图里画了 1 个条目：UC-001。/);
    assert.deepEqual(db("SELECT diagram_id, revision_no, op, name, kind, actor, call_id FROM diagram_version"),
      [{ diagram_id: "D-001", revision_no: 1, op: "add", name: "读者用例", kind: "use_case", actor: "executor", call_id: "call-d2" }]);
    const sources = db("SELECT kind, locator, excerpt, depends_revision FROM item_source WHERE element_kind = '图' ORDER BY position");
    assert.deepEqual(sources.map((one) => [one.kind, one.excerpt, one.depends_revision]), [["用户的话", ASK, null], ["条目", "", 1]]);
    assert.ok(String(sources[0].locator).startsWith(`${session}#`), sources[0].locator);
    assert.equal(sources[1].locator, "UC-001");
    // 图不占任务的修订序号。
    assert.deepEqual(db("SELECT revision_no FROM revision"), [{ revision_no: 1 }]);
    const list = (await call("GET", `/api/v1/tasks/${taskId}/diagrams`)).body.diagrams;
    assert.deepEqual(list.map((one: Dict) => [one.diagram_id, one.name, one.kind_name, one.revision_no, one.source_count]), [["D-001", "读者用例", "用例图", 1, 2]]);

    await send({ text: "把图名改成读者借书。", client_id: "c-3" });
    // 查看条目认图的编号：给出 Mermaid 文本与改它时要写的修订号。
    const seen = resultOf(requests(), "call-g");
    assert.match(seen, /图 D-001「读者用例」（用例图），修订 1，是最新内容。/);
    assert.ok(seen.includes(GOOD), seen);
    assert.match(seen, /要修改或删除这张图时用 save_diagram，diagram 写 D-001，base_revision 写 1/);
    assert.match(resultOf(requests(), "call-d3"), /已修改图 D-001「读者借书」（用例图），现在是修订 2。/);
    const detail = (await call("GET", `/api/v1/tasks/${taskId}/diagrams/D-001`)).body.diagram;
    assert.deepEqual([detail.name, detail.revision_no, detail.revisions, detail.mermaid, detail.drawn], ["读者借书", 2, [1, 2], GOOD, [{ item_id: "UC-001", title: "借书", state: "live" }]]);
    assert.deepEqual(detail.sources.map((one: Dict) => [one.kind, one.depends_revision ?? null, one.stale ?? null]), [["用户的话", null, null], ["条目", 1, null]]);
    // 整份任务数据里条目的「被谁依据」数上了这张图。
    const item = (await call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.task.items[0];
    assert.deepEqual(item.depended_by, [{ element_kind: "图", id: "D-001", revision_no: 2 }]);

    // 用户在页面上改图。写错的文本被任务服务校验拦下，不转交、不写库。
    const target = { diagram_id: "D-001", base_revision: 2 };
    const wrong = await action({ kind: "edit_diagram", targets: [target], fields: { mermaid: BAD }, notify_executor: false });
    assert.deepEqual([wrong.status, wrong.body.error.code, wrong.body.error.data.reason], [422, "rejected", "syntax"]);
    assert.match(wrong.body.error.message, /^这张图没有保存：Mermaid 文本第 2/);
    assert.equal(db("SELECT COUNT(*) AS n FROM diagram_version")[0].n, 2);
    // 写对的存成图自己的修订 3，发起方是用户；多画了一个任务里没有的编号也存得上（用户改图不核对条目编号与来源），来源沿用上一次的两条。
    const mine = `${GOOD}\n  later(["UC-404 以后再补的用例"])\n  reader --> later`;
    const done = await action({ kind: "edit_diagram", targets: [target], fields: { mermaid: mine }, notify_executor: false });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(db("SELECT revision_no, op, name, actor, call_id FROM diagram_version WHERE revision_no = 3"),
      [{ revision_no: 3, op: "update", name: "读者借书", actor: "user", call_id: done.body.op_id }]);
    assert.equal(db("SELECT COUNT(*) AS n FROM item_source WHERE element_kind = '图' AND revision_no = 3")[0].n, 2);
    assert.deepEqual(db("SELECT revision_no FROM revision"), [{ revision_no: 1 }]);
    const edited = (await call("GET", `/api/v1/tasks/${taskId}/diagrams/D-001`)).body.diagram;
    assert.deepEqual([edited.revision_no, edited.revision_by, edited.mermaid], [3, "user", mine]);
    assert.deepEqual(edited.drawn, [{ item_id: "UC-001", title: "借书", state: "live" }, { item_id: "UC-404", title: null, state: "missing" }]);
    // 会话里多了一句界面操作的说明，不可撤销，没有引出一次运行。
    const note = "界面操作（不是用户打的字）：用户在界面上改了图 D-001「读者借书」的 Mermaid 文本，D-001 现在是修订 3。要看现在的文本，用 get_item 写 D-001。";
    let noted: Dict | undefined;
    for (const end = Date.now() + 10000; !noted && Date.now() < end;) {
      const messages: Dict[] = (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${session}`)).body.conversation.messages;
      noted = messages.find((one) => one.type === "ui_action_noted" && one.text === note);
      if (!noted) await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.ok(noted, "对话里要有改图的那句说明");
    assert.deepEqual([noted.undoable, noted.op_id, noted.kind, noted.revision_no], [false, done.body.op_id, "edit_diagram", null]);
    assert.equal((await call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor.state, "idle");
    // 页面看到的修订号过时了：按修订号过时拒绝。
    const late = await action({ kind: "edit_diagram", targets: [target], fields: { mermaid: GOOD }, notify_executor: false });
    assert.deepEqual([late.status, late.body.error.code, late.body.error.data.diagrams[0].current_revision], [409, "stale_revision", 3]);
  });
});
