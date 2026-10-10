/**
 * 静态扫描：后端不写库。
 *
 * 1. backend/ 下的任何文件（源码、测试）从 agent/src/lib 导入的名字都必须在下面的白名单里：只读函数、常量，
 *    以及唯一允许的写入——建任务的 createTask。保存修订、界面操作、评审等写入函数一律不许导入；也不许整个模块导入或动态导入。
 * 2. backend/src 下的源码里不出现写库的 SQL（INSERT、UPDATE、DELETE、REPLACE、CREATE、DROP、ALTER）。
 *    唯一的例外是服务级库的数据模块 src/service_db.ts：服务级库（数据目录下的 service.sqlite）是后端自己的库，它的每一句 SQL
 *    都只许写在那一个文件里。
 * 3. backend/src 下只有两个文件直接用数据库：library.ts（只读打开任务库）与 service_db.ts（服务级库）。别的文件不导入
 *    node:sqlite，也不出现 service.sqlite 这个文件名，要读写服务级库就调 service_db.ts 的取存函数。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 允许从 agent/src/lib 导入的名字，按模块列。 */
const ALLOWED: Record<string, string[]> = {
  "task_read.ts": ["DEFAULT_MATERIALS_DIR", "ParsedDefinition", "Row", "SourceRow", "columnNames", "itemKey", "jsonOrText", "materialsDir",
    "openReadonly", "parseDefinition", "readSources", "splitUserWordsLocator", "tableNames"],
  "conditions.ts": ["checkCompletion", "completionBrief", "completionHints"],
  "db.ts": ["DB_NAME", "ACTOR_USER", "ACTOR_EXECUTOR"],
  // 图：种类与编号的常量、从库里读图、从 Mermaid 文本里扫条目编号（只读与只做计算的函数，不写库）。
  "diagram.ts": ["DIAGRAM_KINDS", "DiagramRecord", "drawnItemIds", "kindName", "latestVersion", "liveDiagrams", "readDiagrams"],
  // TASK_ID_PATTERN 是任务编号的写法（一个正则），数据包导入时用它核对包里写的编号。
  "create_task.ts": ["createTask", "TASK_ID_PATTERN"],
  // renumberTask 是写入：把一个任务库里的任务编号换成新的。它只许在数据包的导入里调（src/data_pack.ts，导入的任务与已有的任务
  // 编号相同而用户选了改编号时），换的是还在暂存位置、没有进到任务根目录的那份副本；下面另有一条测试守着别的文件不导入它。
  "renumber_task.ts": ["renumberTask"],
  "docx_markdown.ts": ["docxProjection", "PROJECTION_SUFFIX", "MEDIA_SUFFIX"],
  // 分段清单：算清单、写成材料旁边的文件（与投影一样是文件，不是库）。
  "segments.ts": ["SEGMENTS_ENV", "SEGMENTS_SUFFIX", "SEGMENT_DEFAULTS", "SegmentParams", "buildSegments", "segmentParams", "writeSegments"],
  // 位置表：从 Word 文件算出章节，写成材料旁边的文件（与分段清单一样是文件，不是库）。
  "docx_locations.ts": ["LOCATIONS_SUFFIX", "isLocationTable"],
  "docx_location_input.ts": ["locationTable"],
  // 总体分析由事实算出来的几样（待核实、因依据而待核实、提到）：不依赖任何模块、只算不读库的函数与两个常量，后端的快照把自己读出的事实交给它们算。
  "overall_analysis.ts": ["OVERALL_COLLECTION", "PlainItem", "RevisionFacts", "Verification", "basisPending", "isSupplement", "mentionsOf", "verificationOf"],
  // 评审结论：不依赖任何模块的纯函数，只按传进去的记录下结论。
  "review_verdict.ts": ["reviewVerdict"],
  // 知识库：文档的种类与通用知识库的编号、来源出处的拆法（不依赖任何模块的纯函数）。
  "knowledge_locator.ts": ["GENERAL", "KINDS", "KIND_NAMES", "Kind", "knowledgeLocator", "parseKnowledgeLocator"],
  // 知识库：交给助手的环境变量名、任务目录里记选用的文件名（两个常量）。
  "knowledge.ts": ["KNOWLEDGE_ROOT_ENV", "SELECTION_FILE"],
  // 理解格式的几个常量：门禁拒绝里固定的几句话，过程摘要按它们认回复是因为什么被拒的。
  "intent_schema.ts": ["GATE_MISSING_TEXT", "INTENT_GATE_TEXT"],
  // Word 文档的投影全文 → 各段文字：只做计算的函数，知识库文档切成片段时用。
  "docx_source.ts": ["projectionParagraphs", "tableCells"],
  // 自带工具返回的限量：几个常量与截短之后加的那句话（只做计算，不碰库），集成测试拿它们核对助手实际收到的文字。
  "tool_limits.ts": ["GREP_CAPPED_STATUS_KEY", "GREP_MAX_BYTES", "cappedText"],
  // PDF 材料：文字规范化（不依赖任何模块的纯函数）；定位符与位置表的格式（同上）；分段清单的算法与写成材料旁边的文件
  // （与 Word 材料的投影、分段清单、位置表一样是文件，不是库）。
  "pdf_normalize.ts": ["comparablePdfText", "tidyPdfText"],
  "pdf_locations.ts": ["PDF_LOCATIONS_SUFFIX", "PDF_LOCATION_RULES_VERSION", "PdfBox", "PdfLocationFile", "PdfPageLocation", "pdfAnchor", "pdfBlockBox",
    "pdfChapterOf", "pdfLocationFile", "pdfLocationsJson"],
  "pdf_segments.ts": ["PDF_SEGMENTS_SUFFIX", "PdfSegmentList", "buildPdfSegments", "pdfProjectionUnits", "writePdfSegments"],
  // PDF 材料的来源：从投影取各块（只做计算，页面也用它）；知识库切片段时用。
  "pdf_source.ts": ["pdfProjectionUnits"],
  // 任务库的格式版本一侧：现在的版本号与 task.json 的文件名（常量）、拒绝比程序新的数据时的那句话（纯函数，不碰库；数据目录比程序新时
  // 后端也用这一句）、从 task.json 读出是哪个版本写的（只读一个小文件）、任务根目录的环境变量名（常量）。
  // upgradeTaskDatabase 是写入：把一个任务库升到现在的格式。它只许在数据升级里调（src/data_upgrade.ts，服务启动时的升级与命令行的
  // 升级都经那里），走的是助手写库时用的同一张步骤表；下面另有一条测试守着别的文件不导入它。
  "schema.ts": ["TABLE_NAMES", "TASKS_ROOT_ENV", "TASK_DB_VERSION", "TASK_JSON", "newerDataText", "taskWrittenBy", "upgradeTaskDatabase"],
  // 任务定义里字段类型的两个名字（常量，不碰库）：导出 Word 时按它们决定一个字段的值怎样写。
  "definition.ts": ["FIELD_ITEM_REF", "FIELD_TEXT_LIST"],
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? files(path) : /\.(m?ts|m?js)$/.test(e.name) ? [path] : [];
  });
}

