/**
 * 有阶段的任务的系统提示怎样拼（src/lib/context_assemble.ts）：每个位置拼出哪几部分、选了哪几个模块、次序、早先的任务不拼、
 * 拼不成时抛错、缓存什么时候沿用什么时候重拼、调试模式的提示词目录、单项活动与空闲、范围说明；以及挂在事件上的那一半（hooks/stage_prompt.ts）。
 * 用的是仓里真实的那几份说明文件；要改文件的测试用它们在临时目录里的一份拷贝。
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { insertMaterial } from "../src/lib/material_db.ts";
import { IDLE, STAGES, STAGE_NAMES, type Stage } from "../src/lib/stage.ts";
import {
  ContextCache, ENV_DEBUG_SETTINGS, EXIT_HEADING, HOW_NAMES, NODE_IO, ORIGIN_NAMES, PART_NAMES, PROMPTS_DIR, PROMPT_DIR_MAX_BYTES, PromptAssemblyError, type PromptIo, REQUIRED_MODULES,
  type StagePrompt, composeContext, debugPromptDir, digestOf, partFact, piTail, promptDirNames, scopeSection, skillBody, stageInWorkspace,
  whereInWorkspace, withoutOpening, withoutSection,
} from "../src/lib/context_assemble.ts";
import { STAGE_PROMPT_ERROR_TYPE, STAGE_PROMPT_STATUS_KEY, type StagePromptReport, type StopMessage, stagePromptFor } from "../src/hooks/stage_prompt.ts";
import { readDefinitions } from "../src/lib/activity_def_read.ts";
import { CALL_SESSION, DEFINITION_PATH, SRS_SKILL_DIR, callIn, demoDefinition, idleSessions, enterStage, makeWorkspace, overallDefinition, tempDir } from "./helpers.ts";
import { assetNamesOf } from "../src/lib/asset_names.ts";

/** 产品自带的需求工程任务定义里的资产显示名。 */
const NAMES = assetNamesOf(null);

const ROOT = resolve(import.meta.dirname, "..", "..");
const SRS_TYPE = join(ROOT, "task-types", "requirements-engineering");
const SRS_SKILL = { name: "requirements-engineering", filePath: join(SRS_TYPE, ".pi", "skills", "requirements-engineering", "SKILL.md") };
const TAIL = "<cwd>\n/somewhere/task\n</cwd>";
/** 产品自带的需求工程的活动与工作流的声明：没有任务 skill 的测试直接给它。 */
const DEFS = readDefinitions(SRS_SKILL_DIR);

const temps: string[] = [];
after(() => { for (const one of temps) rmSync(one, { recursive: true, force: true }); });
function scratchDir(): string {
  const dir = tempDir("context-assemble-");
  temps.push(dir);
  return dir;
}

const compose = (stage: Stage, inFlow = true) => composeContext({ stage, inFlow, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL });
/** 各部分的名字：模块写模块名，别的写部分的种类。 */
const kinds = (prompt: StagePrompt) => prompt.parts.map((one) => one.module ?? one.part);

const ALWAYS = ["system_message", "task_definition", "tools_general", "sources", "three_facts", "work_items"];
/** 每个位置选进来的条件模块。 */
const CONDITIONAL: Record<Stage | typeof IDLE, string[]> = {
  reading: ["materials", "knowledge", "batches", "reply_brief", "understanding_brief", "pages_full", "cross_check", "problems", "stage_cards", "flow_transitions"],
  clarifying: ["reply_full", "understanding_full", "pages_full", "problems", "stage_cards", "retell", "flow_transitions"],
  modeling: ["batches", "reply_brief", "understanding_brief", "pages_full", "problems", "diagrams_full", "stage_cards", "flow_transitions"],
  writing: ["batches", "reply_brief", "reply_confirm", "understanding_brief", "review", "pages_brief", "problems", "items_full", "diagrams_brief", "stage_cards", "flow_transitions"],
  reviewing: ["reply_full", "understanding_full", "review", "confirm_publish", "pages_brief", "problems", "items_full", "diagrams_brief", "stage_cards", "retell", "flow_transitions"],
  document: ["materials", "knowledge", "batches", "reply_brief", "understanding_brief", "confirm_publish", "pages_full", "problems", "stage_cards", "flow_transitions"],
  idle: ["reply_full", "understanding_full", "pages_full", "problems", "retell", "idle_rules"],
};

