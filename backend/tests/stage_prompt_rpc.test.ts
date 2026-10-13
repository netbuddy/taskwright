/**
 * 按阶段换系统提示，在真的 pi 上核对（真的后端进程与真的 pi，RPC 形态，模型换成进程内的假端点）：
 * 模型实际收到的系统消息，与助手一侧拼出来的文字逐字相同；一次运行之内不变；用户在卡片上点了「进入澄清」，这次点击引起的运行拿到的就是澄清的那一段；
 * 阶段没变的下一次运行沿用上一份；早先的任务（任务定义里没有「总体分析」集合）收到的仍是启动参数给的那一份加 pi 的 skill 清单。
 * 这几条依赖 pi 的 before_agent_start 事件在 RPC 形态下的行为，换 pi 的版本时由这例测试守着。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { composeStagePrompt, digestOf } from "../../agent/src/lib/stage_prompt.ts";
import { ROOT, captureConsole, movesSql, sendAndWaitTurn, sqlGet, sqlRun, tempDir } from "./helpers.ts";
import { type Dict, NO_PI, TOPIC_CALL, reply, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const CLARIFY_CARD = { kind: "choose", text: "材料读完了，接下来我一件一件问你。现在进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
  options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "继续本阶段" }] };
const SCRIPT = {
  sequence: [
    // 第一句话（核读材料）：立一页主题，再发「进入澄清」的卡片。
    { tool_calls: [TOPIC_CALL] },
    reply("材料读完了，立了一页主题。现在进入澄清吗？", "call-card", CLARIFY_CARD),
    // 用户点了「进入澄清」之后的那次运行、再后面一句话（都在澄清）：各回一句。
    reply("好的，记下了。", "call-2"),
    reply("好的。", "call-3"),
    // 早先的任务里的那一句。
    reply("我在。", "call-old"),
  ],
};

/** 一个请求里的系统消息的文字。 */
function systemText(request: Dict): string {
  const system = (request["请求体"].messages as Dict[]).find((m) => m.role === "system" || m.role === "developer");
  if (!system) return "";
  return typeof system.content === "string" ? system.content : (system.content as Dict[]).map((p) => p.text ?? "").join("");
}

/** 后端补记里「系统提示」那几条记录的内容，按先后。补记文件在这个任务的归档目录下（扩展名 .backend.jsonl），哪一层由后端定，这里往下找。 */
function promptNotes(dir: string, taskId: string): Dict[] {
  const base = join(dir, "runs", taskId);
  const files = (readdirSync(base, { recursive: true }) as string[]).filter((n) => n.endsWith(".backend.jsonl")).sort();
  const notes: Dict[] = [];
  for (const name of files) {
    for (const line of readFileSync(join(base, name), "utf-8").split("\n").filter(Boolean)) {
      const one = JSON.parse(line) as Dict;
      if (one["记录"] === "系统提示") notes.push(one["内容"]);
    }
  }
  return notes;
}

