#!/usr/bin/env node
// Renders the understanding format (agent/prompts/schemas/user_intent.schema.json) into the platform skill, so the
// schema the extension checks and the format the executor reads are one text.
//
// A generated region is a pair of plain text lines in a Markdown file (not HTML comments: Markdown viewers that
// render the skill, such as Langfuse and the observatory, swallowed everything after an HTML comment):
//   （理解格式说明开始，由 agent/prompts/schemas/user_intent.schema.json 生成，不要手改）
//   ...generated text, do not edit by hand...
//   （理解格式说明结束）
// The path in the first line is relative to the repository root.
//
// Usage:
//   node scripts/render-intent-schema.mjs           rewrite the generated region of every file listed in DOCUMENTS
//   node scripts/render-intent-schema.mjs --check   exit 1 and name the files whose region differs from the schema

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEGIN = /（理解格式说明开始，由 (\S+) 生成，不要手改）\n/;
const END = "（理解格式说明结束）";

/** The documents that carry a generated region. */
export const DOCUMENTS = ["agent/prompts/skills/taskwright-executor/SKILL.md"];

/** One act of an example on one line, the way the schema's example is meant to be read. */
function exampleJson(value) {
  const acts = value.acts.map((act) => `  ${JSON.stringify(act).replace(/,(?=["{[])/g, ", ").replace(/":/g, '": ')}`);
  return `{"acts": [\n${acts.join(",\n")}\n]}`;
}

/** How many, in Chinese numerals, for the few counts the generated text states. */
const COUNT = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** A schema description written inside parentheses: without its closing full stop. */
const bare = (text) => text.replace(/。$/, "");

/** The generated text for one schema. */
export function renderSchema(schema) {
  const act = schema.properties.acts.items;
  const target = act.properties.targets.items;
  const user = schema.$defs.user_function;
  const confidence = schema.$defs.confidence;
  const lines = [];
  lines.push("格式：");
  lines.push("");
  lines.push(`- 最外层是一个对象，只有 \`acts\` 一项：${schema.properties.acts.description}至少一项。`);
  lines.push(`- 每一项必须写 ${act.required.map((k) => `\`${k}\``).join("、")}，可以写 \`targets\` 与 \`responds_to\`，别的键不写。`);
  lines.push(`- \`targets\`：${act.properties.targets.description}每项必须写 \`item_id\`（${bare(target.properties.item_id.description)}），` +
    `可以写 \`field\`（${bare(target.properties.field.description)}）与 \`index\`（${bare(target.properties.index.description)}）。`);
  lines.push(`- \`responds_to\`：${act.properties.responds_to.description}`);
  lines.push(`- \`summary\`：${act.properties.summary.description}不超过 ${act.properties.summary.maxLength} 个字。`);
  lines.push("");
  lines.push(`\`function\` ${COUNT[user.enum.length]}种，按用户这项行为的用意选一种：`);
  lines.push("");
  for (const key of user.enum) lines.push(`- \`${key}\`（${user["x-names"][key]}）：${user["x-usage"][key]}`);
  lines.push("");
  lines.push(`\`confidence\` ${COUNT[confidence.enum.length]}档：`);
  lines.push("");
  for (const key of confidence.enum) lines.push(`- \`${key}\`（${confidence["x-names"][key]}）：${confidence["x-usage"][key]}`);
  for (const example of schema.examples ?? []) {
    lines.push("");
    lines.push(`例子。${example.context}你这一轮写的理解：`);
    lines.push("");
    lines.push("```json");
    lines.push(exampleJson(example.value));
    lines.push("```");
  }
  return lines.join("\n") + "\n";
}

/** Renders every generated region of one document. */
export function renderDocument(text) {
  let out = "";
  let rest = text;
  for (;;) {
    const match = BEGIN.exec(rest);
    if (!match) return out + rest;
    const start = match.index + match[0].length;
    const end = rest.indexOf(END, start);
    if (end < 0) throw new Error(`the generated region for ${match[1]} has no end marker`);
    const schema = JSON.parse(readFileSync(join(ROOT, match[1]), "utf-8"));
    out += rest.slice(0, start) + "\n" + renderSchema(schema) + "\n";
    rest = rest.slice(end);
  }
}

function main() {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const path of DOCUMENTS) {
    const full = join(ROOT, path);
    const text = readFileSync(full, "utf-8");
    const rendered = renderDocument(text);
    if (rendered === text) continue;
    if (check) stale.push(path);
    else writeFileSync(full, rendered, "utf-8");
  }
  if (stale.length > 0) {
    console.error(`generated region out of date (run node scripts/render-intent-schema.mjs): ${stale.join(", ")}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
