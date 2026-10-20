/**
 * 一次运行的看门狗与运行状态：执行器（executor.ts）把 pi 的事件逐条交给它，事件循环每秒空转一次时也让它看一眼钟。
 * 它算两样东西：
 * - 越线：模型输出退化或卡住时该中止这一次运行。四条线，任一越过就中止（阈值在启动配置的「看门狗」一段，没写用 DEFAULT_LIMITS）：
 *   一连串只含空白的增量（个数或累计字数）；单个工具参数的字节数；多少秒没有有效增量（只在等模型、模型输出时算，执行工具时不算）；
 *   单次模型调用的时长。实测见过模型在写保存修订的参数时把推理文字漏进参数、JSON 坏掉后一连两万多个空白增量，九分钟不停。
 * - 运行状态帧：现在在哪一段（等待模型、思考、文字、工具参数、执行工具、空闲）、这次运行已经多少秒、这次模型调用已经收到多少字、
 *   多少秒没有新内容、是否已到「可能卡住了」的提示线。页面据此画对话区底部的运行状态条，数都在这里算，页面不猜。
 * 有效增量：文本、思考、工具参数三种增量里带了非空白字符的那一个。
 */

/** 四条中止线与一条提示线（秒、字、字节）。 */
export interface WatchLimits {
  /** 连续多少个只含空白的增量中止。 */
  blank_run: number;
  /** 连续的空白增量累计多少个字中止。 */
  blank_chars: number;
  /** 单个工具参数多少字节中止。 */
  tool_args_bytes: number;
  /** 多少秒没有有效增量中止（只在等模型、模型输出时算）。 */
  no_progress_seconds: number;
  /** 单次模型调用多少秒中止。 */
  call_seconds: number;
  /** 多少秒没有有效增量时运行状态条提示「这一步可能卡住了」；应当小于 no_progress_seconds。 */
  stall_hint_seconds: number;
}

export const DEFAULT_LIMITS: WatchLimits = {
  blank_run: 200, blank_chars: 2000, tool_args_bytes: 48 * 1024, no_progress_seconds: 90, call_seconds: 8 * 60, stall_hint_seconds: 45,
};

