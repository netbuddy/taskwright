// 工作的阶段在页面上怎样读：六个阶段各画成什么、当前阶段的灯怎样排、一盏灯的句子怎样缩短、点一盏灯去哪里。
// 阶段与灯都随整份数据与库事件来（task.stage，见 state/workState.ts），这里只把它变成要画的样子，不另取数据。
// 阶段的名字、次序与转移卡片的选项键（next_step、goto:<活动标识符>、stay）取自助手一侧的 lib/stage.ts，与工具用的是同一份。

import {
  DOCUMENT_REVIEWED_OPTION, DOCUMENT_REVISE_OPTION, FLOW_NAMES, IDLE, IDLE_NAME, LEGACY_CARD_MOVES, REPORT_ONLY_LAMPS, STAGES, STAGE_NAMES, STAY_TEXT,
  activityDoneSentence, activityStartSentence, cardMove, flowKeyOf,
} from "../../../agent/src/lib/stage";
import type { Item, PositionKey, StageKey, StageLamp, StageMove, StageView } from "../api/types";

export { STAGES, STAGE_NAMES, STAY_TEXT };

/**
 * 这一站只报数、不判：它有灯，而且全是只报数的灯（核读材料就是这样）。这种站没有「齐了」「还差」可说，
 * 左栏与推进建议改说只报数、由用户判断。
 */
export function reportOnlyStation(lamps: readonly Pick<StageLamp, "key">[] | null | undefined): boolean {
  return !!lamps && lamps.length > 0 && lamps.every((one) => REPORT_ONLY_LAMPS.has(one.key));
}

/** 所属流程给人看的名字：认得的写中文名（现在只有「需求分析」；早先的键 initial 也是它），认不出的照原样写，没有给的写「（没有记）」。 */
export function flowName(flow: string | null | undefined): string {
  // null 是不在任何流程里：单项活动的工作项。早先的后端不给这一项。
  if (flow === null) return "单项活动";
  const key = flowKeyOf(flow);
  return key ? (FLOW_NAMES as Record<string, string>)[key] ?? key : "（没有记）";
}

/** 阶段条上的一格：这个阶段已经过了、正在这里、还没到。 */
export type StageMark = "done" | "current" | "ahead";

/**
 * 阶段条上六格各是什么样子。任务在需求分析流程里的某个阶段时，它之前的填实、它自己是当前、之后的空心。
 * 任务空闲时没有当前的一格；用户单独开展一项活动（alone 为真）时只有那一格是当前，别的都空心：单独开展不说明前面的阶段做过。
 */
export function stageMarks(current: PositionKey, alone = false): { key: StageKey; name: string; mark: StageMark }[] {
  const at = current === IDLE ? -1 : STAGES.indexOf(current);
  const loose = current === IDLE || alone;
  return STAGES.map((key, index) => ({ key, name: STAGE_NAMES[key], mark: index === at ? "current" : !loose && index < at ? "done" : "ahead" }));
}

/** 任务现在是不是空闲：没有在进行的活动。 */
export const isIdle = (stage: Pick<StageView, "current"> | null | undefined): boolean => stage?.current === IDLE;
/** 现在这项活动是不是用户单独开展的（不在需求分析流程里）。早先的后端不给 node，当作在流程里。 */
export const isAlone = (stage: Pick<StageView, "current" | "node"> | null | undefined): boolean => !!stage && stage.current !== IDLE && stage.node === null;
/** 阶段条下面、调试页签里说任务现在在哪里的那一句；任务在流程里的某个阶段时不用它。 */
export const IDLE_TEXT = "本会话没有在进行的工作项：自由讨论，或者它的工作项已经结束。";
export const aloneText = (stage: StageKey): string => `本会话的工作项是单项活动：${STAGE_NAMES[stage]}（不在工作流程里）。`;
/** 位置给人看的名字：阶段的名字，或者「空闲」。 */
export const positionLabel = (position: PositionKey | string): string => (position === IDLE ? IDLE_NAME : (STAGE_NAMES as Record<string, string>)[position] ?? position);

/** 工作视图顶栏上会话空闲时的两处字：这条会话是自由讨论（不属于任何工作项，或者归档了），与去任务起点页启动工作的那一枚。 */
export const NO_ACTIVITY_TEXT = "自由讨论 · 不绑定活动";
export const START_WORK_TEXT = "启动工作";
/** 顶栏上有活动在进行时的那一处：「当前活动：整理建模」。 */
export const currentActivityText = (position: PositionKey | string): string => `当前活动：${positionLabel(position)}`;

/**
 * 工作视图顶栏上任务名与会话名后面的那一处写什么：
 *   plain  任务没有阶段（任务定义里没有阶段的任务），写「这个任务没有阶段」；
 *   active 这条会话在做一个工作项，写「当前活动：某项活动」，点了打开切换工作面板；
 *   idle   这条会话是自由讨论，写「自由讨论 · 不绑定活动」（点了同样打开面板），旁边另有一枚「启动工作」去任务起点页。
 */
