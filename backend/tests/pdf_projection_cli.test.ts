/**
 * pdf_projection_cli.mts：给定一份 PDF 写出投影、分段清单与位置表；--print 时什么都不写；失败时退出码 1、给一句说明；
 * 标准输出只有一行 JSON，标准错误输出没有东西（pdf.js 导入时的警告不漏出来）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PDFJS_FILES } from "../src/pdf_projection.ts";
import { ROOT, tempDir } from "./helpers.ts";

const SCRIPT = join(ROOT, "backend", "src", "pdf_projection_cli.mts");
const FIXTURES = join(ROOT, "backend", "tests", "fixtures", "pdf");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]) {
  const done = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" });
  const lines = done.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `标准输出应当只有一行：${done.stdout}`);
  return { status: done.status, stderr: done.stderr, result: JSON.parse(lines[0]) };
}

function workdir(name: string, fixture: string): string {
  const dir = join(tmp, name, "inputs");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIXTURES, fixture), join(dir, "x.pdf"));
  return dir;
}

test("写三个文件，结果里给出路径与页数、块数、没有文字的页；标准错误输出没有东西", () => {
  const dir = workdir("write", "scanned.pdf");
  const { status, stderr, result } = run(["--pdf", join(dir, "x.pdf"), "--rel", "inputs/x.pdf"]);
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.deepEqual(result, {
    ok: true, projection: join(dir, "x.pdf.md"), segments: join(dir, "x.pdf.segments.json"), locations: join(dir, "x.pdf.locations.json"),
    pages: 3, units: 1, chars: result.chars, no_text_pages: [2, 3],
  });
  assert.deepEqual(readdirSync(dir).sort(), ["x.pdf", "x.pdf.locations.json", "x.pdf.md", "x.pdf.segments.json"]);
  assert.ok(readFileSync(join(dir, "x.pdf.md"), "utf-8").includes("出处写 inputs/x.pdf#p页-块"));
});

test("--print：什么都不写，投影全文与位置表在结果里", () => {
  const dir = workdir("print", "table.pdf");
  const { status, result } = run(["--pdf", join(dir, "x.pdf"), "--rel", "inputs/x.pdf", "--print"]);
  assert.equal(status, 0);
  assert.deepEqual([result.ok, result.projection, result.segments, result.locations, result.pages, result.units], [true, null, null, null, 1, 6]);
  assert.ok(result.markdown.includes("[p1-2] 读者类型  一次最多  借期  续借次数"));
  assert.equal(result.location_table.pages[0].blocks.length, 6);
  assert.deepEqual(readdirSync(dir), ["x.pdf"]);
});

test("分段参数与上限从命令行给：分段参数写进清单的摘要，超过上限时失败", () => {
  const dir = workdir("options", "multipage.pdf");
  const pdf = join(dir, "x.pdf");
  const first = run(["--pdf", pdf, "--rel", "inputs/x.pdf"]);
  const before = JSON.parse(readFileSync(first.result.segments, "utf-8"));
  const digest = before.params_digest;
  assert.equal(before.blocks.length, 3);
  const second = run(["--pdf", pdf, "--rel", "inputs/x.pdf", "--segments-json", '{"min_paragraphs": 5}']);
  const list = JSON.parse(readFileSync(second.result.segments, "utf-8"));
  assert.notEqual(list.params_digest, digest);
  // 三页各有 3、4、3 块：前两页并成一段才够五块，最后一页不够，再并进去，整份是一段
  assert.deepEqual(list.blocks.map((b: { first_page: number; last_page: number }) => [b.first_page, b.last_page]), [[1, 3]]);
  const over = run(["--pdf", pdf, "--rel", "inputs/x.pdf", "--max-pages", "2", "--print"]);
  assert.deepEqual([over.status, over.result], [1, { ok: false, error: "这份 PDF 有 3 页，超过上限 2 页" }]);
});

test("失败：缺参数、参数写错、读不到文件、不是 PDF，都是退出码 1 与一句说明", () => {
  const dir = workdir("fail", "table.pdf");
  const cases: [string[], RegExp][] = [
    [["--pdf", join(dir, "x.pdf")], /^要给 --pdf 与 --rel。$/],
    [["--pdf", join(dir, "x.pdf"), "--rel", "inputs/x.pdf", "--nope"], /^参数不对：/],
    [["--pdf", join(dir, "x.pdf"), "--rel", "inputs/x.pdf", "--max-seconds", "abc"], /^--max-seconds 应当是正数，现在是 abc。$/],
    [["--pdf", join(dir, "x.pdf"), "--rel", "inputs/x.pdf", "--segments-json", "{"], /^分段参数不是合法的 JSON/],
    [["--pdf", join(dir, "没有.pdf"), "--rel", "inputs/没有.pdf"], /^读不到文件 /],
    [["--pdf", SCRIPT, "--rel", "inputs/x.pdf", "--print"], /^不是 PDF 文件，或者文件已损坏$/],
  ];
  for (const [args, message] of cases) {
    const { status, result } = run(args);
    assert.equal(status, 1, args.join(" "));
    assert.equal(result.ok, false);
    assert.match(result.error, message);
  }
  assert.deepEqual(readdirSync(dir), ["x.pdf"]);
});

test("像安装包那样摆：pdfjs-dist 只带清单上的几样、旁边没有画页面用的原生模块，结果相同，标准错误输出没有东西", () => {
  // 摆出与仓库同样的相对位置：<根>/backend/src、<根>/agent/src/lib、<根>/node_modules/pdfjs-dist（只有 PDFJS_FILES 列的几样）。
  const root = join(tmp, "packed");
  cpSync(join(ROOT, "backend", "src", "pdf_projection.ts"), join(root, "backend", "src", "pdf_projection.ts"));
  cpSync(join(ROOT, "backend", "src", "pdf_projection_cli.mts"), join(root, "backend", "src", "pdf_projection_cli.mts"));
  cpSync(join(ROOT, "backend", "package.json"), join(root, "backend", "package.json"));
  cpSync(join(ROOT, "agent", "package.json"), join(root, "agent", "package.json"));
  cpSync(join(ROOT, "agent", "src", "lib"), join(root, "agent", "src", "lib"), { recursive: true });
  const installed = realpathSync(join(dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")))));
  for (const each of PDFJS_FILES) cpSync(join(installed, each), join(root, "node_modules", "pdfjs-dist", each), { recursive: true });
  const dir = workdir("packed-work", "multipage.pdf");
  const args = ["--pdf", join(dir, "x.pdf"), "--rel", "inputs/x.pdf", "--print"];
  const packed = spawnSync(process.execPath, [join(root, "backend", "src", "pdf_projection_cli.mts"), ...args], { encoding: "utf-8", cwd: root });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  assert.equal(packed.stderr, "", "pdf.js 导入时找不到原生模块的警告不应当漏出来");
  // 中文是不嵌入字体的，读得出来说明字符映射表也带上了；与在仓库里跑出来的逐字相同。
  assert.equal(packed.stdout, spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" }).stdout);
  assert.ok(JSON.parse(packed.stdout).markdown.includes("[p1-1] 第一章 总则"));
});