for (const stage of STAGES) {
  test(`${STAGE_NAMES[stage]}阶段：系统提示、位置说明、共用模块、这个位置的条件模块、活动模板、任务类型共用、节点的出口、任务类型的补充、工作目录`, () => {
    const prompt = compose(stage);
    assert.equal(prompt.stage, stage);
    assert.deepEqual(kinds(prompt), ["system", "position", ...ALWAYS, ...CONDITIONAL[stage], "template", "task_common", "task_activity", "tail"]);
    const file = (kind: string) => prompt.parts.find((one) => one.part === kind)?.file;
    assert.equal(file("system"), "agent/prompts/system.md");
    assert.equal(file("position"), null);
    assert.equal(file("template"), `agent/prompts/templates/${stage}.md`);
    assert.equal(file("task_common"), ".pi/skills/requirements-engineering/SKILL.md");
    assert.equal(file("task_activity"), `.pi/skills/requirements-engineering/activities/${stage}.md`);
    for (const one of prompt.parts.filter((p) => p.part === "module")) assert.match(one.file!, new RegExp(`^agent/prompts/capabilities/[a-z]+/${one.module}\\.md$`));
    // 活动模板到「做到什么算够」为止；接在任务类型共用之后的是这个节点的一节。
    const template = prompt.parts.find((one) => one.part === "template")!.text;
    assert.ok(template.startsWith(`# 现在这个阶段：${STAGE_NAMES[stage]}\n`) && !/^## 出口$/m.test(template));
    // 工作流里的转移由程序从声明推出来：各步、现在这一步、上一步与下一步、分工表。活动的收尾一节在任务类型的补充里。
    const moves = prompt.parts.find((one) => one.module === "flow_transitions")!.text;
    assert.ok(moves.includes("各步依次是：核读材料、澄清、整理建模、写条目、评审确认、编写文档、发布。") && moves.includes(`现在在「${STAGE_NAMES[stage]}」这一步。`), moves);
    assert.doesNotMatch(moves, /\{\{/);
    assert.ok(prompt.parts.find((one) => one.part === "task_activity")!.text.includes("## 这一步怎样收尾"));
    assert.equal(prompt.text, prompt.parts.map((one) => one.text).join("\n\n"));
    assert.ok(prompt.text.startsWith("你是 Taskwright 的执行者"));
    assert.ok(prompt.text.endsWith(TAIL));
    for (const other of STAGES) assert.equal(prompt.text.includes(`# 现在这个阶段：${STAGE_NAMES[other]}\n`), other === stage, STAGE_NAMES[other]);
    assert.equal(prompt.text.includes("## 这类任务在核读材料阶段"), stage === "reading");
    assert.equal(prompt.text.includes("## 这类任务在写条目阶段"), stage === "writing");
    assert.equal(prompt.text.includes("## 这类任务在编写文档阶段"), stage === "document");
    // 头都不进系统提示；pi 的 skill 清单不接回去；位置说明紧跟系统提示。
    assert.doesNotMatch(prompt.text, /^---$/m);
    assert.doesNotMatch(prompt.text, /<skills>|<available_skills>|^name: |^order: |^when: /m);
    assert.ok(prompt.text.includes("# 需求工程"));
    assert.match(prompt.parts[1].text, new RegExp(`^## 本次会话\\n\\n本次会话在工作流程「需求分析」的「${STAGE_NAMES[stage]}」这一站。主要工作：`));
  });
}

test("位置说明：在哪里、主要工作（活动的头里「写」的几类资产）、获准的写入（获准能力表）", () => {
  assert.equal(compose("writing").parts[1].text,
    "## 本次会话\n\n本次会话在工作流程「需求分析」的「写条目」这一站。主要工作：需求条目。获准的写入：立页、改页、记问题条目、画图、改图、写条目、改条目、请求评审；别的写入工具会拒绝。");
  assert.equal(compose("modeling", false).parts[1].text,
    "## 本次会话\n\n本次会话在单项活动「整理建模」里。主要工作：分析模型、业务说明。获准的写入：立页、改页、记问题条目、画图、改图；别的写入工具会拒绝。");
  assert.equal(composeContext({ stage: IDLE, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: "" }).parts[1].text,
    "## 本次会话\n\n本次会话在自由讨论中，不属于任何工作项。主要工作：没有指定，照用户说的做。获准的写入：立页、改页、记问题条目；别的写入工具会拒绝。");
});

test("核读材料阶段不再带条目、画图、评审、发布、复述之外的规矩：只选它要的模块", () => {
  const text = compose("reading").text;
  for (const absent of ["## 画图\n", "## 评审\n", "## 用户看过就算确认", "## 条目的写法", "## 先写理解\n", "## 怎样回复\n"]) assert.ok(!text.includes(absent), absent);
  for (const present of ["## 先看材料\n", "## 知识库怎样用\n", "## 业务说明的页\n", "## 问题条目\n", "## 工作的阶段\n", "## 怎样回复（批处理的活动）\n"]) assert.ok(text.includes(present), present);
});

test("「材料里的内容都要整理进条目」只出现在写条目阶段的系统提示里", () => {
  for (const stage of STAGES) assert.equal(compose(stage).text.includes("都要整理进条目"), stage === "writing", stage);
});

test("共用模块在每个位置都一样，紧接在位置说明之后", () => {
  const always = (prompt: StagePrompt) => prompt.parts.slice(2, 2 + ALWAYS.length).map((one) => one.text).join("\n\n");
  for (const stage of STAGES) assert.equal(always(compose(stage)), always(compose("reading")), stage);
});

test("早先的任务没有阶段，不拼；任务库不在或还没有任务时也不拼", () => {
  const old = makeWorkspace(demoDefinition());
  createTask(callIn(old), { definition_path: DEFINITION_PATH });
  assert.equal(stageInWorkspace(old, CALL_SESSION), null);
  assert.equal(stageInWorkspace(scratchDir(), null), null);
  const empty = makeWorkspace(overallDefinition());
  assert.equal(stageInWorkspace(empty, CALL_SESSION), null);
});

test("刚建好的任务没有活动记录，是空闲，有没有材料都一样；有了记录看还在进行的那一条", () => {
  const withMaterial = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(withMaterial), { definition_path: DEFINITION_PATH });
  assert.equal(stageInWorkspace(withMaterial, CALL_SESSION), IDLE);
  const noMaterial = makeWorkspace(overallDefinition(), { material: false });
  createTask(callIn(noMaterial), { definition_path: DEFINITION_PATH });
  assert.equal(stageInWorkspace(noMaterial, CALL_SESSION), IDLE);
  enterStage(withMaterial, "modeling");
  assert.equal(stageInWorkspace(withMaterial, CALL_SESSION), "modeling");
  enterStage(withMaterial, "clarifying");
  assert.equal(stageInWorkspace(withMaterial, CALL_SESSION), "clarifying");
});

test("任务目录里的 skill 没有 activities/（早先建的任务）：回退读产品自带的同一相对路径那一份；产品自带的也没有就拼不成", () => {
  const task = scratchDir();
  const skillDir = join(task, ".pi", "skills", "requirements-engineering");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: requirements-engineering\ndescription: 早先的整份说明\n---\n\n# 早先的整份说明\n", "utf-8");
  const prompt = composeContext({ stage: "writing", workspaceDir: task, skills: [{ name: "requirements-engineering", filePath: join(skillDir, "SKILL.md") }], tail: "" });
  const of = (part: string) => prompt.parts.find((one) => one.part === part)!;
  assert.deepEqual([of("task_common").from, of("task_common").file, of("task_common").text], ["task", ".pi/skills/requirements-engineering/SKILL.md", "# 早先的整份说明"]);
  assert.deepEqual([of("task_activity").from, of("task_activity").file], ["builtin", "task-types/requirements-engineering/.pi/skills/requirements-engineering/activities/writing.md"]);

  const other = join(task, ".pi", "skills", "old-type");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "SKILL.md"), "# 早先的整份说明\n", "utf-8");
  assert.throws(() => composeContext({ stage: "writing", workspaceDir: task, skills: [{ name: "old-type", filePath: join(other, "SKILL.md") }], tail: "" }),
    (error: Error) => error instanceof PromptAssemblyError && /都没有这份 skill 的活动定义/.test(error.message));
});

test("一个任务 skill 都没有时拼不成；直接给了声明时，任务类型说明的共用部分不拼", () => {
  assert.throws(() => composeContext({ stage: "clarifying", workspaceDir: scratchDir(), skills: [], tail: TAIL }), /没有任务类型的 skill/);
  const prompt = composeContext({ stage: "clarifying", workspaceDir: scratchDir(), skills: [], tail: TAIL, definitions: DEFS });
  assert.deepEqual(kinds(prompt).slice(-3), ["template", "task_activity", "tail"]);
  assert.ok(!kinds(prompt).includes("task_common"));
});

/** 一个临时的任务目录，里面一份任务 skill：产品自带的需求工程那几份活动与工作流的声明，加给定的 SKILL.md。 */
function skillCopy(common = "任务类型共用"): { task: string; skillDir: string; skills: { name: string; filePath: string }[] } {
  const task = scratchDir();
  const skillDir = join(task, ".pi", "skills", "some-type");
  mkdirSync(skillDir, { recursive: true });
  for (const sub of ["activities", "flows"]) cpSync(join(SRS_SKILL_DIR, sub), join(skillDir, sub), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), common, "utf-8");
  return { task, skillDir, skills: [{ name: "some-type", filePath: join(skillDir, "SKILL.md") }] };
}

/** 产品自带的提示词目录在临时目录里的一份拷贝，测试可以随意改。 */
function platformCopy(): string {
  const dir = scratchDir();
  cpSync(PROMPTS_DIR, dir, { recursive: true });
  return dir;
}

