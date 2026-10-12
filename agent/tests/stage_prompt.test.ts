/**
 * 有阶段的任务的系统提示怎样拼（src/lib/stage_prompt.ts）：五个阶段各拼出什么、早先的任务不拼、没有记录时按缺省的阶段、
 * 早先复制进任务目录的整份任务 skill 怎样读、pi 接在后面的那一截怎样取。用的是仓里真实的那几份说明文件。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { STAGES, STAGE_NAMES } from "../src/lib/stage.ts";
import {
  COMMON_FILE, ENV_DEBUG_SETTINGS, HOW_NAMES, NODE_IO, ORIGIN_NAMES, PART_NAMES, PLATFORM_SKILL_DIR, PLATFORM_STAGES_DIR, PROMPT_DIR_MAX_BYTES, type PromptIo, SYSTEM_FILE,
  StagePromptCache, composeStagePrompt, debugPromptDir, digestOf, partFact, piTail, promptDirNames, skillBody, stageFile, stageInWorkspace, taskSkills,
} from "../src/lib/stage_prompt.ts";
import { STAGE_PROMPT_STATUS_KEY, type StagePromptReport, stagePromptFor } from "../src/hooks/stage_prompt.ts";
import { DEFINITION_PATH, callIn, demoDefinition, enterStage, makeWorkspace, overallDefinition, tempDir } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SRS_TYPE = join(ROOT, "task-types", "srs-authoring");
const SRS_SKILL = { name: "srs-authoring", filePath: join(SRS_TYPE, ".pi", "skills", "srs-authoring", "SKILL.md") };
const PLATFORM_SKILL = { name: "taskwright-executor", filePath: join(PLATFORM_SKILL_DIR, "SKILL.md") };
const TAIL = "<cwd>\n/somewhere/task\n</cwd>";

const temps: string[] = [];
after(() => { for (const one of temps) rmSync(one, { recursive: true, force: true }); });
function scratchDir(): string {
  const dir = tempDir("stage-prompt-");
  temps.push(dir);
  return dir;
}

const compose = (stage: (typeof STAGES)[number]) => composeStagePrompt({ stage, workspaceDir: SRS_TYPE, skills: [PLATFORM_SKILL, SRS_SKILL], tail: TAIL });

for (const stage of STAGES) {
  test(`${STAGE_NAMES[stage]}阶段拼出的系统提示：系统提示、两份共用部分、这个阶段的那一段，最后是工作目录；没有别的五个阶段的段落`, () => {
    const prompt = compose(stage);
    assert.equal(prompt.stage, stage);
    const hasTaskStage = stage === "reading" || stage === "writing" || stage === "document";
    assert.deepEqual(prompt.parts.map((one) => one.part),
      ["system", "platform_common", "task_common", "platform_stage", ...(hasTaskStage ? ["task_stage"] : []), "tail"]);
    assert.deepEqual(prompt.parts.map((one) => one.from), ["builtin", "builtin", "task", "builtin", ...(hasTaskStage ? ["task"] : []), "pi"]);
    assert.deepEqual(prompt.parts.map((one) => one.file), ["agent/prompts/stages/system.md", "agent/prompts/stages/common.md", ".pi/skills/srs-authoring/SKILL.md",
      `agent/prompts/stages/${stage}.md`, ...(hasTaskStage ? [`.pi/skills/srs-authoring/stages/${stage}.md`] : []), null]);
    // 整份文字就是各部分用一个空行接起来。
    assert.equal(prompt.text, prompt.parts.map((one) => one.text).join("\n\n"));
    assert.ok(prompt.text.startsWith("你是 Taskwright 的执行者"));
    assert.ok(prompt.text.endsWith(TAIL));
    // 只有这个阶段的那一段。
    for (const other of STAGES) {
      assert.equal(prompt.text.includes(`# 现在这个阶段：${STAGE_NAMES[other]}\n`), other === stage, STAGE_NAMES[other]);
    }
    assert.equal(prompt.text.includes("## 这类任务在核读材料阶段"), stage === "reading");
    assert.equal(prompt.text.includes("## 这类任务在写条目阶段"), stage === "writing");
    assert.equal(prompt.text.includes("## 这类任务在编写文档阶段"), stage === "document");
    // 任务 skill 的 frontmatter 不进系统提示；pi 的 skill 清单不接回去；早先的任务用的那一份平台说明不在里面。
    assert.doesNotMatch(prompt.text, /^---$/m);
    assert.doesNotMatch(prompt.text, /<skills>|<available_skills>/);
    assert.doesNotMatch(prompt.text, /### 老任务/);
    assert.ok(prompt.text.includes("# 软件需求规格说明编制"));
  });
}

test("「材料里的内容都要整理进条目」只出现在写条目阶段的系统提示里", () => {
  for (const stage of STAGES) assert.equal(compose(stage).text.includes("都要整理进条目"), stage === "writing", stage);
});

test("换阶段时，按阶段的那一段之前的文字一字不变", () => {
  const before = (stage: (typeof STAGES)[number]) => {
    const prompt = compose(stage);
    const at = prompt.parts.findIndex((one) => one.part === "platform_stage");
    return prompt.parts.slice(0, at).map((one) => one.text).join("\n\n");
  };
  for (const stage of STAGES) assert.equal(before(stage), before("reading"), stage);
});

test("早先的任务没有阶段，不拼；任务库不在或还没有任务时也不拼", () => {
  const old = makeWorkspace(demoDefinition());
  createTask(callIn(old), { definition_path: DEFINITION_PATH });
  assert.equal(stageInWorkspace(old), null);
  assert.equal(stageInWorkspace(scratchDir()), null);
  const empty = makeWorkspace(overallDefinition());
  assert.equal(stageInWorkspace(empty), null);
});

test("没有阶段记录时按缺省的阶段：有材料是核读材料，没有材料是澄清；有了记录看最近一条", () => {
  const withMaterial = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(withMaterial), { definition_path: DEFINITION_PATH });
  assert.equal(stageInWorkspace(withMaterial), "reading");
  const noMaterial = makeWorkspace(overallDefinition(), { material: false });
  createTask(callIn(noMaterial), { definition_path: DEFINITION_PATH });
  assert.equal(stageInWorkspace(noMaterial), "clarifying");
  enterStage(withMaterial, "modeling");
  assert.equal(stageInWorkspace(withMaterial), "modeling");
  enterStage(withMaterial, "clarifying");
  assert.equal(stageInWorkspace(withMaterial), "clarifying");
});

test("早先复制进任务目录的整份任务 skill（没有 stages 目录）：整份正文当共用部分，按阶段的那一段为空", () => {
  const task = scratchDir();
  const skillDir = join(task, ".pi", "skills", "old-type");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: old-type\ndescription: 早先的整份说明\n---\n\n# 早先的整份说明\n\n1. 读材料。\n2. 分拣。\n", "utf-8");
  const prompt = composeStagePrompt({ stage: "writing", workspaceDir: task, skills: [PLATFORM_SKILL, { name: "old-type", filePath: join(skillDir, "SKILL.md") }], tail: "" });
  assert.deepEqual(prompt.parts.map((one) => one.part), ["system", "platform_common", "task_common", "platform_stage"]);
  assert.equal(prompt.parts[2].text, "# 早先的整份说明\n\n1. 读材料。\n2. 分拣。");
  assert.equal(prompt.parts[2].file, ".pi/skills/old-type/SKILL.md");
});

test("任务 skill 只认平台 skill 之外的；一个任务 skill 都没有、或者它的文件不在时，只拼平台一级的三份", () => {
  assert.deepEqual(taskSkills([PLATFORM_SKILL, SRS_SKILL]), [SRS_SKILL]);
  for (const skills of [[PLATFORM_SKILL], [PLATFORM_SKILL, { name: "gone", filePath: join(scratchDir(), "SKILL.md") }]]) {
    const prompt = composeStagePrompt({ stage: "clarifying", workspaceDir: scratchDir(), skills, tail: TAIL });
    assert.deepEqual(prompt.parts.map((one) => one.part), ["system", "platform_common", "platform_stage", "tail"]);
  }
});

test("平台一级的文件缺了一份就抛错，说明缺的是哪一份", () => {
  const dir = scratchDir();
  writeFileSync(join(dir, SYSTEM_FILE), "系统提示", "utf-8");
  writeFileSync(join(dir, COMMON_FILE), "共用部分", "utf-8");
  assert.throws(() => composeStagePrompt({ stage: "reading", workspaceDir: dir, skills: [], tail: "", platformDir: dir }), /拼系统提示要用的文件不在：.*reading\.md/);
  writeFileSync(join(dir, stageFile("reading")), "核读材料那一段\n\n", "utf-8");
  assert.equal(composeStagePrompt({ stage: "reading", workspaceDir: dir, skills: [], tail: "", platformDir: dir }).text, "系统提示\n\n共用部分\n\n核读材料那一段");
});

test("pi 接在后面的那一截：去掉启动参数给的那一段与 skill 清单，留下工作目录与上下文文件", () => {
  const skills = "<skills>\nThe following skills provide specialized instructions.\n\n<available_skills>\n  <skill>\n    <name>x</name>\n  </skill>\n</available_skills>\n</skills>";
  const cwd = "<cwd>\n/tasks/TASK-1\n</cwd>";
  // 实测的样子：原文、skill 清单、工作目录，各隔一个空行。
  assert.equal(piTail(`原文\n\n${skills}\n\n${cwd}`, "原文"), cwd);
  // 有上下文文件时它在 skill 清单前面或后面，都原样留下。
  assert.equal(piTail(`原文\n\n<project_context>\n规矩\n</project_context>\n\n${skills}\n\n${cwd}`, "原文"), `<project_context>\n规矩\n</project_context>\n\n${cwd}`);
  // 没有 skill 清单时。
  assert.equal(piTail(`原文\n\n${cwd}`, "原文"), cwd);
  // 当前的系统提示不是以启动参数给的那一段开头（别的扩展先改过）：只取工作目录；取不到就是空的。
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
  for (const [i, fact] of facts.entries()) {
    assert.equal(fact.bytes, Buffer.byteLength(prompt.parts[i].text, "utf-8"));
    assert.equal(fact.digest, digestOf(prompt.parts[i].text));
    assert.match(fact.digest, /^[0-9a-f]{16}$/);
    assert.ok(PART_NAMES[fact.part]);
  }
  assert.equal(facts[facts.length - 1].lines, 3);
  assert.ok(PLATFORM_STAGES_DIR.endsWith(join("agent", "prompts", "stages")));
});

// ───────────── 不是每次都重读重拼 ─────────────

/** 记次数的读文件动作：读了几份文件的内容、查了几次文件的属性。 */
function countingIo(): PromptIo & { reads: string[]; stamps: number } {
  const io = {
    reads: [] as string[],
    stamps: 0,
    stamp(path: string) { io.stamps += 1; return NODE_IO.stamp(path); },
    read(path: string) { io.reads.push(path); return NODE_IO.read(path); },
    plain(path: string) { io.stamps += 1; return NODE_IO.plain(path); },
    readStrict(path: string) { io.reads.push(path); return NODE_IO.readStrict(path); },
  };
  return io;
}

