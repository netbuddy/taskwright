/**
 * 问题条目了结之前的同意：助手把问题条目的状态改为「已解决」或「用户决定保留」，要用户先在卡片上点过头，不只靠助手记得去问。
 * 「没有未解决的问题」是完成任务的条件之一，助手自己标了，这一条就在用户没有表态时满足了。
 *
 * 卡片：「回复」发的请选择（choose），选项里有「已解决」或「先不管，保留」，items 里点名了问题条目。一张卡片点名几个问题条目，
 * 对这几个都算问过；选项的 key 由助手随意写，所以按文字认，比较时去掉空白与标点（与 lib/reply.ts 的 echoedAct 同一种比法）。
 * 点击：会话里一条界面点击的自定义消息加系统替用户发的那句话（lib/completion_consent.ts 的 cardClicks）；用户打字不算。
 *
 * 规则只写在 judgeProblemStatus 里：
 * - 以点名这个问题条目的这种卡片上最近一次点击为准，点的要是与新状态对应的那一项（已解决 ← 「已解决」，用户决定保留 ← 「先不管，保留」）；
 * - 点了之后，这个问题条目或它牵涉的条目（它的条目引用字段里写的那些）有了新的修订或被删除，不论是谁改的，点击就过期，要重新问；
 * - 同一批操作里又改了牵涉的条目，也算点了之后改过。
 * 新增问题条目时状态不能直接写成这两种（newProblemStatus）：新增的条目还没有被问过。
 *
 * 用户在页面上的直接操作（先不管、改字段、撤销）不经这里，由 lib/save_revision.ts 按发起方放行。
 * 本模块不依赖 pi；会话分支由调用方读好，库的查询由调用方给。
 */

import { KEEP_PENDING_STATUS } from "./definition.ts";
import { type Entry, cardClicks, chooseActOf } from "./completion_consent.ts";

/** 问题条目了结为已解决时状态字段的取值。 */
export const RESOLVED_STATUS = "已解决";
/** 卡片上三个选项的文字（助手说明里规定的写法）。 */
export const RESOLVED_TEXT = "已解决";
export const CONTINUE_TEXT = "还没解决，继续改";
export const KEEP_TEXT = "先不管，保留";

/** 需要用户点过头才能改成的状态，以及要点的那一项。 */
export const CONSENT_OPTION: Readonly<Record<string, string>> = { [RESOLVED_STATUS]: RESOLVED_TEXT, [KEEP_PENDING_STATUS]: KEEP_TEXT };

/** 去掉空白与标点之后的文字，比较选项用。 */
const bare = (text: unknown): string => (typeof text === "string" ? text.replace(/[\s\p{P}]/gu, "") : "");
const CARD_OPTIONS = new Set([bare(RESOLVED_TEXT), bare(KEEP_TEXT)]);

/** 会话里对一张「这个问题是否已解决」卡片的一次点击：卡片点名的条目、点的那一项的文字、点击之后那句话的会话条目编号。 */
export interface ProblemClick {
  items: string[];
  optionText: string | null;
  userEntryId: string;
}

/** 这条助手消息是不是问问题是否已解决的卡片：请选择，选项里有「已解决」或「先不管，保留」。是就返回卡片上的请选择。 */
function problemCardOf(entry: Entry): Record<string, any> | null {
  const act = chooseActOf(entry);
  return act && act.options.some((option: any) => CARD_OPTIONS.has(bare(option?.text))) ? act : null;
}

/** 会话分支上对这种卡片的全部点击，按先后排。由工具从会话分支读出，交给保存修订。 */
export function problemClicks(branch: readonly Entry[]): ProblemClick[] {
  return cardClicks(branch, problemCardOf).map((click) => ({
    items: (Array.isArray(click.act.items) ? click.act.items : [])
      .map((ref: any) => (typeof ref?.item_id === "string" ? ref.item_id : ""))
      .filter(Boolean),
    optionText: click.optionText,
    userEntryId: click.userEntryId,
  }));
}

