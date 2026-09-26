/** 任务现状消息：新会话写现状，续接写上次之后的变化，没有变化不写；会话事实从分支条目读出。 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { ACTOR_USER } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { listMaterials, materialsSentence, taskStatusMessage } from "../src/lib/task_status.ts";
import { sessionFacts } from "../src/hooks/task_status.ts";
import { projectionParagraphs } from "../src/lib/docx_source.ts";
import { SEGMENTS_ENV } from "../src/lib/segments.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { DEFINITION_PATH, MATERIAL_TEXT, SAMPLE_DOCX, SOURCE, callIn, makeWorkspace, projection, putSampleDocx } from "./helpers.ts";

const addUseCase = (name: string) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["一步"] }, sources: [SOURCE] });
const addTbd = (text: string) => ({ op: "add", collection: "问题", fields: { 事项: text, 状态: "未解决" }, sources: [SOURCE] });
const FRESH = { hasUserMessage: false, hasStatusMessage: false, lastMessageAt: null };

test("没有库、库里没有任务时不写", () => {
  assert.equal(taskStatusMessage(makeWorkspace(), FRESH, "s"), null);
});

test("新会话写任务现状：任务名与类型、按集合的条目数、完成条件满足几项、未解决的问题条目几条", () => {
  const dir = makeWorkspace();
  createTask({ ...callIn(dir), sessionId: "", callId: "ui-op-1", actor: ACTOR_USER }, { definition_path: DEFINITION_PATH, task_name: "登录模块" });
  const empty = taskStatusMessage(dir, FRESH, "s")!;
  assert.equal(empty.kind, "现状");
  assert.match(empty.text, /^【执行者开始这条会话时（\d\d:\d\d:\d\d）的任务状况：由扩展写入，不是用户打的字】任务「登录模块」（类型：演示任务），任务编号 TASK-001，状态是进行中。交付物还没有任何条目。要完成任务，还差 1 项：用例至少要有一个条目。未解决的问题条目有 0 条。/);
  saveRevision(callIn(dir), { operations: [addUseCase("登录"), addUseCase("注销"), addTbd("口令长度？")] });
  const message = taskStatusMessage(dir, FRESH, "s")!;
  assert.match(message.text, /交付物现有 3 个条目：用例 2 个、问题 1 个。/);
  // 演示定义的完成条件：用例三项（至少一个条目满足，评审与确认不满足），问题一项（有未解决的，不满足）。
  assert.match(message.text, /要完成任务，还差 3 项：用例每个条目评审通过（还差 UC-001、UC-002）；用例每个条目用户确认（还差 UC-001、UC-002）；问题没有状态为未解决的条目（还差 TBD-001）。未解决的问题条目有 1 条。/);
  assert.deepEqual(message.details.items, { 用例: 2, 问题: 1 });
});

test("续接：上次之后的新增、修改、删除按条目合并，写明来自几次修订、谁做的；没有变化返回 null", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [addUseCase("登录"), addUseCase("注销"), addUseCase("找回口令")] });
  const last = Date.now() + 5;   // 这条会话最后一条消息的时刻
  const facts = { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: last };
  assert.equal(taskStatusMessage(dir, facts, "s"), null, "之后什么都没发生，不追加");
  const later = Date.now();
  while (Date.now() <= last + 2) { /* 等过这条会话最后一刻，让之后的事件时刻一定更晚 */ }
  saveRevision({ ...callIn(dir), callId: "ui-op-2", actor: ACTOR_USER },
    { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  saveRevision(callIn(dir, "other-session"), {
    operations: [
      { op: "update", item: "UC-001", base_revision: 2, fields: { 名称: "用口令或短信登录" } },
      { op: "delete", item: "UC-003", base_revision: 1 },
      addUseCase("修改口令"),
    ],
  });
  saveRevision(callIn(dir, "other-session"), { operations: [addTbd("临时"), { op: "delete", item: "UC-004", base_revision: 3 }] });
  saveRevision(callIn(dir, "other-session"), { operations: [{ op: "delete", item: "TBD-001", base_revision: 4 }] });
  const message = taskStatusMessage(dir, facts, "s")!;
  assert.ok(later > 0);
  assert.equal(message.kind, "变化");
  assert.equal(
    message.text.replace(/（\d\d:\d\d:\d\d）/, "（时刻）"),
    "【执行者续接这条会话时（时刻）看到的、上次之后交付物的变化：由扩展写入，不是用户打的字】" +
      "修改 1 个（UC-001 修订 1 → 修订 3）；删除 1 个（UC-003）。" +
      "这些改动来自 4 次修订：用户在界面上直接做的 1 次，执行者在别的会话里做的 3 次。" +
      `材料目录 inputs/ 里有 1 个文件：inputs/材料.md（${Buffer.byteLength(MATERIAL_TEXT)} 字节）。` +
      "材料的引用情况：inputs/材料.md 被引用过 2 次。",
  );
  assert.deepEqual(message.details.added, []);
});