/** 一套放在临时目录里的平台一级文件，测试可以随意改。 */
function platformCopy(): string {
  const dir = scratchDir();
  writeFileSync(join(dir, SYSTEM_FILE), "系统提示", "utf-8");
  writeFileSync(join(dir, COMMON_FILE), "共用部分", "utf-8");
  for (const stage of STAGES) writeFileSync(join(dir, stageFile(stage)), `${STAGE_NAMES[stage]}那一段`, "utf-8");
  return dir;
}

test("连续两次运行阶段不变：第二次沿用上一份，没有读任何文件的内容", () => {
  const io = countingIo();
  const cache = new StagePromptCache(io);
  const input = { stage: "clarifying" as const, workspaceDir: SRS_TYPE, skills: [PLATFORM_SKILL, SRS_SKILL], tail: TAIL };
  const first = cache.get(input);
  assert.equal(first.how, "recomposed");
  // 第一次读了四份：系统提示、平台共用、任务类型共用、澄清那一段（这类任务在澄清阶段没有自己的一段）。
  assert.equal(io.reads.length, 4);
  io.reads.length = 0;
  const second = cache.get({ ...input });
  assert.equal(second.how, "reused");
  assert.deepEqual(io.reads, []);
  assert.equal(second.prompt, first.prompt);
  assert.equal(second.prompt.text, composeStagePrompt(input).text);
});