test("拼不成就抛错，写明是哪一份：系统提示、活动模板、流程里的节点、必需的模块、模块的头、重名、次序号相同、模板的键", () => {
  const input = (dir: string, stage: Stage = "reading") => ({ stage, workspaceDir: dir, skills: [], tail: "", platformDir: dir, definitions: DEFS });
  const fails = (change: (dir: string) => void, message: RegExp, stage: Stage = "reading") => {
    const dir = platformCopy();
    composeContext(input(dir, stage));
    change(dir);
    assert.throws(() => composeContext(input(dir, stage)), (error: Error) => error instanceof PromptAssemblyError && message.test(error.message), String(message));
  };
  fails((dir) => rmSync(join(dir, "system.md")), /拼系统提示要用的文件不在：.*\/system\.md$/);
  fails((dir) => rmSync(join(dir, "templates", "reading.md")), /拼系统提示要用的文件不在：.*templates.reading\.md/);
  // 工作流的声明在任务 skill 的目录里：这条工作流不在了、模块里有填不上的占位，都拼不成。
  const noFlow = skillCopy();
  rmSync(join(noFlow.skillDir, "flows", "analysis.md"));
  assert.throws(() => composeContext({ stage: "reading", workspaceDir: noFlow.task, skills: noFlow.skills, tail: "" }), /任务类型里没有「analysis」这条工作流的声明/);
  fails((dir) => writeFileSync(join(dir, "capabilities", "planning", "flow_transitions.md"),
    "---\nname: flow_transitions\norder: 610\nwhen: session=flow\n---\n\n现在在{{here}}，{{nothing}}。\n"), /占位「\{\{nothing\}\}」这次没有可填的值/);
  fails((dir) => writeFileSync(join(dir, "capabilities", "planning", "standalone_exit.md"),
    "---\nname: standalone_exit\norder: 900\nwhen: always\n---\n\n现在在{{here}}。\n"), /占位「\{\{here\}\}」这次没有可填的值/, IDLE as never);
  // 这次用不着的模块缺了也不行。
  fails((dir) => rmSync(join(dir, "capabilities", "organizing", "diagrams_full.md")), /平台说明缺了这几个模块：diagrams_full/);
  fails((dir) => writeFileSync(join(dir, "capabilities", "reading", "materials.md"), "---\nname: materials\norder: 110\nwhen: reads=everything\n---\n\n正文\n"), /reading\/materials\.md 的头里「when」/);
  fails((dir) => writeFileSync(join(dir, "capabilities", "planning", "extra.md"), "---\nname: materials\norder: 999\nwhen: always\n---\n\n正文\n"), /两份模块同名「materials」/);
  fails((dir) => writeFileSync(join(dir, "capabilities", "planning", "extra.md"), "---\nname: extra\norder: 110\nwhen: always\n---\n\n正文\n"), /次序号都是 110/);
  fails((dir) => writeFileSync(join(dir, "templates", "reading.md"), "---\ntemplate: clarifying\nwrites_allowed: page\n---\n\n正文\n"), /「template」写的是「clarifying」，应当是「reading」/);
  fails((dir) => writeFileSync(join(dir, "templates", "reading.md"), "没有头的模板\n"), /templates.reading\.md 开头没有头/);
  // 单项活动与空闲不用流程的定义：没有它也拼得出来。
  const copy = skillCopy();
  rmSync(join(copy.skillDir, "flows"), { recursive: true });
  const alone = { workspaceDir: copy.task, skills: copy.skills, tail: "" };
  assert.ok(composeContext({ ...alone, stage: "reading", inFlow: false }).text.includes("本会话的工作项是单项活动"));
  assert.ok(composeContext({ ...alone, stage: IDLE }).text.includes("# 现在：自由讨论"));
  assert.equal(REQUIRED_MODULES.length, 29);
});

test("新增一个合规的模块：条件满足的位置就多这一段，次序按次序号", () => {
  const dir = platformCopy();
  writeFileSync(join(dir, "capabilities", "analysis", "compare.md"), "---\nname: compare\norder: 518\nwhen: main=description & mode=batch\n---\n\n## 对照\n\n对照的规矩。\n");
  const input = (stage: Stage) => ({ stage, workspaceDir: dir, skills: [], tail: "", platformDir: dir, definitions: DEFS });
  const reading = kinds(composeContext(input("reading")));
  assert.ok(reading.indexOf("compare") === reading.indexOf("cross_check") + 1 && reading.indexOf("compare") === reading.indexOf("problems") - 1);
  assert.ok(!kinds(composeContext(input("clarifying"))).includes("compare"), "澄清是逐项对话，不进");
});

test("pi 接在后面的那一截：去掉启动参数给的那一段与 skill 清单，留下工作目录与上下文文件", () => {
  const skills = "<skills>\nThe following skills provide specialized instructions.\n\n<available_skills>\n  <skill>\n    <name>x</name>\n  </skill>\n</available_skills>\n</skills>";
  const cwd = "<cwd>\n/tasks/TASK-1\n</cwd>";
  assert.equal(piTail(`原文\n\n${skills}\n\n${cwd}`, "原文"), cwd);
  assert.equal(piTail(`原文\n\n<project_context>\n规矩\n</project_context>\n\n${skills}\n\n${cwd}`, "原文"), `<project_context>\n规矩\n</project_context>\n\n${cwd}`);
  assert.equal(piTail(`原文\n\n${cwd}`, "原文"), cwd);
  assert.equal(piTail(`别的开头\n\n${skills}\n\n${cwd}`, "原文"), cwd);
  assert.equal(piTail("别的开头", "原文"), "");
  assert.equal(piTail(`原文\n\n${cwd}`, ""), cwd);
});

test("任务 skill 的正文去掉 frontmatter；每一部分不带文字的几样事实；每一部分都有给人看的名字", () => {
  assert.equal(skillBody("---\nname: a\n---\n\n# 标题\n正文\n"), "# 标题\n正文\n");
  assert.equal(skillBody("# 没有 frontmatter\n"), "# 没有 frontmatter\n");
  const prompt = compose("reading");
  const facts = prompt.parts.map(partFact);
  assert.deepEqual(Object.keys(facts[0]), ["part", "from", "file", "bytes", "lines", "digest"]);
  assert.deepEqual(Object.keys(facts[2]), ["part", "from", "file", "module", "bytes", "lines", "digest"]);
  for (const [i, fact] of facts.entries()) {
    assert.equal(fact.bytes, Buffer.byteLength(prompt.parts[i].text, "utf-8"));
    assert.equal(fact.digest, digestOf(prompt.parts[i].text));
    assert.match(fact.digest, /^[0-9a-f]{16}$/);
    assert.ok(PART_NAMES[fact.part]);
  }
  assert.equal(facts[facts.length - 1].lines, 3);
  assert.deepEqual(Object.keys(ORIGIN_NAMES).sort(), ["builtin", "generated", "pi", "prompt_dir", "task"]);
});

// ───────────── 不是每次都重读重拼 ─────────────

/** 记次数的读文件动作：读了几份文件的内容。 */
function countingIo(): PromptIo & { reads: string[] } {
  const io = {
    reads: [] as string[],
    stamp: (path: string) => NODE_IO.stamp(path),
    read(path: string) { io.reads.push(path); return NODE_IO.read(path); },
    plain: (path: string) => NODE_IO.plain(path),
    readStrict(path: string) { io.reads.push(path); return NODE_IO.readStrict(path); },
  };
  return io;
}

test("连续两次运行位置不变：第二次沿用上一份，没有读任何文件的内容；位置变了才重拼", () => {
  const io = countingIo();
  const cache = new ContextCache(io);
  const at = (stage: Stage) => cache.get({ stage, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL });
  const first = at("clarifying");
  assert.equal(first.how, "recomposed");
  assert.ok(io.reads.length > 0);
  io.reads.length = 0;
  const second = at("clarifying");
  assert.equal(second.how, "reused");
  assert.deepEqual(io.reads, []);
  assert.equal(second.prompt, first.prompt);
  assert.equal(second.prompt.text, compose("clarifying").text);
  const moved = at("writing");
  assert.equal(moved.how, "recomposed");
  assert.ok(moved.prompt.text.includes("# 现在这个阶段：写条目\n") && !moved.prompt.text.includes("# 现在这个阶段：澄清\n"));
  assert.equal(at("writing").how, "reused");
  assert.equal(at("clarifying").how, "recomposed");
});

