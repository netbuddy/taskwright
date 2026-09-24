/**
 * 「登记用户确认」工具（record_confirmation）：执行者认为用户在对话里接受了某几个条目时调用。
 *
 * 本文件只做编排：从会话当前分支读条目（同步读，在任何事务之外），调 lib/record_confirmation.ts 核对与装配提示，
 * 在执行函数里直接发起一次不带工具的模型调用扮演确认判读者（用启动配置里的同一个模型，干净上下文），
 * 输出不合格时重试一次，仍不合格就拒绝并说明；合格时写库，把判读结论与依据交还执行者。
 * 判读者的调用不经 pi 的运行循环，Langfuse 里看不到，所以每次调用的提示、原始输出、耗时与用量都记进 model_call。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BranchEntry,
  ConfirmationError,
  type ModelCallRecord,
  checkParams,
  parseJudgement,
  prepareJudgement,
  writeFailedModelCalls,
  writeJudgement,
} from "../lib/record_confirmation.ts";

export const TOOL_NAME = "record_confirmation";

/** 判读者一次调用最多等这么久。pi 不给工具设超时，这里自己兜底。 */
export const JUDGE_TIMEOUT_MS = 120_000;

/** 输出不合格时最多试几次（第一次加重试一次）。 */
export const JUDGE_ATTEMPTS = 2;

const parameters = Type.Object({
  items: Type.Optional(Type.Array(
    Type.Object(
      {
        item_id: Type.Optional(Type.String({ description: "条目编号，例如 UC-001。" })),
        version_no: Type.Optional(Type.Integer({ description: "条目的当前版本号，从 1 起；只能登记当前版本。" })),
      },
      { additionalProperties: true },
    ),
    { description: "用户在对话里接受了的条目，每项是 { item_id, version_no }，必须写。" },
  )),
});

export function registerRecordConfirmation(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "登记用户确认",
    description:
      "用户在对话里明确表示接受某几个条目的当前版本之后调用，把确认登记进库。" +
      "工具会把这几个条目这一版产生之后用户说过的原话交给一个独立的确认判读者去判，只有判读者判为接受的才算用户确认；" +
      "它会告诉你哪几条判为接受、哪几条没有、各自的依据。用户在界面上点的「确认」已经直接记下了，不用再登记。" +
      "这一版之后用户还没说过话、或者版本不是当前版本时，它会拒绝。",
    promptSnippet: "用户在对话里接受了某几个条目之后，登记用户确认（经独立的判读者判读用户原话）",
    parameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, signal, _onUpdate, ctx: ExtensionContext) {
      const call = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId };
      const requested = checkParams(params);
      const branch = ctx.sessionManager.getBranch() as BranchEntry[];
      const prepared = prepareJudgement(ctx.cwd, requested, branch);
      const model = ctx.model;
      if (!model) throw new ConfirmationError("现在没有可用的模型，判读者无法判读，什么都没有登记。");
      const modelName = `${model.provider}/${model.id}`;
      const prompt = JSON.stringify({ systemPrompt: prepared.system, messages: [{ role: "user", content: prepared.user }] });
      const calls: ModelCallRecord[] = [];
      let lastProblem = "";
      for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
        const started = Date.now();
        let output = "";
        let usage: { input?: number; output?: number } | undefined;
        try {
          const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
          const response = await ctx.modelRegistry.complete(model, {
            systemPrompt: prepared.system,
            messages: [{ role: "user" as const, timestamp: Date.now(), content: [{ type: "text" as const, text: prepared.user }] }],
          }, { sessionId: `judge-${toolCallId}-${attempt}`, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
          output = response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          usage = (response as { usage?: { input?: number; output?: number } }).usage;
          if ((response as { stopReason?: string }).stopReason === "error") throw new Error((response as { errorMessage?: string }).errorMessage ?? "模型服务报错");
        } catch (error) {
          calls.push({ prompt, output, outcome: "调用失败", model: modelName, durationMs: Date.now() - started, inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null });
          lastProblem = `判读者的模型调用失败了：${(error as Error).message}`;
          continue;
        }
        const record: ModelCallRecord = { prompt, output, outcome: "采用", model: modelName, durationMs: Date.now() - started,
          inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null };
        let verdicts;
        try {
          verdicts = parseJudgement(output, prepared);
        } catch (error) {
          if (!(error instanceof ConfirmationError)) throw error;
          calls.push({ ...record, outcome: "输出不合格" });
          lastProblem = error.message;
          continue;
        }
        calls.push(record);
        const outcome = writeJudgement(call, prepared, verdicts, calls);
        if ("changed" in outcome) {
          throw new ConfirmationError(`没有登记，因为${outcome.changed.join("；")}。请看过最新内容、等用户对新的一版表态之后再登记。`);
        }
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      }
      writeFailedModelCalls(call, prepared.taskId, calls);
      throw new ConfirmationError(`判读者试了 ${JUDGE_ATTEMPTS} 次都没有给出合格的判读，什么都没有登记。最后一次的问题是：${lastProblem}`);
    },
  });
}