test("阶段变了才重拼；移回原来的阶段也是重拼（只记着上一份）", () => {
  const io = countingIo();
  const cache = new StagePromptCache(io);
  const at = (stage: (typeof STAGES)[number]) => cache.get({ stage, workspaceDir: SRS_TYPE, skills: [PLATFORM_SKILL, SRS_SKILL], tail: TAIL });
  assert.equal(at("clarifying").how, "recomposed");
  assert.equal(at("clarifying").how, "reused");
  io.reads.length = 0;
  const moved = at("writing");
  assert.equal(moved.how, "recomposed");
  assert.equal(io.reads.length, 5);
  assert.ok(moved.prompt.text.includes("# 现在这个阶段：写条目\n"));
  assert.ok(!moved.prompt.text.includes("# 现在这个阶段：澄清\n"));
  assert.equal(at("writing").how, "reused");
  assert.equal(at("clarifying").how, "recomposed");
});

test("文件改了（修改时刻或大小变了）、任务目录里多了这个阶段的一段、pi 接的那一截变了，都重拼", () => {
  const dir = platformCopy();
  const task = scratchDir();
  const skillDir = join(task, ".pi", "skills", "some-type");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "任务类型共用", "utf-8");
  const cache = new StagePromptCache();
  const input = { stage: "reading" as const, workspaceDir: task, skills: [{ name: "some-type", filePath: join(skillDir, "SKILL.md") }], tail: TAIL, platformDir: dir };
  assert.equal(cache.get(input).prompt.text, `系统提示\n\n共用部分\n\n任务类型共用\n\n核读材料那一段\n\n${TAIL}`);
  assert.equal(cache.get(input).how, "reused");
  // 改一句：大小变了。
  writeFileSync(join(dir, stageFile("reading")), "核读材料那一段，改过", "utf-8");
  const edited = cache.get(input);
  assert.equal(edited.how, "recomposed");
  assert.ok(edited.prompt.text.includes("核读材料那一段，改过"));
  // 大小没变、修改时刻变了。
  writeFileSync(join(dir, COMMON_FILE), "共用部份", "utf-8");
  utimesSync(join(dir, COMMON_FILE), new Date(), new Date(Date.now() + 5000));
  assert.equal(cache.get(input).how, "recomposed");
  assert.equal(cache.get(input).how, "reused");
  // 任务目录里多了这个阶段的一段。
  mkdirSync(join(skillDir, "stages"));
  writeFileSync(join(skillDir, "stages", stageFile("reading")), "这类任务在核读材料阶段", "utf-8");
  const more = cache.get(input);
  assert.equal(more.how, "recomposed");
  assert.deepEqual(more.prompt.parts.map((one) => one.part), ["system", "platform_common", "task_common", "platform_stage", "task_stage", "tail"]);
  // pi 接的那一截变了。
  assert.equal(cache.get({ ...input, tail: "<cwd>\n/elsewhere\n</cwd>" }).how, "recomposed");
});