test("会话事实：有没有用户消息、有没有写过现状消息、最后一条消息的时刻（不算设置条目）", () => {
  const facts = sessionFacts([
    { type: "model_change", timestamp: "2026-09-22T01:00:09.000Z" },
    { type: "custom_message", customType: "taskwright-task-status", timestamp: "2026-09-22T01:00:00.000Z" },
    { type: "message", message: { role: "user" }, timestamp: "2026-09-22T01:00:01.000Z" },
    { type: "message", message: { role: "assistant" }, timestamp: "2026-09-22T01:00:02.000Z" },
    { type: "thinking_level_change", timestamp: "2026-09-22T01:00:10.000Z" },
  ]);
  assert.deepEqual(facts, { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: Date.parse("2026-09-22T01:00:02.000Z") });
  assert.deepEqual(sessionFacts([{ type: "model_change", timestamp: "2026-09-22T01:00:09.000Z" }]), FRESH);
});

test("新会话的现状列出材料目录里的文件名与大小，不列隐藏文件与子目录；没有文件也明说", () => {
  const dir = makeWorkspace(undefined, { material: false });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  assert.match(taskStatusMessage(dir, FRESH, "s")!.text, /材料目录 inputs\/ 里现在没有文件。$/);
  mkdirSync(join(dir, "inputs/旧稿"), { recursive: true });
  writeFileSync(join(dir, "inputs/借阅需求.md"), "读者可以借书。\n".repeat(200), "utf-8");
  writeFileSync(join(dir, "inputs/补充说明.txt"), "续借一次。", "utf-8");
  writeFileSync(join(dir, "inputs/.DS_Store"), "x");
  const message = taskStatusMessage(dir, FRESH, "s")!;
  assert.match(message.text, /材料目录 inputs\/ 里有 2 个文件：inputs\/借阅需求\.md（4\.3 KB）、inputs\/补充说明\.txt（15 字节）。$/);
  assert.deepEqual(message.details.materials, {
    dir: "inputs/",
    files: [{ path: "inputs/借阅需求.md", bytes: 4400 }, { path: "inputs/补充说明.txt", bytes: 15 }],
    citations: [{ path: "inputs/借阅需求.md", cited: 0 }, { path: "inputs/补充说明.txt", cited: 0 }],
  });
});

