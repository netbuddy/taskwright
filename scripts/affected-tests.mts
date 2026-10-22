// 给一组改动文件，算出 agent、backend、web 三套里要跑的测试文件。
//
// 用法：
//   node scripts/affected-tests.mts                     缺省：git diff --name-only HEAD 加上未跟踪的文件
//   node scripts/affected-tests.mts --since <提交或 ref>  这个提交以来的改动（含工作树里还没提交的）加未跟踪的文件
//   node scripts/affected-tests.mts --files a b c       直接给改动文件（相对仓库根目录）
//   node scripts/affected-tests.mts --json              同样的内容输出成 JSON
//   node scripts/affected-tests.mts --root <目录>        对另一份代码树算（例如 git archive 解出来的某个历史提交），缺省是本仓
//
// 怎样算（不引第三方的依赖分析库，全用正则读源码）：
//   1. 导入图：三套的源码合成一张图。每个 .ts/.tsx/.mts/.mjs/.js 文件里的 import … from "x"、export … from "x"、import "x"、
//      import("x") 写的相对路径，补上 .ts/.tsx/.mts/.mjs/.js 或 /index.ts(x) 解析成仓里的文件，记一条边。web 跨包导入 agent 的
//      也在图里。不是相对路径的（node:fs、antd 这类）不进图。
//   2. 字符串拼的路径：测试与测试辅助文件里 join(根, "段", …) 或 resolve(根, "段", …) 拼出来、在仓里真有的文件或目录，
//      也当作依赖；字面写着的仓内路径（"agent/src" 这样）同样算。辅助文件（helpers.ts 这类）里的这种路径按它所在的那个
//      顶层声明算：测试从辅助文件导入了哪几个名字，才带上这几个名字（连同它们在同一份文件里用到的别的名字）拼出的路径，
//      免得「导入了 helpers 就依赖任务类型目录」。拼不出来的（中间有变量）列在输出的「未解析」一节。
//   3. 额外边（EXTRA_EDGES）：运行时才连上的依赖，导入图与字符串都看不出，按表补。
//   4. 路径规则（PATH_RULES）：读整个目录或清单的扫描类、快照类测试，按改动路径直接列入。
//   5. 从改动文件出发，沿导入边与上面几类边反向传递，走到的 *.test.ts(x) 就是要跑的；改动的测试文件本身直接列入。
// 运行时的动态导入不进图（都不指向仓里的 TypeScript 源码）：backend/src/diagram_worker.ts 的 import(workerData.engine)、
// backend/src/export_docx.ts 的 docx_lib.mjs、backend/src/pdf_projection.ts 的 pdfjs。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 三套测试：文件路径（相对仓库根目录）匹配哪一个正则就属于哪一套。 */
export const SUITES = [
  { suite: "agent", pattern: /^agent\/tests\/[^/]+\.test\.ts$/ },
  { suite: "backend", pattern: /^backend\/tests\/[^/]+\.test\.ts$/ },
  { suite: "web", pattern: /^web\/src\/test\/.+\.test\.tsx?$/ },
] as const;
export type Suite = (typeof SUITES)[number]["suite"];

/** 测试辅助文件所在的目录：这些目录里不是 *.test.* 的源码按「顶层声明」细分依赖（见文件头第 2 条）。 */
const SUPPORT_DIRS = ["agent/tests/", "backend/tests/", "web/src/test/"];

/** 进导入图的源码所在的目录与后缀。 */
const CODE_DIRS = ["agent/", "backend/", "web/src/", "web/", "scripts/"];
const CODE_EXT = /\.(ts|tsx|mts|mjs|js)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage)\//;

/**
 * 额外边：from 依赖 to，但导入图与字符串都看不出（运行时才连上）。to 是文件时，to 的导入链上任何改动都传给 from。
 */
export const EXTRA_EDGES: { from: string; to: string; why: string }[] = [
  { from: "backend/src/launch.ts", to: "agent/src/extension.ts",
    why: "后端起 pi 时按启动配置（backend/profiles/*.json 的 extensions）用 -e 把扩展交给 pi，扩展的入口是 agent/src/extension.ts" },
  { from: "backend/src/launch.ts", to: "backend/profiles",
    why: "启动配置文件决定 pi 的命令行（模型、扩展、思考档位）" },
];