test("文件改了、模块目录里多了一份文件、任务目录里多了补充、pi 接的那一截变了，都重拼", () => {
  const dir = platformCopy();
  const { task, skillDir, skills } = skillCopy();
  const cache = new ContextCache();
  const input = { stage: "reading" as const, workspaceDir: task, skills, tail: TAIL, platformDir: dir };
  assert.equal(cache.get(input).how, "recomposed");
  assert.equal(cache.get(input).how, "reused");
  // 改一句：大小变了。
  writeFileSync(join(dir, "templates", "reading.md"), "---\ntemplate: reading\nwrites_allowed: page, problem\n---\n\n# 现在这个阶段：核读材料\n\n改过。\n");
  const edited = cache.get(input);
  assert.equal(edited.how, "recomposed");
  assert.ok(edited.prompt.text.includes("改过。"));
  // 大小没变、修改时刻变了。
  const sources = join(dir, "capabilities", "writing", "sources.md");
  utimesSync(sources, new Date(), new Date(Date.now() + 5000));
  assert.equal(cache.get(input).how, "recomposed");
  assert.equal(cache.get(input).how, "reused");
  // 模块目录里多了一份：旧结果失效；这一份有错，就拼不成。
  writeFileSync(join(dir, "capabilities", "planning", "broken.md"), "没有头");
  assert.throws(() => cache.get(input), /planning\/broken\.md 开头没有头/);
  rmSync(join(dir, "capabilities", "planning", "broken.md"));
  assert.equal(cache.get(input).how, "recomposed");
  // 任务目录里这项活动的补充多了一句。
  const activity = join(skillDir, "activities", "reading.md");
  // 分了段的活动文件：加在常驻段末尾（第一个分段标记之前）。
  const before = readFileSync(activity, "utf-8"), cut = before.indexOf("\n<!-- segment:");
  writeFileSync(activity, cut < 0 ? `${before}\n补充的一句。\n` : `${before.slice(0, cut)}\n补充的一句。\n${before.slice(cut)}`, "utf-8");
  const more = cache.get(input);
  assert.equal(more.how, "recomposed");
  assert.ok(more.prompt.parts.find((one) => one.part === "task_activity")!.text.endsWith("补充的一句。"));
  assert.equal(cache.get({ ...input, tail: "<cwd>\n/elsewhere\n</cwd>" }).how, "recomposed");
});

test("重拼出错时把错抛出来，不沿用上一份；文件补回来之后照常重拼", () => {
  const dir = platformCopy();
  const cache = new ContextCache();
  const input = (stage: Stage) => ({ stage, workspaceDir: dir, skills: [], tail: "", platformDir: dir, definitions: DEFS });
  cache.get(input("reading"));
  const saved = join(scratchDir(), "clarifying.md");
  cpSync(join(dir, "templates", "clarifying.md"), saved);
  rmSync(join(dir, "templates", "clarifying.md"));
  assert.throws(() => cache.get(input("clarifying")), /拼系统提示要用的文件不在：.*clarifying\.md/);
  // 上一份已经忘掉：核读材料那一份没变也要重拼，不是沿用出错之前的那一份。
  assert.equal(cache.get(input("reading")).how, "recomposed");
  cpSync(saved, join(dir, "templates", "clarifying.md"));
  assert.equal(cache.get(input("clarifying")).how, "recomposed");
  assert.deepEqual(Object.keys(HOW_NAMES).sort(), ["recomposed", "reused"]);
});

// ───────────── 挂在事件上的那一半（hooks/stage_prompt.ts） ─────────────

/** 一次 before_agent_start：事件与上下文照 pi 给的样子搭，返回处理函数的返回值与它报出去的那一行。session 是这次运行所在的会话。 */
function start(workspaceDir: string, cache: ContextCache, summaries: WeakMap<object, any>, skills = [SRS_SKILL], session: string = CALL_SESSION) {
  const reports: [string, StagePromptReport][] = [];
  const custom = "启动参数给的系统提示";
  const event = { systemPrompt: `${custom}\n\n<skills>\n清单\n</skills>\n\n<cwd>\n${workspaceDir}\n</cwd>`, systemPromptOptions: { customPrompt: custom, skills } };
  let aborted = 0;
  const ctx = { cwd: workspaceDir, ui: { setStatus: (key: string, text: string) => { reports.push([key, JSON.parse(text)]); } }, sessionManager: { getSessionId: () => session },
    abort: () => { aborted += 1; } };
  const result = stagePromptFor(event, ctx, cache, summaries as any);
  return { result: result as { systemPrompt: string } | undefined, raw: result, reports, aborted };
}

test("事件处理：有阶段的任务返回拼好的系统提示并报一行事实；连续两次位置不变，第二次报「沿用」；位置变了报「重拼」", () => {
  const dir = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  enterStage(dir, "reading");
  const cache = new ContextCache();
  const summaries = new WeakMap<object, any>();
  const first = start(dir, cache, summaries);
  assert.ok(first.result!.systemPrompt.startsWith("你是 Taskwright 的执行者"));
  assert.ok(first.result!.systemPrompt.includes("# 现在这个阶段：核读材料\n"));
  assert.ok(first.result!.systemPrompt.endsWith(`<cwd>\n${dir}\n</cwd>`));
  assert.doesNotMatch(first.result!.systemPrompt, /启动参数给的系统提示|<skills>/);
  assert.equal(first.reports.length, 1);
  const [key, report] = first.reports[0];
  assert.equal(key, STAGE_PROMPT_STATUS_KEY);
  assert.deepEqual([report.replaced, report.stage, report.how, report.error], [true, "reading", "recomposed", undefined]);
  const own = first.result!.systemPrompt.slice(0, -`\n\n<cwd>\n${dir}\n</cwd>`.length);
  assert.equal(report.digest, digestOf(own));
  assert.equal(report.bytes, Buffer.byteLength(own, "utf-8"));
  assert.equal(report.lines, own.split("\n").length);
  assert.deepEqual(report.parts!.map((one) => one.module ?? one.part), ["system", "position", ...ALWAYS, ...CONDITIONAL.reading, "template", "task_common", "task_activity"]);
  assert.ok(!JSON.stringify(report).includes(dir));
  assert.ok(!JSON.stringify(report).includes("你是 Taskwright 的执行者"));

  const second = start(dir, cache, summaries);
  assert.equal(second.result!.systemPrompt, first.result!.systemPrompt);
  assert.deepEqual([second.reports[0][1].how, second.reports[0][1].digest], ["reused", report.digest]);

  enterStage(dir, "clarifying");
  const third = start(dir, cache, summaries);
  assert.ok(third.result!.systemPrompt.includes("# 现在这个阶段：澄清\n"));
  assert.ok(!third.result!.systemPrompt.includes("# 现在这个阶段：核读材料\n"));
  assert.deepEqual([third.reports[0][1].stage, third.reports[0][1].how], ["clarifying", "recomposed"]);
  assert.notEqual(third.reports[0][1].digest, report.digest);
});

