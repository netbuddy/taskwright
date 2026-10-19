/**
 * 平台说明的能力模块（src/lib/prompt_modules.ts）的配置测试：头的写法与合法取值、条件的组合、读不成时报错
 * （缺模块、重名、次序号相同、放错地方），拼出来的先后只看次序号，目录有变化时指纹跟着变。用临时目录，不用仓里的模块。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  CAPABILITIES, type ModuleIo, MODULE_IO, PromptAssemblyError, type Situation, isAlways, loadModules, modulesStamp, parseModule, parseWhen, requireModules, selectModules, wanted,
} from "../src/lib/prompt_modules.ts";
import { tempDir } from "./helpers.ts";

const temps: string[] = [];
after(() => { for (const one of temps) rmSync(one, { recursive: true, force: true }); });
function scratch(): string {
  const dir = tempDir("prompt-modules-");
  temps.push(dir);
  return dir;
}

function moduleText(name: string, order: number, when: string, body = `正文 ${name}`): string {
  return `---\nname: ${name}\norder: ${order}\nwhen: ${when}\n---\n\n${body}\n`;
}

function put(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const READING: Situation = { mode: "batch", reads: ["materials", "knowledge"], writes: ["description"], allowed: ["page", "problem"], session: "flow" };
const WRITING: Situation = { mode: "batch", reads: ["description", "models"], writes: ["items"], allowed: ["page", "problem", "diagram", "item", "review"], session: "flow" };
const DOCUMENT: Situation = { mode: "batch", reads: ["all"], writes: ["versions"], allowed: ["page", "problem", "publish"], session: "single" };
const IDLE: Situation = { mode: "dialogue", reads: ["description"], writes: ["description"], allowed: ["page", "problem"], session: "idle" };

test("when 的六种条件各认它的合法取值", () => {
  assert.deepEqual(parseWhen("always", "x.md"), [[{ kind: "always" }]]);
  assert.deepEqual(parseWhen("main=description", "x.md"), [[{ kind: "main", value: "description", negated: false }]]);
  assert.deepEqual(parseWhen("allowed=publish", "x.md"), [[{ kind: "allowed", value: "publish", negated: false }]]);
  assert.deepEqual(parseWhen("reads=knowledge", "x.md"), [[{ kind: "reads", value: "knowledge", negated: false }]]);
  assert.deepEqual(parseWhen("mode=batch", "x.md"), [[{ kind: "mode", value: "batch", negated: false }]]);
  assert.deepEqual(parseWhen("session=idle", "x.md"), [[{ kind: "session", value: "idle", negated: false }]]);
});

test("when 的组合：逗号是任一满足，& 是同时满足，! 是不满足", () => {
  const brief = parseWhen("allowed=page & !main=description", "x.md");
  assert.equal(wanted(brief, READING), false, "核读的主要工作是业务说明这一类：给全文，不给短说明");
  assert.equal(wanted(brief, WRITING), true, "写条目获准写页而主要工作不是它：给短说明");
  const either = parseWhen("session=single, session=idle", "x.md");
  assert.deepEqual([READING, DOCUMENT, IDLE].map((at) => wanted(either, at)), [false, true, true]);
  // 「读」写了 all：全部资产与知识库都算读。
  assert.equal(wanted(parseWhen("reads=knowledge", "x.md"), DOCUMENT), true);
  assert.equal(wanted(parseWhen("reads=models", "x.md"), READING), false);
  assert.equal(isAlways(parseWhen("always", "x.md")), true);
  assert.equal(isAlways(parseWhen("mode=batch", "x.md")), false);
});

test("when 写得不对就报错：不认的条件、不认的值、空选项、always 与别的连用或加 !", () => {
  for (const bad of ["main=chapters", "allowed=diagrams", "reads=everything", "mode=user_only", "session=free", "phase=reading", "", "mode=batch,", "always & mode=batch", "!always", "main"]) {
    assert.throws(() => parseWhen(bad, "bad.md"), PromptAssemblyError, bad);
  }
});

test("头缺栏、取值不认、多了不认的栏，都报错并写明是哪份文件", () => {
  assert.throws(() => parseModule("正文", "reading", "reading/a.md"), /reading\/a\.md 开头没有头/);
  assert.throws(() => parseModule("---\norder: 1\nwhen: always\n---\nx", "reading", "reading/a.md"), /「name」/);
  assert.throws(() => parseModule("---\nname: A\norder: 1\nwhen: always\n---\nx", "reading", "reading/a.md"), /「name」写的是「A」/);
  assert.throws(() => parseModule("---\nname: a\norder: 1.5\nwhen: always\n---\nx", "reading", "reading/a.md"), /「order」/);
  assert.throws(() => parseModule("---\nname: a\norder: 1\n---\nx", "reading", "reading/a.md"), /缺「when」/);
  assert.throws(() => parseModule("---\nname: a\norder: 1\nwhen: always\nmust: yes\n---\nx", "reading", "reading/a.md"), /不认的栏：must/);
  const ok = parseModule(moduleText("a_b2", 30, "mode=dialogue"), "dialogue", "dialogue/a_b2.md");
  assert.deepEqual([ok.name, ok.order, ok.capability, ok.file, ok.body], ["a_b2", 30, "dialogue", "dialogue/a_b2.md", "正文 a_b2"]);
});

test("七个能力目录的名字固定", () => {
  assert.deepEqual([...CAPABILITIES], ["reading", "analysis", "organizing", "writing", "reviewing", "dialogue", "planning"]);
});

test("读整个目录：按次序号排；先 always 的、再有条件的，各按次序号", () => {
  const dir = scratch();
  put(dir, "dialogue/late.md", moduleText("late", 90, "always"));
  put(dir, "reading/early.md", moduleText("early", 10, "always"));
  put(dir, "organizing/pages.md", moduleText("pages", 20, "main=description"));
  put(dir, "writing/items.md", moduleText("items", 5, "main=items"));
  put(dir, "README.md", "说明");
  const modules = loadModules(dir);
  assert.deepEqual(modules.map((one) => one.name), ["items", "early", "pages", "late"]);
  assert.deepEqual(selectModules(modules, READING).map((one) => one.name), ["early", "late", "pages"]);
  assert.deepEqual(selectModules(modules, WRITING).map((one) => one.name), ["early", "late", "items"]);
});

test("拼出来的先后与目录列出文件的先后无关", () => {
  const dir = scratch();
  put(dir, "reading/b.md", moduleText("b", 1, "always"));
  put(dir, "reading/a.md", moduleText("a", 2, "always"));
  put(dir, "planning/c.md", moduleText("c", 3, "always"));
  const reversed: ModuleIo = { ...MODULE_IO, list: (path) => {
    const got = MODULE_IO.list(path);
    return got && { dirs: [...got.dirs].reverse(), files: [...got.files].reverse() };
  } };
  assert.deepEqual(loadModules(dir).map((one) => one.name), ["b", "a", "c"]);
  assert.deepEqual(loadModules(dir, reversed).map((one) => one.name), ["b", "a", "c"]);
});

test("两份模块同名、次序号相同，都报错，不挑一个用", () => {
  const dir = scratch();
  put(dir, "reading/a.md", moduleText("same", 1, "always"));
  put(dir, "dialogue/b.md", moduleText("same", 2, "always"));
  assert.throws(() => loadModules(dir), /两份模块同名「same」：dialogue\/b\.md 与 reading\/a\.md|两份模块同名「same」：reading\/a\.md 与 dialogue\/b\.md/);
  const other = scratch();
  put(other, "reading/a.md", moduleText("a", 7, "always"));
  put(other, "dialogue/b.md", moduleText("b", 7, "always"));
  assert.throws(() => loadModules(other), /次序号都是 7/);
});

test("放错地方的文件报错：根上的别的文件、不认的能力目录、能力目录里的子目录与非 .md 文件", () => {
  const cases: [string, RegExp][] = [["stray.md", /根上有不认的文件：stray\.md/], ["thinking/a.md", /不认的能力目录：thinking/],
    ["reading/sub/a.md", /不能再有子目录/], ["reading/a.txt", /只能放 \.md 文件/]];
  for (const [file, message] of cases) {
    const dir = scratch();
    put(dir, file, moduleText("a", 1, "always"));
    assert.throws(() => loadModules(dir), message, file);
  }
  assert.throws(() => loadModules(join(scratch(), "nowhere")), /模块目录不在/);
});

test("要的模块缺了就报错，写明缺哪几个", () => {
  const dir = scratch();
  put(dir, "reading/a.md", moduleText("a", 1, "always"));
  const modules = loadModules(dir);
  requireModules(modules, ["a"]);
  assert.throws(() => requireModules(modules, ["a", "materials", "sources"]), /缺了这几个模块：materials、sources/);
});

test("指纹：新增文件、改了文件、删了文件、多出子目录，指纹都变；什么都没动时不变", () => {
  const dir = scratch();
  put(dir, "reading/a.md", moduleText("a", 1, "always"));
  const first = modulesStamp(dir);
  assert.equal(modulesStamp(dir), first);
  put(dir, "planning/b.md", moduleText("b", 2, "always"));
  const added = modulesStamp(dir);
  assert.notEqual(added, first);
  utimesSync(join(dir, "reading", "a.md"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const touched = modulesStamp(dir);
  assert.notEqual(touched, added);
  mkdirSync(join(dir, "reading", "sub"));
  assert.notEqual(modulesStamp(dir), touched);
  rmSync(join(dir, "reading", "sub"), { recursive: true });
  rmSync(join(dir, "planning", "b.md"));
  assert.notEqual(modulesStamp(dir), added);
  assert.equal(modulesStamp(join(dir, "nowhere")), "absent");
});