/**
 * 路径规则：改动文件匹配 pattern（相对仓库根目录的路径）时，列入 tests。用于读整个目录、清单或期望文件的测试，
 * 以及每份测试都会加载的启动文件。tests 里写相对仓库根目录的测试文件路径；写 "*backend" 这样的是那一套全部。
 */
export const PATH_RULES: { pattern: RegExp; tests: string[]; why: string }[] = [
  { pattern: /^task-types\//, tests: ["backend/tests/observatory_parity.test.ts", "agent/tests/stage_prompt_files.test.ts", "agent/tests/activity_def.test.ts",
    "agent/tests/definition_view.test.ts", "backend/tests/task_status.test.ts", "agent/tests/domain_words_guard.test.ts"],
    why: "observatory_parity 的期望文件含任务类型各文件的字节数与摘要值；stage_prompt_files、activity_def、definition_view 读需求工程任务类型的声明；task_status 断言活动目录；domain_words_guard 的词表取自 task-types/*/docs/task-definitions" },
  { pattern: /^agent\/prompts\/(templates|capabilities)\/|^agent\/prompts\/system\.md$/, tests: ["backend/tests/observatory_parity.test.ts",
    "agent/tests/stage_prompt_files.test.ts", "agent/tests/context_assemble.test.ts", "backend/tests/pi_session.test.ts", "backend/tests/profiles.test.ts"],
    why: "observatory_parity 的期望文件含平台说明各文件；stage_prompt_files 逐份读模板与模块；context_assemble 拼系统提示；pi_session 比对 launch_argv.json；profiles 断言启动记录里的模板与模块清单" },
  { pattern: /^agent\/prompts\//, tests: ["agent/tests/domain_words_guard.test.ts", "agent/tests/texts_guard.test.ts"],
    why: "domain_words_guard 扫 agent/prompts 下全部文件；texts_guard 核对提示词目录的索引与运行时文字" },
  { pattern: /^agent\/prompts\/runtime\/|^agent\/src\/tools\//, tests: ["agent/tests/texts_guard.test.ts", "agent/tests/texts.test.ts"],
    why: "texts_guard 与 texts 读运行时文字与工具里用到的文字键" },
  { pattern: /^agent\/src\//, tests: ["agent/tests/domain_words_guard.test.ts", "agent/tests/refusal_sites_guard.test.ts"],
    why: "domain_words_guard 扫 agent/src 的任务类型词；refusal_sites_guard 扫 agent/src、backend/src、web/src 的拒绝写法" },
  { pattern: /^backend\/src\//, tests: ["backend/tests/no_writes.test.ts", "agent/tests/refusal_sites_guard.test.ts"],
    why: "no_writes 扫 backend 下全部文件对 agent/src/lib 的导入与写库的 SQL；refusal_sites_guard 也扫 backend/src" },
  { pattern: /^backend\/tests\/[^/]+\.ts$/, tests: ["backend/tests/no_writes.test.ts"], why: "no_writes 也扫 backend/tests 的导入" },
  { pattern: /^web\/src\//, tests: ["agent/tests/web_imports.test.ts", "agent/tests/refusal_sites_guard.test.ts"],
    why: "web_imports 扫 web 对 agent 的导入；refusal_sites_guard 也扫 web/src" },
  { pattern: /^web\/src\/test\/setup\.ts$|^web\/vite(st)?\.config\.ts$/, tests: ["*web"], why: "vitest 的启动文件与配置，每份 web 测试都加载" },
  { pattern: /^backend\/tests\/deadline\.ts$/, tests: ["*backend"], why: "backend 整套用 --import ./tests/deadline.ts 跑，每份都加载" },
  { pattern: /^web\/pdfjs_assets\.mjs$/, tests: ["web/src/test/pdfjsAssets.test.ts"], why: "pdfjsAssets 用模板字符串动态导入它" },
  { pattern: /^docs\/api(\.zh-CN)?\.md$/, tests: [], why: "接口文档：本仓没有与它互锁的测试（契约互锁在别的仓），只提醒人工核对" },
];

/** 已知在高负载下不稳的计时测试：失败先看 uptime 再单独重跑那一份，不改测试。 */
export const TIMING_TESTS = new Set([
  "web/src/test/knowledgePage.test.tsx", "web/src/test/diagramsTab.test.tsx", "web/src/test/diagramView.test.tsx", "web/src/test/revisions.test.tsx",
  "backend/tests/data_pack_http.test.ts", "backend/tests/activity_flow.test.ts",
]);