test("重拼出错时沿用上一份并带上原因；手里什么都没有时把错抛出来", () => {
  const dir = platformCopy();
  const cache = new StagePromptCache();
  const input = (stage: (typeof STAGES)[number]) => ({ stage, workspaceDir: dir, skills: [], tail: "", platformDir: dir });
  const good = cache.get(input("reading"));
  rmSync(join(dir, stageFile("clarifying")));
  const kept = cache.get(input("clarifying"));
  assert.equal(kept.how, "kept_after_error");
  assert.equal(kept.prompt, good.prompt);
  assert.match(kept.error!, /拼系统提示要用的文件不在：.*clarifying\.md/);
  // 文件补回来之后照常重拼。
  writeFileSync(join(dir, stageFile("clarifying")), "澄清那一段", "utf-8");
  assert.equal(cache.get(input("clarifying")).how, "recomposed");
  assert.throws(() => new StagePromptCache().get({ ...input("reading"), platformDir: scratchDir() }), /拼系统提示要用的文件不在/);
  assert.deepEqual(Object.keys(HOW_NAMES).sort(), ["kept_after_error", "recomposed", "reused"]);
});

// ───────────── 挂在事件上的那一半（hooks/stage_prompt.ts） ─────────────

/** 一次 before_agent_start：事件与上下文照 pi 给的样子搭，返回处理函数的返回值与它报出去的那一行。 */
function start(workspaceDir: string, cache: StagePromptCache, summaries: WeakMap<object, any>, skills = [PLATFORM_SKILL, SRS_SKILL]) {
  const reports: [string, StagePromptReport][] = [];
  const custom = "启动参数给的系统提示";
  const event = { systemPrompt: `${custom}\n\n<skills>\n清单\n</skills>\n\n<cwd>\n${workspaceDir}\n</cwd>`, systemPromptOptions: { customPrompt: custom, skills } };
  const ctx = { cwd: workspaceDir, ui: { setStatus: (key: string, text: string) => { reports.push([key, JSON.parse(text)]); } } };
  return { result: stagePromptFor(event, ctx, cache, summaries as any), reports };
}

