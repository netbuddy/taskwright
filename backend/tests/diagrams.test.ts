/**
 * 图在任务服务这一侧（只读与校验）：图的列表与详情、整份任务数据里的图、图的来源带依据的现状、图里画了谁、
 * 条目的「被谁依据」里数上图、图的事件写成接口事件；校验接口；后端与助手两边的种类清单相同。
 * 图由夹具经助手一侧真实的保存函数写进库（后端不写库）。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DIAGRAM_KINDS as AGENT_KINDS, drawnItemIds } from "../../agent/src/lib/diagram.ts";
import { type DiagramCheck, DIAGRAM_KINDS, validateDiagram } from "../src/diagram_validate.ts";
import { ApiError } from "../src/errors.ts";
import { DIAGRAM_NOT_SAVED_TEXT, DIAGRAM_UNCHECKED_TEXT, Executor, executorSettings } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { dispatch } from "../src/http.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { captureConsole, makeTypedTask, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "读者凭口令登录。" };
const SAID = "把登录和办证画成一张用例图";
const useCase = (name: string, what: string) =>
  ({ op: "add", collection: "功能用例", fields: { 用例名称: name, 用例功能: what, 参与者: ["读者"], 基本流程: ["开始"] }, sources: [SOURCE] });
const MERMAID = 'flowchart LR\n  reader(["读者"])\n  a(["UC-001 登录"])\n  b(["UC-002 办证"])\n  c(["UC-003 挂失"])\n  reader --> a\n  reader --> b';

let tmp: string;
let root: string;
let ws: string;
before(() => {
  tmp = tempDir();
  root = join(tmp, "service");
  ws = makeTypedTask(join(root, "tasks"), "srs-authoring", { "材料.md": "读者凭口令登录。" }, [
    // 任务修订 1：三个用例。
    [useCase("登录", "读者登录系统。"), useCase("办证", "读者办借书证。"), useCase("挂失", "读者挂失借书证。")],
    // D-001 修订 1：画了三个用例，依据用户的话与三个用例。
    { said: `${SAID}，谢谢`, diagram: { name: "读者用例", kind: "use_case", mermaid: MERMAID, note: "读者能做的事。",
      sources: [{ kind: "用户的话", excerpt: SAID }, { kind: "条目", locator: "UC-001" }, { kind: "条目", locator: "UC-002" }, { kind: "条目", locator: "UC-003" }] } },
    // D-002 修订 1：一张类图，只有用户的话；之后删掉。
    { said: "再画一张类图", diagram: { name: "借书证", kind: "class", mermaid: "classDiagram\n  class Card", sources: [{ kind: "用户的话", excerpt: "再画一张类图" }] } },
    // 任务修订 2：UC-001 改了；UC-003 删了。
    [{ op: "update", item: "UC-001", base_revision: 1, fields: { 用例功能: "读者凭口令登录系统。" } }, { op: "delete", item: "UC-003", base_revision: 1 }],
    // D-001 修订 2：只改说明，来源沿用。
    { diagram: { diagram: "D-001", base_revision: 1, note: "读者能做的三件事。" } },
    // D-002 修订 2：删除。
    { diagram: { diagram: "D-002", base_revision: 1, delete: true } },
    // D-003 修订 1：文本里写了一个任务里没有的编号是存不进去的，这里画一张不带条目编号的。
    { said: "画个流程", diagram: { name: "登录流程", kind: "flowchart", mermaid: "flowchart TD\n  s([开始]) --> e([结束])", sources: [{ kind: "用户的话", excerpt: "画个流程" }] } },
  ]);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("图的列表：只列还在的图，带图名、种类与中文名、它自己现在的修订号、谁改的、来源条数", () => {
  const list = library.diagramList(ws);
  assert.deepEqual(list.map((one) => [one.diagram_id, one.name, one.kind, one.kind_name, one.revision_no, one.revision_by, one.source_count]), [
    ["D-001", "读者用例", "use_case", "用例图", 2, "executor", 4],
    ["D-003", "登录流程", "flowchart", "流程图", 1, "executor", 1],
  ]);
  assert.ok(list.every((one) => typeof one.revision_at === "string" && typeof one.created_at === "string"));
  // 整份任务数据里的 diagrams 与列表相同。
  assert.deepEqual(library.taskSnapshot(ws)[1]!.diagrams, list);
});

test("图的详情：Mermaid 文本、说明、改动过的修订号；来源与条目的来源同形，依据条目的带依据的现状", () => {
  const one = library.diagramDetail(ws, "D-001")!;
  assert.deepEqual([one.mermaid, one.note, one.revisions, one.deleted, one.depended_by], [MERMAID, "读者能做的三件事。", [1, 2], false, []]);
  assert.deepEqual(one.sources.map((s) => [s.kind, s.locator, s.excerpt, s.depends_revision, s.current_revision, s.stale]), [
    ["用户的话", one.sources[0].locator, SAID, undefined, undefined, undefined],
    ["条目", "UC-001", "", 1, 2, "changed"],   // 引用之后改过：依据已变
    ["条目", "UC-002", "", 1, 1, null],
    ["条目", "UC-003", "", 1, null, "deleted"], // 引用之后删了
  ]);
  assert.equal(library.diagramDetail(ws, "D-404"), null);
});

test("图里画了谁：从 Mermaid 文本里扫出来的条目编号，带条目现在的标题与状态", () => {
  assert.deepEqual(library.diagramDetail(ws, "D-001")!.drawn, [
    { item_id: "UC-001", title: "登录", state: "live" },
    { item_id: "UC-002", title: "办证", state: "live" },
    { item_id: "UC-003", title: "挂失", state: "deleted" },
  ]);
  assert.deepEqual(library.diagramDetail(ws, "D-003")!.drawn, []);
});

test("已经删除的图：不在列表里，详情还取得到，带删除之前那一次的来源", () => {
  const gone = library.diagramDetail(ws, "D-002")!;
  assert.deepEqual([gone.deleted, gone.revision_no, gone.revisions, gone.name], [true, 2, [1, 2], "借书证"]);
  assert.deepEqual(gone.sources.map((s) => [s.kind, s.excerpt]), [["用户的话", "再画一张类图"]]);
});

test("条目的「被谁依据」里数上依据它的图（只数还在的图当前修订下的来源），条目自己的来源里没有图的来源", () => {
  const items = new Map(library.taskSnapshot(ws)[1]!.items.map((one) => [one.item_id, one]));
  assert.deepEqual(items.get("UC-001")!.depended_by, [{ element_kind: "图", id: "D-001", revision_no: 2 }]);
  assert.deepEqual(items.get("UC-002")!.depended_by, [{ element_kind: "图", id: "D-001", revision_no: 2 }]);
  assert.deepEqual(items.get("UC-001")!.sources.map((s) => s.kind), ["文档原文"]);
  // 任务的修订序号不因为存图而动：两次保存修订，最新是 2。
  assert.equal(library.taskSnapshot(ws)[1]!.latest_revision, 2);
});

test("图的事件写成接口事件 diagram_changed：是哪一张、它自己改后的修订号、做了什么、图名、种类与中文名", () => {
  const db = library.openRo(ws)!;
  let data;
  try {
    data = library.readAll(db, 0);
  } finally {
    db.close();
  }
  const lib = new library.Library(data);
  const views = data.events!.filter((e) => e.name === "DIAGRAM_SAVED").map((e) => library.eventPayload(lib, e)!);
  assert.deepEqual(views.map(([name, body]) => [name, body.diagram_id, body.revision_no, body.op, body.name, body.kind, body.kind_name, body.actor]), [
    ["diagram_changed", "D-001", 1, "add", "读者用例", "use_case", "用例图", "executor"],
    ["diagram_changed", "D-002", 1, "add", "借书证", "class", "类图", "executor"],
    ["diagram_changed", "D-001", 2, "update", "读者用例", "use_case", "用例图", "executor"],
    ["diagram_changed", "D-002", 2, "delete", "借书证", "class", "类图", "executor"],
    ["diagram_changed", "D-003", 1, "add", "登录流程", "flowchart", "流程图", "executor"],
  ]);
  assert.ok(views.every(([, body]) => typeof body.at === "string" && typeof body.seq === "number"));
});

test("接口：图的列表、详情、没有这张图；校验通过、写错（回 200 与原因）、种类写错（拒绝）", async () => {
  const taskId = library.libraryOf(ws).taskId;
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    const send = async (method: string, path: string, body: Dict | null = null) => {
      const reply = (await dispatch(service, { method, path: `/api/v1/tasks/${taskId}${path}`, query: {}, headers: {},
        body: Buffer.from(body ? JSON.stringify(body) : ""), remote: "127.0.0.1" })) as { status: number; body: Buffer };
      return [reply.status, JSON.parse(reply.body.toString("utf-8"))] as [number, Dict];
    };
    const [listStatus, list] = await send("GET", "/diagrams");
    assert.deepEqual([listStatus, list.ok, list.diagrams.map((one: Dict) => one.diagram_id)], [200, true, ["D-001", "D-003"]]);
    const [oneStatus, one] = await send("GET", "/diagrams/D-001");
    assert.deepEqual([oneStatus, one.diagram.diagram_id, one.diagram.drawn.length, one.diagram.sources.length], [200, "D-001", 3, 4]);
    const [missingStatus, missing] = await send("GET", "/diagrams/D-404");
    assert.deepEqual([missingStatus, missing.error.message], [404, "没有图 D-404。"]);

    assert.deepEqual(await send("POST", "/diagrams/validate", { kind: "use_case", mermaid: MERMAID }), [200, { ok: true, valid: true }]);
    const [badStatus, bad] = await send("POST", "/diagrams/validate", { kind: "sequence", mermaid: "sequenceDiagram\n  A->>B: 你好\n  B-->" });
    assert.deepEqual([badStatus, bad.ok, bad.valid, bad.reason], [200, true, false, "syntax"]);
    assert.match(bad.message, /Mermaid 文本第 \d+/);
    const [mismatchStatus, mismatch] = await send("POST", "/diagrams/validate", { kind: "class", mermaid: MERMAID });
    assert.deepEqual([mismatchStatus, mismatch.valid, mismatch.reason], [200, false, "kind_mismatch"]);
    const [emptyStatus, empty] = await send("POST", "/diagrams/validate", { kind: "class" });
    assert.deepEqual([emptyStatus, empty.valid, empty.reason], [200, false, "empty"]);
    const [kindStatus, kind] = await send("POST", "/diagrams/validate", { kind: "用例图", mermaid: MERMAID });
    assert.deepEqual([kindStatus, kind.error.code, kind.error.data], [422, "rejected", { field: "kind" }]);
    assert.match(kind.error.message, /图的种类要写 use_case、class、state、sequence、flowchart 里的一个，收到的是 "用例图"。/);
  } finally {
    await service.close();
  }
});

test("助手说明里教的写法（条目编号写在节点的文字里、节点的名字只用字母数字）五种图都通过校验，扫得出条目编号", async () => {
  const texts: Record<string, string> = {
    use_case: 'flowchart LR\n  buyer(["买家"])\n  subgraph 商城\n    r1(["UC-001 提交申请"])\n    r2(["UC-002 查看进度"])\n  end\n  buyer --> r1\n  r1 -. 包含 .-> r2',
    class: 'classDiagram\n  class Order["UC-001 订单"]\n  class Refund["UC-002 退款单"]\n  Order "1" --> "0..1" Refund : 产生',
    state: 'stateDiagram-v2\n  state "UC-001 待审核" as s1\n  state "UC-002 已退款" as s2\n  [*] --> s1\n  s1 --> s2 : 审核通过',
    sequence: 'sequenceDiagram\n  participant b as 买家\n  participant s as UC-001 退款服务\n  b->>s: UC-002 提交申请\n  s-->>b: 受理',
    flowchart: 'flowchart TD\n  a["UC-001 提交申请"] --> c{"金额大于 500？"}\n  c -- 是 --> d["UC-002 主管复核"]\n  c -- 否 --> e(["结束"])',
  };
  for (const [kind, text] of Object.entries(texts)) {
    assert.deepEqual(await validateDiagram(kind, text), { ok: true }, kind);
    assert.deepEqual(drawnItemIds(text, ["UC"]), ["UC-001", "UC-002"], kind);
  }
});

test("后端校验模块与助手一侧的种类清单相同", () => {
  assert.deepEqual([...DIAGRAM_KINDS], [...AGENT_KINDS]);
});

/** 一个接着假 pi 的执行者：发给它的命令记下来，/tw-user 一律回报成功。校验换成 check。 */
function editing(check: (kind: unknown, text: unknown) => Promise<DiagramCheck>) {
  const executor = new Executor(library.libraryOf(ws).taskId, ws, join(tmp, "runs-edit"), {}, new Hub(ws));
  const calls: string[] = [];
  const asked: [unknown, unknown][] = [];
  const pi = {
    alive: () => true,
    note() {},
    async request(command: string, fields: Dict = {}) {
      const message = String(fields.message ?? "");
      if (command === "prompt" && message.startsWith("/tw-user ")) {
        calls.push(message);
        const body = JSON.parse(message.slice("/tw-user ".length));
        setTimeout(() => void (executor as any).handle(this, { type: "界面请求", method: "setStatus", status_key: "taskwright-user-result", status_text: JSON.stringify({ op_id: body.op_id, ok: true }) }), 5);
      }
      if (command === "get_state") return { isCompacting: false, sessionName: "有名字" };
      return {};
    },
    async getState() {
      return this.request("get_state");
    },
  };
  executor.pi = pi as any;
  executor.state = "idle";
  executor.activeSession = "S1";
  const saved = executorSettings.validateDiagram;
  executorSettings.validateDiagram = async (kind, text) => { asked.push([kind, text]); return check(kind, text); };
  return { executor, calls, asked, restore: () => { executorSettings.validateDiagram = saved; } };
}