test("事件处理：早先的任务什么都不返回、什么都不报；读不出、拼不成时停下这次运行，写一条消息给用户并报出原因，不用启动时给的那一份", () => {
  const old = makeWorkspace(demoDefinition());
  createTask(callIn(old), { definition_path: DEFINITION_PATH });
  const quiet = start(old, new ContextCache(), new WeakMap());
  assert.equal(quiet.result, undefined);
  assert.deepEqual(quiet.reports, []);

  const broken = scratchDir();
  writeFileSync(join(broken, "task.sqlite"), "这不是一个数据库文件", "utf-8");
  const failed = start(broken, new ContextCache(), new WeakMap());
  assert.equal(failed.aborted, 1);
  assert.ok(failed.raw && "message" in failed.raw && !("systemPrompt" in failed.raw));
  const message = (failed.raw as { message: StopMessage }).message;
  assert.equal(message.customType, STAGE_PROMPT_ERROR_TYPE);
  assert.equal(message.display, true);
  assert.match(message.content, /^这一次助手没有开始工作：拼它的工作说明时出了错，没有拼成。原因：.+ 说明文件修好之前/);
  assert.equal(failed.reports.length, 1);
  assert.deepEqual([failed.reports[0][1].replaced, failed.reports[0][1].stopped], [false, true]);
  assert.match(failed.reports[0][1].error!, /^按会话拼系统提示没有拼成，这次运行停下了：/);
  assert.ok(failed.reports[0][1].error!.endsWith(message.details.reason));
});

// ───────────── 调试模式的提示词目录 ─────────────

test("提示词目录认的文件名：系统提示、每个模块、七份活动模板、流程的定义，加任务类型一级的七份", () => {
  const names = promptDirNames();
  assert.equal(names[0], "system.md");
  assert.equal(names.filter((one) => one.startsWith("capabilities/")).length, REQUIRED_MODULES.length);
  assert.deepEqual(names.filter((one) => one.startsWith("templates/")), [...STAGES, "idle"].map((one) => `templates/${one}.md`));
  assert.deepEqual(names.slice(-7), ["task-type/common.md", ...STAGES.map((one) => `task-type/${one}.md`)]);
});

test("提示词目录里有哪一份就用哪一份，没有的照旧；空目录的效果与没有设相同；别的文件名不读；模块只能代替、不能改名或换次序", () => {
  const dir = scratchDir();
  const input = (stage: Stage) => ({ stage, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL, promptDir: dir });
  assert.equal(composeContext(input("clarifying")).text, compose("clarifying").text);
  // 代替澄清的活动模板与一个模块。
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "templates", "clarifying.md"), "---\ntemplate: clarifying\nwrites_allowed: page, problem\n---\n\n# 现在这个阶段：澄清\n\n改过的一句。\n", "utf-8");
  mkdirSync(join(dir, "capabilities", "dialogue"), { recursive: true });
  writeFileSync(join(dir, "capabilities", "dialogue", "reply_full.md"), "---\nname: reply_full\norder: 200\nwhen: mode=dialogue\n---\n\n## 怎样回复\n\n改过的回复规矩。\n", "utf-8");
  writeFileSync(join(dir, "不认识的名字.md"), "不该读到的文字", "utf-8");
  const io = countingIo();
  const one = composeContext(input("clarifying"), io);
  const of = (name: string) => one.parts.find((p) => (p.module ?? p.part) === name)!;
  assert.deepEqual([of("template").from, of("template").file], ["prompt_dir", "templates/clarifying.md"]);
  assert.deepEqual([of("reply_full").from, of("reply_full").file], ["prompt_dir", "capabilities/dialogue/reply_full.md"]);
  assert.deepEqual([of("system").from, of("sources").from], ["builtin", "builtin"]);
  assert.ok(one.text.includes("改过的一句。") && one.text.includes("改过的回复规矩。"));
  assert.ok(!one.text.includes("问法有六种") && !one.text.includes("不该读到的文字"));
  assert.deepEqual(one.notes, []);
  assert.ok(io.reads.every((path) => !path.includes("不认识的名字")));
  assert.equal(composeContext(input("modeling")).text, compose("modeling").text);
  // 任务类型一级：目录里的共用部分代替任务目录里的；目录里可以给原来没有补充的活动加一段。
  mkdirSync(join(dir, "task-type"));
  writeFileSync(join(dir, "task-type", "common.md"), "---\nname: x\n---\n\n# 改过的任务类型说明\n", "utf-8");
  writeFileSync(join(dir, "task-type", "clarifying.md"), "## 这类任务在澄清阶段\n\n新加的一段。\n", "utf-8");
  const two = composeContext(input("clarifying"));
  assert.deepEqual(two.parts.filter((p) => p.part.startsWith("task_")).map((p) => [p.part, p.from, p.file]),
    [["task_common", "prompt_dir", "task-type/common.md"], ["task_activity", "prompt_dir", "task-type/clarifying.md"]]);
  assert.ok(!two.text.includes("# 需求工程"));
  // 代替的模块改了名字或次序号：拼不成。
  writeFileSync(join(dir, "capabilities", "dialogue", "reply_full.md"), "---\nname: reply_full\norder: 201\nwhen: mode=dialogue\n---\n\n正文\n", "utf-8");
  assert.throws(() => composeContext(input("clarifying")), /只能代替，不能改名或换次序/);
});

