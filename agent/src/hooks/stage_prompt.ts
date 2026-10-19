/**
 * 按阶段换系统提示的挂点：一次运行开始之前（before_agent_start），任务有阶段就把系统提示整份换成
 * 按会话选段拼成的那一份（怎样拼见 lib/context_assemble.ts），早先的任务什么都不做。
 *
 * pi 的约定（docs/extensions.md）：这个事件的处理函数返回 systemPrompt，就整份替换这一次运行的系统提示；
 * 下一次运行不返回，用的就是启动参数给的那一份。RPC 形态下同样触发；扩展代用户发的话引起的运行也触发；
 * 一次运行结束时追加一句话让它接着跑的那一截不再触发，沿用这次运行已经换上的文字。所以换阶段只在下一次运行生效：
 * 助手在回复里移动阶段时这次运行随即结束，用户点「开始写条目」时扩展先记移动、再代发那句固定的话。
 * 这几条由 backend/tests/stage_prompt_rpc.test.ts 用真的 pi 核对。
 *
 * 不是每次都重读重拼：进程里记着上一份，阶段与文件都没变就原样交回（lib/context_assemble.ts 的 ContextCache）。
 *
 * 每次换了系统提示都经状态栏报一行短事实给后端（键名 taskwright-stage-prompt）：哪个阶段、这一次是重拼还是沿用、
 * 说明文字与它各部分的摘要值、字节数与行数（不算 pi 接在后面的工作目录那一截），不带文字本身。它不写库。
 *
 * 拼不成时（模块缺了、头写得不对、重名、次序号相同、活动或工作流的定义读不成），这次运行停下：不调用模型，不沿用以前拼好的任何一份，
 * 也不退回启动参数给的那一份（那一份不知道现在在哪一项活动，照它做会越界）。停下的办法是在这次运行的第一个回合开始时调用 pi 的 abort
 * （见 registerStagePrompt），同时往会话里写一条
 * 给用户看的消息（customType 为 taskwright-stage-prompt-error，文字取自模板 stage_prompt.compose_failed），并把原因报出去。
 * 这一条由 backend/tests/stage_prompt_rpc.test.ts 用真的 pi 核对。
 *
 * 调试模式（后端带 --debug 启动时给了环境变量，见 lib/context_assemble.ts 的 debugPromptDir）下多做两件事：每次运行开始时读一次设置里的
 * 「提示词目录」，目录里有的文件代替原来的；报出去的那一行另带每一部分的文字（texts），早先的任务也报一行（启动时给的整份）。
 * 这些文字后端只留在内存里给调试接口用，不写进归档。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ComposeHow, ContextCache, type LoadedSkill, type PartFact, type PartKind, type PartOrigin, type StagePrompt, debugPromptDir, digestOf, partFact, piTail,
  whereInWorkspace,
} from "../lib/context_assemble.ts";
import type { Position } from "../lib/stage.ts";
import { fillText } from "../lib/texts.ts";

/** 报这一行事实用的状态栏键名。与 backend/src/pi_session.ts 里的同名常量是一份约定。 */
export const STAGE_PROMPT_STATUS_KEY = "taskwright-stage-prompt";

/** 拼不成而停下这次运行时，写进会话给用户看的那条消息的 customType。与 backend/src/pi_session.ts 里的同名常量是一份约定。 */
export const STAGE_PROMPT_ERROR_TYPE = "taskwright-stage-prompt-error";

