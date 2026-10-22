/**
 * 逆向解析收尾前查一次知识库（活动正文收尾一段）：任务选用的知识库里有一份客户的需求编写规范时，
 * 助手查到它，记一条种类为待澄清、事项点名这份规范的问题条目，再发提议进入下一步的卡片。
 * 起真后端与真 pi，模型换成假端点；查找走真的知识库检索（没有嵌入模型，只按字面）。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { KnowledgeStore } from "../src/knowledge.ts";
import { type Dict, NO_PI, reply, withStack } from "./consent_stack.ts";
import { sendAndWaitTurn, tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
/** 知识库目录与库编号：起栈之前先登记一个编号固定的库，假端点脚本里来源的出处才能事先写好库编号（服务启动时空的 general 会被删掉，所以不用它）。 */
const KNOWLEDGE = join(tmp, "parse-spec-norm-knowledge");
const LIBRARY = "lib-norm0001";

const NORM = "星河 需求编写规范";
const NORM_TEXT = "需求语句一律用「应」字句式，每条只写一件事。";
const QUERY = "客户的需求写作规范或需求编写规范";
const CARD = { kind: "choose", text: "逆向解析做完了，下一步核读补充证据。",
  options: [{ key: "next_step", text: "进入下一步：核读材料", reason: "原文各节都有了去处" }, { key: "stay", text: "继续本步", reason: "还要再核对一遍" }] };
const SCRIPT = {
  sequence: [
    { tool_calls: [{ id: "call-search", name: "search_knowledge", arguments: { query: QUERY } }] },
    { tool_calls: [{ id: "call-norm", name: "save_revision", arguments: { operations: [{ op: "add", collection: "问题",
      sources: [{ kind: "文档原文", locator: `knowledge/${LIBRARY}/${NORM}.md`, excerpt: NORM_TEXT }],
      fields: { 事项: `评审时按《${NORM}》核对写法`, 种类: "待澄清", 是否阻断下游: "不阻断", 何时回看: "评审确认时", 状态: "未解决" } }] } }] },
    reply(`原文各节都有了去处。写法判据参照《${NORM}》。`, "call-done", CARD),
  ],
};

/** 经上传接口放一个文件，fields 是另加的表单项。 */
async function upload(port: number, path: string, name: string, text: string, fields: Dict = {}): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new Blob([text]), name);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: form });
  assert.equal(res.status, 200, await res.text());
}

test("逆向解析收尾：任务选的知识库里有客户的需求编写规范，查到后记一条待澄清的问题条目，事项点名这份规范", { skip: NO_PI, timeout: 180000 }, () => {
  const store = new KnowledgeStore(KNOWLEDGE);
  store.ensure();
  store.adopt({ id: LIBRARY, name: "客户规范", created_at: "2026-01-01T00:00:00" });
  return withStack(tmp, "parse-spec-norm", SCRIPT, async ({ call, taskId, port, db, dir }) => {
    await upload(port, `/api/v1/knowledge/libraries/${LIBRARY}/documents`, `${NORM}.md`, `# ${NORM}\n\n${NORM_TEXT}\n`, { kind: "standard" });
    assert.equal((await call("POST", `/api/v1/tasks/${taskId}/knowledge`, { libraries: [LIBRARY] })).status, 200);
    await upload(port, `/api/v1/tasks/${taskId}/materials`, "旧版规格说明.md", "# 1 引言\n\n本说明书规定借阅系统的功能。\n", { slot: "spec" });
    const started = await call("POST", `/api/v1/tasks/${taskId}/actions`,
      { kind: "start_activity", targets: [], fields: { activity: "parse_spec", in_flow: true, flow: "reengineering" }, notify_executor: false });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const session: string = started.body.session_id;
    await sendAndWaitTurn(port, taskId, session, async () => {
      assert.equal((await call("POST", `/api/v1/tasks/${taskId}/messages?session=${session}`, { text: "请开始逆向解析。", client_id: "c-1", attachments: [] })).status, 200);
    });

    // 查找真的查到了这份规范：会话文件里查找知识库的工具结果带着规范名。
    const sessionDir = join(dir, "runs", taskId, "pi-sessions", "service");
    const entries = readFileSync(join(sessionDir, readdirSync(sessionDir).find((n) => n.endsWith(`_${session}.jsonl`))!), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const found = entries.find((e) => e.message?.role === "toolResult" && e.message.toolCallId === "call-search");
    assert.ok(found && JSON.stringify(found.message.content).includes(NORM), JSON.stringify(found?.message.content));

    assert.deepEqual(db("SELECT tool_name, reason_code FROM tool_rejection"), []);
    const problems = db("SELECT item_id, fields FROM item_version WHERE item_id LIKE 'TBD-%'").map((r: Dict) => [r.item_id, JSON.parse(r.fields)]);
    assert.equal(problems.length, 1);
    const [id, fields] = problems[0];
    assert.equal(id, "TBD-001");
    assert.equal(fields.种类, "待澄清");
    assert.ok(fields.事项.includes(`《${NORM}》`), fields.事项);
    assert.equal(fields.关联条目, undefined);
  }, { seed: false, launch: false, args: ["--knowledge", KNOWLEDGE] });
});
