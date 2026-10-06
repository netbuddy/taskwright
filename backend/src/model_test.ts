/**
 * 测试模型（docs/api.md §10）。测试语言模型：起一次不属于任何任务的助手，让模型读一个小文件并回答文件里写的一个数，回报这一次通过还是没有通过。
 *
 * 走的是任务里起助手的同一条路：同一份启动配置、同一个模型（launch.ts 的 resolveModel）、同一个会话类与收发数据层。
 * 与任务不同的只有这几样：工作目录是一个临时目录；工具只留读文件的那一个；不加载任何扩展与技能，所以没有产品自己的工具，
 * 也没有任务现状消息；不带任务的系统提示，用助手程序自带的。归档也写在临时目录里，测试结束连同临时目录一起删掉，结果不保存。
 *
 * 测试嵌入模型：不起助手，用调嵌入模型的模块（embedding.ts）把一句话按查询的用途换算一次，拿回一条数字串就算通过。
 *
 * 同一时间只跑一个测试，两种模型的测试共用这一条。
 */

import { randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textOf } from "./conversation.ts";
import { EmbeddingError, embed } from "./embedding.ts";
import { ApiError } from "./errors.ts";
import { startFailure } from "./executor.ts";
import { type Profile, resolveModel } from "./launch.ts";
import { type Context, embeddingTarget } from "./model_config.ts";
import { PiExited, PiSession, technicalOf } from "./pi_session.ts";
import type { PiTransport } from "./transport.ts";

/** 一次测试最多这么久（含启动助手的时间）；本地的模型服务第一次载入模型可能要一分多钟。 */
export const TEST_TIMEOUT_MS = 90_000;
export const BUSY_TEXT = "正在测试，请等它结束。";
/** 模型最后一句回复最多带回这么多个字。 */
const REPLY_LIMIT = 200;
const READ_TOOL = "read";
const FILE_NAME = "inventory.txt";
/** 问模型的那句话；结果里原样带回，页面把它与模型的回答一起显示。 */
export const QUESTION = `请读当前目录下的文件 ${FILE_NAME}，然后用一句话回答：这批货一共有多少箱？`;

export interface TestResult {
  ok: true;
  result: "passed" | "failed";
  /** 这一次测的模型，「服务商/型号」；没有模型可测时是空串。 */
  model: string;
  /** 用时，秒，一位小数。 */
  seconds: number;
  /** 模型调用了几次工具。 */
  tool_calls: number;
  /** 问模型的那句话。 */
  question: string;
  /** 模型最后一句回复，最多 200 个字；没有回复时是空串。 */
  reply: string;
  /** 没有通过时一句给人看的原因；通过时是 null。 */
  reason: string | null;
}

/** 一次测试做到哪里了：run 边做边写，超时的时候已经记下的照样带回。 */
interface Progress {
  toolCalls: number;
  reply: string;
}

export interface TestOptions {
  /** 最多等多久；不给时是 TEST_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 起助手用的收发数据层；不给时是会话类的缺省实现（子进程）。测试用它核对助手停了没有。 */
  makeTransport?: () => PiTransport;
}

let running = false;

/** 测试用的启动配置：只在内存里，从服务的启动配置去掉与任务有关的几项。 */
function testProfile(profile: Profile): Profile {
  const { platform_skill: _skill, workspace_skills_dir: _skills, system_prompt_file: _prompt, ...rest } = profile;
  return { ...rest, tools: [READ_TOOL], extensions: [] };
}

/** 回答里有没有这个箱数：只认阿拉伯数字，前后不能再紧挨着别的数字（文件里写 42 时，「420」「142」都不算）。 */
function mentions(reply: string, count: number): boolean {
  return new RegExp(`(?<![0-9])${count}(?![0-9])`).test(reply);
}

function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join("") + "…" : text;
}