/** 判断要用到的库里的事实，由保存修订按这个任务接好。 */
export interface ProblemFacts {
  /** 这次调用交来的点击；没有交就是一次都没有。 */
  clicks: readonly ProblemClick[];
  /** 点击之后那句话记进对话行为表时的事件序号；库里找不到时为 null。 */
  clickSeq: (userEntryId: string) => number | null;
  /** 这个条目在事件序号 seq 之后有没有新的修订或被删除：有就返回最近一次的说法（「修订 9」「修订 9 删除」），没有返回 null。 */
  changedAfter: (itemId: string, seq: number) => string | null;
}

/** 核对不通过时的两层文字：事实（给人看）与指引（给助手）。 */
export interface ProblemRefusal {
  fact: string;
  guidance: string;
}

/** 被拒时指引助手怎样问。 */
function askGuidance(itemId: string, status: string): string {
  const option = CONSENT_OPTION[status];
  const typed = status === RESOLVED_STATUS ? "已经解决" : "先不管";
  return `请用回复的请选择（choose）问用户这个问题是否已解决：在 items 里点名 ${itemId}，三个选项是「${RESOLVED_TEXT}」「${CONTINUE_TEXT}」「${KEEP_TEXT}」；` +
    `用户点了「${option}」之后再把状态改为「${status}」。用户在对话里打字说${typed}不算，照样先发卡片`;
}

/**
 * 助手要把问题条目 itemId 的状态改为 status（已经确认是 CONSENT_OPTION 里的一种）：用户点过头了没有。
 * linked 是它牵涉的条目，changedInBatch 是同一批操作里被修改、删除的其余条目。通过返回 null。
 */
export function judgeProblemStatus(
  itemId: string,
  status: string,
  linked: readonly string[],
  changedInBatch: ReadonlySet<string>,
  facts: ProblemFacts,
): ProblemRefusal | null {
  const option = CONSENT_OPTION[status];
  const head = `助手想把 ${itemId} 的状态改为「${status}」，但`;
  const click = [...facts.clicks].reverse().find((one) => one.items.includes(itemId));
  const seq = click ? facts.clickSeq(click.userEntryId) : null;
  if (!click || seq === null) {
    return { fact: `${head}用户还没有在问 ${itemId} 是否已解决的卡片上点「${option}」`, guidance: askGuidance(itemId, status) };
  }
  if (bare(click.optionText) !== bare(option)) {
    return { fact: `${head}用户在最近一张问 ${itemId} 是否已解决的卡片上选的是「${click.optionText ?? ""}」`, guidance: askGuidance(itemId, status) };
  }
  for (const one of [itemId, ...linked]) {
    const change = facts.changedAfter(one, seq);
    if (change) return { fact: `${head}用户点「${option}」之后，${one} 又有了${change}，要重新问`, guidance: askGuidance(itemId, status) };
  }
  const here = linked.filter((one) => changedInBatch.has(one));
  if (here.length) {
    return {
      fact: `${head}这一批操作里还改了它牵涉的 ${here.join("、")}，用户点「${option}」时还没有这些改动，要重新问`,
      guidance: `先单独保存对 ${here.join("、")} 的修改；${askGuidance(itemId, status)}`,
    };
  }
  return null;
}

/** 新增问题条目时写的状态：不能直接写成要用户点头的那两种。unresolved 是这个集合里表示未解决的取值（没有时为 null）。 */
export function newProblemStatus(status: unknown, unresolved: string | null): ProblemRefusal | null {
  if (typeof status !== "string" || !Object.hasOwn(CONSENT_OPTION, status)) return null;
  return {
    fact: `新增的问题条目状态不能直接写成「${status}」`,
    guidance: `先按${unresolved ? `「${unresolved}」` : "未解决"}记下，用问这个问题是否已解决的卡片问过用户、用户点了「${CONSENT_OPTION[status]}」之后再改状态`,
  };
}
