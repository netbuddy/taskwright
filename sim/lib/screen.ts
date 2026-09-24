/**
 * 用户 agent 眼里的界面：把后端整份数据里的对话与条目区，写成一个坐在工作视图前的人看到的文字；
 * 以及把「回应」的参数翻成对后端的一次请求。纯函数，不依赖 pi，也不发请求，单元测试直接调用。
 *
 * 看到什么：执行者新说的话（回复的告知、主行为、成文正文，以及可以点的按钮）、
 * 条目区现状（各集合条目数、每个条目的编号与标题；给编号时看这个条目的字段）。不给完成条件、材料原文、版本历史。
 */

export interface Act {
  kind: "ask" | "confirm" | "suggest" | "choose" | "propose";
  text: string;
  items?: { item_id: string; version_no: number }[];
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
  informs?: string[];
  act?: Act | null;
  via_reply_tool?: boolean;
  /** 连续被拒到上限后放行的纯文字回复：界面照普通文字显示，加一行说明，不画卡片（与前端工作视图一致）。 */
  degraded?: boolean;
}

/** 这条回复在界面上有没有卡片：degraded 的回复即使带着 act 也不画。 */
export function cardOf(m: Message | null | undefined): Act | null {
  return m && !m.degraded ? m.act ?? null : null;
}

/** 界面上「标为先不管」要写的那个枚举取值；前端按它认出待定事项一类的集合（web 的 keepPendingField）。 */
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
  if (act.kind === "confirm") return ["确认", "不对"];
  if (act.kind === "choose") return (act.options ?? []).map((o) => o.key);
  if (act.kind === "suggest") return ["采纳", "换一个"];
  if (act.kind === "propose") return ["就这样做", "不要"];
  if (act.kind === "ask" && act.scope !== "general" && act.items?.length) return [...keepButtons(act, task).keys(), DONT_KNOW];
  return [];
}

const KIND_WORD: Record<string, string> = { ask: "提问", confirm: "请确认", suggest: "建议", choose: "请选择", propose: "提议" };
const EFFECT_WORD: Record<string, string> = { remove: "去掉", add: "加上", change: "改动" };

/** 一条执行者的回复写成用户看到的样子。 */
export function renderReply(m: Message, task?: TaskView | null): string {
  const lines: string[] = [];
  if (m.degraded) return [`（界面注明：这条回复没有按结构发出。）`, `助手说：${m.text ?? ""}`].join("\n");
  const act = cardOf(m);
  if (act) for (const one of m.informs ?? []) lines.push(`助手告诉你：${one}`);
  lines.push(`助手说：${m.text ?? ""}`);
  if (act) {
    lines.push(`【卡片：${KIND_WORD[act.kind] ?? act.kind}】${act.text}`);
    if (act.items?.length) lines.push(`涉及的条目：${act.items.map((i) => `${i.item_id} 第 ${i.version_no} 版`).join("、")}`);
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
  version_no: number;
  fields: Record<string, unknown>;
  confirmations?: { version_no: number; accepted: boolean }[];
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
    const confirmed = (item.confirmations ?? []).filter((c) => c.version_no === item.version_no);
    const mark = confirmed.length ? (confirmed[confirmed.length - 1].accepted ? "（你已确认这一版）" : "（你撤回过对这一版的确认）") : "";
    return [`${item.item_id}「${item.title}」，集合「${item.collection}」，第 ${item.version_no} 版${mark}：`,
      ...declared.map((name) => `  ${name}：${valueText(item.fields[name])}`)].join("\n");
  }
  const lines = ["条目区："];
  for (const c of task.definition.collections) {
    const items = task.items.filter((i) => i.collection === c.name);
    lines.push(`  ${c.name} ${items.length} 个${items.length ? "：" + items.map((i) => `${i.item_id}「${i.title}」`).join("、") : ""}`);
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
 * 按接口约定（docs/api.md「卡片上的按钮」）把一次回应翻成请求：「确认」走 actions（带 notify_executor），其余按钮走 messages 带 card，
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
    if (click === "确认") {
      return { kind: "action", body: { client_id: clientId, kind: "confirm", notify_executor: true,
        targets: (act.items ?? []).map((i) => ({ item_id: i.item_id, base_version: i.version_no })) } };
    }
    const keep = keepButtons(act, task).get(click);
    if (keep) {
      // 与前端一致：直接操作 keep_pending，带通知；版本取卡片上写的，没写就取条目区的当前版本。
      const base = act.items?.find((i) => i.item_id === keep)?.version_no ?? task?.items.find((i) => i.item_id === keep)?.version_no;
      return { kind: "action", body: { client_id: clientId, kind: "keep_pending", notify_executor: true, targets: [{ item_id: keep, base_version: base }] } };
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
