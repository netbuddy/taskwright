/**
 * 调试模式（启动参数 --debug，缺省关）：开关怎样传到服务信息与助手程序的环境里；调试用的三个接口（设置里的提示词目录的读与设、
 * 某个任务最近一次运行实际发给模型的系统提示）；最后用真的后端进程与真的 pi（模型换成假端点）把「改一句再问一句」走一遍。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEBUG_ONLY_TEXT } from "../src/debug_prompt.ts";
import { dispatch, serviceInfo } from "../src/http.ts";
import { DEBUG_MODE, ENV_DEBUG_SETTINGS, buildEnvironment } from "../src/launch.ts";
import { readPromptDir, settingsFile } from "../src/product_settings.ts";
import { Service } from "../src/service.ts";
import { NO_PI, withStack } from "./consent_stack.ts";
import { captureConsole, spawnBackend, tempDir } from "./helpers.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

test("调试模式缺省关：服务信息里 debug 为假，启动配置上没有标记；开着时两样都有", async () => {
  const off = new Service(join(tmp, "off", "tasks"), join(tmp, "off", "runs"), {});
  const on = new Service(join(tmp, "on", "tasks"), join(tmp, "on", "runs"), {}, { debug: true });
  try {
    assert.deepEqual([off.debug, serviceInfo(off).debug, DEBUG_MODE in off.profile], [false, false, false]);
    assert.deepEqual([on.debug, serviceInfo(on).debug, on.profile[DEBUG_MODE]], [true, true, true]);
  } finally {
    await off.close();
    await on.close();
  }
});

test("起助手的程序时：调试模式下环境里多一个变量，值是产品设置文件的路径；不是调试模式时这个变量一定不在，即使服务自己的环境里有", () => {
  const before = process.env[ENV_DEBUG_SETTINGS];
  try {
    delete process.env[ENV_DEBUG_SETTINGS];
    assert.equal(ENV_DEBUG_SETTINGS in buildEnvironment({}), false);
    assert.equal(buildEnvironment({ [DEBUG_MODE]: true })[ENV_DEBUG_SETTINGS], settingsFile(process.env));
    process.env[ENV_DEBUG_SETTINGS] = "/somewhere/else.json";
    assert.equal(ENV_DEBUG_SETTINGS in buildEnvironment({}), false);
    assert.equal(buildEnvironment({ [DEBUG_MODE]: true })[ENV_DEBUG_SETTINGS], settingsFile(process.env));
  } finally {
    if (before === undefined) delete process.env[ENV_DEBUG_SETTINGS];
    else process.env[ENV_DEBUG_SETTINGS] = before;
  }
});

test("命令行的 --debug：带了它启动，服务信息里 debug 为真，启动时的那一行说明调试模式已打开；不带就是假", async () => {
  const get = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/v1/service`)).json()) as Record<string, unknown>;
  const stop = (child: { kill: (signal: NodeJS.Signals) => boolean; once: (name: "exit", done: () => void) => unknown }) =>
    new Promise<void>((ok) => { child.once("exit", () => ok()); child.kill("SIGTERM"); });
  const plain = await spawnBackend(["--tasks", join(tmp, "plain", "tasks"), "--runs", join(tmp, "plain", "runs"), "--host", "127.0.0.1"]);
  try {
    assert.equal((await get(plain.port)).debug, false);
    assert.doesNotMatch(plain.output(), /调试模式/);
  } finally {
    await stop(plain.child);
  }
  const debug = await spawnBackend(["--tasks", join(tmp, "debug", "tasks"), "--runs", join(tmp, "debug", "runs"), "--host", "127.0.0.1", "--debug"]);
  try {
    assert.equal((await get(debug.port)).debug, true);
    assert.match(debug.output(), /调试模式已打开（只在自己的机器上用）/);
  } finally {
    await stop(debug.child);
  }
});

// ───────────── 调试用的三个接口 ─────────────

type Dict = Record<string, any>;
const go = async (service: Service, method: string, path: string, body?: unknown): Promise<{ status: number; body: Dict }> => {
  const reply = await dispatch(service, { method, path, query: {}, headers: {}, body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)), remote: "127.0.0.1" }) as Dict;
  return { status: reply.status, body: JSON.parse(reply.body.toString()) };
};

/** 这一例里产品设置文件换成临时目录里的一份，做完换回去。 */
async function withSettings(file: string, body: () => Promise<void>): Promise<void> {
  const before = process.env.TASKWRIGHT_SETTINGS_FILE;
  process.env.TASKWRIGHT_SETTINGS_FILE = file;
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env.TASKWRIGHT_SETTINGS_FILE;
    else process.env.TASKWRIGHT_SETTINGS_FILE = before;
  }
}

