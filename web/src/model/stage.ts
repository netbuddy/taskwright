// 工作的阶段在页面上怎样读：五个阶段各画成什么、当前阶段的灯怎样排、一盏灯的句子怎样缩短、点一盏灯去哪里。
// 阶段与灯都随整份数据与库事件来（task.stage，见 state/workState.ts），这里只把它变成要画的样子，不另取数据。
// 阶段的名字、次序与卡片上「进入下一段」的选项键取自助手一侧的 lib/stage.ts，与工具用的是同一份。

import { ENTER_OPTIONS, STAGES, STAGE_NAMES, STAGE_START_TEXTS } from "../../../agent/src/lib/stage";
import type { Item, StageKey, StageLamp, StageMove, StageView } from "../api/types";

export { STAGES, STAGE_NAMES };

/** 阶段条上的一格：这个阶段已经过了、正在这里、还没到。 */
export type StageMark = "done" | "current" | "ahead";

export function stageMarks(current: StageKey): { key: StageKey; name: string; mark: StageMark }[] {
  const at = STAGES.indexOf(current);
  return STAGES.map((key, index) => ({ key, name: STAGE_NAMES[key], mark: index < at ? "done" : index === at ? "current" : "ahead" }));
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
  const lamps = stage.lamps[stage.current] ?? [];
  const failing = lamps.filter((one) => one.ok === false);
  const passed = lamps.filter((one) => one.ok === true).length;
  return { failing, passed, applicable: failing.length + passed };
}

/** 点一盏灯去哪里：清单里的第一个。是任务里的条目就打开它；否则当作材料的路径，去右侧栏的材料页签。清单是空的时候哪里也不去。 */
export function lampTarget(lamp: StageLamp, items: readonly Item[]): { kind: "item"; itemId: string } | { kind: "material"; path: string } | null {
  const first = lamp.items[0];
  if (!first) return null;
  return items.some((one) => one.item_id === first) ? { kind: "item", itemId: first } : { kind: "material", path: first };
}

/** 「进入下一段」的四个选项键各进入哪个阶段：进入澄清、进入整理建模、开始写条目、进入评审确认。 */
export const ENTER_KEYS: Record<string, StageKey> = Object.fromEntries(
  (Object.keys(ENTER_OPTIONS) as (keyof typeof ENTER_OPTIONS)[]).map((stage) => [ENTER_OPTIONS[stage].key, stage]),
);

/**
 * 对话区里说一次阶段移动的那一行。助手只会把任务退回前面的阶段，写「助手把任务退回澄清：理由」；
 * 用户在卡片上点了进入下一段，写「界面操作：用户把任务从核读材料移到澄清。」，与别的界面操作记号是同一种说法。
 */
/** 用户点了一张进入某个阶段的卡片而阶段没有移动时，卡片上「✓ 你选了……」下面的那句小字。at 是任务当时所在的阶段。 */
export function stageUnmovedLine(at: string): string {
  return `这次点击没有改变阶段：任务当时在${(STAGE_NAMES as Record<string, string>)[at] ?? at}。`;
}

export function stageMoveLine(move: StageMove): string {
  const to = STAGE_NAMES[move.to] ?? move.to;
  if (move.actor === "executor") {
    const reason = (move.reason ?? "").trim();
    return reason ? `助手把任务退回${to}：${reason}` : `助手把任务退回${to}。`;
  }
  return `界面操作：用户把任务从${STAGE_NAMES[move.from] ?? move.from}移到${to}。`;
}

/**
 * 总体分析还没有一页主题时的两个开头：按钮上的字、先把任务移到哪个阶段（界面操作 move_stage 的 stage 写阶段的名字）、
 * 再替用户发给助手的那句固定的话。
 */
export const STAGE_STARTS = {
  reading: { key: "reading", label: "通读材料起草", stage: STAGE_NAMES.reading, text: STAGE_START_TEXTS.reading },
  clarifying: { key: "clarifying", label: "逐项澄清", stage: STAGE_NAMES.clarifying, text: STAGE_START_TEXTS.clarifying },
} as const;
export type StageStart = (typeof STAGE_STARTS)[keyof typeof STAGE_STARTS];

/** 任务还没有材料时「通读材料起草」不可用的原因。 */
export const NO_MATERIALS_TEXT = "这个任务还没有材料，先在右侧栏上传材料。";
