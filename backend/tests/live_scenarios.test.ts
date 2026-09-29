/**
 * 起真的后端进程与真的 pi（模型换成进程内的假端点），把一条操作从接口一路走到任务库、再从事件连接推回页面的三种情形：
 * 1. 两个任务同时各开一个助手：各自的事件连接只收到本任务的事件，各自的库只有本任务的写入。
 * 2. 评审之后保留写法、撤销保留、改评审规则、改完之后再评审：几种界面操作经助手的程序写进库，推出相应的库事件与界面操作记录；
 *    改规则之前同一次修订再评审被拒。
 * 3. 助手工作中途让它停下：停下请求返回 cleared（对话严格轮替，总是空的），这一轮的摘要与结束消息的结束原因都是 stopped_by_user，
 *    两处的步数相同。
 * 后端测试里别的几份用假的 pi 或直接喂事件，只核对各自那一段；这三种要整条链路一起走才看得到。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, reply, sleep, withStack } from "./consent_stack.ts";

captureConsole();
// 助手的程序不出网查模型目录
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const source = { kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL };
const save = (id: string, name: string) => ({ tool_calls: [{ id, name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例",
  sources: [source], fields: { 用例名称: name, 用例功能: `读者${name}。`, 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } }] } }] });

/** 订阅一条事件连接，把收到的事件按先后收进 events（每项是 {event, data}）。 */
function subscribe(port: number, path: string): { events: Dict[]; close: () => void } {
  const events: Dict[] = [];
  let buffer = "";
  const req = request({ host: "127.0.0.1", port, path }, (res) => {
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.end();
  return { events, close: () => req.destroy() };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30000): Promise<void> {
  for (const end = Date.now() + ms; !(await ok());) {
    if (Date.now() > end) throw new Error(`等${what}超时`);
    await sleep(100);
  }
}

test("两个任务同时各开一个助手：各自的事件连接只收到本任务的事件，各自的库只有本任务的写入", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "two-tasks", { sequence: [save("call-a", "借书"), reply("存好了。", "call-a-done"), save("call-b", "还书"), reply("存好了。", "call-b-done")] },
    async ({ call, taskId, session, port, pid, db, send }) => {
      const other: string = (await call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "另一个任务" })).body.task_id;
      writeFileSync(join(tmp, "two-tasks", "tasks", other, "inputs", "材料.md"), `${MATERIAL}\n`, "utf-8");
      const otherSession: string = (await call("POST", `/api/v1/tasks/${other}/sessions`)).body.session_id;
      const pis = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" }).stdout.split("\n").filter(Boolean);
      assert.equal(pis.length, 2, "两个任务各有一个助手的程序在运行");

      const first = subscribe(port, `/api/v1/tasks/${taskId}/events`);
      const second = subscribe(port, `/api/v1/tasks/${other}/events`);
      try {
        await sleep(300);
        await send({ text: "把材料整理成用例。", client_id: "c-1" });
        const said = await call("POST", `/api/v1/tasks/${other}/messages?session=${otherSession}`, { text: "把材料整理成用例。", client_id: "c-2" });
        assert.equal(said.status, 200);
        await until("另一个任务的这一轮做完", () => second.events.some((e) => e.event === "work_ended"));
        await until("两边的修订事件都到", () => first.events.some((e) => e.event === "deliverable_changed")
          && second.events.some((e) => e.event === "deliverable_changed"));

        const library = (list: Dict[]) => list.filter((e) => typeof e.data.seq === "number");
        assert.ok(library(first.events).every((e) => e.data.task_id === taskId), "第一个任务的连接只收到本任务的库事件");
        assert.ok(library(second.events).every((e) => e.data.task_id === other), "另一个任务的连接只收到本任务的库事件");
        const sessions = (list: Dict[]) => new Set(list.map((e) => e.data.session_id).filter(Boolean));
        assert.deepEqual([...sessions(first.events)], [session], "第一个任务的连接只收到本任务会话的过程事件");
        assert.deepEqual([...sessions(second.events)], [otherSession], "另一个任务的连接只收到本任务会话的过程事件");

        assert.deepEqual(db("SELECT DISTINCT task_id FROM event").map((r: Dict) => r.task_id), [taskId]);
        assert.deepEqual(db("SELECT call_id FROM revision").map((r: Dict) => r.call_id), ["call-a"], "第一个任务的库只有自己那次保存");
        const otherDb = JSON.parse(spawnSync(process.execPath, ["-e",
          `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});` +
          `console.log(JSON.stringify(db.prepare("SELECT call_id, task_id FROM revision").all()))`,
          join(tmp, "two-tasks", "tasks", other, "task.sqlite")], { encoding: "utf-8" }).stdout);
        assert.deepEqual(otherDb, [{ call_id: "call-b", task_id: other }], "另一个任务的库只有自己那次保存");
      } finally {
        first.close();
        second.close();
      }
    }));

