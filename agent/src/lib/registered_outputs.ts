/**
 * 登记表：这一轮期待执行者写出的结构化输出，每一种一项（接口见 lib/structured_outputs.ts 的 StructuredOutput）。
 *
 * 今天只登记一种：理解（lib/dialogue_acts.ts 的 USER_INTENT_OUTPUT，schema 为 agent/prompts/schemas/user_intent.schema.json）。
 * 以后对话里要执行者写别的结构化输出时，在这里加一项即可，识别代码不用改；加的那一种的 schema 也要发给执行者，
 * 发出去的格式说明与这里用来匹配的 schema 必须是同一个文件（照 scripts/render-intent-schema.mjs 的做法从它生成）。
 * 顺序就是匹配的顺序：一个片段按这个顺序逐个校验，第一种完整通过的就是它。
 */

import { USER_INTENT_OUTPUT } from "./dialogue_acts.ts";
import type { StructuredOutput } from "./structured_outputs.ts";

export const REGISTERED_OUTPUTS: readonly StructuredOutput[] = [USER_INTENT_OUTPUT];