test("模型收到的系统消息就是按阶段拼出的那一份；用户点卡片进入下一段，那次点击引起的运行就换成新阶段的；早先的任务收到的与原来相同", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "prompt", SCRIPT, async ({ call, taskId, session, dir, port, requests, send, db, entryOfCall }) => {
    const taskDir = join(dir, "tasks", taskId);
    const expected = (stage: "reading" | "clarifying") => composeStagePrompt({
      stage, workspaceDir: taskDir, tail: `<cwd>\n${taskDir}\n</cwd>`,
      skills: [{ name: "srs-authoring", filePath: join(taskDir, ".pi", "skills", "srs-authoring", "SKILL.md") }],
    });

    // 第一次运行：任务在核读材料。这次运行的两个请求（立页之前、工具结果回来之后）收到的都是核读材料的那一份。
    await send({ text: "把材料整理一下。", client_id: "c-1" });
    const first = requests();
    assert.equal(first.length, 2);
    const reading = expected("reading");
    assert.equal(systemText(first[0]), reading.text);
    assert.equal(systemText(first[1]), reading.text, "同一次运行里的后一个请求还是这一份");
    assert.ok(reading.text.includes("# 现在这个阶段：核读材料\n"));
    assert.ok(reading.text.includes("## 这类任务在核读材料阶段\n"));
    // 启动参数给的那一份与 pi 的 skill 清单都不在里面；工作目录接在最后。
    assert.doesNotMatch(systemText(first[0]), /先用 read 读 taskwright-executor 的正文|<skills>|<available_skills>/);
    assert.ok(systemText(first[0]).endsWith(`<cwd>\n${taskDir}\n</cwd>`));
    assert.equal(db("SELECT COUNT(*) AS n FROM activity_record")[0].n, 0, "助手只发了卡片，阶段没有动");

    // 用户在卡片上点「进入澄清」：扩展先记移动、再代发那句固定的话，这句话引起的运行拿到的已经是澄清的那一份；
    // 按阶段的那一段之前的文字与上一次相同。
    await send({ text: "我选：进入澄清", client_id: "c-2", origin: "card_choice", card: { reply_message_id: entryOfCall("call-card"), kind: "choose", choice: "enter_clarify" } });
    assert.equal(db(movesSql(["stage"])).at(-1).stage, "clarifying");
    const clarifying = expected("clarifying");
    assert.equal(systemText(requests()[2]), clarifying.text);
    assert.ok(clarifying.text.includes("# 现在这个阶段：澄清\n"));
    assert.ok(!clarifying.text.includes("# 现在这个阶段：核读材料\n"));
    const sharedLength = reading.text.indexOf("# 现在这个阶段：");
    assert.equal(clarifying.text.slice(0, sharedLength), reading.text.slice(0, sharedLength));

    // 第三次运行：阶段没变，同一份。
    await send({ text: "还有，逾期不能预约。", client_id: "c-3" });
    assert.equal(systemText(requests()[3]), clarifying.text);

    // 扩展每次运行报一行：哪个阶段、重拼还是沿用、说明文字的摘要值（不算工作目录那一截，不带文字本身）。
    const notes = promptNotes(dir, taskId);
    assert.deepEqual(notes.map((n) => [n.replaced, n.stage, n.how]), [[true, "reading", "recomposed"], [true, "clarifying", "recomposed"], [true, "clarifying", "reused"]]);
    const own = (text: string) => text.slice(0, -`\n\n<cwd>\n${taskDir}\n</cwd>`.length);
    assert.deepEqual(notes.map((n) => n.digest), [digestOf(own(reading.text)), digestOf(own(clarifying.text)), digestOf(own(clarifying.text))]);
    assert.deepEqual(notes[0].parts.map((p: Dict) => p.file), ["agent/prompts/stages/system.md", "agent/prompts/stages/common.md", ".pi/skills/srs-authoring/SKILL.md",
      "agent/prompts/stages/reading.md", "agent/prompts/flows/initial.md", ".pi/skills/srs-authoring/stages/reading.md"]);
    assert.ok(!JSON.stringify(notes).includes("你是 Taskwright 的执行者"));

    // 早先的任务：把另一个任务的任务定义改成没有「总体分析」集合的样子（早先建的任务就是这样），它没有阶段。
    const oldId: string = (await call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "早先的任务" })).body.task_id;
    const oldDir = join(dir, "tasks", oldId);
    writeFileSync(join(oldDir, "inputs", "材料.md"), "读者凭借书证借书。\n", "utf-8");
    const definition = JSON.parse(sqlGet(oldDir, "SELECT definition_text FROM task")!.definition_text);
    definition.交付物.条目集合 = definition.交付物.条目集合.filter((one: Dict) => one.名称 !== "总体分析");
    delete definition.完成条件.总体分析;
    sqlRun(oldDir, [["UPDATE task SET definition_text = ?", JSON.stringify(definition)]]);
    const oldSession: string = (await call("POST", `/api/v1/tasks/${oldId}/sessions`)).body.session_id;
    await sendAndWaitTurn(port, oldId, oldSession, async () => {
      assert.equal((await call("POST", `/api/v1/tasks/${oldId}/messages?session=${oldSession}`, { text: "你好。", client_id: "c-old" })).status, 200);
    });
    const old = systemText(requests()[4]);
    const legacy = readFileSync(join(ROOT, "backend", "prompts", "executor_system_prompt.md"), "utf-8");
    assert.ok(old.startsWith(legacy), "系统提示的开头就是启动参数给的那一份");
    assert.match(old, /<skills>[\s\S]*<name>taskwright-executor<\/name>[\s\S]*<name>srs-authoring<\/name>[\s\S]*<\/skills>/);
    assert.ok(old.endsWith(`<cwd>\n${oldDir}\n</cwd>`));
    assert.ok(!old.includes("# 现在这个阶段："));
    assert.deepEqual(promptNotes(dir, oldId), [], "早先的任务不报这一行");
  }, { seed: false }));