const FINDING = { 规则: "UC-R1", 字段: "用例名称", 序号: null, 问题: "用例名称没有写出参与者的目的。", 建议: "写成动词加对象。" };

test("评审不合规之后保留写法、撤销保留、改评审规则、再评审：经助手的程序写进库，推出库事件与界面操作记录；规则没改时再评被拒", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "review", {
    rules: [
      { when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [FINDING] }) }, max_uses: 1 },
      { when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [] }) } },
    ],
    sequence: [save("call-save", "借书"), reply("存好了。", "call-done")],
  }, async ({ port, session, taskId, db, send, action }) => {
    await send({ text: "把材料整理成用例。", client_id: "c-1" });
    const stream = subscribe(port, `/api/v1/tasks/${taskId}/events?session=${session}`);
    const target = [{ item_id: "UC-001", base_revision: 1 }];
    const finished = () => stream.events.filter((e) => e.event === "review_finished").length;
    try {
      await sleep(300);
      assert.equal((await action({ kind: "request_review", targets: [] })).status, 200);
      await until("第一次评审做完", () => finished() === 1);
      assert.deepEqual(db("SELECT verdict FROM review").map((r: Dict) => r.verdict), ["不合规"]);

      const again = await action({ kind: "request_review", targets: target });
      assert.deepEqual([again.status, again.body.error.code], [422, "rejected"]);
      assert.match(again.body.error.message, /同一次修订、同一套规则只评审一次/);

      assert.equal((await action({ kind: "waive_review", targets: target, fields: { reason: "流程另有规定", source: "panel" } })).status, 200);
      assert.equal((await action({ kind: "unwaive_review", targets: target })).status, 200);
      assert.equal((await action({ kind: "set_review_rules", fields: { collection: "功能用例", off: ["UC-R2"], promote: [] } })).status, 200);
      assert.equal((await action({ kind: "request_review", targets: [] })).status, 200);
      await until("改规则之后的评审做完", () => finished() === 2);
      await until("界面操作记录都到", () => stream.events.filter((e) => e.event === "ui_action_noted").length >= 5);

      const names = stream.events.map((e) => e.event);
      const order = ["review_recorded", "review_waived", "review_unwaived", "review_rules_changed", "review_recorded"];
      let at = -1;
      for (const name of order) {
        at = names.indexOf(name, at + 1);
        assert.ok(at >= 0, `按先后收到 ${order.join("、")}，缺 ${name}：${names.join("、")}`);
      }
      const recorded = stream.events.filter((e) => e.event === "review_recorded").map((e) => e.data.verdict);
      assert.deepEqual(recorded, ["不合规", "合规"]);
      assert.deepEqual(stream.events.find((e) => e.event === "review_waived")!.data.items, [{ item_id: "UC-001", revision_no: 1 }]);
      assert.deepEqual(stream.events.find((e) => e.event === "review_rules_changed")!.data.off, ["UC-R2"]);
      assert.deepEqual(stream.events.filter((e) => e.event === "ui_action_noted").map((e) => e.data.kind),
        ["request_review", "waive_review", "unwaive_review", "set_review_rules", "request_review"]);
      assert.deepEqual(db("SELECT revoked_at IS NOT NULL AS revoked FROM review_waiver").map((r: Dict) => r.revoked), [1], "保留写进库，又被撤销");
    } finally {
      stream.close();
    }
  }));

test("助手工作中途让它停下：返回的 cleared 是空的，这一轮的摘要与结束消息都是 stopped_by_user，步数相同", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "stop", { sequence: [{ ...save("call-save", "借书"), delay: 8 }] }, async ({ call, port, session, taskId }) => {
    const stream = subscribe(port, `/api/v1/tasks/${taskId}/events?session=${session}`);
    try {
      await sleep(300);
      assert.equal((await call("POST", `/api/v1/tasks/${taskId}/messages?session=${session}`, { text: "把材料整理成用例。", client_id: "c-1" })).status, 200);
      await until("助手开始工作", () => stream.events.some((e) => e.event === "executor_state" && e.data.state === "working"));
      const stopped = await call("POST", `/api/v1/tasks/${taskId}/control?session=${session}`, { action: "stop" });
      assert.deepEqual(stopped, { status: 200, body: { ok: true, cleared: [] } });
      await until("这一轮结束", () => stream.events.some((e) => e.event === "work_ended"));
      const summary = stream.events.find((e) => e.event === "work_summary")!.data;
      const ended = stream.events.find((e) => e.event === "work_ended")!.data;
      assert.deepEqual([summary.outcome, ended.outcome], ["stopped_by_user", "stopped_by_user"]);
      assert.equal(ended.step_count, summary.step_count);
      assert.equal(stream.events.filter((e) => e.event === "problem").length, 0, "被停下时不提示");
    } finally {
      stream.close();
    }
  }));
