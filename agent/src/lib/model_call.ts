/**
 * 工具里直接调一次模型（不经 pi 的运行循环）时共用的两样东西：记进 model_call 表的那一行的形状，
 * 以及从模型输出里取 JSON 的函数。现在只有「请求评审」的评审者用它们。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

/** 一次模型调用的记录，写进 model_call。 */
export interface ModelCallRecord {
  prompt: string;
  output: string;
  outcome: "采用" | "输出不合格" | "调用失败";
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * 从模型输出里取 JSON：先整段解析，不行就取第一个左花括号到最后一个右花括号之间那段。
 * 取不出来时抛异常，文字里的「模型」由调用方换成具体角色（例如评审者）。
 */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("模型的输出里没有 JSON 对象");
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error("模型的输出不是合法的 JSON");
    }
  }
}