test("事件处理：有阶段的任务返回拼好的系统提示并报一行事实；连续两次阶段不变，第二次报「沿用」；阶段变了报「重拼」", () => {
  const dir = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const cache = new StagePromptCache();
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
  // 摘要值、字节数与各部分只算从文件来的说明文字，不算 pi 接在后面的工作目录那一截（那里面有任务目录的路径）。
  const own = first.result!.systemPrompt.slice(0, -`\n\n<cwd>\n${dir}\n</cwd>`.length);
  assert.equal(report.digest, digestOf(own));
  assert.equal(report.bytes, Buffer.byteLength(own, "utf-8"));
  assert.equal(report.lines, own.split("\n").length);
  assert.deepEqual(report.parts!.map((one) => one.part), ["system", "platform_common", "task_common", "platform_stage", "task_stage"]);
  assert.ok(!JSON.stringify(report).includes(dir));
  // 报出去的那一行不带文字本身。
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

test("事件处理：早先的任务什么都不返回、什么都不报；任务库读不出时不换系统提示并报出原因", () => {
  const old = makeWorkspace(demoDefinition());
  createTask(callIn(old), { definition_path: DEFINITION_PATH });
  const quiet = start(old, new StagePromptCache(), new WeakMap());
  assert.equal(quiet.result, undefined);
  assert.deepEqual(quiet.reports, []);

  const broken = scratchDir();
  writeFileSync(join(broken, "task.sqlite"), "这不是一个数据库文件", "utf-8");
  const failed = start(broken, new StagePromptCache(), new WeakMap());
  assert.equal(failed.result, undefined);
  assert.equal(failed.reports.length, 1);
  assert.equal(failed.reports[0][1].replaced, false);
  assert.match(failed.reports[0][1].error!, /^按阶段换系统提示没有做成，这次运行用启动时给的那一份：/);
});

// ───────────── 调试模式的提示词目录 ─────────────

test("提示词目录只认十五个固定的文件名：平台一级八份，任务类型一级七份", () => {
  assert.deepEqual(promptDirNames(), ["system.md", "common.md", "reading.md", "clarifying.md", "modeling.md", "writing.md", "reviewing.md", "document.md",
    "task-type/common.md", "task-type/reading.md", "task-type/clarifying.md", "task-type/modeling.md", "task-type/writing.md", "task-type/reviewing.md", "task-type/document.md"]);
});

test("提示词目录里有哪一份就用哪一份，没有的照旧；空目录的效果与没有设相同；别的文件名不读", () => {
  const dir = scratchDir();
  const input = (stage: (typeof STAGES)[number]) => ({ stage, workspaceDir: SRS_TYPE, skills: [PLATFORM_SKILL, SRS_SKILL], tail: TAIL, promptDir: dir });
  // 空目录：与没有设一样。
  assert.equal(composeStagePrompt(input("clarifying")).text, compose("clarifying").text);
  // 只放澄清那一段：别的部分照旧。
  writeFileSync(join(dir, "clarifying.md"), "# 现在这个阶段：澄清\n\n改过的一句。\n", "utf-8");
  writeFileSync(join(dir, "不认识的名字.md"), "不该读到的文字", "utf-8");
  const io = countingIo();
  const one = composeStagePrompt(input("clarifying"), io);
  assert.deepEqual(one.parts.map((p) => [p.part, p.from, p.file]), [
    ["system", "builtin", "agent/prompts/stages/system.md"], ["platform_common", "builtin", "agent/prompts/stages/common.md"],
    ["task_common", "task", ".pi/skills/srs-authoring/SKILL.md"], ["platform_stage", "prompt_dir", "clarifying.md"], ["tail", "pi", null]]);
  assert.ok(one.text.includes("改过的一句。"));
  assert.ok(!one.text.includes("问法有六种"));
  assert.ok(!one.text.includes("不该读到的文字"));
  assert.deepEqual(one.notes, []);
  // 读内容的只有四份：三份原来的、一份目录里的；目录里别的文件名碰都没碰。产品自带的澄清那一段没有读。
  assert.equal(io.reads.length, 4);
  assert.ok(io.reads.every((path) => !path.includes("不认识的名字")));
  assert.ok(!io.reads.includes(join(PLATFORM_STAGES_DIR, "clarifying.md")));
  // 别的阶段不受这一份影响。
  assert.equal(composeStagePrompt(input("modeling")).text, compose("modeling").text);
  // 任务类型一级：目录里的共用部分代替任务目录里的；目录里可以给原来没有的阶段加一段。
  mkdirSync(join(dir, "task-type"));
  writeFileSync(join(dir, "task-type", "common.md"), "---\nname: x\n---\n\n# 改过的任务类型说明\n", "utf-8");
  writeFileSync(join(dir, "task-type", "clarifying.md"), "## 这类任务在澄清阶段\n\n新加的一段。\n", "utf-8");
  const two = composeStagePrompt(input("clarifying"));
  assert.deepEqual(two.parts.map((p) => [p.part, p.from, p.file]), [
    ["system", "builtin", "agent/prompts/stages/system.md"], ["platform_common", "builtin", "agent/prompts/stages/common.md"],
    ["task_common", "prompt_dir", "task-type/common.md"], ["platform_stage", "prompt_dir", "clarifying.md"], ["task_stage", "prompt_dir", "task-type/clarifying.md"], ["tail", "pi", null]]);
  assert.equal(two.parts[2].text, "# 改过的任务类型说明");
  assert.ok(!two.text.includes("# 软件需求规格说明编制"));
  // 一份空文件：这一部分就没有了。
  writeFileSync(join(dir, "task-type", "clarifying.md"), "\n", "utf-8");
  assert.ok(!composeStagePrompt(input("clarifying")).parts.some((p) => p.part === "task_stage"));
  assert.deepEqual(Object.keys(ORIGIN_NAMES).sort(), ["builtin", "pi", "prompt_dir", "task"]);
});

test("提示词目录里不用的文件：软链接不跟、目录不读、太大的不读、不是合法 UTF-8 的不用；这一部分照旧用原来的，并写明原因", () => {
  const dir = scratchDir();
  const secret = join(scratchDir(), "别处的文件.md");
  writeFileSync(secret, "别处的文字，不该进系统提示", "utf-8");
  symlinkSync(secret, join(dir, "system.md"));
  mkdirSync(join(dir, "common.md"));
  writeFileSync(join(dir, "reading.md"), "字".repeat(Math.ceil(PROMPT_DIR_MAX_BYTES / 3) + 1), "utf-8");
  mkdirSync(join(dir, "task-type"));
  writeFileSync(join(dir, "task-type", "common.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  const io = countingIo();
  const prompt = composeStagePrompt({ stage: "reading", workspaceDir: SRS_TYPE, skills: [PLATFORM_SKILL, SRS_SKILL], tail: TAIL, promptDir: dir }, io);
  // 拼出来的与没有设目录时完全相同。
  assert.equal(prompt.text, compose("reading").text);
  assert.ok(!prompt.text.includes("别处的文字"));
  assert.ok(!io.reads.includes(join(dir, "system.md")), "软链接指向的文件没有读");
  assert.ok(!io.reads.includes(join(dir, "reading.md")), "太大的文件没有读");
  assert.equal(prompt.notes.length, 4);
  assert.match(prompt.notes[0], /^提示词目录里的 system\.md 没有用上：它是一个软链接。这一部分照旧用产品自带的。$/);
  assert.match(prompt.notes[1], /^提示词目录里的 common\.md 没有用上：它不是普通文件。这一部分照旧用产品自带的。$/);
  assert.match(prompt.notes[2], /^提示词目录里的 task-type\/common\.md 没有用上：它不是合法的 UTF-8 文字。这一部分照旧用任务目录的。$/);
  assert.match(prompt.notes[3], /^提示词目录里的 reading\.md 没有用上：它有 \d+ 字节，超过了 262144 字节的上限。这一部分照旧用产品自带的。$/);
});

test("提示词目录里改一句，下一次就重拼；目录没变就沿用；换一个目录也重拼", () => {
  const dir = scratchDir();
  const cache = new StagePromptCache();
  const input = (promptDir: string | null) => ({ stage: "clarifying" as const, workspaceDir: SRS_TYPE, skills: [PLATFORM_SKILL, SRS_SKILL], tail: TAIL, promptDir });
  assert.equal(cache.get(input(dir)).how, "recomposed");
  assert.equal(cache.get(input(dir)).how, "reused");
  writeFileSync(join(dir, "clarifying.md"), "起先的文字", "utf-8");
  const first = cache.get(input(dir));
  assert.equal(first.how, "recomposed");
  assert.ok(first.prompt.text.includes("起先的文字"));
  assert.equal(cache.get(input(dir)).how, "reused");
  writeFileSync(join(dir, "clarifying.md"), "改过之后的文字，长一些", "utf-8");
  const second = cache.get(input(dir));
  assert.equal(second.how, "recomposed");
  assert.ok(second.prompt.text.includes("改过之后的文字，长一些"));
  rmSync(join(dir, "clarifying.md"));
  assert.equal(cache.get(input(dir)).prompt.text, compose("clarifying").text);
  assert.equal(cache.get(input(null)).how, "recomposed");
  assert.equal(cache.get(input(null)).how, "reused");
});

test("这一次运行的提示词目录：不是调试模式时不读设置文件；调试模式下每次现读，设的不是一个存在的目录时不用并写明原因", () => {
  const dir = scratchDir();
  const settings = join(scratchDir(), "settings.json");
  const env = (extra: Record<string, string> = {}) => ({ [ENV_DEBUG_SETTINGS]: settings, ...extra });
  writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: dir } }), "utf-8");
  // 没有那个环境变量：不是调试模式，设置文件里写着目录也不起作用。
  assert.deepEqual(debugPromptDir({}), { debug: false, dir: null });
  assert.deepEqual(debugPromptDir({ [ENV_DEBUG_SETTINGS]: "  " }), { debug: false, dir: null });
  assert.deepEqual(debugPromptDir(env()), { debug: true, dir });
  // 换了目录，下一次读到的就是新的。
  const other = scratchDir();
  writeFileSync(settings, JSON.stringify({ version: 2, debug: { prompt_dir: other }, pi_dirs: {} }), "utf-8");
  assert.deepEqual(debugPromptDir(env()), { debug: true, dir: other });
  // 没有设、清掉了、设置文件不在或读不出：没有目录，不算出错。
  for (const text of ["{}", JSON.stringify({ debug: {} }), JSON.stringify({ debug: { prompt_dir: "" } }), "这不是 JSON"]) {
    writeFileSync(settings, text, "utf-8");
    assert.deepEqual(debugPromptDir(env()), { debug: true, dir: null }, text);
  }
  assert.deepEqual(debugPromptDir({ [ENV_DEBUG_SETTINGS]: join(scratchDir(), "没有这个文件.json") }), { debug: true, dir: null });
  // 相对路径、不存在的目录、是一个文件：不用，写明原因。
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
  const promptDir = scratchDir();
  const settings = join(scratchDir(), "settings.json");
  writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: promptDir } }), "utf-8");
  writeFileSync(join(promptDir, "clarifying.md"), "# 现在这个阶段：澄清\n\n调试时改的一句。", "utf-8");
  const before = process.env[ENV_DEBUG_SETTINGS];
  try {
    process.env[ENV_DEBUG_SETTINGS] = settings;
    const cache = new StagePromptCache();
    const summaries = new WeakMap<object, any>();
    const first = start(dir, cache, summaries);
    assert.ok(first.result!.systemPrompt.includes("调试时改的一句。"));
    const report = first.reports[0][1];
    assert.deepEqual([report.replaced, report.stage, report.how, report.debug, report.prompt_dir, report.notes], [true, "clarifying", "recomposed", true, promptDir, []]);
    assert.equal(report.texts!.map((one) => one.text).join("\n\n"), first.result!.systemPrompt);
    // 这里的任务 skill 用的是仓里那一份，不在这个临时的任务目录里，所以只核对各部分是什么、出自哪里。
    assert.deepEqual(report.texts!.map((one) => [one.part, one.from]),
      [["system", "builtin"], ["platform_common", "builtin"], ["task_common", "task"], ["platform_stage", "prompt_dir"], ["tail", "pi"]]);
    assert.equal(report.texts![3].file, "clarifying.md");
    // 改一句再问一句：不用重启，下一次运行就是新的。
    writeFileSync(join(promptDir, "clarifying.md"), "# 现在这个阶段：澄清\n\n调试时又改了一句，比上一句长。", "utf-8");
    const second = start(dir, cache, summaries);
    assert.ok(second.result!.systemPrompt.includes("调试时又改了一句，比上一句长。"));
    assert.equal(second.reports[0][1].how, "recomposed");
    assert.equal(start(dir, cache, summaries).reports[0][1].how, "reused");
    // 设置里的目录不能用：照旧用原来的，原因在 notes 里。
    writeFileSync(settings, JSON.stringify({ debug: { prompt_dir: join(promptDir, "没有这个目录") } }), "utf-8");
    const third = start(dir, cache, summaries);
    assert.ok(!third.result!.systemPrompt.includes("调试时"));
    assert.deepEqual([third.reports[0][1].prompt_dir, third.reports[0][1].notes!.length], [null, 1]);
    // 早先的任务：系统提示不换，报一行，带启动时给的那一份。
    const old = makeWorkspace(demoDefinition());
    createTask(callIn(old), { definition_path: DEFINITION_PATH });
    const legacy = start(old, new StagePromptCache(), new WeakMap());
    assert.equal(legacy.result, undefined);
    assert.deepEqual([legacy.reports[0][1].replaced, legacy.reports[0][1].debug, legacy.reports[0][1].texts!.length, legacy.reports[0][1].texts![0].part], [false, true, 1, "launch"]);
    assert.ok(legacy.reports[0][1].texts![0].text.startsWith("启动参数给的系统提示"));
  } finally {
    if (before === undefined) delete process.env[ENV_DEBUG_SETTINGS];
    else process.env[ENV_DEBUG_SETTINGS] = before;
  }
  // 不是调试模式：设置文件还在，目录里的文件不读，报出去的那一行不带文字。
  const plain = start(dir, new StagePromptCache(), new WeakMap());
  assert.ok(!plain.result!.systemPrompt.includes("调试时"));
  assert.deepEqual(["debug" in plain.reports[0][1], "texts" in plain.reports[0][1], "prompt_dir" in plain.reports[0][1]], [false, false, false]);
});