/** 一个文件里从 agent/src/lib 导入的每一项：[模块文件名, 名字]；整模块导入与动态导入记为名字 "*"。 */
export function agentImports(source: string): [string, string][] {
  const out: [string, string][] = [];
  const statement = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (let m = statement.exec(source); m; m = statement.exec(source)) {
    const spec = m[3];
    if (!spec.includes("agent/src/lib/")) continue;
    const module = spec.slice(spec.lastIndexOf("/") + 1);
    const clause = m[2];
    const named = /\{([\s\S]*)\}/.exec(clause);
    if (!named || /\*\s+as/.test(clause) || /^[A-Za-z_$][\w$]*\s*,?/.test(clause.replace(/^\{[\s\S]*\}$/, "").trim()) && !clause.trim().startsWith("{")) {
      out.push([module, "*"]);
      continue;
    }
    for (const part of named[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) out.push([module, name]);
    }
  }
  for (const m of source.matchAll(/import\(\s*[`"']([^`"']*agent\/src\/lib\/[^`"']*)[`"']\s*\)/g)) out.push([m[1].slice(m[1].lastIndexOf("/") + 1), "*"]);
  return out;
}

test("扫描规则本身：认得出具名导入、类型导入、改名导入、整模块导入与动态导入", () => {
  const lib = "../../agent/src/" + "lib";   // 拆开写，免得本文件自己被下一条测试扫到
  const source = [
    `import { createTask } from "${lib}/create_task.ts";`,
    `import { type Row, jsonOrText as j } from "${lib}/task_read.ts";`,
    `import * as all from "${lib}/save_revision.ts";`,
    `import runUserOperation from "${lib}/user_ops.ts";`,
    `const m = await import("${lib}/review.ts");`,
    'import { join } from "node:path";',
  ].join("\n");
  assert.deepEqual(agentImports(source), [["create_task.ts", "createTask"], ["task_read.ts", "Row"], ["task_read.ts", "jsonOrText"],
    ["save_revision.ts", "*"], ["user_ops.ts", "*"], ["review.ts", "*"]]);
});