export type TopbarActivity = { kind: "plain" | "active" | "idle"; text: string };
export function topbarActivity(task: { stage?: Pick<StageView, "current"> | null }): TopbarActivity {
  if (!task.stage) return { kind: "plain", text: "这个任务没有阶段" };
  if (isIdle(task.stage)) return { kind: "idle", text: NO_ACTIVITY_TEXT };
  return { kind: "active", text: currentActivityText(task.stage.current) };
}

/**
 * 一盏灯在阶段条上的那一句：后端的整句带着编号清单（「有 2 页……的例子：OA-003、OA-005。」），阶段条上只显示清单前面那个冒号之前的
 * 半句并补上句号；句子里没有这样的冒号时显示整句。整句留给悬停时看。
 * 直角引号里的冒号不算（「以「例外：」开头的例子」里那一个是引出来的写法，不是清单前面的冒号）。
 */
export function lampShort(summary: string): string {
  let depth = 0, at = -1;
  for (let i = 0; i < summary.length && at < 0; i++) {
    const ch = summary[i];
    if (ch === "「") depth += 1;
    else if (ch === "」") depth = Math.max(0, depth - 1);
    else if (ch === "：" && depth === 0) at = i;
  }
  if (at < 0) return summary;
  const head = summary.slice(0, at).replace(/[。.\s]+$/, "");
  return `${head}。`;
}

/** 把一句话按其中的数字拆开，数字单独成段（阶段条上把数字加重）。 */
export function splitNumbers(text: string): { text: string; number: boolean }[] {
  return text.split(/(\d+)/).filter((part) => part !== "").map((part) => ({ text: part, number: /^\d+$/.test(part) }));
}

/** 当前阶段的灯分三类：没通过的逐盏列出，通过的只数个数，不适用的不显示也不计数。 */
export function lampGroups(stage: StageView): { failing: StageLamp[]; passed: number; applicable: number } {
  const lamps = stage.current === IDLE ? [] : stage.lamps[stage.current] ?? [];
  const failing = lamps.filter((one) => one.ok === false);
  const passed = lamps.filter((one) => one.ok === true).length;
  return { failing, passed, applicable: failing.length + passed };
}

/** 点一盏灯去哪里：清单里的第一个。是任务里的条目就打开它；否则当作材料的路径，去右侧栏的原文定位页签。清单是空的时候哪里也不去。 */
export function lampTarget(lamp: StageLamp, items: readonly Item[]): { kind: "item"; itemId: string } | { kind: "material"; path: string } | null {
  const first = lamp.items[0];
  if (!first) return null;
  return items.some((one) => one.item_id === first) ? { kind: "item", itemId: first } : { kind: "material", path: first };
}

/**
 * 转移卡片的选项键（lib/stage.ts 的 cardMove）：进入下一步 next_step、转到某一步 goto:<活动标识符>、留在这一步 stay；
 * 早先按阶段的固定键（enter_clarify、back_to_reading、continue_reading 之类）照 LEGACY_CARD_MOVES 换，还开着的旧卡片照样认。
 * 一个转到某一步的选项是往前还是往回：早先的键看它是 back_to_ 开头的还是别的；新键看卡片上的字，助手照规矩把往回的写成「回到：某活动」。
 */
export const isForwardOption = (option: { key: string; text?: string }): boolean => {
  const move = cardMove(option.key);
  if (move === null || move.kind === "stay") return false;
  if (move.kind === "next") return true;
  return option.key in LEGACY_CARD_MOVES ? !option.key.startsWith("back_to_") : !(option.text ?? "").startsWith("回到");
};
export const isBackOption = (option: { key: string; text?: string }): boolean => {
  const move = cardMove(option.key);
  return move !== null && move.kind === "goto" && !isForwardOption(option);
};
/** 一个往前走的选项要去哪个阶段：转到某一步的就是那一步；进入下一步的要看任务在哪一步，这里不知道，是 null。 */
export function forwardTarget(option: { key: string; text?: string }): StageKey | null {
  const move = cardMove(option.key);
  return move !== null && move.kind === "goto" && isForwardOption(option) ? move.to : null;
}
/** 请过目卡片上两个选项的键。 */
export const DOCUMENT_REVIEWED_KEY = DOCUMENT_REVIEWED_OPTION.key;
export const DOCUMENT_REVISE_KEY = DOCUMENT_REVISE_OPTION.key;

/**
 * 助手提议的卡片有三种：enter 提议往前走，back 提议退回前面的一步，review 编写文档阶段请用户过目补写的页。
 * 认法是看选项，照这个先后取第一种对得上的；不是提议的卡片是 null。
 */
