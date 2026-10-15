// 模板加载器（agent/src/lib/texts.ts）：文件的写法、填值、读入时的检查。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { TextsError, fill, loadTemplates, parseTemplates } from "../src/lib/texts.ts";
import { tempDir } from "./helpers.ts";

const temps: string[] = [];
after(() => { for (const one of temps) rmSync(one, { recursive: true, force: true }); });

const FILE = [
  "# 任务状况",
  "",
  "这一段是文件的说明，不属于任何键。",
  "",
  "## `status.opening`",
  "",
  "用途：会话开头任务现状消息的第一句。",
  "",
  "任务「{{name}}」现在在{{stage}}。",
  "{{name}} 有 {{count}} 个条目。",
  "",
  "",
  "## `status.empty`",
  "用途：任务里还没有条目时的那一句。",
  "还没有条目。",
  "",
].join("\n");

test("一段是：标题行写键，第一个不空的行写用途，往下到下一个标题是正文；第一个键之前的不算，正文去掉首尾的空行", () => {
  const got = parseTemplates("runtime/status.md", FILE);
  assert.deepEqual(got.map((one) => [one.key, one.purpose, one.body, one.placeholders]), [
    ["status.opening", "会话开头任务现状消息的第一句。", "任务「{{name}}」现在在{{stage}}。\n{{name}} 有 {{count}} 个条目。", ["name", "stage", "count"]],
    ["status.empty", "任务里还没有条目时的那一句。", "还没有条目。", []],
  ]);
  assert.equal(got[0].file, "runtime/status.md");
});

test("填值：同一个占位出现几次都填上；数字照写；值里的花括号不再当占位", () => {
  const [opening] = parseTemplates("runtime/status.md", FILE);
  assert.equal(fill(opening, { name: "借还书", stage: "澄清", count: 3 }), "任务「借还书」现在在澄清。\n借还书 有 3 个条目。");
  assert.equal(fill(opening, { name: "{{stage}}", stage: "澄清", count: 0 }), "任务「{{stage}}」现在在澄清。\n{{stage}} 有 0 个条目。");
});

test("填值时少给或多给都抛错，说出键、文件与对不上的名字", () => {
  const [opening, empty] = parseTemplates("runtime/status.md", FILE);
  assert.throws(() => fill(opening, { name: "甲", count: 1 }), (error: Error) => error instanceof TextsError && /status\.opening.*runtime\/status\.md.*缺 stage/.test(error.message));
  assert.throws(() => fill(empty, { name: "甲" }), /多给了 name/);
  assert.equal(fill(empty), "还没有条目。");
});

test("写得不合规矩时读入就抛错：别的二级标题、键的写法、没有用途、没有正文、写错的占位", () => {
  const bad = (text: string, pattern: RegExp) => assert.throws(() => parseTemplates("runtime/x.md", text), (error: Error) => error instanceof TextsError && pattern.test(error.message), text);
  bad("## 状况\n用途：一句。\n正文", /第 1 行：二级标题只能写成/);
  bad("## `Status.Opening`\n用途：一句。\n正文", /键「Status\.Opening」的写法不对/);
  bad("## `status`\n用途：一句。\n正文", /键「status」的写法不对/);
  bad("## `status.a`\n\n正文", /下面第一行要写「用途：」/);
  bad("## `status.a`\n用途：\n正文", /下面第一行要写「用途：」/);
  bad("## `status.a`\n用途：一句。\n\n## `status.b`\n用途：一句。\n正文", /第 1 行：键「status\.a」没有正文/);
  bad("## `status.a`\n用途：一句。\n任务{{ name }}。", /写错的占位/);
  bad("## `status.a`\n用途：一句。\n任务{name}}。", /写错的占位/);
});

test("读一个目录：tools/ 与 runtime/ 下的 .md（README.md 不算）；同一个键写了两次时抛错，说出两个文件", () => {
  const dir = tempDir("texts-");
  temps.push(dir);
  mkdirSync(join(dir, "tools"));
  mkdirSync(join(dir, "runtime"));
  writeFileSync(join(dir, "tools", "reply.md"), "## `reply.description`\n用途：工具的总说明。\n对用户说话。\n", "utf-8");
  writeFileSync(join(dir, "runtime", "README.md"), "## 说明\n", "utf-8");
  writeFileSync(join(dir, "runtime", "status.md"), FILE, "utf-8");
  writeFileSync(join(dir, "runtime", "notes.txt"), "## `status.opening`\n", "utf-8");
  assert.deepEqual([...loadTemplates(dir).keys()], ["reply.description", "status.opening", "status.empty"]);
  writeFileSync(join(dir, "runtime", "again.md"), "## `reply.description`\n用途：重复。\n又一份。\n", "utf-8");
  assert.throws(() => loadTemplates(dir), /键「reply\.description」写了两次：tools\/reply\.md 与 runtime\/again\.md/);
});

test("正文放在 ````text 围栏里时原样取中间的内容：里面可以有 ## 开头的行，首尾的空行保留；没有收尾、围栏后还有字都抛错", () => {
  const fenced = ["## `prompt.exit`", "用途：一节出口。", "", "````text", "## 出口", "", "做够了就汇报。", "````", "", "## `prompt.next`", "用途：下一段。", "下一段。"].join("\n");
  assert.deepEqual(parseTemplates("runtime/x.md", fenced).map((one) => [one.key, one.body]), [["prompt.exit", "## 出口\n\n做够了就汇报。"], ["prompt.next", "下一段。"]]);
  assert.equal(parseTemplates("runtime/x.md", "## `prompt.a`\n用途：一句。\n````text\n\n两头空行\n\n````\n")[0].body, "\n两头空行\n");
  assert.throws(() => parseTemplates("runtime/x.md", "## `prompt.a`\n用途：一句。\n````text\n## 出口\n"), /第 3 行：键「prompt\.a」的围栏没有收尾/);
  assert.throws(() => parseTemplates("runtime/x.md", "## `prompt.a`\n用途：一句。\n````text\n正文\n````\n又一行\n"), /第 6 行：键「prompt\.a」的围栏之后不能再写正文/);
});