/**
 * 生成旧版本样本任务目录的脚本不在这条规则里：它里面的导入语句是一段种子脚本的文字，那段脚本交给取出来的旧版本代码
 * 在临时目录里运行（用旧版本自己的保存修订函数写样本），不是后端的代码，后端与测试都不导入它。
 */
const SAMPLE_BUILDER = join("tests", "fixtures", "task_dirs", "build.mjs");

test("backend/ 下的文件不导入 agent 的写入函数（建任务的 createTask 除外）", () => {
  const bad: string[] = [];
  for (const file of files(BACKEND)) {
    if (relative(BACKEND, file) === SAMPLE_BUILDER) continue;
    for (const [module, name] of agentImports(readFileSync(file, "utf-8"))) {
      if (!(ALLOWED[module] ?? []).includes(name)) bad.push(`${relative(BACKEND, file)}：${module} 的 ${name}`);
    }
  }
  assert.deepEqual(bad, [], "不在白名单里的导入");
});

/** 服务级库的数据模块：后端里唯一可以写 SQL 的文件。 */
const SERVICE_DB_MODULE = "service_db.ts";
/** 直接用数据库的两个文件。 */
const DATABASE_MODULES = ["library.ts", SERVICE_DB_MODULE];

test("backend/src 的源码里没有写库的 SQL（服务级库的数据模块除外）", () => {
  const bad: string[] = [];
  for (const file of files(join(BACKEND, "src"))) {
    if (relative(join(BACKEND, "src"), file) === SERVICE_DB_MODULE) continue;
    readFileSync(file, "utf-8").split("\n").forEach((line, n) => {
      if (/["'`]\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\s/i.test(line)) bad.push(`${relative(BACKEND, file)}:${n + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("改任务库的 upgradeTaskDatabase 只有数据升级模块导入", () => {
  const importers = files(join(BACKEND, "src")).filter((file) => agentImports(readFileSync(file, "utf-8")).some(([module, name]) => module === "schema.ts" && name === "upgradeTaskDatabase"));
  assert.deepEqual(importers.map((file) => relative(join(BACKEND, "src"), file)), ["data_upgrade.ts"]);
});

test("给任务换编号的 renumberTask 只有数据包模块导入", () => {
  const importers = files(join(BACKEND, "src")).filter((file) => agentImports(readFileSync(file, "utf-8")).some(([module, name]) => module === "renumber_task.ts" && name === "renumberTask"));
  assert.deepEqual(importers.map((file) => relative(join(BACKEND, "src"), file)).filter((name) => name !== "data_pack.ts"), []);
});

test("服务级库只经它的数据模块读写：别的文件不导入 node:sqlite，也不出现它的文件名", () => {
  const bad: string[] = [];
  const src = join(BACKEND, "src");
  for (const file of files(src)) {
    const name = relative(src, file);
    if (DATABASE_MODULES.includes(name)) continue;
    readFileSync(file, "utf-8").split("\n").forEach((line, n) => {
      if (/["']node:sqlite["']/.test(line) || /service\.sqlite/.test(line)) bad.push(`${name}:${n + 1}`);
    });
  }
  assert.deepEqual(bad, []);
  // 数据模块自己确实有写库的 SQL：这条规则守着的东西是存在的。
  assert.match(readFileSync(join(src, SERVICE_DB_MODULE), "utf-8"), /CREATE TABLE IF NOT EXISTS tasks/);
});