export type ProposalCardKind = "enter" | "back" | "review";
export function proposalCardKind(options: readonly { key: string; text?: string }[] | null | undefined): ProposalCardKind | null {
  const list = options ?? [];
  if (list.some(isForwardOption)) return "enter";
  if (list.some(isBackOption)) return "back";
  if (list.some((one) => one.key === DOCUMENT_REVIEWED_KEY)) return "review";
  return null;
}
/** 卡片上点了就生效的那一项：进入下一步、转到某一步、看过了。 */
export const isActingKey = (key: string): boolean => {
  const move = cardMove(key);
  return (move !== null && move.kind !== "stay") || key === DOCUMENT_REVIEWED_KEY;
};
/** 卡片上不生效的那一项：转移卡片的「继续本步」（含早先的几种写法）、请过目卡片的「需要修改」。点它只把卡片标为已选，提议仍然开着。 */
export const isQuietKey = (key: string): boolean => cardMove(key)?.kind === "stay" || key === DOCUMENT_REVISE_KEY;
/** 不生效的那一项在页面上写成什么：转移卡片上一律是「继续本步」，请过目卡片上是「需要修改」。 */
export function quietText(key: string): string {
  return key === DOCUMENT_REVISE_KEY ? DOCUMENT_REVISE_OPTION.text : STAY_TEXT;
}
/** 界面操作 continue_stage 认的四种选项在页面上的叫法：上面三种，加请过目卡片上的「看过了，生成文档」。 */
export function quietChoiceText(key: string | null | undefined): string {
  return key === DOCUMENT_REVIEWED_KEY ? DOCUMENT_REVIEWED_OPTION.text : quietText(key ?? "");
}

/** 界面操作通知的种类：用户在提议转移的卡片上选了「继续本步」（后端 conversation.ts 的 CONTINUE_STAGE）。 */
export const CONTINUE_STAGE_KIND = "continue_stage";
/** 对话区里那条通知写成的一行。 */
export const CONTINUE_STAGE_LINE = `界面操作：用户选择${STAY_TEXT}`;
/** 同一种通知按点的是哪一项写成一行（早先的通知没有记点的是哪一项，当作「继续本步」）。 */
export const continueStageLine = (optionKey: string | null | undefined): string => `界面操作：用户选择${quietChoiceText(optionKey)}`;
/** 选了「继续本步」之后卡片下面的那句小字：提议还开着，从哪里点。 */
export const STAY_HINT = "这个提议仍然开着，要转过去时点输入框上方「待决定」一行里的按钮。";
export const REVISE_HINT = "请在输入框里说要改哪里。这几页你还没有都看过，提议仍然开着。";
/** 请过目卡片上选了「看过了，生成文档」之后卡片下面的那句小字。 */
export const REVIEWED_HINT = "这几页已经记为看过，可以在条目区按「生成文档」。";
/** 不生效的那一项选了之后的小字，按点的是哪一项取。 */
export const quietHint = (key: string): string => (key === DOCUMENT_REVISE_KEY ? REVISE_HINT : STAY_HINT);

/**
 * 对话区里说一次阶段移动的那一行：用户在卡片上点了进入下一段（或者退回前面的阶段），写「界面操作：用户把任务从核读材料移到澄清。」，
 * 与别的界面操作记号是同一种说法。阶段只由用户移动。任务空闲时点了「开始核读材料」，写的是启动（或继续）需求分析。
 */
/**
 * 用户点了一张进入某个阶段的卡片而阶段没有移动时，卡片上「✓ 你选了……」下面的那句小字。at 是这条会话当时所在的阶段。
 * why 为 not_in_flow 是这条会话当时不在做流程的工作项（自由讨论的会话、工作项已经结束，或者工作项是单项活动）：进入与退回不算数，
 * 请用户从任务起点页启动一个工作项。
 */
export function stageUnmovedLine(at: string, why?: string | null, blocked?: string | null): string {
  // 要去的那一步前置条件不满足：照它的说法告诉用户。
  if (why === "not_ready") return `这次点击没有生效：${blocked ? blocked.replace(/。$/, "") : "要去的那一步前置条件不满足"}。`;
  if (why === "not_in_flow") {
    return `这次点击没有生效：${at === IDLE ? "本会话没有在进行的工作流程" : `本会话的工作项是单项活动「${positionLabel(at)}」`}。要进入某个阶段，请从任务起点页启动一个工作项。`;
  }
  return `这次点击没有改变阶段：工作项当时在${positionLabel(at)}。`;
}

/** 助手在一条回复里汇报这条会话的工作项（单项活动）做完了时，那条回复下面的一行。 */
export const activityDoneLine = (activity: StageKey): string => activityDoneSentence(activity);

export function stageMoveLine(move: StageMove): string {
  return `界面操作：${activityStartSentence(move.how ?? "move", move.to, move.from)}`;
}

