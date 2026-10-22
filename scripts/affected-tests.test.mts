// scripts/affected-tests.mts 的用例：在临时目录里搭一个小仓库（不是 git 仓，脚本按目录列文件），核对导入解析、反向传递、
// 字符串拼的路径、辅助文件按名字传路径、额外边、路径规则、计时类与真栈的标注、--json。跑法：node --test scripts/affected-tests.test.mts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { affected, importSpecs, importedNames, render, resolveSpec, topLevel } from "./affected-tests.mts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "affected-tests.mts");
const root = mkdtempSync(join(tmpdir(), "affected-"));
after(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text = ""): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf-8");
}

// 小仓库：agent 的 a → b → c；web 跨包导入 agent 的 c；backend 的入口与测试辅助；任务类型目录；一份 README。
put("agent/src/lib/c.ts", "export const C = 1;\n");
put("agent/src/lib/b.ts", 'import { C } from "./c.ts";\nexport const B = C;\n');
put("agent/src/lib/a.ts", 'export { B } from "./b.ts";\n');
put("agent/src/extension.ts", 'import "./lib/a.ts";\n');
put("agent/tests/a.test.ts", 'import { B } from "../src/lib/a.ts";\n');
put("agent/tests/helpers.ts", [
  'import { join } from "node:path";',
  'export const SKILL_DIR = join(import.meta.dirname, "..", "..", "task-types", "demo");',
  "export function makeWorkspace() { return SKILL_DIR; }",
  "export function plain() { return 1; }",
  "",
].join("\n"));
put("agent/tests/uses_workspace.test.ts", 'import { makeWorkspace } from "./helpers.ts";\nmakeWorkspace();\n');
put("agent/tests/uses_plain.test.ts", 'import { plain } from "./helpers.ts";\nplain();\n');
put("agent/tests/domain_words_guard.test.ts", 'const SCANNED = ["agent/src"];\n');
put("task-types/demo/flows/x.md", "---\nflow: x\n---\n");
put("web/src/model/m.ts", 'import { C } from "../../../agent/src/lib/c";\nexport const M = C;\n');
put("web/src/test/m.test.ts", 'import { M } from "../model/m";\n');
put("web/src/styles/page.css", ".tp-x {}\n");
put("web/src/test/pageStyles.test.ts", 'const read = (name: string) => name;\nread("styles/page.css");\n');
put("web/src/test/diagramView.test.tsx", 'import { M } from "../model/m";\n');
put("backend/src/launch.ts", "export const L = 1;\n");
put("backend/src/main.mts", 'import { L } from "./launch.ts";\n');
put("backend/tests/helpers.ts", [
  'import { join, resolve, dirname } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");',
  'export const BACKEND_MAIN = join(ROOT, "backend", "src", "main.mts");',
  "export function spawnBackend() { return BACKEND_MAIN; }",
  "",
].join("\n"));
put("backend/tests/stack.test.ts", 'import { spawnBackend } from "./helpers.ts";\nspawnBackend();\n');
put("backend/tests/no_writes.test.ts", "// 扫 backend\n");
put("README.md", "# 说明\n");

const list = (changed: string[]) => affected(root, changed);
const all = (changed: string[]) => Object.values(list(changed).tests).flat();

test("读导入：import … from、export … from、import \"x\"、import(\"x\")；相对路径补后缀解析，不是相对路径的不进图", () => {
  assert.deepEqual(importSpecs('import a from "./a.ts";\nexport { b } from "./b";\nimport "./c.ts";\nconst d = await import("./d.ts");\nimport { e } from "node:fs";'),
    ["./a.ts", "./b", "node:fs", "./c.ts", "./d.ts"]);
  const files = new Set(["agent/src/lib/b.ts", "web/src/model/m.ts", "web/src/model/index.ts"]);
  assert.equal(resolveSpec("agent/src/lib/a.ts", "./b.ts", files), "agent/src/lib/b.ts");
  assert.equal(resolveSpec("web/src/test/x.ts", "../model/m", files), "web/src/model/m.ts");
  assert.equal(resolveSpec("web/src/test/x.ts", "../model", files), "web/src/model/index.ts");
  assert.equal(resolveSpec("web/src/test/x.ts", "antd", files), null);
});

test("反向传递：改 c.ts，经 b.ts、a.ts 到 agent 的测试，也经 web 跨包导入到 web 的测试；改测试文件本身直接列入", () => {
  const got = list(["agent/src/lib/c.ts"]);
  assert.ok(got.tests.agent.includes("agent/tests/a.test.ts"));
  assert.ok(got.tests.web.includes("web/src/test/m.test.ts"));
  assert.deepEqual(list(["agent/tests/a.test.ts"]).tests.agent, ["agent/tests/a.test.ts"]);
});

