/**
 * 知识库查找轨迹评估的命令行入口：读一条会话文件、知识库根目录与期望文件，打印几行结论，并把全部度量写成 JSON。
 *
 * 用法（在代码仓根目录）：
 *   node agent/eval/knowledge/measure.ts --session <会话文件.jsonl> --knowledge-root <知识库根目录> --expect <期望.json> [--cwd <任务目录>] [--out <度量.json>]
 *
 * 会话文件在归档目录的 <任务编号>/pi-sessions/ 下；知识库根目录是任务服务 --knowledge 指的那个目录。期望文件的格式见 eval_lib.ts，
 * sample/expect.json 是一份样例。只读文件，不调模型，不改任何东西。
 *
 * 这是评估工具，不是产品运行时的代码：它导入 backend/src 里与产品相同的实现（切分、关键词打分、候选规则），好让评估与产品算的是同一件事。
 * 安装包不带这个目录（release/build.mjs 只复制 agent/src 与 agent/prompts）；agent/src 与 backend/src 都不导入这里的任何东西。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { measure, sessionEntries, summaryLines } from "./eval_lib.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const session = arg("--session");
const root = arg("--knowledge-root");
const expect = arg("--expect");
if (!session || !root || !expect) {
  process.stderr.write("用法：node agent/eval/knowledge/measure.ts --session <会话文件.jsonl> --knowledge-root <知识库根目录> --expect <期望.json> [--cwd <任务目录>] [--out <度量.json>]\n");
  process.exit(2);
}
const expectations = JSON.parse(readFileSync(expect, "utf-8")).expectations ?? [];
const measures = measure(sessionEntries(readFileSync(session, "utf-8")), { knowledgeRoot: root, expectations, cwd: arg("--cwd") ?? undefined });
for (const line of summaryLines(measures)) console.log(line);
const out = arg("--out");
if (out) writeFileSync(out, JSON.stringify(measures, null, 1));