/** 从启动配置的「看门狗」一段读阈值：写了的、是正数的才用，别的用默认。 */
export function limitsOf(raw: unknown): WatchLimits {
  const given = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof WatchLimits)[]) {
    const value = given[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

/** 中止的原因：原因码与计量。 */
export type AbortReason =
  | { code: "blank_output"; run: number; chars: number }
  | { code: "tool_args_too_large"; bytes: number }
  | { code: "no_progress"; seconds: number }
  | { code: "call_too_long"; seconds: number };

/** 给人看的原因，放进对话里那条系统消息与运行状态条。 */
export function reasonText(reason: AbortReason): string {
  switch (reason.code) {
    case "blank_output": return `连续输出了 ${reason.run} 段空白`;
    case "tool_args_too_large": return `工具参数超过 ${Math.round(reason.bytes / 1024)} KB`;
    case "no_progress": return `${reason.seconds} 秒没有新内容`;
    case "call_too_long": return `一次模型调用超过 ${Math.round(reason.seconds / 60)} 分钟`;
  }
}

export type Phase = "idle" | "waiting" | "thinking" | "text" | "tool_args" | "tool";

/** 推给页面的运行状态帧。 */
export interface RunStatus {
  phase: Phase;
  /** 正在写参数或正在执行的工具名；别的阶段为 null。 */
  tool: string | null;
  /** 这次运行已经多少秒；空闲时为 null。 */
  run_seconds: number | null;
  /** 这次模型调用已经收到多少字（三种增量合计）。 */
  received_chars: number;
  /** 正在写的工具参数有多少字。 */
  tool_args_chars: number;
  /** 多少秒没有有效增量（只在等模型、模型输出时算；别的时候为 null）。 */
  idle_seconds: number | null;
  /** 是否到了「这一步可能卡住了」的提示线。 */
  stalled: boolean;
}

/**
 * 正在写参数的那个工具调用的名字。经 RPC 推来的事件是精简过的：toolcall_start 直接带 toolName，不带 partial；
 * 直接用 pi 的库时带的是 partial（整条消息到目前为止的样子），两种都认。
 */
function toolNameOf(event: Record<string, any>, inner: Record<string, any>): string | null {
  if (typeof inner.toolName === "string" && inner.toolName) return inner.toolName;
  const block = inner.partial?.content?.[inner.contentIndex] ?? event.message?.content?.[inner.contentIndex];
  return typeof block?.name === "string" && block.name ? block.name : null;
}

const DELTA_PHASE: Record<string, Phase> = { text_delta: "text", thinking_delta: "thinking", toolcall_delta: "tool_args" };

export class RunWatch {
  private phase: Phase = "idle";
  private tool: string | null = null;
  private runStarted: number | null = null;
  private callStarted: number | null = null;
  private lastProgress = 0;
  private received = 0;
  private argsChars = 0;
  private argsBytes = 0;
  private blankRun = 0;
  private blankChars = 0;

  readonly limits: WatchLimits;

  constructor(limits: WatchLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /** 正在等模型或模型正在输出（这时才算「没有新内容」与调用时长）。 */
  private inCall(): boolean {
    return this.phase === "waiting" || this.phase === "thinking" || this.phase === "text" || this.phase === "tool_args";
  }

  /** 一次新的模型调用开始（新的一轮）：计数从头算。 */
  private startCall(now: number): void {
    this.phase = "waiting";
    this.tool = null;
    this.callStarted = now;
    this.lastProgress = now;
    this.received = 0;
    this.argsChars = 0;
    this.argsBytes = 0;
    this.blankRun = 0;
    this.blankChars = 0;
  }

  /** 看一条 pi 事件（now 是毫秒）；越线时返回原因。 */
  feed(event: Record<string, any>, now: number): AbortReason | null {
    const kind = event.type;
    if (kind === "agent_start") {
      this.runStarted = now;
      this.startCall(now);
      return null;
    }
    if (kind === "turn_start") {
      if (this.runStarted === null) this.runStarted = now;
      this.startCall(now);
      return null;
    }
    if (kind === "tool_execution_start") {
      this.phase = "tool";
      this.tool = typeof event.toolName === "string" ? event.toolName : null;
      this.callStarted = null;
      return null;
    }
    if (kind === "agent_settled" || kind === "agent_end") {
      this.phase = "idle";
      this.tool = null;
      this.runStarted = null;
      this.callStarted = null;
      return null;
    }
    if (kind !== "message_update") return null;
    const inner = event.assistantMessageEvent ?? {};
    if (inner.type === "toolcall_start") {
      this.phase = "tool_args";
      this.tool = toolNameOf(event, inner);
      this.argsChars = 0;
      this.argsBytes = 0;
      return null;
    }
    const phase = DELTA_PHASE[inner.type];
    if (!phase || typeof inner.delta !== "string" || inner.delta.length === 0) return null;
    if (this.phase === "idle") this.startCall(now);
    this.phase = phase;
    if (phase !== "tool_args") this.tool = null;
    else if (this.tool === null) {
      // 工具名在开头那一下可能还没到（各家接口发得不一样），参数增量到来时补上。
      this.tool = toolNameOf(event, inner);
    }
    this.received += inner.delta.length;
    if (inner.delta.trim() === "") {
      this.blankRun += 1;
      this.blankChars += inner.delta.length;
    } else {
      this.blankRun = 0;
      this.blankChars = 0;
      this.lastProgress = now;
    }
    if (phase === "tool_args") {
      this.argsChars += inner.delta.length;
      this.argsBytes += new TextEncoder().encode(inner.delta).length;
      if (this.argsBytes >= this.limits.tool_args_bytes) return { code: "tool_args_too_large", bytes: this.argsBytes };
    }
    if (this.blankRun >= this.limits.blank_run || this.blankChars >= this.limits.blank_chars) {
      return { code: "blank_output", run: this.blankRun, chars: this.blankChars };
    }
    return this.clock(now);
  }

  /** 看一眼钟（事件循环每秒空转一次时调）：时长类的线。 */
  clock(now: number): AbortReason | null {
    if (!this.inCall()) return null;
    const idle = (now - this.lastProgress) / 1000;
    if (idle >= this.limits.no_progress_seconds) return { code: "no_progress", seconds: Math.floor(idle) };
    if (this.callStarted !== null && (now - this.callStarted) / 1000 >= this.limits.call_seconds) {
      return { code: "call_too_long", seconds: Math.floor((now - this.callStarted) / 1000) };
    }
    return null;
  }

  /** 中止之后：回到空闲。 */
  stop(): void {
    this.phase = "idle";
    this.tool = null;
    this.runStarted = null;
    this.callStarted = null;
  }

  status(now: number): RunStatus {
    const idle = this.inCall() ? Math.floor((now - this.lastProgress) / 1000) : null;
    return {
      phase: this.phase, tool: this.tool,
      run_seconds: this.runStarted === null ? null : Math.floor((now - this.runStarted) / 1000),
      received_chars: this.received, tool_args_chars: this.phase === "tool_args" ? this.argsChars : 0,
      idle_seconds: idle, stalled: idle !== null && idle >= this.limits.stall_hint_seconds,
    };
  }
}