test("不是调试模式时，调试用的几个接口都答 not_found，并说明要用 --debug 启动；设置文件不动", async () => {
  const settings = join(tmp, "plain-settings.json");
  await withSettings(settings, async () => {
    const service = new Service(join(tmp, "n1", "tasks"), join(tmp, "n1", "runs"), {});
    try {
      for (const [method, path, body] of [["GET", "/api/v1/debug/prompt-dir"], ["POST", "/api/v1/debug/prompt-dir", { path: tmp }], ["GET", "/api/v1/tasks/TASK-X/debug/system-prompt"],
        ["GET", "/api/v1/tasks/TASK-X/debug/stage"]] as const) {
        const answer = await go(service, method, path, body);
        assert.deepEqual([answer.status, answer.body.error.code, answer.body.error.message], [404, "not_found", DEBUG_ONLY_TEXT], path);
      }
      assert.equal(existsSync(settings), false);
    } finally {
      await service.close();
    }
  });
});

test("提示词目录的读与设：只收存在的目录的绝对路径；存进设置文件顶层的 debug.prompt_dir，别的键原样保留；十六个文件名各自的情形；空串是清掉", async () => {
  const settings = join(tmp, "debug-settings.json");
  writeFileSync(settings, JSON.stringify({ version: 2, pi_dirs: { "/some/agent": { selection: { language: null, embedding: null }, providers: {} } } }), "utf-8");
  const dir = join(tmp, "prompts");
  mkdirSync(join(dir, "task-type"), { recursive: true });
  writeFileSync(join(dir, "clarifying.md"), "改过的澄清那一段", "utf-8");
  writeFileSync(join(dir, "task-type", "writing.md"), "改过的写条目那一段", "utf-8");
  symlinkSync(settings, join(dir, "system.md"));
  await withSettings(settings, async () => {
    const service = new Service(join(tmp, "d1", "tasks"), join(tmp, "d1", "runs"), {}, { debug: true });
    try {
      const empty = (await go(service, "GET", "/api/v1/debug/prompt-dir")).body;
      assert.deepEqual([empty.prompt_dir, empty.usable, empty.note, empty.files.length], [null, null, null, 16]);
      assert.ok(empty.files.every((one: Dict) => one.state === "absent"));

      for (const [path, words] of [["relative/dir", /提示词目录要写绝对路径/], [join(tmp, "没有这个目录"), /这个目录不存在或者不是目录/], [settings, /这个目录不存在或者不是目录/]] as const) {
        const refused = await go(service, "POST", "/api/v1/debug/prompt-dir", { path });
        assert.deepEqual([refused.status, refused.body.error.code], [400, "bad_request"], path);
        assert.match(refused.body.error.message, words);
      }
      assert.equal((await go(service, "POST", "/api/v1/debug/prompt-dir", { path: 3 })).status, 400);
      assert.equal(readPromptDir(), null, "被拒的都没有写进设置文件");

      const set = await go(service, "POST", "/api/v1/debug/prompt-dir", { path: dir });
      assert.equal(set.status, 200);
      assert.deepEqual([set.body.prompt_dir, set.body.usable, set.body.note], [dir, true, null]);
      assert.deepEqual(set.body.files.map((one: Dict) => one.name), ["system.md", "common.md", "reading.md", "clarifying.md", "modeling.md", "writing.md", "reviewing.md", "document.md", "flows/analysis.md",
        "task-type/common.md", "task-type/reading.md", "task-type/clarifying.md", "task-type/modeling.md", "task-type/writing.md", "task-type/reviewing.md", "task-type/document.md"]);
      const states = Object.fromEntries(set.body.files.map((one: Dict) => [one.name, one.state]));
      assert.deepEqual([states["clarifying.md"], states["task-type/writing.md"], states["system.md"], states["common.md"]], ["used", "used", "refused", "absent"]);
      assert.match(set.body.files.find((one: Dict) => one.name === "system.md").reason, /^它是一个软链接，这一份照旧用原来的。$/);
      const stored = JSON.parse(readFileSync(settings, "utf-8"));
      assert.deepEqual(stored.debug, { prompt_dir: dir });
      assert.deepEqual([stored.version, Object.keys(stored.pi_dirs)], [2, ["/some/agent"]]);
      assert.deepEqual((await go(service, "GET", "/api/v1/debug/prompt-dir")).body, set.body);

      // 设了之后目录被删掉：读的时候说明它不能用。
      const gone = join(tmp, "prompts-gone");
      mkdirSync(gone);
      await go(service, "POST", "/api/v1/debug/prompt-dir", { path: gone });
      rmSync(gone, { recursive: true });
      const stale = (await go(service, "GET", "/api/v1/debug/prompt-dir")).body;
      assert.deepEqual([stale.prompt_dir, stale.usable], [gone, false]);
      assert.match(stale.note, /^这个目录不存在或者不是目录：.*现在每次运行用的都是产品自带的文字。$/);

      const cleared = await go(service, "POST", "/api/v1/debug/prompt-dir", { path: "" });
      assert.deepEqual([cleared.status, cleared.body.prompt_dir], [200, null]);
      assert.equal("debug" in JSON.parse(readFileSync(settings, "utf-8")), false);
    } finally {
      await service.close();
    }
  });
});

