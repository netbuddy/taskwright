/**
 * 提交交付物之前的同意：任务标为已完成之后整个任务只读、不能撤回，所以程序核对用户确实同意了，不只靠助手记得去问。
 *
 * 同意从哪里来，两处：
 * - 助手的卡片：回复工具发的请选择（choose），其中一项的 key 是 COMPLETE_KEY，就是问这个任务是否已经完成的卡片；
 *   用户在卡片上点了哪一项，会话里记着一条界面点击（自定义消息 taskwright-ui-click，只有扩展命令写得出来）。
 *   用户在输入框里打字说要完成不算，因为那不是点击。
 * - 页面上的提示：用户点「已完成，提交交付物」，作为直接操作带上页面当时看到的修订号。
 *
 * 两处都换成同一种 Consent（同意了没有、在哪次修订时点的）交给 judgeConsent，有效期的规则只写在这里：
 * 点的是同意的那一项，而且点的时候交付物已经是现在的修订（之后没有新的修订）。已读、评审、保留不产生修订，不让同意失效。
 * 卡片以会话里最近一次对这种卡片的点击为准：后来点了「还没完成，继续修改」，先前的同意就不算。
 *
 * 不依赖任何模块：会话分支由调用方读好交进来，库里的查询由 complete_task.ts 做。
 */

/** 同意的那一项的 key（程序内部的约定，不显示给用户）。 */
export const COMPLETE_KEY = "complete";
/** 同意的那一项给用户看的文字。 */
export const AGREE_TEXT = "已完成，提交交付物";
/** 另一项给用户看的文字。 */
export const DECLINE_TEXT = "还没完成，继续修改";

/** 卡片点击的自定义消息类型（hooks/user_commands.ts 的 UI_CLICK_CUSTOM_TYPE）。 */
const UI_CLICK_TYPE = "taskwright-ui-click";

type Entry = { id: string; type: string; customType?: string; details?: any; message?: { role?: string; content?: unknown } };

/** 会话里对一张「任务是否已经完成」卡片的一次点击。userEntryId 是点击之后系统替用户发的那句话的条目编号。 */
export interface CardClick {
  replyEntry: string;
  optionKey: string | null;
  optionText: string | null;
  userEntryId: string;
}

/** 一次同意（或不同意）：从哪里来、点的是不是同意的那一项、点的时候交付物是哪次修订（还没有修订时为 0）。 */
export interface Consent {
  source: "card" | "page";
  agreed: boolean;
  revisionNo: number;
  /** 点的那一项的文字（卡片上没点同意时写进拒绝的说明）。 */
  optionText?: string | null;
}

export type ConsentVerdict =
  | { ok: true }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "declined"; optionText: string | null }
  | { ok: false; reason: "stale"; revisionNo: number; latest: number };

/** 同意算不算数：点的是同意的那一项，并且点的时候交付物已经是现在的修订 latestRevision。 */
export function judgeConsent(consent: Consent | null, latestRevision: number): ConsentVerdict {
  if (!consent) return { ok: false, reason: "none" };
  if (!consent.agreed) return { ok: false, reason: "declined", optionText: consent.optionText ?? null };
  if (consent.revisionNo !== latestRevision) return { ok: false, reason: "stale", revisionNo: consent.revisionNo, latest: latestRevision };
  return { ok: true };
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && (part as any).type === "text" ? String((part as any).text ?? "") : "")).join("")
    : "";

/** 这条助手消息里是不是有一张问任务是否已经完成的卡片：回复工具的请选择，有一项的 key 是 COMPLETE_KEY。 */
function isCompletionCard(entry: Entry): boolean {
  if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some((part: any) => part?.type === "toolCall" && part.name === "reply"
    && part.arguments?.act?.kind === "choose" && Array.isArray(part.arguments.act.options)
    && part.arguments.act.options.some((option: any) => option?.key === COMPLETE_KEY));
}

/**
 * 会话分支上最近一次对「任务是否已经完成」卡片的点击；没有时为 null。
 * 一次点击是一条界面点击的自定义消息，紧跟着系统替用户发的那句话（文字与点击记下的 text 相同）；
 * 点的那张卡片要在同一条分支上、在点击之前。
 */
export function lastCompletionClick(branch: readonly Entry[]): CardClick | null {
  const cards = new Set<string>();
  let last: CardClick | null = null;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (isCompletionCard(entry)) cards.add(entry.id);
    if (entry.type !== "custom_message" || entry.customType !== UI_CLICK_TYPE) continue;
    const details = entry.details ?? {};
    const next = branch[i + 1];
    if (!cards.has(details.reply_entry) || next?.type !== "message" || next.message?.role !== "user" || textOf(next.message.content) !== details.text) continue;
    last = { replyEntry: details.reply_entry, optionKey: details.option_key ?? null, optionText: details.option_text ?? null, userEntryId: next.id };
  }
  return last;
}
