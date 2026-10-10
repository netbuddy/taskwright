/**
 * 用户 agent 眼里的界面：把后端整份数据里的对话与条目区，写成一个坐在工作视图前的人看到的文字；
 * 以及把「回应」的参数翻成对后端的一次请求。纯函数，不依赖 pi，也不发请求，单元测试直接调用。
 *
 * 看到什么：执行者新说的话（回复的告知、主行为、成文正文，以及可以点的按钮）、
 * 条目区现状（各集合条目数、每个条目的编号与标题；给编号时看这个条目的字段）。不给完成条件、材料原文、条目改动过的修订。
 * 总体分析这个集合在条目区里写成提纲：每页一行，写标题、标签，以及这一页现在的样子用户看没看过、有没有助手补的内容等着确认。
 */

export interface Act {
  kind: "ask" | "confirm" | "suggest" | "choose" | "propose";
  text: string;
  items?: { item_id: string; revision_no: number }[];
  options?: { key: string; text: string }[];
  value?: string;
  basis?: { kind: string; locator: string; excerpt: string }[];
  preview?: { effect: string; text: string }[];
  /** 只有提问、给建议值、提议可以写，取值只有 general：与任何条目都无关，这时没有 items。界面上只是不列涉及的条目。 */
  scope?: "general";
}

export interface Message {
  type: string;
  message_id: string | null;
  text?: string;
  /** 告知：后端交来的是 { text, items }；旧的记录里可能是一句纯文字。 */
  informs?: (string | { text: string; items?: { item_id: string }[] })[];
  act?: Act | null;
  via_reply_tool?: boolean;
  /** 连续被拒到上限后放行的纯文字回复：界面照普通文字显示，加一行说明，不画卡片（与前端工作视图一致）。 */
  degraded?: boolean;
}

/** 这条回复在界面上有没有卡片：degraded 的回复即使带着 act 也不画。 */
export function cardOf(m: Message | null | undefined): Act | null {
  return m && !m.degraded ? m.act ?? null : null;
}

/** 界面上「标为先不管」要写的那个枚举取值；前端按它认出问题条目一类的集合（web 的 keepPendingField）。 */
export const KEEP_PENDING_VALUE = "用户决定保留";
export const DONT_KNOW = "我不知道，你按常识补";

/** 这个集合有没有取值里带「用户决定保留」的枚举字段，也就是能不能「标为先不管」。 */
function keepable(task: TaskView | null | undefined, itemId: string): boolean {
  const item = task?.items.find((i) => i.item_id === itemId);
  const collection = item && task!.definition.collections.find((c) => c.name === item.collection);
  return !!collection?.fields.some((f) => f.type === "枚举" && (f.values ?? []).includes(KEEP_PENDING_VALUE));
}

/** 提问卡片上「先不管」按钮对应的条目：卡片挂着条目（不是 scope general）时，其中能标为先不管的那些。 */
function keepTargets(act: Act, task: TaskView | null | undefined): string[] {
  if (act.kind !== "ask" || act.scope === "general" || !act.items?.length) return [];
  return act.items.map((i) => i.item_id).filter((id) => keepable(task, id));
}

/** 「先不管」按钮的名字：只有一条时叫「先不管这条」，多条时每条一个「先不管 编号」（与前端一致）。 */
function keepButtons(act: Act, task: TaskView | null | undefined): Map<string, string> {
  const ids = keepTargets(act, task);
  return new Map(ids.map((id) => [ids.length === 1 ? "先不管这条" : `先不管 ${id}`, id]));
}

/**
 * 每种卡片可以点的按钮，与前端工作视图一致。choose 的按钮就是各选项的 key。
 * 提问挂在条目上（不是 scope general、items 不为空）时有两类按钮：能标为先不管的条目各一个「先不管」，
 * 再加一个「我不知道，你按常识补」；判断「能不能标为先不管」要看任务定义，所以要传条目区的数据。
 */