test("续接：交付物没有变化但有上次之后新放进来的材料时，只写材料；旧材料不算新", () => {
  const dir = makeWorkspace(undefined, { material: false });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  mkdirSync(join(dir, "inputs"));
  writeFileSync(join(dir, "inputs/旧材料.md"), "旧", "utf-8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "inputs/旧材料.md"), old, old);
  const facts = { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: Date.now() - 1000 };
  assert.equal(taskStatusMessage(dir, facts, "s"), null, "只有旧材料，不追加");
  writeFileSync(join(dir, "inputs/新材料.md"), "新", "utf-8");
  const message = taskStatusMessage(dir, facts, "s")!;
  assert.equal(
    message.text.replace(/（\d\d:\d\d:\d\d）/, "（时刻）"),
    "【执行者续接这条会话时（时刻）看到的、上次之后交付物的变化：由扩展写入，不是用户打的字】交付物没有变化。" +
      "材料目录 inputs/ 里有 2 个文件：inputs/新材料.md（3 字节）、inputs/旧材料.md（3 字节）。其中上次之后新放进来的是：inputs/新材料.md。" +
      "材料的引用情况：inputs/新材料.md 被引用过 0 次；inputs/旧材料.md 被引用过 0 次。",
  );
  assert.deepEqual(message.details.new_materials, ["inputs/新材料.md"]);
  assert.deepEqual(listMaterials(dir, "inputs/").files.map((f) => f.path), ["inputs/新材料.md", "inputs/旧材料.md"]);
});

test("材料清单里有 Word 文件与它的投影时，另加一句：读投影，出处写 Word 文件加段落号；0.2 的 .txt 投影也认", () => {
  const files = [
    { path: "inputs/需求.docx", bytes: 2048, modifiedAt: 0 },
    { path: "inputs/需求.docx.md", bytes: 100, modifiedAt: 0 },
    { path: "inputs/补充.md", bytes: 3, modifiedAt: 0 },
  ];
  assert.equal(materialsSentence({ dir: "inputs/", files }),
    "材料目录 inputs/ 里有 3 个文件：inputs/需求.docx（2.0 KB）、inputs/需求.docx.md（100 字节）、inputs/补充.md（3 字节）。" +
    "其中 inputs/需求.docx 是 Word 文件，请读由它生成的投影 inputs/需求.docx.md（每段一行，段落号写在方括号里）；引用它作来源时，出处写 Word 文件加段落号，例如 inputs/需求.docx#p12。");
  const legacy = [files[0], { path: "inputs/需求.docx.txt", bytes: 100, modifiedAt: 0 }];
  assert.match(materialsSentence({ dir: "inputs/", files: legacy }), /请读由它生成的投影 inputs\/需求\.docx\.txt（/);
  // 没有投影的 .docx 不加这一句
  assert.doesNotMatch(materialsSentence({ dir: "inputs/", files: files.slice(0, 1) }), /Word 文件/);
});

test("Word 材料：现状写段数、块数与分段清单；续接写还有几段没有被引用（跨段的摘录算到跨过的每一段，删掉的条目与旧修订不算）", () => {
  const dir = makeWorkspace(undefined, { material: false });
  mkdirSync(join(dir, "inputs"));
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  putSampleDocx(dir);
  const fresh = taskStatusMessage(dir, FRESH, "s")!;
  assert.match(fresh.text, /inputs\/requirements-styled\.docx 共 108 段有文字（段落号 1 到 114）、11 块，分段清单见 inputs\/requirements-styled\.docx\.segments\.json。$/);
  assert.ok(existsSync(join(dir, "inputs/requirements-styled.docx.segments.json")), "读的时候清单不在，就算好写回");
  const paragraphs = projectionParagraphs(projection());
  const at = (n: number, excerpt: string) => ({ kind: "文档原文", locator: `${SAMPLE_DOCX}#p${n}`, excerpt });
  // UC-001 引 p7 末尾接到 p8 开头（跨两段）；UC-002 引 p25，之后改成引 p81；UC-003 引 p110，之后删掉。
  const span = paragraphs[6].slice(-6) + paragraphs[7].slice(0, 6);
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "借书", 步骤: ["一步"] }, sources: [at(7, span)] },
    { op: "add", collection: "用例", fields: { 名称: "刷卡", 步骤: ["一步"] }, sources: [at(25, paragraphs[24])] },
    { op: "add", collection: "用例", fields: { 名称: "待定", 步骤: ["一步"] }, sources: [at(110, paragraphs[109])] },
  ] });
  saveRevision(callIn(dir), { operations: [
    { op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "预约" }, sources: [at(81, paragraphs[80])] },
    { op: "delete", item: "UC-003", base_revision: 1 },
  ] });
  const last = Date.now() - 60_000;
  const message = taskStatusMessage(dir, { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: last }, "s")!;
  // p7、p8 由 UC-001 引，p25（UC-002 的旧来源仍被沿用，改名不改来源）与 p81 由 UC-002 引；p110 的条目删掉了。
  assert.match(message.text, /材料的引用情况：inputs\/requirements-styled\.docx 还有 104 段没有被任何条目引用。$/);
  assert.deepEqual(message.details.materials, {
    dir: "inputs/",
    files: listMaterials(dir, "inputs/").files.map((f) => ({ path: f.path, bytes: f.bytes })),
    citations: [{ path: SAMPLE_DOCX, text_paragraphs: 108, blocks: 11, uncited: 104 }],
  });
  const status = getTaskStatus(dir);
  const lines = status.text.split("\n");
  const head = lines.findIndex((l) => l.startsWith("材料的分段与引用情况"));
  assert.deepEqual(lines.slice(head + 1, head + 4), [
    "  inputs/requirements-styled.docx（读 inputs/requirements-styled.docx.md）：共 108 段有文字、11 块，还有 104 段没有被任何条目引用。",
    "    第 1 块 p1–p5（第 10–18 行）（第一个标题之前）：5 段，被 0 个条目引用，5 段没有引用。",
    "    第 2 块 p6–p9（第 20–26 行）「1 概述」：4 段，被 1 个条目引用，2 段没有引用。",
  ]);
  // UC-002 的两条来源（p25 与 p81）分在两块，各算一个条目。
  const facts = (status.details.materials as { blocks: { index: number; items: number }[] }[])[0];
  assert.deepEqual(facts.blocks.filter((b) => b.items).map((b) => [b.index, b.items]), [[2, 1], [5, 1], [9, 1]]);
});

test("0.2 的任务只有纯文本投影：分段现算、不写清单文件，现状里不提分段清单", () => {
  const dir = makeWorkspace(undefined, { material: false });
  mkdirSync(join(dir, "inputs"));
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  putSampleDocx(dir, true);
  const fresh = taskStatusMessage(dir, FRESH, "s")!;
  assert.match(fresh.text, /inputs\/requirements-styled\.docx 共 108 段有文字（段落号 1 到 114）、1 块。$/);
  assert.equal(existsSync(join(dir, "inputs/requirements-styled.docx.segments.json")), false);
});

test("分段参数经环境变量给：参数变了，读的时候按新参数重算清单", () => {
  const dir = makeWorkspace(undefined, { material: false });
  mkdirSync(join(dir, "inputs"));
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  putSampleDocx(dir);
  assert.match(taskStatusMessage(dir, FRESH, "s")!.text, /、11 块，/);
  const before = process.env[SEGMENTS_ENV];
  process.env[SEGMENTS_ENV] = '{"heading_depth":1}';
  try {
    assert.match(taskStatusMessage(dir, FRESH, "s")!.text, /、6 块，/);
    assert.equal(JSON.parse(readFileSync(join(dir, "inputs/requirements-styled.docx.segments.json"), "utf-8")).blocks.length, 6);
  } finally {
    if (before === undefined) delete process.env[SEGMENTS_ENV];
    else process.env[SEGMENTS_ENV] = before;
  }
});
