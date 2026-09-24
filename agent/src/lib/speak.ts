/**
 * 「说话」类工具的公共骨架：执行者的「回复」（tools/reply.ts）与用户 agent 的「回应」（sim/tools/respond.ts）
 * 共用这几样，不复制代码：
 *
 *   1. 读会话当前分支上最后一条助手消息，得到它的条目编号与这一轮的全部工具调用（lastAssistantTurn）；
 *   2. 同一轮里混入别的工具调用就拒绝（requireAlone）：说话类工具要单独调用，pi 才会在这一轮之后结束本次运行；
 *   3. 合格时返回 terminate: true 的工具结果（spoken），pi 不再请求模型；
 *   4. 两个小判断 isObject、isBlank。
 *
 * 拒绝一律抛异常，异常文字由 pi 交还模型重写。本模块不依赖 pi，也不读库。
 */

/** 同一轮助手消息里的一个工具调用。 */
export interface TurnCall {
  id: string;
  name: string;
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isBlank = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";

type Entry = { id: string; type: string; message?: { role?: string; content?: unknown } };

/** 会话当前分支上最后一条助手消息：返回它的条目编号与里面的全部工具调用。 */
export function lastAssistantTurn(branch: Entry[]): { entryId: string | null; calls: TurnCall[] } {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const content = Array.isArray(entry.message.content) ? entry.message.content : [];
      const calls = content
        .filter((part: any) => part?.type === "toolCall")
        .map((part: any) => ({ id: String(part.id), name: String(part.name) }));
      return { entryId: entry.id, calls };
    }
  }
  return { entryId: null, calls: [] };
}

/**
 * 核对「单独调用」：这一轮里除了这次调用之外还有别的工具调用时抛异常。
 * label 是这个工具在拒绝理由里的叫法（例如「回复」），toolName 是它的工具名（例如 reply）。
 */
export function requireAlone(label: string, toolName: string, toolCallId: string, callsThisTurn: TurnCall[]): void {
  const others = callsThisTurn.filter((call) => call.id !== toolCallId);
  if (others.length > 0) {
    throw new Error(
      `${label}必须单独调用，不能与其他工具同一轮。这一轮里除了${label}还调用了：${others.map((c) => c.name).join("、")}。` +
        `请先把那些工具调用完、看到结果之后，再在下一次单独调用 ${toolName}。这次${label}没有送达。`,
    );
  }
}

/** 说话类工具合格时的返回：给模型一句短话，details 给读取一侧，terminate 让 pi 在这一轮之后结束本次运行。 */
export function spoken(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details, terminate: true as const };
}