export function buttonsOf(act: Act | null | undefined, task?: TaskView | null): string[] {
  if (!act) return [];
  if (act.kind === "confirm") return [SEEN, "不对"];
  if (act.kind === "choose") return (act.options ?? []).map((o) => o.key);
  if (act.kind === "suggest") return ["采纳", "换一个"];
  if (act.kind === "propose") return ["就这样做", "不要"];
  if (act.kind === "ask" && act.scope !== "general" && act.items?.length) return [...keepButtons(act, task).keys(), DONT_KNOW];
  return [];
}

/** 「请确认」卡片上的按钮：点一次把卡片点名的条目标为已读（已读就算确认）。 */
export const SEEN = "这几条都看过了";

const KIND_WORD: Record<string, string> = { ask: "提问", confirm: "请确认", suggest: "建议", choose: "请选择", propose: "提议" };
const EFFECT_WORD: Record<string, string> = { remove: "去掉", add: "加上", change: "改动" };

/** 一条执行者的回复写成用户看到的样子。 */
export function renderReply(m: Message, task?: TaskView | null): string {
  const lines: string[] = [];
  if (m.degraded) return [`（界面注明：这条回复没有按结构发出。）`, `助手说：${m.text ?? ""}`].join("\n");
  const act = cardOf(m);
  // 与网页一致：有卡片时告知逐条列出，点名的条目跟在后面；没有卡片时只有正文，正文下方一行「提到的条目」。
  const informs = (m.informs ?? []).map((one) => (typeof one === "string" ? { text: one, items: [] } : { text: one.text, items: one.items ?? [] }));
  const ids = (list: typeof informs) => [...new Set(list.flatMap((one) => one.items.map((i) => i.item_id)))];
  if (act) for (const one of informs) lines.push(`助手告诉你：${one.text}` + (one.items.length ? `（${ids([one]).join("、")}）` : ""));
  lines.push(`助手说：${m.text ?? ""}`);
  if (!act && ids(informs).length) lines.push(`提到的条目：${ids(informs).join("、")}`);
  if (act) {
    lines.push(`【卡片：${KIND_WORD[act.kind] ?? act.kind}】${act.text}`);
    if (act.items?.length) lines.push(`涉及的条目：${act.items.map((i) => `${i.item_id}（修订 ${i.revision_no}）`).join("、")}`);
    if (act.kind === "choose") for (const o of act.options ?? []) lines.push(`选项 ${o.key}：${o.text}`);
    if (act.kind === "suggest") {
      lines.push(`建议的值：${act.value ?? ""}`);
      for (const b of act.basis ?? []) lines.push(`依据（${b.kind}）：${b.excerpt}`);
    }
    if (act.kind === "propose") for (const p of act.preview ?? []) lines.push(`这样做会${EFFECT_WORD[p.effect] ?? p.effect}：${p.text}`);
    const buttons = buttonsOf(act, task);
    lines.push(buttons.length ? `可以点：${buttons.join("／")}（也可以直接回一句话）` : "这张卡片没有按钮，直接回一句话。");
  }
  return lines.join("\n");
}

/** 对话里的新消息（上一次看界面之后出现的）写成文字；自己说的话不再复述。 */
export function renderMessages(messages: Message[], task?: TaskView | null): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.type === "assistant_reply") parts.push(renderReply(m, task));
    else if (m.type === "system_note") parts.push(`系统说明：${m.text ?? ""}`);
    else if (m.type === "ui_action_noted") parts.push(`界面记下了你刚才的操作：${m.text ?? ""}`);
  }
  return parts.length ? parts.join("\n\n") : "（助手这次没有说新的话。）";
}

export interface Item {
  item_id: string;
  collection: string;
  title: string;
  /** 条目当前所在的修订号。 */
  revision_no: number;
  fields: Record<string, unknown>;
  /** 确认标记，按记下的先后；basis 是依据：viewed（已读）、ui_click、ui_edit（用户亲手改）、user_words。 */
  confirmations?: { revision_no: number; accepted: boolean; basis?: string }[];
  /** 条目在任何一次修订上有过接受的确认标记；没有就是未读。 */
  viewed?: boolean;
  /** 待核实：当前修订上有助手补充的内容，而用户还没有确认过。 */
  pending_verification?: boolean;
  /** 还待核实的助手补充来源有几条。 */
  pending_sources?: number;
  /** 还待核实的各处：字段与（列表字段的）第几项，从 0 起；field 为 null 指整个条目。 */
  pending_places?: { field: string | null; index: number | null }[];
}