test("辅助文件按名字传路径：用了 makeWorkspace 的测试依赖任务类型目录，只用了 plain 的不依赖", () => {
  const got = all(["task-types/demo/flows/x.md"]);
  assert.ok(got.includes("agent/tests/uses_workspace.test.ts"));
  assert.equal(got.includes("agent/tests/uses_plain.test.ts"), false);
});

test("额外边与真栈：起后端子进程的测试经 BACKEND_MAIN 依赖后端入口，再经 launch.ts 依赖 pi 扩展；它们标真栈", () => {
  const got = list(["agent/src/lib/c.ts"]);
  assert.ok(got.tests.backend.includes("backend/tests/stack.test.ts"), JSON.stringify(got.tests));
  assert.ok(got.realStack.includes("backend/tests/stack.test.ts"));
  assert.match(render(got), /backend\/tests\/stack\.test\.ts {4}\[真栈：起后端与 pi，慢\]/);
});

test("字面量里的相对文件路径：交给别的函数去拼的 \"styles/page.css\" 也算", () => {
  assert.ok(all(["web/src/styles/page.css"]).includes("web/src/test/pageStyles.test.ts"));
});

test("路径规则：agent/src 的改动列入领域词守卫，backend/src 的改动列入 no_writes；命中写进说明", () => {
  const got = list(["agent/src/lib/c.ts", "backend/src/launch.ts"]);
  assert.ok(got.tests.agent.includes("agent/tests/domain_words_guard.test.ts"));
  assert.ok(got.tests.backend.includes("backend/tests/no_writes.test.ts"));
  assert.ok(got.rules.some((one) => one.files.includes("backend/src/launch.ts") && one.tests.includes("backend/tests/no_writes.test.ts")));
});

test("计时类标出并排在那一套末尾；只改 README 是空清单并写明原因", () => {
  const got = list(["agent/src/lib/c.ts"]);
  assert.deepEqual(got.timing, ["web/src/test/diagramView.test.tsx"]);
  assert.equal(got.tests.web.at(-1), "web/src/test/diagramView.test.tsx");
  const none = list(["README.md"]);
  assert.deepEqual([Object.values(none.tests).flat(), none.note], [[], "改动里没有代码、任务类型或提示词文件（例如只改了说明文档），不用跑测试。"]);
});

test("辅助文件切顶层声明、测试导入了哪几个名字", () => {
  assert.deepEqual([...topLevel("const A = 1;\nexport function b() { return A; }\nexport const C = b();\n").keys()], ["A", "b", "C"]);
  assert.deepEqual(importedNames('import { a, b as c, type D } from "./helpers.ts";', "./helpers.ts"), ["a", "b", "D"]);
  assert.equal(importedNames('import * as h from "./helpers.ts";', "./helpers.ts"), "all");
});

test("git 仓里的中文文件名照原样列出，不被转义，依赖它的测试能找到", () => {
  const repo = mkdtempSync(join(tmpdir(), "affected-git-"));
  try {
    mkdirSync(join(repo, "agent", "tests", "fixtures"), { recursive: true });
    writeFileSync(join(repo, "agent", "tests", "fixtures", "借阅规范.md"), "规范\n", "utf-8");
    writeFileSync(join(repo, "agent", "tests", "kb.test.ts"), 'const ROOT = "";\njoin(ROOT, "agent", "tests", "fixtures", "借阅规范.md");\n', "utf-8");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    assert.deepEqual(affected(repo, ["agent/tests/fixtures/借阅规范.md"]).tests.agent, ["agent/tests/kb.test.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("命令行：--files 与 --json 输出能被 JSON.parse，路径都真实存在", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--root", root, "--json", "--files", "agent/src/lib/c.ts"], { encoding: "utf-8" });
  const got = JSON.parse(out) as { tests: Record<string, string[]> };
  const tests = Object.values(got.tests).flat();
  assert.ok(tests.includes("agent/tests/a.test.ts"));
  for (const one of tests) assert.doesNotThrow(() => execFileSync("test", ["-f", join(root, one)]), one);
  const text = execFileSync(process.execPath, [SCRIPT, "--root", root, "--files", "README.md"], { encoding: "utf-8" });
  assert.match(text, /^## agent（0 份）/);
});
