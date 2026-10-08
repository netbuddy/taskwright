/**
 * 「保存图」工具（save_diagram）：助手把一张图（图名、种类、Mermaid 文本、说明、来源）交给它，它存成这张图的一次新修订；
 * 也用它修改或删除一张已有的图。只在用户要求画图时用。图不是条目：不评审，不算进完成条件。
 *
 * 为什么是单独一个工具（工具数量受限，每加一个都要说清楚）：保存修订的操作单位是条目，有集合、字段、必填与指到字段的来源；
 * 图是任务的另一种要素，没有集合与字段，内容是一段 Mermaid 文本，保存前要先问任务服务校验写法，修订号也是图自己的。
 *
 * 本文件只做三件事：声明参数、调用 lib/save_diagram.ts 的核心函数、把结果转成 pi 要的返回形状。参数只做最宽的声明，
 * 逐项的核对在核心函数里做，好让不对的地方得到中文说明。校验由 lib/diagram_check.ts 去问任务服务；这一轮里图已经连续几次
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
import { SAVE_DIAGRAM_TOOL_NAME, type SaveDiagramParams, consecutiveDiagramFailures, saveDiagram } from "../lib/save_diagram.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";
import { userMessagesOnBranch } from "./save_revision.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = SAVE_DIAGRAM_TOOL_NAME;

const KINDS_TEXT = DIAGRAM_KINDS.map((one) => `${one}（${DIAGRAM_KIND_NAMES[one]}）`).join("、");

const source = Type.Object(
  {
    kind: Type.String({ description: "来源的种类，只能是「文档原文」「用户的话」「助手补充」「条目」四者之一。" }),
    locator: Type.Optional(Type.String({ description: "出处：文档原文写文件路径；条目写条目编号。种类是「用户的话」「助手补充」时不写。" })),
    excerpt: Type.Optional(Type.String({ description: "摘录的原文：用户的话逐字照抄；助手补充在这里写理由。种类是「条目」时可以不写。" })),
  },
  { additionalProperties: true },
);

const parameters = Type.Object({
  diagram: Type.Optional(Type.String({ description: "修改或删除一张已有的图时写它的编号，例如 D-001。新画一张图时不写，编号由工具生成。" })),
  base_revision: Type.Optional(Type.Integer({ description: "修改或删除时写你所见的这张图现在的修订号（图自己的修订号）。新画时不写。" })),
  name: Type.Optional(Type.String({ description: "图名，一行字。新画时必填。" })),
  kind: Type.Optional(Type.String({ description: `图的种类，只能是 ${KINDS_TEXT} 之一。新画时必填。用例图用流程图的写法画。` })),
  mermaid: Type.Optional(Type.String({ description: "Mermaid 文本。新画时必填。图里的节点画的是某个条目时，把条目编号写在节点的文字里，例如 r1([\"REQ-001 提交申请\"])。" })),
  note: Type.Optional(Type.String({ description: "一两句说明：这张图画的是什么。可以不写。" })),
  sources: Type.Optional(Type.Array(source, {
    description: "这张图的来源，新画时至少一条：用户要你画图的那句话写一条「用户的话」，画进图里的每个条目各写一条种类为「条目」的来源（出处写条目编号）。" +
      "不写 supports。修改时不写就沿用原来的，写了就是整份替换。",
  })),
  delete: Type.Optional(Type.Boolean({ description: "删除这张图时写 true，同时写 diagram 与 base_revision，别的都不写。" })),
});

export function registerSaveDiagram(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "保存图",
    description:
      "保存一张图：新画一张、修改一张已有的图，或者删除一张图。只在用户要求画图时用。" +
      "图用 Mermaid 文本写，种类是用例图（use_case，用流程图的写法画）、类图（class）、状态图（state）、时序图（sequence）、流程图（flowchart）之一。" +
      "保存前系统校验 Mermaid 文本的写法，不对就不保存，并告诉你第几行附近错在哪里。" +
      "图的编号由工具生成（D-001 这样）；修改与删除时写图的编号与 base_revision。" +
      "图里画了某个条目时，把条目编号写在节点的文字里，并给它写一条种类为「条目」的来源。" +
      "图不是条目：不评审，不算进完成条件。",
    promptSnippet: "保存一张图（新画、修改或删除），保存前校验 Mermaid 文本",
    parameters,
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