test("提示词目录里不用的文件：软链接不跟、目录不读、太大的不读、不是合法 UTF-8 的不用；这一部分照旧用原来的，并写明原因", () => {
  const dir = scratchDir();
  const secret = join(scratchDir(), "别处的文件.md");
  writeFileSync(secret, "别处的文字，不该进系统提示", "utf-8");
  symlinkSync(secret, join(dir, "system.md"));
  mkdirSync(join(dir, "templates", "reading.md"), { recursive: true });
  mkdirSync(join(dir, "capabilities", "reading"), { recursive: true });
  writeFileSync(join(dir, "capabilities", "reading", "materials.md"), "字".repeat(Math.ceil(PROMPT_DIR_MAX_BYTES / 3) + 1), "utf-8");
  mkdirSync(join(dir, "task-type"));
  writeFileSync(join(dir, "task-type", "common.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  const io = countingIo();
  const prompt = composeContext({ stage: "reading", workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL, promptDir: dir }, io);
  assert.equal(prompt.text, compose("reading").text);
  assert.ok(!prompt.text.includes("别处的文字"));
  assert.ok(!io.reads.includes(join(dir, "system.md")), "软链接指向的文件没有读");
  assert.ok(!io.reads.includes(join(dir, "capabilities", "reading", "materials.md")), "太大的文件没有读");
  assert.deepEqual(prompt.notes.map((one) => one.replace(/：.*$/, "")).sort(), ["提示词目录里的 capabilities/reading/materials.md 没有用上", "提示词目录里的 system.md 没有用上",
    "提示词目录里的 task-type/common.md 没有用上", "提示词目录里的 templates/reading.md 没有用上"]);
  assert.ok(prompt.notes.some((one) => / system\.md 没有用上：它是一个软链接。这一部分照旧用原来的。$/.test(one)));
  assert.ok(prompt.notes.some((one) => /templates\/reading\.md 没有用上：它不是普通文件。/.test(one)));
  assert.ok(prompt.notes.some((one) => /task-type\/common\.md 没有用上：它不是合法的 UTF-8 文字。/.test(one)));
  assert.ok(prompt.notes.some((one) => /materials\.md 没有用上：它有 \d+ 字节，超过了 262144 字节的上限。/.test(one)));
});

test("提示词目录里改一句，下一次就重拼；目录没变就沿用；换一个目录也重拼", () => {
  const dir = scratchDir();
  mkdirSync(join(dir, "templates"));
  const cache = new ContextCache();
  const input = (promptDir: string | null) => ({ stage: "clarifying" as const, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL, promptDir });
  const file = join(dir, "templates", "clarifying.md");
  const head = "---\ntemplate: clarifying\nwrites_allowed: page, problem\n---\n\n";
  assert.equal(cache.get(input(dir)).how, "recomposed");
  assert.equal(cache.get(input(dir)).how, "reused");
  writeFileSync(file, `${head}起先的文字`, "utf-8");
  const first = cache.get(input(dir));
  assert.equal(first.how, "recomposed");
  assert.ok(first.prompt.text.includes("起先的文字"));
  assert.equal(cache.get(input(dir)).how, "reused");
  writeFileSync(file, `${head}改过之后的文字，长一些`, "utf-8");
  assert.ok(cache.get(input(dir)).prompt.text.includes("改过之后的文字，长一些"));
  rmSync(file);
  assert.equal(cache.get(input(dir)).prompt.text, compose("clarifying").text);
  // 提示词目录里多了一个模块的代替文件：也重拼。
  mkdirSync(join(dir, "capabilities", "writing"), { recursive: true });
  writeFileSync(join(dir, "capabilities", "writing", "sources.md"), "---\nname: sources\norder: 40\nwhen: always\n---\n\n## 来源怎样填\n\n调试用的来源规矩。\n");
  assert.ok(cache.get(input(dir)).prompt.text.includes("调试用的来源规矩。"));
  assert.equal(cache.get(input(null)).how, "recomposed");
  assert.equal(cache.get(input(null)).how, "reused");
});

test("这一次运行的提示词目录：不是调试模式时不读设置文件；调试模式下每次现读，设的不是一个存在的目录时不用并写明原因", () => {
  const dir = scratchDir();
  const settings = join(scratchDir(), "settings.json");
  const env = (extra: Record<string, string> = {}) => ({ [ENV_DEBUG_SETTINGS]: settings, ...extra });
  writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: dir } }), "utf-8");
  assert.deepEqual(debugPromptDir({}), { debug: false, dir: null });
  assert.deepEqual(debugPromptDir({ [ENV_DEBUG_SETTINGS]: "  " }), { debug: false, dir: null });
  assert.deepEqual(debugPromptDir(env()), { debug: true, dir });
  const other = scratchDir();
  writeFileSync(settings, JSON.stringify({ version: 2, debug: { prompt_dir: other }, pi_dirs: {} }), "utf-8");
  assert.deepEqual(debugPromptDir(env()), { debug: true, dir: other });
  for (const text of ["{}", JSON.stringify({ debug: {} }), JSON.stringify({ debug: { prompt_dir: "" } }), "这不是 JSON"]) {
    writeFileSync(settings, text, "utf-8");
    assert.deepEqual(debugPromptDir(env()), { debug: true, dir: null }, text);
  }
  assert.deepEqual(debugPromptDir({ [ENV_DEBUG_SETTINGS]: join(scratchDir(), "没有这个文件.json") }), { debug: true, dir: null });
  writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: "relative/dir" } }), "utf-8");
  assert.match(debugPromptDir(env()).note!, /^设置里的提示词目录不是绝对路径：relative\/dir。这次没有用它。$/);
  for (const bad of [join(dir, "没有这个目录"), settings]) {
    writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: bad } }), "utf-8");
    const got = debugPromptDir(env());
    assert.deepEqual([got.debug, got.dir], [true, null]);
    assert.match(got.note!, /^设置里的提示词目录不存在或者不是目录：/);
  }
});

test("事件处理，调试模式：从提示词目录读，报出去的那一行带每一部分的文字；早先的任务也报一行；不是调试模式时两样都没有", () => {
  const dir = makeWorkspace(overallDefinition(), { material: false });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  enterStage(dir, "clarifying");
  const promptDir = scratchDir();
  const settings = join(scratchDir(), "settings.json");
  writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: promptDir } }), "utf-8");
  mkdirSync(join(promptDir, "templates"));
  const head = "---\ntemplate: clarifying\nwrites_allowed: page, problem\n---\n\n";
  writeFileSync(join(promptDir, "templates", "clarifying.md"), `${head}# 现在这个阶段：澄清\n\n调试时改的一句。`, "utf-8");
  const before = process.env[ENV_DEBUG_SETTINGS];
  try {
    process.env[ENV_DEBUG_SETTINGS] = settings;
    const cache = new ContextCache();
    const summaries = new WeakMap<object, any>();
    const first = start(dir, cache, summaries);
    assert.ok(first.result!.systemPrompt.includes("调试时改的一句。"));
    const report = first.reports[0][1];
    assert.deepEqual([report.replaced, report.stage, report.how, report.debug, report.prompt_dir, report.notes], [true, "clarifying", "recomposed", true, promptDir, []]);
    assert.equal(report.texts!.map((one) => one.text).join("\n\n"), first.result!.systemPrompt);
    const template = report.texts!.find((one) => one.part === "template")!;
    assert.deepEqual([template.from, template.file], ["prompt_dir", "templates/clarifying.md"]);
    writeFileSync(join(promptDir, "templates", "clarifying.md"), `${head}# 现在这个阶段：澄清\n\n调试时又改了一句，比上一句长。`, "utf-8");
    const second = start(dir, cache, summaries);
    assert.ok(second.result!.systemPrompt.includes("调试时又改了一句，比上一句长。"));
    assert.equal(second.reports[0][1].how, "recomposed");
    assert.equal(start(dir, cache, summaries).reports[0][1].how, "reused");
    writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: join(promptDir, "没有这个目录") } }), "utf-8");
    const third = start(dir, cache, summaries);
    assert.ok(!third.result!.systemPrompt.includes("调试时"));
    assert.deepEqual([third.reports[0][1].prompt_dir, third.reports[0][1].notes!.length], [null, 1]);
    const old = makeWorkspace(demoDefinition());
    createTask(callIn(old), { definition_path: DEFINITION_PATH });
    const legacy = start(old, new ContextCache(), new WeakMap());
    assert.equal(legacy.result, undefined);
    assert.deepEqual([legacy.reports[0][1].replaced, legacy.reports[0][1].debug, legacy.reports[0][1].texts!.length, legacy.reports[0][1].texts![0].part], [false, true, 1, "launch"]);
    assert.ok(legacy.reports[0][1].texts![0].text.startsWith("启动参数给的系统提示"));
  } finally {
    if (before === undefined) delete process.env[ENV_DEBUG_SETTINGS];
    else process.env[ENV_DEBUG_SETTINGS] = before;
  }
  const plain = start(dir, new ContextCache(), new WeakMap());
  assert.ok(!plain.result!.systemPrompt.includes("调试时"));
  assert.deepEqual(["debug" in plain.reports[0][1], "texts" in plain.reports[0][1], "prompt_dir" in plain.reports[0][1]], [false, false, false]);
});

// ───────────── 节点的出口、单项活动、空闲 ─────────────