const PROMPT_SCRIPT = { default: { tool_calls: [{ name: "reply", arguments: { informs: [], act: null, text: "好的。" } }] } };
const systemText = (request: Dict): string => {
  const system = (request["请求体"].messages as Dict[]).find((m) => m.role === "system" || m.role === "developer");
  return typeof system?.content === "string" ? system.content : (system?.content ?? []).map((p: Dict) => p.text ?? "").join("");
};

test("调试模式下真的跑一遍：提示词目录里改一句，再问一句就生效，不用重启；接口给出的最近一次系统提示与模型收到的逐字相同，并标出每一段出自哪里", { skip: NO_PI, timeout: 180000 }, async () => {
  const settings = join(tmp, "stack-settings.json");
  const dir = join(tmp, "stack-prompts");
  mkdirSync(dir);
  await withStack(tmp, "debug-stack", PROMPT_SCRIPT, async ({ call, taskId, session, requests, send }) => {
    // 还没有运行过。
    const none = (await call("GET", `/api/v1/tasks/${taskId}/debug/system-prompt`)).body;
    assert.deepEqual([none.available, none.parts, none.text], [false, [], ""]);
    assert.match(none.note, /这个任务还没有运行过/);

    // 没有设目录：用的是产品自带的。
    await send({ text: "你好。", client_id: "c-1" });
    const first = (await call("GET", `/api/v1/tasks/${taskId}/debug/system-prompt`)).body;
    assert.equal(first.text, systemText(requests()[0]));
    assert.deepEqual([first.available, first.replaced, first.stage, first.stage_name, first.how, first.prompt_dir, first.session_id], [true, true, "reading", "核读材料", "recomposed", null, session]);
    assert.deepEqual(first.parts.map((one: Dict) => [one.part, one.from]),
      [["system", "builtin"], ["platform_common", "builtin"], ["task_common", "task"], ["platform_stage", "builtin"], ["node_exit", "builtin"], ["task_stage", "task"], ["tail", "pi"]]);
    assert.deepEqual(first.parts.map((one: Dict) => one.part_name), ["系统提示", "平台说明的共用部分", "任务类型说明的共用部分", "平台说明里这个阶段的那一段", "这个阶段在流程里的出口", "任务类型说明里这个阶段的那一段", "助手程序接在后面的工作目录等"]);
    assert.deepEqual(first.parts.map((one: Dict) => one.from_name), ["产品自带", "产品自带", "任务目录", "产品自带", "产品自带", "任务目录", "助手程序"]);
    assert.equal(first.parts[3].file, "agent/prompts/stages/reading.md");
    for (const one of first.parts) assert.deepEqual([one.lines, one.bytes], [one.text.split("\n").length, Buffer.byteLength(one.text, "utf-8")]);

    // 设目录、放一份改过的核读材料那一段：下一句话就用它。
    writeFileSync(join(dir, "reading.md"), "# 现在这个阶段：核读材料\n\n调试时改的头一句。\n", "utf-8");
    assert.equal((await call("POST", "/api/v1/debug/prompt-dir", { path: dir })).status, 200);
    await send({ text: "再来一句。", client_id: "c-2" });
    const second = (await call("GET", `/api/v1/tasks/${taskId}/debug/system-prompt`)).body;
    assert.equal(second.text, systemText(requests()[1]));
    assert.ok(second.text.includes("调试时改的头一句。"));
    assert.deepEqual([second.how, second.prompt_dir, second.notes], ["recomposed", dir, []]);
    assert.deepEqual([second.parts[3].from, second.parts[3].from_name, second.parts[3].file], ["prompt_dir", "提示词目录", "reading.md"]);

    // 改一句再问一句。
    writeFileSync(join(dir, "reading.md"), "# 现在这个阶段：核读材料\n\n调试时改的后一句，比头一句长。\n", "utf-8");
    await send({ text: "第三句。", client_id: "c-3" });
    const third = (await call("GET", `/api/v1/tasks/${taskId}/debug/system-prompt`)).body;
    assert.equal(third.text, systemText(requests()[2]));
    assert.ok(third.text.includes("调试时改的后一句，比头一句长。") && !third.text.includes("调试时改的头一句。"));

    // 没有再改：沿用。
    await send({ text: "第四句。", client_id: "c-4" });
    const fourth = (await call("GET", `/api/v1/tasks/${taskId}/debug/system-prompt`)).body;
    assert.deepEqual([fourth.how, fourth.text], ["reused", third.text]);
    assert.equal(systemText(requests()[3]), third.text);
  }, { seed: false, args: ["--debug"], env: { TASKWRIGHT_SETTINGS_FILE: settings } });
});

