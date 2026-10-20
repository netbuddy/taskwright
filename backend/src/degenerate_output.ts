/**
 * 模型退化输出的识别：流式输出里一连串只含空白的增量（文本、工具参数、思考三种增量都算）。实测见过模型在调保存修订时
 * 工具参数一连几千个增量全是「 \n」之类，一次运行跑了九分钟、事件文件涨到几 MB 还不停。连续 RUN_LIMIT 个增量只含空白，
 * 或者连续的空白增量累计到 CHARS_LIMIT 个字，就判为退化，由执行器中止这一次运行（executor.ts）。
 * 有一个增量带了非空白的字就从头数；每条助手消息开头（message_start）也从头数。
 */

/** 连续多少个只含空白的增量判为退化。 */
export const RUN_LIMIT = 200;
/** 连续的空白增量累计多少个字判为退化。 */
export const CHARS_LIMIT = 2000;

/** 数哪几种增量：文本、工具参数、思考。 */
const DELTA_KINDS = new Set(["text_delta", "toolcall_delta", "thinking_delta"]);

export class DegenerateWatch {
  private run = 0;
  private chars = 0;

  /** 从头数（新的一条助手消息开始时）。 */
  reset(): void {
    this.run = 0;
    this.chars = 0;
  }

  /**
   * 看一条 pi 事件；判为退化时返回真（此后每次都返回真，直到 reset）。只看 message_update 里的三种增量，别的事件不影响计数，
   * message_start 从头数。
   */
  feed(event: Record<string, any>): boolean {
    if (event.type === "message_start") {
      this.reset();
      return false;
    }
    if (event.type !== "message_update") return this.tripped();
    const inner = event.assistantMessageEvent;
    if (!inner || !DELTA_KINDS.has(inner.type) || typeof inner.delta !== "string" || inner.delta.length === 0) return this.tripped();
    if (inner.delta.trim() === "") {
      this.run += 1;
      this.chars += inner.delta.length;
    } else {
      this.reset();
    }
    return this.tripped();
  }

  private tripped(): boolean {
    return this.run >= RUN_LIMIT || this.chars >= CHARS_LIMIT;
  }
}