test("去掉一节、去掉开头：两个切文字的小函数", () => {
  assert.equal(EXIT_HEADING, "出口");
  assert.equal(withoutSection("# 甲\n\n一句。\n\n## 出口\n\n- 发卡片。\n\n### 细节\n\n键。\n\n## 别的\n\n别的话。", EXIT_HEADING), "# 甲\n\n一句。\n\n## 别的\n\n别的话。");
  for (const same of ["## 甲\n\n一句。", "## 出口之外\n\n一句。", "## 甲\n\n### 出口\n\n一句。", ""]) assert.equal(withoutSection(same, EXIT_HEADING), same);
  assert.equal(withoutOpening("# 现在这个阶段：澄清\n\n任务现在在澄清阶段。\n\n## 这一段做什么\n\n1. 问。"), "## 这一段做什么\n\n1. 问。");
  assert.equal(withoutOpening("没有小节的一段。"), "没有小节的一段。");
});

test("工作项是单项活动时：活动模板原样，单项活动的收尾是一个模块，不带节点的出口与阶段迁移的规矩，流程的定义不读", () => {
  const io = countingIo();
  const alone = composeContext({ stage: "modeling", inFlow: false, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL }, io);
  const inFlow = compose("modeling");
  assert.deepEqual(kinds(alone), ["system", "position", ...ALWAYS, ...CONDITIONAL.modeling.filter((one) => one !== "flow_transitions"), "standalone_exit", "template", "task_common", "tail"]);
  assert.ok(io.reads.every((path) => !path.includes("flows")));
  const text = (prompt: StagePrompt, name: string) => prompt.parts.find((one) => (one.module ?? one.part) === name)!.text;
  assert.equal(text(alone, "template"), text(inFlow, "template"));
  const exit = text(alone, "standalone_exit");
  assert.ok(exit.startsWith("## 出口\n\n本会话的工作项是单项活动，不在工作流程里。这项活动做够了就在回复里汇报做完，不提议进入别的活动"));
  assert.ok(exit.includes("汇报只是一句话，工作项照旧留着") && exit.includes("回复里写 `activity_done: true`") && exit.includes("请用户从任务起点页启动相应的工作项"));
  // 工作流里怎样提议下一步（转移的模块、活动补充里的收尾一节）不在里面；在工作流里时在。
  const flowExit = "在成文的话里写第 7 条的汇报";
  assert.ok(!alone.text.includes(flowExit) && inFlow.text.includes(flowExit));
  assert.ok(!alone.text.includes("## 各步之间的转移") && inFlow.text.includes("## 各步之间的转移"));
  const cache = new ContextCache();
  const input = { stage: "modeling" as const, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL };
  assert.deepEqual([cache.get(input).how, cache.get({ ...input, inFlow: false }).how, cache.get({ ...input, inFlow: false }).how, cache.get({ ...input, inFlow: true }).how],
    ["recomposed", "recomposed", "reused", "recomposed"]);
});

test("任务空闲时：空闲的规矩紧接在活动模板之前，活动模板是澄清的去掉标题、开头那一段话与「出口」一节；不带任何节点的出口", () => {
  const idle = composeContext({ stage: IDLE, workspaceDir: SRS_TYPE, skills: [SRS_SKILL], tail: TAIL });
  const clarifying = compose("clarifying");
  assert.equal(idle.stage, IDLE);
  assert.deepEqual(kinds(idle), ["system", "position", ...ALWAYS, ...CONDITIONAL.idle, "template", "task_common", "tail"]);
  assert.equal(idle.parts.find((one) => one.part === "template")!.file, "agent/prompts/templates/idle.md");
  const own = idle.parts.find((one) => one.part === "template")!.text;
  assert.equal(own, withoutOpening(withoutSection(clarifying.parts.find((one) => one.part === "template")!.text, EXIT_HEADING)));
  const rules = idle.parts.find((one) => one.module === "idle_rules")!.text;
  assert.equal(rules, "# 现在：自由讨论\n\n本会话不属于任何工作项，是自由讨论的会话。下面的规矩与澄清一段相同，但不写需求条目，不提议进入任何阶段，" +
    "也不提议开始哪一项活动；用户上传了材料也不自行核读。用户要做哪一项活动，请他从任务起点页启动一个工作项。");
  assert.ok(idle.text.includes(`${rules}\n\n${own}`), "空闲的规矩与活动模板紧挨着");
  assert.ok(!own.includes("# 现在这个阶段：澄清") && !own.includes("任务现在在澄清阶段"));
  for (const heading of ["## 这一段做什么", "## 这一段不做什么", "## 做到什么算够"]) assert.ok(own.includes(`${heading}\n`), heading);
  assert.doesNotMatch(idle.text, /^## 出口$|^## 用户说的话不属于本段时$/m);
  const flowExit = "两种情形发卡片：用户问起";
  assert.ok(!idle.text.includes(flowExit) && clarifying.text.includes(flowExit), "流程里澄清这个节点的出口不在里面");
});

test("任务空闲时：任务类型一级澄清的那一段若有「出口」一节也去掉；共用部分里的同名一节不动", () => {
  const { task, skillDir, skills } = skillCopy("任务类型共用\n\n## 出口\n\n共用部分里的这一节不动。");
  const activity = join(skillDir, "activities", "clarifying.md");
  writeFileSync(activity, `${readFileSync(activity, "utf-8")}\n## 这类任务在澄清阶段\n\n多问一句。\n\n## 出口\n\n任务类型的出口。`, "utf-8");
  const prompt = composeContext({ stage: IDLE, workspaceDir: task, skills, tail: TAIL });
  assert.equal(prompt.parts.find((one) => one.part === "task_common")!.text, "任务类型共用\n\n## 出口\n\n共用部分里的这一节不动。");
  assert.equal(prompt.parts.find((one) => one.part === "task_activity")!.text, "## 这类任务在澄清阶段\n\n多问一句。");
});

test("读一条会话现在在哪里：流程的工作项、单项活动的工作项、空闲各是什么；同一个任务里不同的会话各看各的；事件处理照它拼并报出去", () => {
  const dir = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  assert.deepEqual(whereInWorkspace(dir, CALL_SESSION), { stage: IDLE, inFlow: false, flow: null, scope: null });
  enterStage(dir, "modeling");
  assert.deepEqual(whereInWorkspace(dir, CALL_SESSION), { stage: "modeling", inFlow: true, flow: "analysis", scope: null, activity: "modeling", assetNames: NAMES });
  const cache = new ContextCache(), summaries = new WeakMap<object, any>();
  const flowed = start(dir, cache, summaries).reports[0][1];
  assert.deepEqual([flowed.stage, flowed.in_flow], ["modeling", true]);
  assert.ok(flowed.parts!.some((one) => one.module === "flow_transitions"));
  runUserOperation({ workspaceDir: dir, sessionId: "sess-alone" }, { op_id: "ui-op-prompt-1", kind: "start_activity", fields: { activity: "澄清", in_flow: false } });
  assert.deepEqual([whereInWorkspace(dir, "sess-alone"), whereInWorkspace(dir, CALL_SESSION)], [{ stage: "clarifying", inFlow: false, flow: null, scope: null, activity: "clarifying", assetNames: NAMES }, { stage: "modeling", inFlow: true, flow: "analysis", scope: null, activity: "modeling", assetNames: NAMES }]);
  const alone = start(dir, cache, summaries, undefined, "sess-alone");
  assert.deepEqual([alone.reports[0][1].stage, alone.reports[0][1].in_flow, alone.reports[0][1].how], ["clarifying", false, "recomposed"]);
  assert.ok(alone.result!.systemPrompt.includes("本会话的工作项是单项活动") && alone.result!.systemPrompt.includes("# 现在这个阶段：澄清\n"));
  assert.ok(!alone.reports[0][1].parts!.some((one) => one.module === "flow_transitions"));
  assert.deepEqual(whereInWorkspace(dir, "sess-free"), { stage: IDLE, inFlow: false, flow: null, scope: null });
  idleSessions(dir);
  assert.deepEqual([whereInWorkspace(dir, CALL_SESSION), stageInWorkspace(dir, "sess-alone")], [{ stage: IDLE, inFlow: false, flow: null, scope: null }, IDLE]);
  const idle = start(dir, cache, summaries);
  assert.deepEqual([idle.reports[0][1].replaced, idle.reports[0][1].stage, idle.reports[0][1].in_flow, idle.reports[0][1].how], [true, "idle", false, "recomposed"]);
  assert.ok(idle.result!.systemPrompt.includes("# 现在：自由讨论\n") && !idle.result!.systemPrompt.includes("# 现在这个阶段："));
  assert.deepEqual(whereInWorkspace(dir, null), { stage: IDLE, inFlow: false, flow: null, scope: null });
});

test("范围说明：用户启动工作项时写了，这个工作项的会话的系统提示在任务类型的几段后面多一部分；别的工作项的会话、空闲的会话没有；只是范围说明不同也重拼", () => {
  const dir = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const op = (n: number, session: string, fields: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: session }, { op_id: `ui-op-scope-${n}`, kind: "start_activity", fields });
  op(1, "sess-1", { activity: "澄清", in_flow: false, scope: "只问续借的规则" });
  assert.deepEqual(whereInWorkspace(dir, "sess-1"), { stage: "clarifying", inFlow: false, flow: null, scope: "只问续借的规则", activity: "clarifying", assetNames: NAMES });
  const cache = new ContextCache(), summaries = new WeakMap<object, any>();
  const scoped = start(dir, cache, summaries, undefined, "sess-1");
  assert.deepEqual(scoped.reports[0][1].parts!.map((one) => [one.part, one.from, one.file]).at(-1), ["scope", "task", null]);
  assert.equal(scopeSection("  只问续借的规则 "), "## 本次范围说明\n\n用户启动这个工作项时写了范围说明。这一次照它说的范围做；它没有说到的，照上面的说明。\n\n本次范围说明：只问续借的规则");
  const text = scoped.result!.systemPrompt;
  assert.ok(text.includes(scopeSection("只问续借的规则")));
  assert.ok(text.indexOf("## 本次范围说明") < text.indexOf("<cwd>"), "接在助手程序接的那一截之前");
  assert.equal(PART_NAMES.scope, "本次范围说明");
  assert.equal(start(dir, cache, summaries, undefined, "sess-1").reports[0][1].how, "reused");
  op(2, "sess-2", { activity: "核读材料", in_flow: true, scope: "先读新补的那一份。" });
  const flowed = start(dir, cache, summaries, undefined, "sess-2");
  assert.deepEqual([flowed.reports[0][1].how, flowed.reports[0][1].parts!.map((one) => one.part).slice(-3)], ["recomposed", ["task_common", "task_activity", "scope"]]);
  assert.ok(flowed.result!.systemPrompt.includes("本次范围说明：先读新补的那一份。") && !flowed.result!.systemPrompt.includes("只问续借的规则"));
  op(3, "sess-3", { activity: "澄清", in_flow: false });
  assert.deepEqual([whereInWorkspace(dir, "sess-3"), whereInWorkspace(dir, "sess-1")!.scope], [{ stage: "clarifying", inFlow: false, flow: null, scope: null, activity: "clarifying", assetNames: NAMES }, "只问续借的规则"]);
  assert.ok(!start(dir, cache, summaries, undefined, "sess-3").result!.systemPrompt.includes("本次范围说明"));
  const idle = composeContext({ stage: IDLE, scope: "不该出现", workspaceDir: dir, skills: [], tail: "", definitions: DEFS });
  assert.ok(!idle.text.includes("不该出现"));
});

