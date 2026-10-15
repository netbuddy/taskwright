/**
 * 「保存图」工具（save_diagram）：助手把一张图（图名、种类、Mermaid 文本、说明、来源）交给它，它存成这张图的一次新修订；
 * 也用它修改或删除一张已有的图。只在用户要求画图时用。图不是条目：不评审，不算进完成条件。
 *
 * 为什么是单独一个工具（工具数量受限，每加一个都要说清楚）：保存修订的操作单位是条目，有集合、字段、必填与指到字段的来源；
 * 图是任务的另一种要素，没有集合与字段，内容是一段 Mermaid 文本，保存前要先问任务服务校验写法，修订号也是图自己的。
 *
 * 本文件只做三件事：声明参数、调用 lib/save_diagram.ts 的核心函数、把结果转成 pi 要的返回形状。参数只做最宽的声明，
 * 逐项的核对在核心函数里做，好让不对的地方得到中文说明。只有 sources 在参数模式里标成了必填（可以是 null）：模型对必填的
 * 那几项守得比说明里的一句话牢，新画时就不容易漏写来源。必填在这里只是写给模型看的：pi 在调用执行函数之前拿参数模式核对参数，
 * 漏写必填的一项会被它用英文拦下，所以另给 prepareArguments（lib/save_diagram.ts 的 withSourcesKey），没有写这一项时补成 null，
 * 新画而没有写来源的仍由核心函数用中文拒绝并留痕，修改与删除照旧可以不写。校验由 lib/diagram_check.ts 去问任务服务；这一轮里图已经连续几次
 * 没有通过校验，从会话里数（lib/save_diagram.ts 的 consecutiveDiagramFailures）。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTOR_EXECUTOR } from "../lib/db.ts";
import { DIAGRAM_KINDS, DIAGRAM_KIND_NAMES } from "../lib/diagram.ts";
import { checkWithService } from "../lib/diagram_check.ts";
import { currentRun, requireUnderstanding } from "../lib/dialogue_acts.ts";
import { envKnowledgeRoot } from "../lib/knowledge.ts";
import { isUnderstandingGate, reportStopped, stopAtLimit } from "../lib/rejection_limit.ts";
import { SAVE_DIAGRAM_TOOL_NAME, type SaveDiagramParams, consecutiveDiagramFailures, saveDiagram, withSourcesKey } from "../lib/save_diagram.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";
import { userMessagesOnBranch } from "./save_revision.ts";
import { fillText } from "../lib/texts.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = SAVE_DIAGRAM_TOOL_NAME;

const KINDS_TEXT = DIAGRAM_KINDS.map((one) => `${one}（${DIAGRAM_KIND_NAMES[one]}）`).join("、");

const source = Type.Object(
  {
    kind: Type.String({ description: fillText("save_diagram.param.sources.kind") }),
    locator: Type.Optional(Type.String({ description: fillText("save_diagram.param.sources.locator") })),
    excerpt: Type.Optional(Type.String({ description: fillText("save_diagram.param.sources.excerpt") })),
  },
  { additionalProperties: true },
);

const parameters = Type.Object({
  diagram: Type.Optional(Type.String({ description: fillText("save_diagram.param.diagram") })),
  base_revision: Type.Optional(Type.Integer({ description: fillText("save_diagram.param.base_revision") })),
  name: Type.Optional(Type.String({ description: fillText("save_diagram.param.name") })),
  kind: Type.Optional(Type.String({ description: fillText("save_diagram.param.kind", { kinds: KINDS_TEXT }) })),
  mermaid: Type.Optional(Type.String({ description: fillText("save_diagram.param.mermaid") })),
  note: Type.Optional(Type.String({ description: fillText("save_diagram.param.note") })),
  sources: Type.Union([Type.Array(source), Type.Null()], {
    description: fillText("save_diagram.param.sources"),
  }),
  delete: Type.Optional(Type.Boolean({ description: fillText("save_diagram.param.delete") })),
});

export function registerSaveDiagram(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "保存图",
    description: fillText("save_diagram.description"),
    promptSnippet: fillText("save_diagram.snippet"),
    parameters,
    // 没有写 sources 这一项时补成 null：不让 pi 用英文拦下，交给核心函数去核对（见文件开头）。
    prepareArguments: (args) => withSourcesKey(args) as never,
    executionMode: "sequential",
    async execute(toolCallId: string, params: SaveDiagramParams, signal, _onUpdate, ctx: ExtensionContext) {
      // 对话理解：这一轮没有有效的理解就拒绝，与保存修订过同一道门。
      const branch = ctx.sessionManager.getBranch() as never;
      const run = currentRun(branch);
      const sessionId = ctx.sessionManager.getSessionId();
      const rejection = { workspaceDir: ctx.cwd, sessionId, callId: toolCallId, toolName: TOOL_NAME, workId: workIdOf(run?.userEntryId) };
      return withRejectionRecord(rejection, params, async () => {
        requireUnderstanding(ctx.cwd, sessionId, branch, "保存图", TOOL_NAME);
        let taskId = "";
        const outcome = await saveDiagram(
          { workspaceDir: ctx.cwd, sessionId, callId: toolCallId, actor: ACTOR_EXECUTOR, userMessages: userMessagesOnBranch(ctx), knowledgeRoot: envKnowledgeRoot() },
          params,
          {
            priorFailures: consecutiveDiagramFailures(branch),
            validate: (kind, mermaid) => checkWithService(ctx.cwd, taskId, kind, mermaid, { signal: signal ?? undefined }),
            onTask: (id) => { taskId = id; },
          },
        );
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      }).catch((error: unknown) => {
        // 因为没有合格的理解而被拒、而且这一轮连续被拒到上限：返回「出错并结束本次运行」的结果（lib/rejection_limit.ts）。
        const stopped = stopAtLimit(error, branch, isUnderstandingGate(error));
        if (!stopped) throw error;
        reportStopped(ctx.ui, TOOL_NAME, stopped);
        return stopped;
      });
    },
  });
}