/** 真栈测试的标志：依赖这个文件（起后端子进程、后端再起 pi）的测试慢，输出里单独标出。 */
const REAL_STACK_ENTRY = "backend/src/main.mts";

export interface Result {
  changed: string[];
  tests: Record<Suite, string[]>;
  timing: string[];
  realStack: string[];
  rules: { why: string; files: string[]; tests: string[] }[];
  unresolved: string[];
  note: string | null;
}

/** 仓里的全部文件（git ls-files 加未跟踪的；--root 给的不是 git 仓时按目录列）。 */
function listFiles(root: string): string[] {
  try {
    // -z：文件名按原样输出，不把中文转义成 "\345…" 这样的写法。
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf-8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean).filter((one) => !SKIP.test(one));
  } catch {
    const out = execFileSync("find", [".", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], { cwd: root, encoding: "utf-8", maxBuffer: 64 << 20 });
    return out.split("\n").filter(Boolean).map((one) => one.replace(/^\.\//, ""));
  }
}

const isCode = (path: string) => CODE_EXT.test(path) && CODE_DIRS.some((dir) => path.startsWith(dir)) && !SKIP.test(path);
const isTest = (path: string) => SUITES.some((one) => one.pattern.test(path));
const isSupport = (path: string) => isCode(path) && !isTest(path) && SUPPORT_DIRS.some((dir) => path.startsWith(dir));
const suiteOf = (path: string): Suite | null => SUITES.find((one) => one.pattern.test(path))?.suite ?? null;

/** 一个文件里写的模块名：import … from "x"、export … from "x"、import "x"、import("x")。 */
export function importSpecs(text: string): string[] {
  const out: string[] = [];
  const patterns = [/\b(?:import|export)\s[^;'"`]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) out.push(match[1]);
  return out;
}

/** 把一个相对的模块名解析成仓里的文件；解析不出（或者不是相对路径）是 null。 */
export function resolveSpec(from: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec).split(sep).join("/");
  const tries = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
  if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  return tries.find((one) => files.has(one)) ?? null;
}

/** 文件或目录在不在仓里（目录：有文件在它下面）。 */
function makeExists(files: ReadonlySet<string>) {
  const dirs = new Set<string>();
  for (const one of files) {
    const parts = one.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return (path: string) => files.has(path) || dirs.has(path);
}

/**
 * 一段源码里用字符串拼出、或者字面写着的仓内路径。join(根, "a", "b") 与 resolve(根, "a", "b")：根是 ROOT、REPO_ROOT 这类时从仓库根目录拼，
 * 是 import.meta.dirname、__dirname 这类时从文件所在目录拼；认不出的根两样都试，再往上试几层。拼得出就收，拼不出的记进 unresolved。
 */
export function pathStrings(text: string, file: string, exists: (path: string) => boolean, constants: ReadonlyMap<string, string> = new Map()): { found: string[]; unresolved: string[] } {
  const found = new Set<string>(), unresolved = new Set<string>();
  // dirname(fileURLToPath(import.meta.url)) 与 import.meta.dirname 是同一个目录：先换成后者，下面的正则只认标识符当根。
  text = text.replace(/dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)/g, "import.meta.dirname");
  const call = /\b(?:join|resolve)\(\s*([A-Za-z_$][\w.$]*)\s*((?:,\s*(?:"[^"\n]*"|'[^'\n]*'))+)\s*([,)])/g;
  for (const match of text.matchAll(call)) {
    const segments = [...match[2].matchAll(/["']([^"']*)["']/g)].map((m) => m[1]).filter((one) => one !== "");
    if (segments.length === 0 || segments.every((one) => /^(\.\.\/?)+$/.test(one)) || segments[0] === "node_modules") continue;
    const head = match[1];
    // 根是已知指向仓内路径的常量（helpers 里的 SRS_SKILL_DIR 这类）：从那个路径拼。
    if (constants.has(head)) {
      const path = join(constants.get(head)!, ...segments).split(sep).join("/");
      if (exists(path)) found.add(path);
      else unresolved.add(`${file}: ${match[0].slice(0, 120)}`);
      continue;
    }
    const fileDir = dirname(file);
    const ancestors = [fileDir, dirname(fileDir), dirname(dirname(fileDir)), dirname(dirname(dirname(fileDir)))].filter((one) => one !== ".");
    const known = /^(ROOT|REPO_ROOT|REPO|repoRoot)$/.test(head) || /dirname|__dirname|HERE|DIR$/.test(head);
    // 认不出的根多半是测试里的临时目录（join(dir, "README.md")）：只有一段名字时不当作仓内路径，免得碰巧拼到根目录的同名文件。
    if (!known && segments.length < 2) continue;
    const bases = /^(ROOT|REPO_ROOT|REPO|repoRoot)$/.test(head) ? [""] : /dirname|__dirname|HERE|DIR$/.test(head) ? [fileDir, ...ancestors.slice(1), ""] : ["", ...ancestors];
    const hit = bases.map((base) => join(base, ...segments).split(sep).join("/")).find((one) => !one.startsWith("..") && exists(one));
    if (hit) found.add(hit);
    // 拼不出的只报像是仓内路径的那些：根是仓库根目录这类，或者第一段是仓里的顶层目录名；根是测试里的临时目录的不报。
    else if (known || /^(agent|backend|web|task-types|scripts|observatory|sim)$/.test(segments[0])) unresolved.add(`${file}: ${match[0].slice(0, 120)}`);
  }
  for (const match of text.matchAll(/["'`]((?:agent|backend|web|task-types|docs|scripts|observatory|sim)\/[\w./-]+)["'`]/g)) {
    const path = match[1].replace(/\/$/, "");
    if (exists(path)) found.add(path);
  }
  // 像相对文件路径的字面量（"styles/task-page.css" 这样，带斜杠与扩展名）：交给别的函数去拼（new URL(`../${name}`, here)），
  // 从文件所在目录与上几层试，拼得到仓里的文件就算。
  const fileDir = dirname(file);
  const ups = [fileDir, dirname(fileDir), dirname(dirname(fileDir))].filter((one) => one !== ".");
  for (const match of text.matchAll(/["'`]((?:\.\.?\/)*[\w-]+(?:\/[\w.-]+)+\.[a-z]{1,5})["'`]/g)) {
    const hit = ups.map((base) => join(base, match[1]).split(sep).join("/")).find((one) => !one.startsWith("..") && exists(one));
    if (hit) found.add(hit);
  }
  return { found: [...found], unresolved: [...unresolved] };
}

/** 一份辅助文件按顶层声明切开：名字到那一段源码。只认行首的 export/const/function/class/let 声明。 */
export function topLevel(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)];
  starts.forEach((match, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index! : text.length;
    out.set(match[1], (out.get(match[1]) ?? "") + text.slice(match.index!, end));
  });
  return out;
}

/** 一份测试从某个模块导入了哪些名字：import { a, b as c } from "x"、import * as m from "x"（整份算）、import x from "x"。 */
export function importedNames(text: string, spec: string): string[] | "all" {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names: string[] = [];
  for (const match of text.matchAll(new RegExp(`\\bimport\\s+(type\\s+)?([^;]*?)\\s+from\\s*["']${escaped}["']`, "g"))) {
    const clause = match[2];
    if (/\*\s+as\s/.test(clause)) return "all";
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const part of braces[1].split(",")) { const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim(); if (name) names.push(name); }
    const plain = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    if (plain) names.push("default");
  }
  return names;
}

interface Graph {
  files: Set<string>;
  /** 反向边：被依赖的文件或目录 → 依赖它的文件。 */
  reverse: Map<string, Set<string>>;
  unresolved: string[];
}

/** 建图：导入边、测试文件的路径字符串边、经辅助文件的名字传来的路径边、额外边。 */
export function buildGraph(root: string): Graph {
  const files = new Set(listFiles(root));
  const exists = makeExists(files);
  const reverse = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => { if (from !== to) (reverse.get(to) ?? reverse.set(to, new Set()).get(to)!).add(from); };
  const unresolved: string[] = [];
  const text = new Map<string, string>();
  const read = (path: string) => { if (!text.has(path)) text.set(path, readFileSync(join(root, path), "utf-8")); return text.get(path)!; };
  const code = [...files].filter(isCode).filter((one) => existsSync(join(root, one)));
  // 指向仓内路径的大写常量（const SRS_SKILL_DIR = join(…)）：先解出它们的值，别处拿它们当根时用。每份文件各有一张表（同名的常量
  // 在不同文件里可以指向不同目录），辅助文件导出的另进一张公共表；几轮，常量可以叠着定义。
  const exported = new Map<string, string>();
  const local = new Map<string, Map<string, string>>();
  // 测试目录里的文件全看；产品代码只看导出的（测试会导入它们，例如 context_assemble.ts 的 PROMPTS_DIR）。
  const testDirFiles = code.filter((one) => SUPPORT_DIRS.some((dir) => one.startsWith(dir)) || /^(agent\/src|backend\/src)\//.test(one));
  const constantsOf = (file: string) => new Map([...exported, ...(local.get(file) ?? [])]);
  for (let round = 0; round < 3; round++) {
    for (const file of testDirFiles) {
      const own = local.get(file) ?? local.set(file, new Map()).get(file)!;
      for (const match of read(file).matchAll(/^(export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*((?:join|resolve)\([^\n;]*\))/gm)) {
        if (own.has(match[2])) continue;
        const { found } = pathStrings(match[3], file, exists, constantsOf(file));
        if (found.length !== 1) continue;
        own.set(match[2], found[0]);
        if (match[1] && !isTest(file)) exported.set(match[2], found[0]);
      }
    }
  }

  // 辅助文件：每个顶层声明拼出的路径、用到的同文件声明、用到的从别的辅助文件导入的名字。
  const support = new Map<string, Map<string, { paths: string[]; refs: string[]; imports: { file: string; name: string }[] }>>();
  for (const file of code.filter(isSupport)) {
    const body = read(file);
    const decls = topLevel(body);
    const names = [...decls.keys()];
    const fromOther: { file: string; names: string[] }[] = [];
    for (const spec of importSpecs(body)) {
      const target = resolveSpec(file, spec, files);
      if (target && isSupport(target)) { const got = importedNames(body, spec); fromOther.push({ file: target, names: got === "all" ? [] : got }); }
    }
    const info = new Map<string, { paths: string[]; refs: string[]; imports: { file: string; name: string }[] }>();
    for (const [name, chunk] of decls) {
      const { found, unresolved: bad } = pathStrings(chunk, file, exists, constantsOf(file));
      unresolved.push(...bad);
      const refs = names.filter((other) => other !== name && new RegExp(`\\b${other}\\b`).test(chunk));
      const imports = fromOther.flatMap((one) => one.names.filter((n) => new RegExp(`\\b${n}\\b`).test(chunk)).map((n) => ({ file: one.file, name: n })));
      info.set(name, { paths: found, refs, imports });
    }
    support.set(file, info);
  }
  /** 一份辅助文件里某个名字连带用到的全部路径（顺着同文件的声明与别的辅助文件的名字走）。 */
  const pathsOf = (file: string, name: string, seen = new Set<string>()): string[] => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const one = support.get(file)?.get(name);
    if (!one) return [];
    return [...one.paths, ...one.refs.flatMap((ref) => pathsOf(file, ref, seen)), ...one.imports.flatMap((imp) => pathsOf(imp.file, imp.name, seen))];
  };

  for (const file of code) {
    const body = read(file);
    for (const spec of importSpecs(body)) {
      const target = resolveSpec(file, spec, files);
      if (!target) continue;
      edge(file, target);
      // 测试从辅助文件导入的名字：带上这些名字拼出的路径。
      if (isTest(file) && isSupport(target)) {
        const names = importedNames(body, spec);
        const list = names === "all" ? [...(support.get(target)?.keys() ?? [])] : names;
        for (const name of list) for (const path of pathsOf(target, name)) edge(file, path);
      }
    }
    if (isTest(file)) {
      const { found, unresolved: bad } = pathStrings(body, file, exists, constantsOf(file));
      for (const path of found) edge(file, path);
      unresolved.push(...bad);
    }
  }
  for (const one of EXTRA_EDGES) if (exists(one.from) && exists(one.to)) edge(one.from, one.to);
  return { files, reverse, unresolved: [...new Set(unresolved)].sort() };
}

/** 一个改动文件直接命中的被依赖者：它自己，加上它所在的各级目录（目录边：依赖整个目录的测试）。 */
function targetsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("/"));
}

/** 从改动文件出发沿反向边走到的全部文件。 */
function reach(graph: Graph, changed: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (one: string) => { if (!seen.has(one)) { seen.add(one); queue.push(one); } };
  for (const one of changed) for (const target of targetsOf(one)) for (const from of graph.reverse.get(target) ?? []) push(from);
  for (const one of changed) push(one);
  while (queue.length > 0) {
    const one = queue.shift()!;
    for (const target of [one]) for (const from of graph.reverse.get(target) ?? []) push(from);
  }
  return seen;
}

/** 算一组改动要跑的测试。 */
export function affected(root: string, changed: readonly string[], graph: Graph = buildGraph(root)): Result {
  const reached = reach(graph, changed);
  const tests = new Set([...reached].filter(isTest).filter((one) => graph.files.has(one) && existsSync(join(root, one))));
  const allOf = (suite: Suite) => [...graph.files].filter((one) => SUITES.find((s) => s.suite === suite)!.pattern.test(one));
  const rules: Result["rules"] = [];
  for (const rule of PATH_RULES) {
    const hit = changed.filter((one) => rule.pattern.test(one));
    if (hit.length === 0) continue;
    const listed = rule.tests.flatMap((one) => (one.startsWith("*") ? allOf(one.slice(1) as Suite) : [one])).filter((one) => graph.files.has(one));
    for (const one of listed) tests.add(one);
    rules.push({ why: rule.why, files: hit, tests: rule.tests });
  }
  // 真栈测试：直接拿后端入口这个文件起后端子进程的测试（经辅助文件的名字传来的也算）。只经导入链或扫描 backend/src 目录
  // 连到入口的不算，它们不起进程。
  const stack = new Set([...(graph.reverse.get(REAL_STACK_ENTRY) ?? [])].filter(isTest));
  const bySuite = Object.fromEntries(SUITES.map(({ suite }) => [suite, [...tests].filter((one) => suiteOf(one) === suite).sort((a, b) => {
    const rank = (x: string) => (TIMING_TESTS.has(x) ? 2 : stack.has(x) ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
  })])) as Record<Suite, string[]>;
  const all = Object.values(bySuite).flat();
  const code = changed.filter((one) => isCode(one) || PATH_RULES.some((rule) => rule.pattern.test(one)) || /^(task-types|agent\/prompts)\//.test(one));
  return {
    changed: [...changed],
    tests: bySuite,
    timing: all.filter((one) => TIMING_TESTS.has(one)),
    realStack: all.filter((one) => stack.has(one) && !TIMING_TESTS.has(one)),
    rules,
    unresolved: graph.unresolved,
    note: all.length === 0 ? (code.length === 0 ? "改动里没有代码、任务类型或提示词文件（例如只改了说明文档），不用跑测试。" : "改动没有连到任何测试。") : null,
  };
}

/** 改动文件：--files 给的；--since 给的提交以来的改动；缺省是 git diff HEAD。都加上未跟踪的文件。 */
function changedFiles(root: string, since: string | null): string[] {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).split("\0").filter(Boolean);
  return [...new Set([...git(["diff", "-z", "--name-only", since ?? "HEAD"]), ...git(["ls-files", "-z", "--others", "--exclude-standard"])])].filter((one) => !SKIP.test(one));
}

/** 给人看的输出。 */
export function render(result: Result): string {
  const lines: string[] = [];
  for (const { suite } of SUITES) {
    const list = result.tests[suite];
    lines.push(`## ${suite}（${list.length} 份）`);
    for (const one of list) lines.push(`${one}${TIMING_TESTS.has(one) ? "    [计时类：失败先看 uptime 再单独重跑]" : result.realStack.includes(one) ? "    [真栈：起后端与 pi，慢]" : ""}`);
    lines.push("");
  }
  if (result.rules.length > 0) {
    lines.push("## 路径规则命中");
    for (const rule of result.rules) lines.push(`- ${rule.files.join("、")} → ${rule.tests.join("、") || "（无测试）"}：${rule.why}`);
    lines.push("");
  }
  if (result.note) lines.push(result.note, "");
  return lines.join("\n");
}

function main(argv: string[]): void {
  const at = (flag: string) => argv.indexOf(flag);
  const root = at("--root") >= 0 ? resolve(argv[at("--root") + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const since = at("--since") >= 0 ? argv[at("--since") + 1] : null;
  const files = at("--files") >= 0 ? argv.slice(at("--files") + 1).filter((one) => !one.startsWith("--")) : changedFiles(root, since);
  const result = affected(root, files.map((one) => relative(root, resolve(root, one)).split(sep).join("/")));
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(render(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
