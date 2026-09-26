/**
 * 「保存修订」工具：执行者把一批按条目的操作（新增、修改、删除）交给它，它把这批操作存成整份交付物的
 * 一次新修订。它只存不评审，也不代表任务完成。
 *
 * 本文件只做三件事：声明参数、调用 lib/save_revision.ts 里的核心函数、把结果转成 pi 要的返回形状。
 * 参数的形状这里只做最宽的声明，逐项的核对都在核心函数里做，好让不对的地方得到逐条的中文说明，
 * 而不是 pi 的一句英文的参数校验失败。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "../lib/create_task.ts";
import { ACTOR_EXECUTOR } from "../lib/db.ts";
import { saveRevision } from "../lib/save_revision.ts";
import { currentRun, requireUnderstanding } from "../lib/dialogue_acts.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";

/** 工具名。模型调用时写的就是它，`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "save_revision";

const support = Type.Object(
  {
    field: Type.String({ description: "这条来源支持的字段名，必须是这个集合声明的字段。" }),
    index: Type.Optional(
      Type.Integer({ description: "列表型字段（文本列表、条目引用）里的第几项，从 0 起。不写表示支持整个字段。" }),
    ),
  },
  { additionalProperties: true },
);

const source = Type.Object(
  {
    kind: Type.String({ description: "来源的种类，只能是「文档原文」「用户的话」「执行者补充」「领域说明」四者之一。" }),
    locator: Type.Optional(
      Type.String({
        description: "出处：文档原文写文件路径；执行者补充写「执行者补充」；领域说明写那条领域说明的条目编号，例如 DN-002。种类是「用户的话」时不要写，工具会在对话里找到那句话并代填。",
      }),
    ),
    excerpt: Type.String({ description: "摘录的原文。用户的话要逐字照抄用户说过的一段原话；领域说明要逐字照抄那条说明的标题或内容里的一段，包括标点。" }),
    normalized_value: Type.Optional(
      Type.String({
        description:
          "只用于种类为「用户的话」的来源：你写进字段的值与用户原话不同时（例如原话是「应该是三十天吧」，写入的是「30 天」），" +
          "在这里写写入的值。摘录仍要逐字照抄原话。写入的值与原话相同就不写。",
      }),
    ),
    supports: Type.Optional(
      Type.Array(support, {
        description:
          "这条来源支持哪几处：每项写一个字段名，列表型字段还可以写 index 指到其中一项。" +
          "这条来源支持整个条目时不写或写 []。",
      }),
    ),
  },
  { additionalProperties: true },
);

const operation = Type.Object(
  {
    op: Type.String({ description: "操作的种类：add 是新增一个条目，update 是修改一个条目，delete 是删除一个条目。" }),
    collection: Type.Optional(Type.String({ description: "新增时写条目所属的集合名，例如「功能用例」。修改与删除时不写。" })),
    item: Type.Optional(Type.String({ description: "修改与删除时写条目编号，例如 UC-001。新增时不写，编号由工具生成。" })),
    base_revision: Type.Optional(
      Type.Integer({
        description:
          "修改与删除时必须写：你所见的这个条目当前所在的修订号（返回与通知里「UC-001 现在是修订 N」的那个 N）。" +
          "与库里的不符时整批拒绝，说明是谁把它改到了哪次修订。新增时不写。",
      }),
    ),
    fields: Type.Optional(
      Type.Object({}, {
        additionalProperties: true,
        description:
          "字段内容，键是任务定义里声明的字段名。新增时写全部必填字段；修改时只写要改的字段。" +
          "文本写字符串，文本列表写字符串数组，枚举写取值之一，条目引用写条目编号的数组（例如 [\"UC-001\"]，可以是空数组），每个编号都要指向已有且没有删除的条目。",
      }),
    ),
    sources: Type.Optional(
      Type.Array(source, {
        description: "这个条目的来源，至少一条。新增时必须给；修改时省略就沿用它当前的全部来源；给了就只替换这次改到的字段上的来源，没改的字段的来源沿用（只给 sources、不改字段时整体替换）。",
      }),
    ),
  },
  { additionalProperties: true },
);

const parameters = Type.Object({
  operations: Type.Array(operation, {
    description: "这次要保存的操作列表，至少一个。整批操作一起形成一次修订；有一个不对，整批都不写入。",
  }),
});

/**
 * 当前会话分支上的全部用户消息（pi 的 user 角色），按先后排。扩展追加的自定义消息（custom_message）
 * 条目类型不同，不在其中。读会话是同步的内存读取，在调用核心函数之前做，核心函数的事务里不读会话。
 */
export function userMessagesOnBranch(ctx: ExtensionContext): UserMessage[] {
  const out: UserMessage[] = [];
  for (const entry of ctx.sessionManager.getBranch() as Array<{ id: string; type: string; message?: any }>) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : (Array.isArray(content) ? content : []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
    out.push({ entryId: entry.id, text });
  }
  return out;
}

export function registerSaveRevision(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "保存修订",
    description:
      "把交付物的一批改动存成一次新修订。改动的单位是条目：新增一个条目、修改某个条目的某几个字段、删除一个条目；" +
      "一次调用可以带多个操作，整批只产生一次修订。条目编号由工具生成。每个新增的条目至少带一条来源。" +
      "修改与删除时要写 base_revision（你所见的这个条目当前所在的修订号）。" +
      "它只核对集合、字段、类型、必填与来源是否齐全，不评判内容好坏，也不代表任务完成。" +
      "有任何一个操作不对，整批都不写入，它会逐条告诉你哪个操作的哪一处不对。",
    promptSnippet: "把交付物的一批按条目的改动存成一次新修订",
    parameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: { operations: unknown }, _signal, _onUpdate, ctx: ExtensionContext) {
      // 对话理解：这一轮没有有效的理解就拒绝；修订记下是因用户哪一项对话行为而做（intentEntry）。
      const branch = ctx.sessionManager.getBranch() as never;
      const run = currentRun(branch);
      // 被拒时把拒绝记进 tool_rejection 表（lib/tool_rejection.ts），拒绝文字照样交还模型。
      const rejection = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId, toolName: TOOL_NAME, workId: workIdOf(run?.userEntryId) };
      return withRejectionRecord(rejection, params, () => {
        requireUnderstanding(ctx.cwd, ctx.sessionManager.getSessionId(), branch, "保存修订", TOOL_NAME);
        const outcome = saveRevision(
          {
            workspaceDir: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            callId: toolCallId,
            actor: ACTOR_EXECUTOR,
            userMessages: userMessagesOnBranch(ctx),
            intentEntry: run?.userEntryId ?? null,
          },
          params,
        );
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      });
    },
  });
}