const USE_CASE = { op: "add", collection: "功能用例", sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "读者凭借书证在自助机上借书。" }],
  fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } };
const REJECT_SCRIPT = {
  sequence: [
    // 核读材料阶段就想写用例：被拦。
    { tool_calls: [{ id: "call-early", name: "save_revision", arguments: { operations: [USE_CASE] } }] },
    { tool_calls: [{ id: "call-say", name: "reply", arguments: { informs: [], act: null, text: "这个阶段还不能写用例。" } }] },
    { tool_calls: [{ id: "call-say-2", name: "reply", arguments: { informs: [], act: null, text: "好的。" } }] },
  ],
};

test("调试模式下的阶段记录流水与被拒的工具调用：谁在什么时候把任务从哪移到哪、理由；被拒的调用带工具名、事实、指引与它所属的那次工作", { skip: NO_PI, timeout: 180000 }, async () => {
  await withStack(tmp, "debug-stage", REJECT_SCRIPT, async ({ call, taskId, session, send, action }) => {
    // 一开始：只有用户启动需求分析的那一条（任务此前空闲，从哪里来是空的），没有被拒的调用。
    const fresh = (await call("GET", `/api/v1/tasks/${taskId}/debug/stage`)).body;
    assert.deepEqual([fresh.records.map((one: Dict) => [one.from, one.from_name, one.to, one.to_name, one.actor, one.flow]), fresh.rejections, fresh.latest_work_id],
      [[[null, "", "reading", "核读材料", "user", "analysis"]], [], null]);

    await send({ text: "直接写用例吧。", client_id: "c-1" });
    assert.equal((await action({ kind: "move_stage", targets: [], fields: { stage: "澄清", reason: "材料看过了。" } })).status, 200);
    assert.equal((await action({ kind: "move_stage", targets: [], fields: { stage: "整理建模" } })).status, 200);
    await send({ text: "再说一句。", client_id: "c-2" });

    const view = (await call("GET", `/api/v1/tasks/${taskId}/debug/stage`)).body;
    assert.deepEqual(view.records.slice(1).map((one: Dict) => [one.from, one.from_name, one.to, one.to_name, one.actor, one.reason, one.run_id]), [
      ["reading", "核读材料", "clarifying", "澄清", "user", "材料看过了。", null],
      ["clarifying", "澄清", "modeling", "整理建模", "user", "", null],
    ]);
    for (const one of view.records) {
      assert.match(one.at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(typeof one.session_id, "string");
    }
    assert.equal(view.rejections.length, 1);
    const refused = view.rejections[0];
    // 被阶段拦下的保存，原因码 gate.stage_item_write 是守门类，拒绝种类记作缺前置步骤（gate）。
  assert.deepEqual([refused.tool, refused.kind, refused.call_id, refused.session_id], ["save_revision", "gate", "call-early", session]);
    assert.match(refused.fact, /任务现在在核读材料阶段，这个阶段不能新增「功能用例」的条目/);
    assert.match(refused.guidance, /进入写条目要由用户在卡片上选「开始写条目」/);
    assert.match(refused.work_id, /^w-/);
    assert.equal(view.latest_work_id, refused.work_id);
  }, { seed: false, args: ["--debug"], env: { TASKWRIGHT_SETTINGS_FILE: join(tmp, "stage-settings.json") } });
});
