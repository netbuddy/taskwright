/**
 * 工作的阶段从头走一遍，五个阶段各有一次运行（真的后端进程与真的 pi，模型换成进程内的假端点）。往前的每一步都由用户在卡片上点：
 * 核读材料时助手立页、想写用例被拦，发「进入澄清」的卡片 → 用户点了，助手发「进入整理建模」的卡片 → 用户点了，助手发「开始写条目」的卡片 →
 * 用户看过那一页、点了，助手写用例，想在回复里自己移到评审确认（被退回，回复照常送达），同一条回复带着「进入评审确认」的卡片 → 用户点了 →
 * 用户看过用例、发起评审 → 助手发是否完成的卡片、用户点了之后发布第 1 版。
 * 核对的是整条链路：库里的活动记录、被拦的那次调用留下的原话、接口给的整份数据里的 stage、事件连接推出的 activity_started，
 * 以及每一次运行里模型收到的系统提示只有那个阶段的一段。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { after, test } from "node:test";
import { captureConsole, movesSql, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, TOPIC_CALL, reply, sleep, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const USE_CASE = { op: "add", collection: "功能用例", sources: [{ kind: "条目", locator: "OA-001", excerpt: MATERIAL }],
  fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } };
const save = (id: string, operations: unknown[]) => ({ tool_calls: [{ id, name: "save_revision", arguments: { operations } }] });
const CLARIFY_CARD = { kind: "choose", text: "材料读完了，接下来我一件一件问你。现在进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
  options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "继续本阶段" }] };
const MODEL_CARD = { kind: "choose", text: "要问的都问到了，接下来我把主题页通读一遍。现在进入整理建模吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
  options: [{ key: "enter_consolidate", text: "进入整理建模" }, { key: "continue_clarify", text: "继续本阶段" }] };
const START_CARD = { kind: "choose", text: "这一页你看过之后，现在开始写条目吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
  options: [{ key: "start_items", text: "开始写条目" }, { key: "continue_consolidate", text: "继续本阶段" }] };
const REVIEW_CARD = { kind: "choose", text: "用例写好了，接下来请你逐条看、发起评审。现在进入评审确认吗？", items: [{ item_id: "UC-001", revision_no: 2 }],
  options: [{ key: "enter_review", text: "进入评审确认" }, { key: "continue_writing", text: "继续本阶段" }] };
const DONE_CARD = { kind: "choose", text: "功能用例一共 1 个条目，已经评审通过，你也看过了。这个任务是否已经完成、可以发布了？发布之后仍然可以接着修改。",
  options: [{ key: "complete", text: "已完成，发布版本" }, { key: "continue", text: "还没完成，继续修改" }] };
const SCRIPT = {
  rules: [{ when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [] }) } }],
  sequence: [
    // 第一句话：立一页主题；接着想写用例（还在核读材料，被拦）；然后发「进入澄清」的卡片。
    { tool_calls: [TOPIC_CALL] },
    save("call-early", [USE_CASE]),
    reply("材料读完了，我立了一页主题。现在进入澄清吗？", "call-clarify", CLARIFY_CARD),
    // 用户点了「进入澄清」：发「进入整理建模」的卡片。
    reply("要问的都问到了。现在进入整理建模吗？", "call-model", MODEL_CARD),
    // 用户点了「进入整理建模」：发「开始写条目」的卡片。
    reply("主题页理好了。这一页你看过之后，现在开始写条目吗？", "call-start", START_CARD),
    // 用户点了「开始写条目」：写用例；想在回复里自己移到评审确认（stage 已经停用，这次回复被拒），再照指引只发「进入评审确认」的卡片。
    save("call-uc", [USE_CASE]),
    { tool_calls: [{ id: "call-wrote-stage", name: "reply", arguments: { informs: [], act: REVIEW_CARD, text: "写好了一个用例。现在进入评审确认吗？", stage: "评审确认", reason: "条目写完了。" } }] },
    reply("写好了一个用例。现在进入评审确认吗？", "call-wrote", REVIEW_CARD),
    // 用户点了「进入评审确认」。
    reply("请逐条打开看，再在界面上点「评审」。", "call-review"),
    // 用户说发布：发是否完成的卡片；用户点了之后发布版本。
    reply("完成条件都满足了，请在卡片上选。", "call-card", DONE_CARD),
    { tool_calls: [{ id: "call-complete", name: "publish_version", arguments: {} }] },
    reply("任务已经完成。", "call-done"),
  ],
};

/** 订阅任务的事件连接，把收到的换站事件（node_entered）收进来。 */
function stageEvents(port: number, taskId: string): { events: Dict[]; close: () => void } {
  const events: Dict[] = [];
  let buffer = "";
  const req = request({ host: "127.0.0.1", port, path: `/api/v1/tasks/${taskId}/events` }, (res) => {
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (/^event: node_entered$/m.test(block) && data) events.push(JSON.parse(data));
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.end();
  return { events, close: () => req.destroy() };
}

/** 一个请求里的系统消息的文字。 */
function systemText(request: Dict): string {
  const system = (request["请求体"].messages as Dict[]).find((m) => m.role === "system" || m.role === "developer");
  if (!system) return "";
  return typeof system.content === "string" ? system.content : (system.content as Dict[]).map((p) => p.text ?? "").join("");
}
const STAGE_HEADINGS = ["核读材料", "澄清", "整理建模", "写条目", "评审确认"].map((name) => `# 现在这个阶段：${name}\n`);

test("五个阶段从头走到完成：往前的每一步都由用户在卡片上点，助手在回复里写 stage 被拒；被拦的写入、整份数据里的 stage 与推出的事件；每次运行的系统提示只有那个阶段的一段", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "stages", SCRIPT, async ({ call, taskId, session, port, db, send, action, entryOfCall, requests }) => {
    let seen = 0;
    /** 上次核对之后助手这一侧新发的请求（评审者的请求不算），每一个的系统提示里都只有 name 这个阶段的一段。 */
    const promptsAre = (name: string, atLeast: number) => {
      const fresh = requests().slice(seen).filter((one) => !systemText(one).includes("你是评审者"));
      seen = requests().length;
      assert.ok(fresh.length >= atLeast, `${name}：这次运行至少有 ${atLeast} 个请求，实际 ${fresh.length} 个`);
      for (const one of fresh) {
        assert.deepEqual(STAGE_HEADINGS.filter((heading) => systemText(one).includes(heading)), [`# 现在这个阶段：${name}\n`]);
      }
    };
    const stageNow = async () => (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${session}`)).body.task.stage as Dict;
    const pushed = stageEvents(port, taskId);
    try {
      // 用户启动了需求分析（夹具做的）：停在核读材料。
      const fresh = await stageNow();
      assert.deepEqual([fresh.current, fresh.moved_by, fresh.reason, fresh.node, fresh.flow_node], ["reading", "user", "", "reading", "reading"]);

      await send({ text: "把材料整理成需求规格说明。", client_id: "c-1" });
      // 核读材料阶段写用例被拦：整批没有写入，原话留在拒绝记录里。
      const early = db("SELECT fact, guidance FROM tool_rejection WHERE call_id = 'call-early'");
      assert.equal(early.length, 1);
      assert.match(early[0].fact, /任务现在在核读材料阶段，这个阶段不能新增「功能用例」的条目/);
      assert.match(early[0].guidance, /进入写条目要由用户在卡片上选「转到：写条目」/);
      assert.deepEqual(db("SELECT item_id FROM item").map((r: Dict) => r.item_id), ["OA-001"]);
      // 助手发了卡片，任务还在核读材料：往前要等用户点。这次运行的三个请求拿到的都是核读材料的那一段。
      assert.equal((await stageNow()).current, "reading");
      promptsAre("核读材料", 3);

      // 用户在卡片上点「进入澄清」：记一条用户的移动。
      await send({ text: "我选：进入澄清", client_id: "c-clarify", origin: "card_choice", card: { reply_message_id: entryOfCall("call-clarify"), kind: "choose", choice: "enter_clarify" } });
      const clarifying = await stageNow();
      assert.deepEqual([clarifying.current, clarifying.moved_by, clarifying.reason], ["clarifying", "user", "用户在卡片上选了「进入澄清」"]);
      assert.equal(clarifying.lamps.reading[0].ok, true, "材料被那一页引用了");
      // 扩展先记移动、再代发那句固定的话：这句话引起的运行拿到的已经是澄清的那一段。
      promptsAre("澄清", 1);

      // 用户在卡片上点「进入整理建模」。
      await send({ text: "我选：进入整理建模", client_id: "c-model", origin: "card_choice", card: { reply_message_id: entryOfCall("call-model"), kind: "choose", choice: "enter_consolidate" } });
      assert.equal((await stageNow()).current, "modeling");
      promptsAre("整理建模", 1);

      // 用户看过那一页，在卡片上点「开始写条目」：助手随后写出用例。
      assert.equal((await action({ kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] })).status, 200);
      await send({ text: "我选：开始写条目", client_id: "c-2", origin: "card_choice", card: { reply_message_id: entryOfCall("call-start"), kind: "choose", choice: "start_items" } });
      assert.deepEqual(db("SELECT item_id FROM item ORDER BY rowid").map((r: Dict) => r.item_id), ["OA-001", "UC-001"]);
      // 助手在回复里写了 stage「评审确认」：回复的参数里已经没有这一项，按多出来的项被拒、阶段没有动；助手改发卡片。
      assert.equal((await stageNow()).current, "writing");
      const refusedReply = db("SELECT tool_name, fact, guidance FROM tool_rejection ORDER BY rowid").at(-1) as Dict;
      assert.equal(refusedReply.tool_name, "reply");
      assert.match(refusedReply.fact, /多了「stage」这一项，回复只有 informs、act、text 三项/);
      promptsAre("写条目", 3);

      // 用户在卡片上点「进入评审确认」。
      await send({ text: "我选：进入评审确认", client_id: "c-review", origin: "card_choice", card: { reply_message_id: entryOfCall("call-wrote"), kind: "choose", choice: "enter_review" } });
      const reviewing = await stageNow();
      assert.deepEqual([reviewing.current, reviewing.moved_by, reviewing.reason], ["reviewing", "user", "用户在卡片上选了「进入评审确认」"]);
      assert.deepEqual(db(movesSql(["from_stage", "stage", "actor", "reason", "run_id"])).slice(1), [
        { from_stage: "reading", stage: "clarifying", actor: "user", reason: "用户在卡片上选了「进入澄清」", run_id: null },
        { from_stage: "clarifying", stage: "modeling", actor: "user", reason: "用户在卡片上选了「进入整理建模」", run_id: null },
        { from_stage: "modeling", stage: "writing", actor: "user", reason: "用户在卡片上选了「开始写条目」", run_id: null },
        { from_stage: "writing", stage: "reviewing", actor: "user", reason: "用户在卡片上选了「进入评审确认」", run_id: null },
      ]);

      // 用户看过用例、发起评审；评审做完之后说完成，在卡片上点同意：任务完成。
      assert.equal((await action({ kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 2 }] })).status, 200);
      assert.equal((await action({ kind: "request_review", targets: [] })).status, 200);
      for (const end = Date.now() + 30000; db("SELECT 1 FROM event WHERE name = 'REVIEW_FINISHED'").length === 0;) {
        if (Date.now() > end) throw new Error("评审没有做完");
        await sleep(100);
      }
      await send({ text: "都看过了，发布吧。", client_id: "c-3" });
      await send({ text: "我选：已完成，发布版本", client_id: "c-4", origin: "card_choice", card: { reply_message_id: entryOfCall("call-card"), kind: "choose", choice: "complete" } });
      assert.deepEqual(db("SELECT version_no, actor FROM version_record").map((r: Dict) => ({ ...r })), [{ version_no: 1, actor: "executor" }]);
      promptsAre("评审确认", 4);
      assert.deepEqual(db("SELECT tool_name FROM tool_rejection ORDER BY rowid").map((r: Dict) => r.tool_name), ["save_revision", "reply"], "除了核读材料时那一次与写了 stage 的那次回复，没有别的调用被拦");

      // 事件连接推出了四次换站（启动需求分析是夹具在订阅之前做的），都是同一个工作项的、往前的，序号与库里的事件相同。
      for (const end = Date.now() + 10000; pushed.events.length < 4 && Date.now() < end;) await sleep(100);
      assert.deepEqual(pushed.events.map((e) => [e.record_id, e.from, e.node, e.direction, e.actor]),
        [[1, "reading", "clarifying", "forward", "user"], [1, "clarifying", "modeling", "forward", "user"], [1, "modeling", "writing", "forward", "user"], [1, "writing", "reviewing", "forward", "user"]]);
      assert.deepEqual(pushed.events.map((e) => e.seq), db("SELECT seq FROM event WHERE name = 'ACTIVITY_NODE_ENTERED' ORDER BY seq").map((r: Dict) => r.seq));
      // 整个过程只有一个工作项：流程换站不另开一行。
      assert.deepEqual(db("SELECT record_id, flow, activity FROM activity_record"), [{ record_id: 1, flow: "analysis", activity: "reviewing" }]);
    } finally {
      pushed.close();
    }
  }, { seed: false }));