/** 报给后端的那一行事实。replaced 为假是这一次没有换系统提示：早先的任务（调试模式下才报），或者拼不成而停下了这次运行（stopped 为真，error 写着原因）。 */
export interface StagePromptReport {
  replaced: boolean;
  /** 拼不成而停下了这次运行。 */
  stopped?: true;
  /** 这一次是为哪个阶段拼的；会话空闲时是 idle（用的是澄清的那一段，去掉了「出口」一节）。 */
  stage?: Position;
  /** 这条会话的工作项是不是流程的工作项：为假是单项活动的工作项（节点的出口换成固定的一段），空闲时也为假。 */
  in_flow?: boolean;
  how?: ComposeHow;
  error?: string;
  /** 说明文字（从文件来的那几部分接起来，不含 pi 接在后面的工作目录等）的摘要值、字节数与行数。 */
  digest?: string;
  bytes?: number;
  lines?: number;
  parts?: PartFact[];
  /** 下面几项只在调试模式下有。 */
  debug?: true;
  /** 这一次用的提示词目录；没有设或不能用时是 null。 */
  prompt_dir?: string | null;
  /** 提示词目录不能用、或者里面有文件没有用上时的原因，各一句。 */
  notes?: string[];
  /** 发给模型的系统提示按先后排的每一部分，带文字；接起来（各隔一个空行）就是整份。早先的任务只有一项，part 是 launch。 */
  texts?: { part: PartKind | "launch"; from: PartOrigin; file: string | null; text: string }[];
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
type StartContext = { cwd: string; ui: { setStatus(key: string, text: string): void }; sessionManager?: { getSessionId(): string }; abort?(): void };

/** 停下这次运行时写进会话的那条消息。 */
export interface StopMessage {
  customType: string;
  content: string;
  display: true;
  details: { reason: string };
}

/**
 * 处理一次 before_agent_start：返回要换上的系统提示；早先的任务不换，返回 undefined；拼不成时停下这次运行，返回写进会话的那条消息。
 * 单独导出是为了不起 pi 也能测；cache 与 summaries 由 registerStagePrompt 在进程里各留一份。
 */
export function stagePromptFor(event: StartEvent, ctx: StartContext, cache: ContextCache,
  summaries: WeakMap<StagePrompt, ReturnType<typeof summarize>>): { systemPrompt: string } | { message: StopMessage } | undefined {
  const report = (fact: StagePromptReport) => ctx.ui.setStatus(STAGE_PROMPT_STATUS_KEY, JSON.stringify(fact));
  const launched = String(event.systemPrompt ?? "");
  try {
    const debug = debugPromptDir();
    // 换哪一份看这条会话属于的工作项；拿不到会话编号时按自由讨论的会话办。
    const where = whereInWorkspace(ctx.cwd, ctx.sessionManager?.getSessionId() ?? null);
    // 早先的任务没有阶段：系统提示与原来完全相同。平时不多报什么；调试模式下报一行，让调试接口看得到它拿到的是启动时给的那一份。
    if (where === null) {
      if (debug.debug) report({ replaced: false, debug: true, prompt_dir: debug.dir, notes: [], texts: [{ part: "launch", from: "pi", file: null, text: launched }] });
      return undefined;
    }
    const options = event.systemPromptOptions ?? {};
    const tail = piTail(launched, String(options.customPrompt ?? ""));
    const { stage, inFlow, flow, scope } = where;
    const got = cache.get({ stage, inFlow, flow, scope, workspaceDir: ctx.cwd, skills: options.skills ?? [], tail, promptDir: debug.dir });
    let summary = summaries.get(got.prompt);
    if (!summary) summaries.set(got.prompt, (summary = summarize(got.prompt)));
    report({
      replaced: true, stage, in_flow: inFlow, how: got.how, ...summary,
      ...(debug.debug ? { debug: true as const, prompt_dir: debug.dir, notes: [...(debug.note ? [debug.note] : []), ...got.prompt.notes], texts: got.prompt.parts } : {}),
    });
    return { systemPrompt: got.prompt.text };
  } catch (error) {
    const reason = (error as Error).message;
    report({ replaced: false, stopped: true, error: `按会话拼系统提示没有拼成，这次运行停下了：${reason}` });
    ctx.abort?.();
    return { message: { customType: STAGE_PROMPT_ERROR_TYPE, content: fillText("stage_prompt.compose_failed", { reason }), display: true, details: { reason } } };
  }
}

export function registerStagePrompt(pi: ExtensionAPI): void {
  const cache = new ContextCache();
  const summaries = new WeakMap<StagePrompt, ReturnType<typeof summarize>>();
  // 拼不成时要停下这次运行。before_agent_start 的时候 pi 还没有开始流式请求，这时调用 abort 不起作用（实测模型照样被调用）；
  // 所以这里只记下「要停」，到这次运行第一个回合开始（turn_start，请求模型之前）再调用 abort：模型一次也不被请求，
  // 会话里留下用户那句话、那条报错的消息与一条以 error 结束的空的助手消息（errorMessage 是 This operation was aborted）。
  let stopAtTurnStart = false;
  pi.on("before_agent_start", async (event, ctx) => {
    stopAtTurnStart = false;
    const given = ctx as unknown as StartContext;
    const wrapped: StartContext = { cwd: given.cwd, ui: given.ui, sessionManager: given.sessionManager, abort: () => { stopAtTurnStart = true; } };
    return stagePromptFor(event as StartEvent, wrapped, cache, summaries);
  });
  pi.on("turn_start", async (_event, ctx) => {
    if (!stopAtTurnStart) return;
    stopAtTurnStart = false;
    ctx.abort();
  });
}
