/**
 * 几种取结果的办法离线比较的命令行入口：读一个知识库根目录里的文档（照产品的切法切成片段）与一份查询文件，打印一张表：
 * 每种办法在各个 limit 下有几处期望的规定进了结果，括号里是进了候选的处数。
 *
 * 用法（在代码仓根目录）：
 *   node agent/eval/knowledge/fusion_compare.ts --knowledge-root <知识库根目录> --queries <查询.json>
 *        [--limits 1,2,3,5] [--keep 1,2,3] [--rrf-k 60] [--rrf-top 5] [--keyword-only] [--out <结果.json>]
 *
 * 查询文件的格式：{ queries: [{ query, expect: [{ document, sentence }] }] }，sample/queries.json 是一份样例。
 * 按意思那一路用产品自己选定的嵌入模型（设置页面里选的那一个，读的是 PI_CODING_AGENT_DIR 与 TASKWRIGHT_SETTINGS_FILE 指的设置）：
 * 片段与查询都现场换算，不读也不写文档旁边的成品。没有选嵌入模型、换算没有做成，或者给了 --keyword-only 时，只比按字面一路。
 * 换算要向模型服务发请求，商业接口会按量计费；语料大时先用 --keyword-only 看按字面一路。
 *
 * 这是评估工具，不是产品运行时的代码：它导入 backend/src 里与产品相同的实现（切分、关键词打分、候选规则），好让评估与产品算的是同一件事。
 * 安装包不带这个目录（release/build.mjs 只复制 agent/src 与 agent/prompts）；agent/src 与 backend/src 都不导入这里的任何东西。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { EmbeddingError, embed } from "../../../backend/src/embedding.ts";
import { chunkInput } from "../../../backend/src/knowledge_chunks.ts";
import { normalize } from "../../../backend/src/knowledge_embeddings.ts";
import { loadProfile } from "../../../backend/src/launch.ts";
import { embeddingTarget } from "../../../backend/src/model_config.ts";
import { type CompareEntry, type CompareQuery, compare, compareTable, methods } from "./compare_lib.ts";
import { knowledgeDocuments } from "./eval_lib.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const numbers = (text: string | null, fallback: number[]) => (text ? text.split(",").map((one) => Number(one.trim())).filter((n) => Number.isInteger(n) && n > 0) : fallback);

const root = arg("--knowledge-root");
const queriesFile = arg("--queries");
if (!root || !queriesFile) {
  process.stderr.write("用法：node agent/eval/knowledge/fusion_compare.ts --knowledge-root <知识库根目录> --queries <查询.json> [--limits 1,2,3,5] [--keep 1,2,3] [--keyword-only] [--out <结果.json>]\n");
  process.exit(2);
}
const limits = numbers(arg("--limits"), [1, 2, 3, 5]);
const keeps = numbers(arg("--keep"), [2]);
const rrf = { k: Number(arg("--rrf-k") ?? 60), top: Number(arg("--rrf-top") ?? 5) };

const entries: CompareEntry[] = knowledgeDocuments(root).flatMap((doc) => doc.chunks.map((chunk) => ({ document: doc.name, index: chunk.index, heading: chunk.heading, text: chunk.text, vector: null })));
const queries: CompareQuery[] = (JSON.parse(readFileSync(queriesFile, "utf-8")).queries ?? []).map((one: { query: string; expect?: { document: string; sentence: string }[] }) => ({ query: one.query, expect: one.expect ?? [], vector: null }));

const ctx = { env: process.env, profile: loadProfile("dev") };
let note = "";
if (process.argv.includes("--keyword-only")) note = "给了 --keyword-only，只比按字面一路。";
else if (!embeddingTarget(ctx)) note = "没有选嵌入模型，只比按字面一路。";
else {
  try {
    // 一次请求送几段由模型服务的种类定，这里每次送 8 段，哪一种都收得下。
    for (let i = 0; i < entries.length; i += 8) {
      const batch = entries.slice(i, i + 8);
      const got = await embed(ctx, batch.map((entry) => chunkInput(entry)), "document");
      batch.forEach((entry, k) => (entry.vector = normalize(got.vectors[k])));
    }
    for (const query of queries) query.vector = normalize((await embed(ctx, [query.query], "query")).vectors[0]);
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error;
    for (const entry of entries) entry.vector = null;
    for (const query of queries) query.vector = null;
    note = `换算没有做成（${error.message}），只比按字面一路。`;
  }
}

const result = compare(entries, queries, limits, methods(keeps, rrf));
console.log(`语料 ${new Set(entries.map((entry) => entry.document)).size} 份文档、${entries.length} 个片段；查询 ${queries.length} 句，期望的规定 ${result.rows[0]?.places ?? 0} 处。${note}`);
console.log("每格是进了结果的处数，括号里是进了候选的处数。");
console.log(compareTable(result.rows, limits));
for (const one of result.missing) console.log(`期望里的这一句在语料里找不到：《${one.document}》「${one.sentence}」（查询「${one.query}」）`);
const out = arg("--out");
if (out) writeFileSync(out, JSON.stringify({ limits, keeps, rrf, note, ...result }, null, 1));