test("工作流里的转移由程序从声明推出来：各步、上一步与下一步、下一步只能由用户发起时不发卡片、分工表按各活动的写入；声明里一步的提示接在活动补充之后", () => {
  const moves = (stage: Stage) => compose(stage).parts.find((one) => one.module === "flow_transitions")!.text;
  assert.ok(moves("reading").includes("现在在「核读材料」这一步。这是第一步，前面没有别的步。下一步是「澄清」：提议进入时选项固定两个，`next_step`「进入下一步：澄清」、`stay`「继续本步」。"));
  assert.ok(moves("modeling").includes("上一步是「澄清」。下一步是「写条目」"));
  assert.ok(moves("document").includes("下一步是「发布」，只能由用户发起：这一步做完了，在成文的话里说明怎样发布（前置条件：评审无未处理发现，确认记录待处理为 0），不发进入它的卡片。"));
  assert.ok(moves("writing").includes("- 业务说明：核读材料、澄清、整理建模、编写文档\n- 分析模型：整理建模\n- 需求条目：写条目、评审确认\n- 评审与确认：评审确认\n- 文档与版本：编写文档、发布"));
  // 一步的提示：写在流程声明里 note.<活动标识符>，接在这一步的活动补充之后。
  const { task, skillDir, skills } = skillCopy();
  const flowFile = join(skillDir, "flows", "analysis.md");
  writeFileSync(flowFile, readFileSync(flowFile, "utf-8").replace("\nrequires:\n", "\nrequires:\nnote.clarifying: 这一步先问目标。\n"));
  const prompt = composeContext({ stage: "clarifying", workspaceDir: task, skills, tail: "" });
  assert.deepEqual(kinds(prompt).slice(-2), ["task_activity", "flow_note"]);
  assert.equal(prompt.parts.at(-1)!.text, "这一步先问目标。");
  assert.ok(!kinds(composeContext({ stage: "clarifying", inFlow: false, workspaceDir: task, skills, tail: "" })).includes("flow_note"));
});

test("逆向解析的工作项：会话在哪里读出活动标识符 parse_spec 与它算作的阶段核读；位置说明写需求再工程，选的是逆向解析的声明", () => {
  const dir = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  // 需求再工程要「既有规格说明」槽位里有材料：把任务里那份材料记进这个槽位。
  insertMaterial(dir, "inputs/材料.md", { slot: "spec", role: "既有规格说明" });
  runUserOperation({ workspaceDir: dir, sessionId: CALL_SESSION }, { op_id: "ui-op-rewrite-1", kind: "start_activity", fields: { activity: "parse_spec", in_flow: true, flow: "rewrite" } });
  assert.deepEqual(whereInWorkspace(dir, CALL_SESSION), { stage: "reading", inFlow: true, flow: "rewrite", scope: null, activity: "parse_spec", assetNames: NAMES });
  const run = start(dir, new ContextCache(), new WeakMap<object, any>());
  assert.deepEqual([run.reports[0][1].stage, run.reports[0][1].in_flow], ["reading", true]);
  const prompt = run.result!.systemPrompt;
  assert.ok(prompt.includes("「需求再工程」") && prompt.includes("「逆向解析」"), "位置说明写的是这条工作流与这一站");
  assert.ok(prompt.includes("## 这类任务在逆向解析阶段"), "活动补充取的是逆向解析的声明");
});