/**
 * 助手的程序给的英文原因里认得出的两种，换成给人看的一句；认不出时返回 null。模型登记里没有这个模型时它一启动就退出
 * （Model "…" not found），模型服务没有凭据时它拒绝发话（No API key found for …）。
 */
function knownReason(model: string, technical: string): string | null {
  if (/Model\b.*\bnot found/i.test(technical)) return `模型登记里找不到「${model}」。请检查它的模型服务还在不在。`;
  if (/No API key/i.test(technical)) return `「${model}」的模型服务还没有设置密钥，或者还没有登录。`;
  return null;
}

/** 起助手、核对模型、发一句话、看事件。返回没有通过的原因，通过时返回 null；不负责停助手（由调用方在 finally 里停）。 */
async function run(pi: PiSession, model: string, count: number, progress: Progress): Promise<string | null> {
  let state: Record<string, any>;
  try {
    await pi.start();
    state = await pi.getState();
  } catch (error) {
    // 给人看的那句与任务里助手起不来时相同（认得出原因的两种另写）；排查用的原话只写进日志。
    const technical = (error instanceof PiExited ? technicalOf(error) : pi.stderrText || technicalOf(error)).trim();
    console.log(`测试语言模型时助手没有启动起来：${technical.slice(-500)}`);
    return knownReason(model, technical) ?? startFailure(error).text;
  }
  const current = state.model ? `${state.model.provider}/${state.model.id}` : "";
  if (current !== model) {
    return `助手没有用上要测的模型「${model}」${current ? `，它用的是「${current}」` : ""}。请检查这个模型在它的模型服务里是不是勾选了。`;
  }
  let error = "";
  try {
    for await (const event of pi.send(QUESTION)) {
      if (event.type === "tool_execution_start") progress.toolCalls += 1;
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      const message = event.message;
      // 出错看最后一条助手消息：出错之后自动重试成功时，后面那条不是 error，这一次不算出错（与 executor.ts 的判断相同）。
      error = message.stopReason === "error" ? String(message.errorMessage ?? "").trim() || "没有给原因" : "";
      const text = textOf(message.content ?? null).trim();
      const calls = (message.content || []).some((p: unknown) => typeof p === "object" && p !== null && (p as Record<string, any>).type === "toolCall");
      if (text && !calls) progress.reply = clip(text, REPLY_LIMIT);
    }
  } catch (failure) {
    const technical = technicalOf(failure).trim();
    console.log(`测试语言模型时助手中途停了：${technical.slice(-500)}`);
    return knownReason(model, technical) ?? (failure instanceof PiExited ? "助手中途退出了。" : "助手没有把这句话做完。");
  }
  if (error) return `模型服务报错：${clip(error, REPLY_LIMIT)}`;
  if (progress.toolCalls === 0) return "模型没有调用读文件的工具。";
  if (!mentions(progress.reply, count)) return "模型的回答里没有文件里写的箱数。";
  return null;
}

/**
 * 对助手现在实际会用的语言模型做一次测试。通过要两条都满足：事件里有工具调用；最后一句回复里有文件里写的箱数（阿拉伯数字）。
 * 工具调用了不止一次不算没有通过，次数记在 tool_calls 里。已经有一个测试在跑时报 busy。
 */
