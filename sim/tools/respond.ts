/**
 * 「回应」工具（respond）：用户 agent 说一句话、点一个按钮，或者表示目标达成（done）、放弃（give_up，配 reason）。
 * 合格时发给后端（说话与卡片按钮走 messages，「确认」走 actions 并带 notify_executor），然后返回 terminate，
 * 结束用户 agent 的这一次运行；同一轮混入别的工具调用即拒绝。骨架引用 agent/src/lib/speak.ts。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lastAssistantTurn, requireAlone, spoken } from "../../agent/src/lib/speak.ts";
import { call, state, taskPath } from "../lib/backend.ts";
import { type RespondParams, planRespond } from "../lib/screen.ts";

export const RESPOND_TOOL = "respond";

export function registerRespond(pi: ExtensionAPI): void {
  pi.registerTool({
    name: RESPOND_TOOL,
    label: "回应",
    description:
      "回应助手：text 是你要说的一句话；click 是点卡片上的一个按钮（按钮名照「看界面」列出的写）；" +
      "你的目标达成了就把 done 设为 true，不想再继续了就把 give_up 设为 true 并在 reason 里说一句为什么。" +
      "这是你这一次的最后一步，要单独调用，调用之后不要再做别的。",
    promptSnippet: "回应助手：说一句话、点一个按钮、表示完成或放弃；单独调用，是这一次的最后一步",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "你要对助手说的一句话。" })),
      click: Type.Optional(Type.String({ description: "要点的按钮，照「看界面」列出的写，例如 确认、不对、采纳、换一个、就这样做、不要、先不管这条、我不知道，你按常识补，或者选项的编号。" })),
      done: Type.Optional(Type.Boolean({ description: "你想要的东西已经拿到了，就设为 true。" })),
      give_up: Type.Optional(Type.Boolean({ description: "你不想再继续了，就设为 true，并写 reason。" })),
      reason: Type.Optional(Type.String({ description: "放弃的原因，一句话。" })),
    }),
    executionMode: "sequential",
    async execute(toolCallId: string, params: RespondParams, _signal, _onUpdate, ctx: ExtensionContext) {
      const turn = lastAssistantTurn(ctx.sessionManager.getBranch() as Parameters<typeof lastAssistantTurn>[0]);
      requireAlone("回应", RESPOND_TOOL, toolCallId, turn.calls);
      state.counter += 1;
      const plan = planRespond(params, state.lastReply, `sim-${state.counter}`, state.lastTask);
      let response: unknown = null;
      if (plan.kind !== "none") {
        const path = plan.kind === "action" ? "/actions" : "/messages";
        const { status, data } = await call("POST", taskPath(path), plan.body);
        if (status !== 200) {
          throw new Error(`界面提示：${data?.error?.message ?? `请求失败（${status}）`}。这次回应没有发出去，可以先看看界面再回应。`);
        }
        response = data;
      }
      return spoken("已经发出去了", {
        sent: plan.kind === "none" ? null : plan.body,
        route: plan.kind,
        done: params.done === true,
        give_up: params.give_up === true,
        reason: params.reason ?? null,
        response,
      });
    },
  });
}