const edit = (id: string, mermaid: unknown, base = 2): Dict =>
  ({ client_id: "c1", kind: "edit_diagram", task_id: "不核对", targets: [{ diagram_id: id, base_revision: base }], fields: { mermaid }, notify_executor: false });

test("用户改图：任务服务先校验（种类用这张图现在的），通过了才转交助手一侧；转交的命令只带五个键与操作编号", async () => {
  const { executor, calls, asked, restore } = editing(async () => ({ ok: true }));
  try {
    const text = `${MERMAID}\n  a --> b`;
    const opId = await executor.action("S1", { ...edit("D-001", text), force: true });
    assert.match(opId, /^ui-op-[0-9a-f]{12}$/);
    assert.deepEqual(asked, [["use_case", text]]);
    assert.deepEqual(calls.map((one) => JSON.parse(one.slice("/tw-user ".length))), [
      { kind: "edit_diagram", task_id: "不核对", targets: [{ diagram_id: "D-001", base_revision: 2 }], fields: { mermaid: text }, notify_executor: false, op_id: opId },
    ]);
  } finally {
    restore();
  }
});

test("用户改图：校验不过、校验没有做成，都拒绝并不转交；说明里是校验给的原话或者一句「程序这边的问题」", async () => {
  const syntax: DiagramCheck = { ok: false, reason: "syntax", line: 2, message: "Mermaid 文本第 2 行附近写得不对，改了再存。解析时的原话：Parse error on line 2" };
  const down: DiagramCheck = { ok: false, reason: "unavailable", line: null, message: "这一次没有办法校验 Mermaid 文本（校验引擎加载不了）。这是程序这边的问题，不是文本写错了，请告诉用户。" };
  for (const [check, text] of [[syntax, `${DIAGRAM_NOT_SAVED_TEXT}${syntax.message}`], [down, DIAGRAM_UNCHECKED_TEXT]] as const) {
    const { executor, calls, restore } = editing(async () => check);
    try {
      await assert.rejects(executor.action("S1", edit("D-001", "flowchart LR\n  a(")), (e: ApiError) => e.status === 422 && e.code === "rejected" && e.message === text
        && (e.data as Dict).reason === check.reason && (e.data as Dict).line === check.line && (e.data as Dict).message === check.message);
      assert.deepEqual(calls, []);
    } finally {
      restore();
    }
  }
  assert.equal(DIAGRAM_UNCHECKED_TEXT, "这一次没有办法校验 Mermaid 文本，图没有保存。这是程序这边的问题，不是文本写错了。");
});

test("用户改图：没有这张图、图已经删除、请求写得不对，不校验也不转交；助手工作中先按单一写入者拒绝", async () => {
  const { executor, calls, asked, restore } = editing(async () => ({ ok: true }));
  try {
    for (const id of ["D-009", "D-002"]) {
      await assert.rejects(executor.action("S1", edit(id, "flowchart LR\n  a --> b")), (e: ApiError) => e.code === "rejected" && e.message === `图 ${id} 不存在或已经删除。`);
    }
    for (const body of [{ ...edit("D-001", 5) }, { ...edit("D-001", "x"), targets: [] }, { ...edit("D-001", "x"), targets: [{ item_id: "UC-001", base_revision: 1 }] }, { ...edit("D-001", "x"), fields: null }]) {
      await assert.rejects(executor.action("S1", body), (e: ApiError) => e.status === 400 && e.code === "bad_request", JSON.stringify(body));
    }
    executor.state = "working";
    await assert.rejects(executor.action("S1", edit("D-001", "flowchart LR\n  a --> b")), (e: ApiError) => e.code === "session_busy");
    assert.deepEqual([calls, asked], [[], []]);
  } finally {
    restore();
  }
});
