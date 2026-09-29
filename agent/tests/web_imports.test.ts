// 页面直接导入的助手一侧文件：页面（web/src）从 agent/src 导入的文件，连同它们经相对路径再导入的文件，
// 一个都不得导入 Node 的模块（node:…，只导入类型也不行）或别的包——页面的类型检查与构建里没有 Node 的类型，
// 一处这样的导入就让 web 里的 tsc -b 失败、页面构建失败。页面测试照常通过，看不出来，所以由这里守着。

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const WEB_SRC = join(ROOT, "web", "src");
const AGENT_SRC = join(ROOT, "agent", "src");

/** 一个文件里的导入与再导出写的模块名（import … from "x"、export … from "x"、import "x"、import("x")）。 */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) found.push(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** 相对导入落到的文件：写了扩展名就是它，没写就补 .ts、.tsx。 */
function resolveFile(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const one of [base, `${base}.ts`, `${base}.tsx`]) if (existsSync(one) && statSync(one).isFile()) return one;
  return base;
}

/** 页面直接导入的 agent/src 文件，以及它们经相对导入牵进来的全部文件。 */
function agentFilesUsedByWeb(): { files: Set<string>; problems: string[] } {
  const queue = sourceFiles(WEB_SRC).flatMap((file) =>
    specifiers(readFileSync(file, "utf-8")).filter((spec) => spec.startsWith(".")).map((spec) => resolveFile(file, spec))
      .filter((path) => path.startsWith(AGENT_SRC + "/")));
  const files = new Set<string>();
  const problems: string[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!existsSync(file)) {
      problems.push(`${relative(ROOT, file)}：页面导入了它，但这个文件不存在`);
      continue;
    }
    for (const spec of specifiers(readFileSync(file, "utf-8"))) {
      if (spec.startsWith(".")) queue.push(resolveFile(file, spec));
      else problems.push(`${relative(ROOT, file)} 导入了「${spec}」`);
    }
  }
  return { files, problems };
}

test("页面导入的助手一侧文件不导入 Node 的模块或别的包（否则页面的类型检查与构建失败）", () => {
  const { files, problems } = agentFilesUsedByWeb();
  const names = [...files].map((file) => relative(ROOT, file)).sort();
  // 先确认真的找到了页面导入的文件，免得守护因为找不到而一直通过。
  for (const known of ["agent/src/lib/completion_consent.ts", "agent/src/lib/docx_locations.ts", "agent/src/lib/review_verdict.ts"]) {
    assert.ok(names.includes(known), `应当找到页面导入的 ${known}，找到的是：${names.join("、")}`);
  }
  assert.deepEqual(problems, [], "页面导入的文件要只用相对导入、不依赖任何模块；需要查库或读文件的函数放进页面不导入的文件");
});
