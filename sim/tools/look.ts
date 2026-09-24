/**
 * 「看界面」工具（look）：用户 agent 看一眼工作视图。等执行者停下来再返回两部分文字：
 * 执行者新说的话（上一次看之后出现的）与条目区现状；参数里给条目编号时，条目区只看这个条目的字段。
 * 给条目编号等于在界面上打开这个条目的详情：与前端一致，打开就记为已读（直接操作 mark_viewed，不通知执行者）。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { call, snapshotWhenIdle, state, taskPath } from "../lib/backend.ts";
import { type Message, renderItems, renderMessages } from "../lib/screen.ts";

export const LOOK_TOOL = "look";

export function registerLook(pi: ExtensionAPI): void {
  pi.registerTool({
    name: LOOK_TOOL,
    label: "看界面",
    description:
      "看一眼界面：助手新说了什么（带卡片的话会列出可以点的按钮），以及条目区里现在有哪些条目。" +
      "想看某个条目的具体内容，就在 item_id 里写它的编号（例如 UC-001）。",
    promptSnippet: "看界面上助手新说的话与条目区；给 item_id 时看那个条目的内容",
    parameters: Type.Object({
      item_id: Type.Optional(Type.String({ description: "想细看的条目编号，例如 UC-001；不写就只看条目清单。" })),
    }),
    async execute(_toolCallId: string, params: { item_id?: string }) {
      const { snapshot, idle, waited } = await snapshotWhenIdle();
      const messages: Message[] = snapshot.conversation?.messages ?? [];
      const fresh = messages.filter((m) => m.message_id && !state.seen.has(m.message_id));
      // 只看某个条目时不算看过新消息，下一次不带编号看界面时照样列出来。
      if (!params.item_id) for (const m of fresh) state.seen.add(m.message_id!);
      const replies = messages.filter((m) => m.type === "assistant_reply");
      state.lastReply = replies.length ? replies[replies.length - 1] : null;
      state.lastTask = snapshot.task ?? null;
      const parts = [];
      if (!idle) parts.push(`（助手还在做事，已经等了 ${Math.round(waited / 1000)} 秒。）`);
      parts.push(params.item_id ? "" : renderMessages(fresh, snapshot.task));
      parts.push(renderItems(snapshot.task, params.item_id || undefined));
      const opened = params.item_id ? snapshot.task?.items?.find((i: { item_id: string }) => i.item_id === params.item_id) : null;
      if (opened) {
        state.counter += 1;
        await call("POST", taskPath("/actions"), { client_id: `sim-${state.counter}`, kind: "mark_viewed",
          targets: [{ item_id: opened.item_id, base_revision: opened.revision_no }] });
      }
      const text = parts.filter(Boolean).join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { item_id: params.item_id ?? null, new_messages: fresh.map((m) => m.message_id), executor: snapshot.executor, text },
      };
    },
  });
}