/** 总体分析这个集合的名字与它的几个字段名，与 agent/src/lib/overall_analysis.ts 一致。 */
export const OVERALL = "总体分析";
const TAGS_FIELD = "标签";
const STATUS_FIELD = "状态";
const DEPRECATED = "已废弃";

/** 一页待不待核实、有几处：与网页的 pendingCount（web/src/model/overall.ts）同一个算法。 */
export function pendingCount(item: Item): number {
  return item.pending_verification ? Math.max(1, item.pending_sources ?? 1) : 0;
}

/**
 * 一页现在这一版用户看没看过：它当前所在的修订上，依据不是用户亲手改的确认标记里，最近一条是接受。
 * 用户 agent 不会亲手改字段，所以这与产品里「用户看过」的判法（从最近一次助手保存起的那一段修订）结果相同。
 */
export function viewedNow(item: Item): boolean {
  const marks = (item.confirmations ?? []).filter((c) => c.revision_no === item.revision_no && c.basis !== "ui_edit");
  return marks.length > 0 && marks[marks.length - 1].accepted;
}

/** 提纲里一页的那一行：编号、标题、标签，以及四种状态之一。 */
function outlineLine(item: Item): string {
  const tags = Array.isArray(item.fields[TAGS_FIELD]) ? (item.fields[TAGS_FIELD] as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
  const head = `${item.item_id}「${item.title}」${tags.length ? `〔${tags.join("、")}〕` : ""}`;
  if (item.fields[STATUS_FIELD] === DEPRECATED) return `${head}：已废弃`;
  const pending = pendingCount(item);
  if (pending) return `${head}：有 ${pending} 处是助手补的，等你确认`;
  return `${head}：${viewedNow(item) ? "你看过现在这一版了" : "你还没看过现在这一版"}`;
}

export interface TaskView {
  definition: { collections: { name: string; fields: { name: string; type?: string; values?: string[] | null }[] }[] };
  items: Item[];
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map((v, i) => `${i + 1}. ${v}`).join("；") : "（空）";
  if (value === undefined || value === null || value === "") return "（空）";
  return String(value);
}

/** 条目区：各集合几个条目、每个条目的编号与标题；给了编号就只看这一个条目的字段。 */
export function renderItems(task: TaskView | null, itemId?: string): string {
  if (!task) return "条目区：还没有任务。";
  if (itemId) {
    const item = task.items.find((i) => i.item_id === itemId);
    if (!item) return `条目区里没有 ${itemId}。`;
    const declared = task.definition.collections.find((c) => c.name === item.collection)?.fields.map((f) => f.name) ?? Object.keys(item.fields);
    // 打开一个条目看它现在的内容就算看过（已读），「看界面」带条目编号时工具会替你记下。
    const mark = "（你正在看它现在的内容，看过就算确认）";
    return [`${item.item_id}「${item.title}」，集合「${item.collection}」，修订 ${item.revision_no}${mark}：`,
      ...declared.map((name) => `  ${name}：${valueText(item.fields[name])}`)].join("\n");
  }
  const lines = ["条目区："];
  for (const c of task.definition.collections) {
    const items = task.items.filter((i) => i.collection === c.name);
    if (c.name === OVERALL) {
      // 总体分析写成提纲：一页一行，让人知道有哪些页可以看、哪一页还等着确认。
      lines.push(`  ${c.name} ${items.length} 页${items.length ? "：" : ""}`);
      for (const item of items) lines.push(`    ${outlineLine(item)}`);
      continue;
    }
    lines.push(`  ${c.name} ${items.length} 个${items.length ? "：" + items.map((i) => `${i.item_id}「${i.title}」${i.viewed === false ? "（未读）" : ""}`).join("、") : ""}`);
  }
  return lines.join("\n");
}

/** 「回应」的参数。 */
export interface RespondParams {
  text?: string;
  click?: string;
  done?: boolean;
  give_up?: boolean;
  reason?: string;
}

/** 一次回应要发给后端的请求：说话、直接操作，或者什么都不发（只表示结束或放弃）。 */
export type Plan =
  | { kind: "message"; body: Record<string, unknown> }
  | { kind: "action"; body: Record<string, unknown> }
  | { kind: "none" };

const CLICK_TEXT: Record<string, string> = { 不对: "这个不对。", 采纳: "我采纳这个建议。", 换一个: "请换一个建议。", 就这样做: "就这样做。", 不要: "不要这样做。" };

/**
 * 按接口约定（docs/api.md「卡片上的按钮」）把一次回应翻成请求：「这几条都看过了」走 actions 的 mark_viewed（带 notify_executor），其余按钮走 messages 带 card，
 * 话用第 7 节的模板；说话走 messages。形式不对时抛异常，写明哪里不对。
 */
export function planRespond(params: RespondParams, lastReply: Message | null, clientId: string, task?: TaskView | null): Plan {
  const p = params ?? {};
  const text = typeof p.text === "string" ? p.text.trim() : "";
  const click = typeof p.click === "string" ? p.click.trim() : "";
  const errors: string[] = [];
  if (p.done && p.give_up) errors.push("done 与 give_up 不能同时为真");
  if (p.give_up && (typeof p.reason !== "string" || !p.reason.trim())) errors.push("give_up 要配一句 reason，说明为什么放弃");
  if (!text && !click && !p.done && !p.give_up) errors.push("要么写 text 说一句话，要么写 click 点一个按钮，要么用 done 或 give_up 结束");
  const act = cardOf(lastReply);
  if (click) {
    const buttons = buttonsOf(act, task);
    if (!buttons.length) errors.push("助手最近一条话没有可以点的按钮，请用 text 直接说");
    else if (!buttons.includes(click)) errors.push(`没有「${click}」这个按钮，可以点的是：${buttons.join("／")}`);
    if (text && click !== "不对") errors.push("点这个按钮时不要同时写 text；要说话就另外回一次");
  }
  if (errors.length) throw new Error(`这次回应的形式不对，没有发出去：${errors.join("；")}。`);
  if (click && act) {
    if (click === SEEN) {
      return { kind: "action", body: { client_id: clientId, kind: "mark_viewed", notify_executor: true,
        targets: (act.items ?? []).map((i) => ({ item_id: i.item_id, base_revision: i.revision_no })) } };
    }
    const keep = keepButtons(act, task).get(click);
    if (keep) {
      // 与前端一致：直接操作 keep_pending，带通知；修订号取卡片上写的，没写就取条目区里它当前所在的修订。
      const base = act.items?.find((i) => i.item_id === keep)?.revision_no ?? task?.items.find((i) => i.item_id === keep)?.revision_no;
      return { kind: "action", body: { client_id: clientId, kind: "keep_pending", notify_executor: true, targets: [{ item_id: keep, base_revision: base }] } };
    }
    if (click === DONT_KNOW) {
      const ids = (act.items ?? []).map((i) => i.item_id).join("、");
      return { kind: "message", body: { text: `关于 ${ids}，我不知道，你按常识补上并标明是你补的。`, client_id: clientId, origin: "card_choice",
        card: { reply_message_id: lastReply?.message_id ?? null, kind: act.kind, choice: "不知道" } } };
    }
    const option = act.kind === "choose" ? act.options?.find((o) => o.key === click) : undefined;
    const said = option ? `我选：${option.text}` : click === "不对" && text ? text : CLICK_TEXT[click];
    return { kind: "message", body: { text: said, client_id: clientId, origin: "card_choice",
      card: { reply_message_id: lastReply?.message_id ?? null, kind: act.kind, choice: click } } };
  }
  if (text) return { kind: "message", body: { text, client_id: clientId } };
  return { kind: "none" };
}