export async function testLanguageModel(ctx: Context, options: TestOptions = {}): Promise<TestResult> {
  if (running) throw new ApiError("busy", BUSY_TEXT);
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
  running = true;
  const started = Date.now();
  const model = resolveModel(ctx.profile, ctx.env).model;
  const progress: Progress = { toolCalls: 0, reply: "" };
  const result = (reason: string | null): TestResult => ({
    ok: true, result: reason === null ? "passed" : "failed", model, seconds: Math.round((Date.now() - started) / 100) / 10,
    tool_calls: progress.toolCalls, question: QUESTION, reply: progress.reply, reason,
  });
  let dir: string | null = null;
  let pi: PiSession | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!model) return result("还没有选定语言模型，启动配置里也没有写模型。");
    dir = mkdtempSync(join(tmpdir(), "taskwright-model-test-"));
    const workspace = join(dir, "work");
    mkdirSync(workspace);
    // 文件里的箱数每次随机取一个两位数，模型不读文件就答不出来。
    const count = randomInt(10, 100);
    writeFileSync(join(workspace, FILE_NAME), `这批货一共有 ${count} 箱。\n`, "utf-8");
    pi = new PiSession(testProfile(ctx.profile), workspace, join(dir, "runs"), "model-test", null, options.makeTransport);
    const work = run(pi, model, count, progress);
    // 超时之后助手在 finally 里被停掉，这时 run 里等着的那一步会出错；它已经没有人等了，接住免得成为没有处理的拒绝。
    work.catch(() => {});
    const timeout = new Promise<string>((ok) => {
      timer = setTimeout(() => ok(`${Math.round(timeoutMs / 1000)} 秒内没有做完。`), timeoutMs);
    });
    return result(await Promise.race([work, timeout]));
  } finally {
    clearTimeout(timer);
    try {
      await pi?.close();
    } catch {
      // 停不掉也要接着删临时目录
    }
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    running = false;
  }
}

export interface EmbeddingTestResult {
  ok: true;
  result: "passed" | "failed";
  /** 这一次测的嵌入模型，「服务名/型号」；没有选嵌入模型时是空串。 */
  model: string;
  /** 用时，秒，一位小数。 */
  seconds: number;
  /** 送去换算的那句话：设置里的查询前缀接上「这批货一共有 N 箱。」。 */
  question: string;
  /** 算出来的数字串的长度；没有拿到数字串时是 null。 */
  dimensions: number | null;
  /** 没有通过时一句给人看的原因；通过时是 null。 */
  reason: string | null;
}

export interface EmbeddingTestOptions {
  /** 最多等多久；不给时是调嵌入模型的模块的时限（60 秒）。 */
  timeoutMs?: number;
}

/**
 * 对选定的嵌入模型做一次测试：把一句话按查询的用途（前面加设置里的查询前缀）送去换算。拿回正好一条数字串算通过；
 * 数字串非空、每一项都是数由调嵌入模型的模块核对。没有做成的各种情形（没有选嵌入模型也在内）都算没有通过，原因写在 reason 里。
 * 已经有一个测试在跑时报 busy。
 */
export async function testEmbeddingModel(ctx: Context, options: EmbeddingTestOptions = {}): Promise<EmbeddingTestResult> {
  if (running) throw new ApiError("busy", BUSY_TEXT);
  running = true;
  const started = Date.now();
  try {
    // 句式与测试语言模型时文件里写的那一句相同，箱数每次随机取一个两位数。
    const sentence = `这批货一共有 ${randomInt(10, 100)} 箱。`;
    const target = embeddingTarget(ctx);
    const result = (reason: string | null, dimensions: number | null): EmbeddingTestResult => ({
      ok: true, result: reason === null ? "passed" : "failed", model: target ? `${target.provider_id}/${target.model}` : "",
      seconds: Math.round((Date.now() - started) / 100) / 10, question: (target?.query_prefix ?? "") + sentence, dimensions, reason,
    });
    try {
      const got = await embed(ctx, [sentence], "query", { timeoutMs: options.timeoutMs });
      return result(null, got.dimensions);
    } catch (error) {
      if (!(error instanceof EmbeddingError)) throw error;
      return result(error.message, null);
    }
  } finally {
    running = false;
  }
}

/** POST /api/v1/model-config/test */
export async function testModel(ctx: Context, body: Record<string, any>): Promise<TestResult | EmbeddingTestResult> {
  if (body.type === "language") return testLanguageModel(ctx);
  if (body.type === "embedding") return testEmbeddingModel(ctx);
  const message = "type 应当是 language 或 embedding。";
  throw new ApiError("rejected", message, { field: "type", reasons: [message] });
}
