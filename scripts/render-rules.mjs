#!/usr/bin/env node
// Renders the review rules (task-types/<type>/docs/review-rules/*.json) into the domain-knowledge documents that
// quote them, so the rules the reviewer checks and the rules the executor reads are one text.
//
// A generated region is a pair of HTML comments in a Markdown file:
//   <!-- 规则生成区 开始：docs/review-rules/use-case.json UC-R1 UC-R2 UC-R3 -->
//   ...generated list, do not edit by hand...
//   <!-- 规则生成区 结束 -->
// After the path come the rules to list: explicit numbers, 全部 (every rule of the file) or 其余 (every rule of the
// file that no other region of the same document lists). The path is relative to the task type's directory.
//
// Usage:
//   node scripts/render-rules.mjs            rewrite every generated region in task-types/*/docs/domain-knowledge/*.md
//   node scripts/render-rules.mjs --check    exit 1 and name the files whose regions differ from the rule files
//
// Every rule of a quoted rule file must be listed exactly once across the document's regions; otherwise the script
// stops with an error instead of writing.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEGIN = /<!-- 规则生成区 开始：(\S+)((?: \S+)*) -->\n/;
const END = "<!-- 规则生成区 结束 -->";

/** One rule as a Markdown list entry: number and level in bold, the rule, then its counter-example and example. */
export function ruleLines(rule, n) {
  const indent = " ".repeat(`${n}. `.length);     // sub-items nest under the entry only when indented past its marker
  return [
    `${n}. **${rule.编号}（${rule.级别}）** ${rule.条文}`,
    `${indent}- 反例：${rule.反例}`,
    `${indent}- 正例：${rule.正例}`,
  ].join("\n");
}

/** Renders every generated region of one document. `typeDir` is the task type's directory the paths are relative to. */
export function renderDocument(text, typeDir) {
  const regions = [];
  const pattern = new RegExp(BEGIN.source, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf(END, start);
    if (end < 0) throw new Error(`a generated region for ${match[1]} has no end marker`);
    regions.push({ head: match.index, start, end, path: match[1], wanted: match[2].trim().split(/\s+/).filter(Boolean) });
    pattern.lastIndex = end;
  }
  const files = new Map();
  const rulesOf = (path) => {
    if (!files.has(path)) {
      const full = join(typeDir, path);
      if (!existsSync(full)) throw new Error(`rule file ${path} does not exist in ${typeDir}`);
      files.set(path, JSON.parse(readFileSync(full, "utf-8")));
    }
    return files.get(path);
  };
  const explicit = new Map();
  for (const r of regions) {
    if (r.wanted.length === 1 && (r.wanted[0] === "全部" || r.wanted[0] === "其余")) continue;
    for (const id of r.wanted) explicit.set(`${r.path} ${id}`, (explicit.get(`${r.path} ${id}`) ?? 0) + 1);
  }
  const listed = new Map();
  const bodies = regions.map((r) => {
    const rules = rulesOf(r.path);
    let chosen;
    if (r.wanted.length === 1 && r.wanted[0] === "全部") chosen = rules;
    else if (r.wanted.length === 1 && r.wanted[0] === "其余") chosen = rules.filter((one) => !explicit.has(`${r.path} ${one.编号}`));
    else {
      chosen = r.wanted.map((id) => {
        const rule = rules.find((one) => one.编号 === id);
        if (!rule) throw new Error(`${r.path} has no rule ${id}`);
        return rule;
      });
    }
    for (const rule of chosen) listed.set(`${r.path} ${rule.编号}`, (listed.get(`${r.path} ${rule.编号}`) ?? 0) + 1);
    return chosen.map((rule, i) => ruleLines(rule, i + 1)).join("\n") + "\n";
  });
  for (const [path, rules] of files) {
    for (const rule of rules) {
      const times = listed.get(`${path} ${rule.编号}`) ?? 0;
      if (times !== 1) throw new Error(`rule ${rule.编号} of ${path} is listed ${times} times in the document; it must be listed exactly once`);
    }
  }
  let out = "";
  let at = 0;
  regions.forEach((r, i) => {
    out += text.slice(at, r.start) + bodies[i];
    at = r.end;
  });
  return out + text.slice(at);
}

/** Every domain-knowledge document that has at least one generated region: [path, task type directory]. */
export function documents(root = ROOT) {
  const out = [];
  const types = join(root, "task-types");
  for (const type of readdirSync(types, { withFileTypes: true })) {
    if (!type.isDirectory()) continue;
    const dir = join(types, type.name, "docs", "domain-knowledge");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      if (BEGIN.test(readFileSync(path, "utf-8"))) out.push([path, join(types, type.name)]);
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [path, typeDir] of documents()) {
    const text = readFileSync(path, "utf-8");
    const rendered = renderDocument(text, typeDir);
    if (rendered === text) continue;
    stale.push(path);
    if (!check) writeFileSync(path, rendered, "utf-8");
  }
  if (check && stale.length) {
    console.error(`generated rule lists are out of date; run node scripts/render-rules.mjs:\n${stale.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  if (!check) console.log(stale.length ? `rewrote ${stale.length} file(s)` : "nothing to rewrite");
}
