/**
 * 对话理解评测的跑分入口：对 cases.jsonl 里的每一例，经 pi 的一次性运行（-p，不开工具、不存会话）让模型只写理解，
 * 按 eval_lib.ts 的规则判分，把报告写到 reports/<日期时间>.md，逐次的原始输出写到同名的 .jsonl。
 *
 * 用法（在代码仓根目录）：
 *   node agent/eval/understanding/run.ts [--repeat N] [--only U-001,U-002] [--concurrency 4]
 *
 * 模型与思考档位取自生产用的启动配置 server/taskwright_server/profiles/dev.json。pi 在一个临时空目录里运行，
 * 不会读到代码仓里的说明文件。设了 TASKWRIGHT_LANGFUSE_PLUGIN 时加载 Langfuse 观测插件；设了 TASKWRIGHT_LANGFUSE_ENV_FILE 时，
 * 按启动配置的 env_passthrough 从那个文件读密钥，只经环境变量交给 pi，不写进任何文件。
 * LANGFUSE_TRACING_ENVIRONMENT 没设时用 intent-eval，在 Langfuse 里按它筛出评测的调用。
 * 跑分要调真模型，不进 CI；判分逻辑的单元测试在 agent/tests/understanding_eval.test.ts。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt, majority, parseUnderstanding, scoreCase, tally, understandingSection, type Act, type CaseScore, type EvalCase } from "./eval_lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SKILL = join(REPO, "agent/prompts/skills/taskwright-executor/SKILL.md");
const SCHEMA = join(REPO, "agent/prompts/schemas/user_intent.schema.json");
const PROFILE = join(REPO, "server/taskwright_server/profiles/dev.json");
const TIMEOUT_MS = 180_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && "\"'".includes(value[0])) value = value.slice(1, -1);
    out[line.slice(0, at).trim()] = value;
  }
  return out;
}

function piSetup(profile: Record<string, any>): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = ["-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--model", profile.model, "--thinking", profile.thinking];
  const env: NodeJS.ProcessEnv = { ...process.env };
  const plugin = process.env.TASKWRIGHT_LANGFUSE_PLUGIN?.trim();
  if (plugin) {
    const entry = existsSync(plugin) && statSync(plugin).isDirectory() ? join(plugin, "src/index.ts") : plugin;
    if (existsSync(entry)) args.push("-e", entry);
  }
  const keyFile = process.env.TASKWRIGHT_LANGFUSE_ENV_FILE?.trim();
  if (keyFile && existsSync(keyFile)) {
    const loaded = readEnvFile(keyFile);
    for (const name of profile.env_passthrough ?? []) if (loaded[name] && !env[name]) env[name] = loaded[name];
  }
  env.LANGFUSE_TRACING_ENVIRONMENT ||= "intent-eval";
  return { args, env };
}

function runPi(args: string[], env: NodeJS.ProcessEnv, prompt: string): Promise<{ output: string; error: string | null; ms: number }> {
  const cwd = mkdtempSync(join(tmpdir(), "intent-eval-"));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pi", [...args, prompt], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ output: out, error: code === 0 ? null : `pi 退出码 ${code}：${err.trim().slice(0, 300)}`, ms: Date.now() - started });
    });
  });
}

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, " ");
const actsText = (acts: Act[]) => acts.map((a) => `${a.function}${a.targets?.length ? `[${a.targets.map((t) => t.item_id + (t.field ? "." + t.field : "")).join(",")}]` : ""}${a.responds_to ? `→${a.responds_to}` : ""}「${a.summary}」`).join("；");

async function main() {
  const repeat = Math.max(1, Number(arg("--repeat", "1")));
  const concurrency = Math.max(1, Number(arg("--concurrency", "4")));
  const only = arg("--only", "").split(",").filter(Boolean);
  const profile = JSON.parse(readFileSync(PROFILE, "utf-8"));
  const section = understandingSection(readFileSync(SKILL, "utf-8"));
  const cases: EvalCase[] = readFileSync(join(HERE, "cases.jsonl"), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    .filter((c) => !only.length || only.includes(c.id));
  const { args, env } = piSetup(profile);
  const started = new Date();
  const stamp = started.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const reports = join(HERE, "reports");
  mkdirSync(reports, { recursive: true });

  const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, r) => async () => {
    const res = await runPi(args, env, buildPrompt(section, c));
    const parsed = res.error ? { error: res.error } : parseUnderstanding(res.output);
    const acts = "acts" in parsed ? parsed.acts : null;
    process.stderr.write(`${c.id} 第 ${r + 1} 次：${acts ? actsText(acts) : `格式不合格（${"error" in parsed ? parsed.error : ""}）`}\n`);
    return { id: c.id, run: r + 1, ms: res.ms, output: res.output, error: "error" in parsed ? parsed.error : null, acts, score: scoreCase(c.expected.acts, acts) };
  }));
  const raw = await pool(jobs, concurrency);
  writeFileSync(join(reports, `${stamp}.jsonl`), raw.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const perCase = cases.map((c) => {
    const runs = raw.filter((r) => r.id === c.id);
    const score = runs.length > 1 ? majority(runs.map((r) => r.score)) : runs[0].score;
    const readings = new Set(runs.map((r) => (r.acts ? r.acts.map((a) => a.function).join("+") : "格式不合格")));
    return { c, runs, score, stable: readings.size === 1 };
  });
  const t = tally(perCase.map((p) => p.score));
  const lines = [
    `# 对话理解评测报告 ${stamp}`,
    "",
    `- 模型：${profile.model}，思考 ${profile.thinking}；每例跑 ${repeat} 次${repeat > 1 ? "，四项各按多数判" : ""}`,
    `- 平台 skill（SKILL.md）sha256 前 12 位：${hash(SKILL)}；理解 schema sha256 前 12 位：${hash(SCHEMA)}；评测集 sha256 前 12 位：${hash(join(HERE, "cases.jsonl"))}`,
    `- 例数 ${t.cases}（其中补写 ${cases.filter((c) => c.source === "补写").length}）；格式不合格 ${t.formatFailures} 例；开始于 ${started.toISOString()}，用时 ${Math.round((Date.now() - started.getTime()) / 1000)} 秒`,
    "",
    "## 总分",
    "",
    "| 项 | 对的例数 |",
    "|---|---|",
    `| 功能全对 | ${t.functions} |`,
    `| 目标全对 | ${t.targets} |`,
    `| 回应对 | ${t.responds} |`,
    `| 摘要对 | ${t.summary} |`,
    `| 四项全对 | ${t.allFour} |`,
    `| 纠正的摘要写明了变更方式（按项计） | ${t.changes} |`,
    "",
    "## 按功能分组（按期望的每一项计，同一位置上的功能对了算对）",
    "",
    "| 功能 | 准确率 |",
    "|---|---|",
    ...t.byFunction.map((r) => `| ${r.name}（${r.function}） | ${r.accuracy} |`),
    "",
  ];
  if (repeat > 1) {
    const unstable = perCase.filter((p) => !p.stable);
    lines.push("## 波动", "", `${repeat} 次读出的功能组合不完全相同的有 ${unstable.length} 例：${unstable.map((p) => p.c.id).join("、") || "无"}。`, "");
    for (const p of unstable) lines.push(`- ${p.c.id}「${clip(p.c.text)}」：${p.runs.map((r) => (r.acts ? r.acts.map((a) => a.function).join("+") : "格式不合格")).join(" / ")}`);
    lines.push("");
  }
  lines.push("## 失败例", "");
  for (const p of perCase.filter((x) => !(x.score.functions && x.score.targets && x.score.responds && x.score.summary))) {
    const shown = p.runs.find((r) => r.score.diff.length) ?? p.runs[0];
    lines.push(`### ${p.c.id}（${p.c.source === "补写" ? "补写" : "真实"}）「${clip(p.c.text, 80)}」`, "",
      `- 期望：${actsText(p.c.expected.acts)}`,
      `- 实际（第 ${shown.run} 次）：${shown.acts ? actsText(shown.acts) : `格式不合格：${shown.error}`}`,
      `- 差在哪：${shown.score.diff.join("；")}`, "");
  }
  const reportPath = join(reports, `${stamp}.md`);
  writeFileSync(reportPath, lines.join("\n") + "\n");
  process.stderr.write(`报告：${reportPath}\n`);
}

main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
