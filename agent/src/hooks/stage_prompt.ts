/**
 * 按阶段换系统提示的挂点：一次运行开始之前（before_agent_start），任务有阶段就把系统提示整份换成
 * 「系统提示、两份共用部分、现在这个阶段的那一段」（怎样拼见 lib/stage_prompt.ts），早先的任务什么都不做。
 *
 * pi 的约定（docs/extensions.md）：这个事件的处理函数返回 systemPrompt，就整份替换这一次运行的系统提示；
 * 下一次运行不返回，用的就是启动参数给的那一份。RPC 形态下同样触发；扩展代用户发的话引起的运行也触发；
 * 一次运行结束时追加一句话让它接着跑的那一截不再触发，沿用这次运行已经换上的文字。所以换阶段只在下一次运行生效：
 * 助手在回复里移动阶段时这次运行随即结束，用户点「开始写条目」时扩展先记移动、再代发那句固定的话。
 * 这几条由 backend/tests/stage_prompt_rpc.test.ts 用真的 pi 核对。
 *
 * 不是每次都重读重拼：进程里记着上一份，阶段与文件都没变就原样交回（lib/stage_prompt.ts 的 StagePromptCache）。
 *
 * 每次换了系统提示都经状态栏报一行短事实给后端（键名 taskwright-stage-prompt）：哪个阶段、这一次是重拼还是沿用、
 * 说明文字与它各部分的摘要值、字节数与行数（不算 pi 接在后面的工作目录那一截），不带文字本身。出错时不换系统提示（这次运行用启动参数给的那一份，
 * 阶段的守门仍由工具执行），把原因报出去。它不写库。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ComposeHow, type LoadedSkill, type PartFact, type StagePrompt, StagePromptCache, digestOf, partFact, piTail, stageInWorkspace } from "../lib/stage_prompt.ts";
import type { Stage } from "../lib/stage.ts";

/** 报这一行事实用的状态栏键名。与 backend/src/pi_session.ts 里的同名常量是一份约定。 */
export const STAGE_PROMPT_STATUS_KEY = "taskwright-stage-prompt";

/** 报给后端的那一行事实。replaced 为假是这一次没有换系统提示，error 写着原因。 */
export interface StagePromptReport {
  replaced: boolean;
  stage?: Stage;
  how?: ComposeHow;
  error?: string;
  /** 说明文字（从文件来的那几部分接起来，不含 pi 接在后面的工作目录等）的摘要值、字节数与行数。 */
  digest?: string;
  bytes?: number;
  lines?: number;
  parts?: PartFact[];
}

/**
 * 一份拼好的系统提示的事实：只在重拼时算一次。只算从文件来的那几部分，不算 pi 接在后面的那一截：
 * 那一截里有任务目录的路径，算进去的话同样的说明在不同的任务、不同的机器上摘要值就不同，没法拿来比两次运行用的是不是同一版说明。
 */
function summarize(prompt: StagePrompt): Pick<StagePromptReport, "digest" | "bytes" | "lines" | "parts"> {
  const own = prompt.parts.filter((one) => one.from !== "pi");
  const text = own.map((one) => one.text).join("\n\n");
  return { digest: digestOf(text), bytes: Buffer.byteLength(text, "utf-8"), lines: text.split("\n").length, parts: own.map(partFact) };
}

type StartEvent = { systemPrompt?: string; systemPromptOptions?: { customPrompt?: string; skills?: LoadedSkill[] } };
type StartContext = { cwd: string; ui: { setStatus(key: string, text: string): void } };

/**
 * 处理一次 before_agent_start：返回要换上的系统提示，不换时返回 undefined。
 * 单独导出是为了不起 pi 也能测；cache 与 summaries 由 registerStagePrompt 在进程里各留一份。
 */
export function stagePromptFor(event: StartEvent, ctx: StartContext, cache: StagePromptCache,
  summaries: WeakMap<StagePrompt, ReturnType<typeof summarize>>): { systemPrompt: string } | undefined {
  const report = (fact: StagePromptReport) => ctx.ui.setStatus(STAGE_PROMPT_STATUS_KEY, JSON.stringify(fact));
  try {
    const stage = stageInWorkspace(ctx.cwd);
    // 早先的任务没有阶段：系统提示与原来完全相同，也不多报什么。
    if (stage === null) return undefined;
    const options = event.systemPromptOptions ?? {};
    const tail = piTail(String(event.systemPrompt ?? ""), String(options.customPrompt ?? ""));
    const got = cache.get({ stage, workspaceDir: ctx.cwd, skills: options.skills ?? [], tail });
    let summary = summaries.get(got.prompt);
    if (!summary) summaries.set(got.prompt, (summary = summarize(got.prompt)));
    // 重拼出错而沿用上一份时，stage 写的是任务现在的阶段，上一份是哪个阶段的看 parts 里那一段的文件名。
    report({ replaced: true, stage, how: got.how, ...(got.error ? { error: got.error } : {}), ...summary });
    return { systemPrompt: got.prompt.text };
  } catch (error) {
    report({ replaced: false, error: `按阶段换系统提示没有做成，这次运行用启动时给的那一份：${(error as Error).message}` });
    return undefined;
  }
}

export function registerStagePrompt(pi: ExtensionAPI): void {
  const cache = new StagePromptCache();
  const summaries = new WeakMap<StagePrompt, ReturnType<typeof summarize>>();
  pi.on("before_agent_start", async (event, ctx) => stagePromptFor(event as StartEvent, ctx as unknown as StartContext, cache, summaries));
}
