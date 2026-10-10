// 工作的阶段在页面上怎样读：五个阶段各画成什么、当前阶段的灯怎样排、一盏灯的句子怎样缩短、点一盏灯去哪里。
// 阶段与灯都随整份数据与库事件来（task.stage，见 state/workState.ts），这里只把它变成要画的样子，不另取数据。
// 阶段的名字、次序与卡片上「进入下一段」的选项键取自助手一侧的 lib/stage.ts，与工具用的是同一份。

import { ENTER_OPTIONS, STAGES, STAGE_NAMES } from "../../../agent/src/lib/stage";
import type { Item, StageKey, StageLamp, StageView } from "../api/types";

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
