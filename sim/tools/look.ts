/**
 * 「看界面」工具（look）：用户 agent 看一眼工作视图。等执行者停下来再返回两部分文字：
 * 执行者新说的话（上一次看之后出现的）与条目区现状；参数里给条目编号时，条目区只看这个条目的字段。
 * 给条目编号等于在界面上打开这个条目的详情：与前端一致，打开就记为已读（直接操作 mark_viewed，不通知执行者）。
 * 例外也与前端一致：业务说明里待核实的页打开时不记，要带 confirm 再看一次才记，相当于在那一页上点「确认待核实的 N 处」
 * （发的是同一个 mark_viewed 请求）。记不记由 lib/screen.ts 的 viewOnLook 定。
 * 不带编号时条目区后面另列助手画的图；给图的编号（diagram_id）等于在界面上打开这张图：取它的详情写成文字，并与前端一样记一次
 * 「看过这张图」（直接操作 mark_diagram_viewed，不通知执行者）。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { call, snapshotWhenIdle, state, taskPath } from "../lib/backend.ts";
import { type Diagram, type Message, renderDiagram, renderDiagrams, renderItems, renderLaunch, renderMessages, viewOnLook, viewOnLookDiagram } from "../lib/screen.ts";

export const LOOK_TOOL = "look";

export function registerLook(pi: ExtensionAPI): void {
  pi.registerTool({
    name: LOOK_TOOL,
    label: "看界面",
    description:
      "看一眼界面：助手新说了什么（带卡片的话会列出可以点的按钮），以及条目区里现在有哪些条目。" +
      "想看某个条目或某一页主题的具体内容，就在 item_id 里写它的编号（例如 UC-001、OA-002）。" +
      "一页主题上写着有几处是助手补的、等你确认时，你看了觉得对，就再看一次这一页并把 confirm 设为 true。" +
      "想看助手画的某一张图，就在 diagram_id 里写它的编号（例如 D-001）；item_id 与 diagram_id 一次只写一个。",
    promptSnippet: "看界面上助手新说的话与条目区；给 item_id 时看那个条目或那一页主题的内容；confirm 确认那一页上助手补的内容；给 diagram_id 时看那张图",
    parameters: Type.Object({
      item_id: Type.Optional(Type.String({ description: "想细看的条目或主题页的编号，例如 UC-001、OA-002；不写就只看条目清单。" })),
      confirm: Type.Optional(Type.Boolean({ description: "只在看一页主题时用：这一页上有助手补的内容等你确认，你看过觉得对，就设为 true。" })),
      diagram_id: Type.Optional(Type.String({ description: "想细看的图的编号，例如 D-001；写了它就不要写 item_id。" })),
    }),
    async execute(_toolCallId: string, params: { item_id?: string; confirm?: boolean; diagram_id?: string }) {
      if (params.item_id && params.diagram_id) throw new Error("这次看界面的形式不对：item_id 与 diagram_id 一次只写一个。要看条目与图，就分两次看。");
      const { snapshot, idle, waited } = await snapshotWhenIdle();
      const messages: Message[] = snapshot.conversation?.messages ?? [];
      const fresh = messages.filter((m) => m.message_id && !state.seen.has(m.message_id));
      // 只看某个条目或某张图时不算看过新消息，下一次不带编号看界面时照样列出来。
      const detailOnly = !!(params.item_id || params.diagram_id);
      if (!detailOnly) for (const m of fresh) state.seen.add(m.message_id!);
      const replies = messages.filter((m) => m.type === "assistant_reply");
      state.lastReply = replies.length ? replies[replies.length - 1] : null;
      state.lastTask = snapshot.task ?? null;
      const parts = [];
      if (!idle) parts.push(`（助手还在做事，已经等了 ${Math.round(waited / 1000)} 秒。）`);
      parts.push(detailOnly ? "" : renderMessages(fresh, snapshot.task));
      const confirm = params.confirm === true;
      let target: object | null = null;
      if (params.diagram_id) {
        // 打开一张图：详情接口给说明与 Mermaid 文本；看到了就记一次看过，修订号取用户看到的这一版。
        const { status, data } = await call("GET", taskPath(`/diagrams/${encodeURIComponent(params.diagram_id)}`));
        const detail: Diagram | null = status === 200 && data?.diagram && !data.diagram.deleted ? data.diagram : null;
        parts.push(renderDiagram(detail, params.diagram_id));
        target = viewOnLookDiagram(detail);
        if (target) {
          state.counter += 1;
          await call("POST", taskPath("/actions"), { client_id: `sim-${state.counter}`, kind: "mark_diagram_viewed", targets: [target], notify_executor: false });
        }
      } else {
        parts.push(renderItems(snapshot.task, params.item_id || undefined, confirm));
        if (!params.item_id) parts.push(renderDiagrams(snapshot.task));
        // 任务状况卡上的「开展一项活动」：看整个界面时列出来，可以在「回应」里选一项。
        if (!params.item_id) parts.push(renderLaunch(snapshot.task?.stage?.launch));
        target = params.item_id ? viewOnLook(snapshot.task, params.item_id, confirm) : null;
        if (target) {
          state.counter += 1;
          await call("POST", taskPath("/actions"), { client_id: `sim-${state.counter}`, kind: "mark_viewed", targets: [target] });
        }
      }
      const text = parts.filter(Boolean).join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        // marked：这一次有没有记已读或者看过这张图（待核实的主题页不带 confirm 时没有记）。
        details: { item_id: params.item_id ?? null, diagram_id: params.diagram_id ?? null, confirm, marked: target !== null, new_messages: fresh.map((m) => m.message_id), executor: snapshot.executor, text },
      };
    },
  });
}
