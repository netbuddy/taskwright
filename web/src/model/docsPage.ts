// 工作台「文档与版本」页签要的几句话：发布按钮能不能点（不能点时为什么）、与上一版的差异、追溯一句。
// 只算，不画（components/work/DocsTab.tsx）。数据都在任务详情里。

import type { Item, Task } from "../api/types";
import { requirementItems } from "./assetTabs";
import { SOURCE_FIGURE, SOURCE_ITEM, issueRefs } from "./items";
import { isOverall } from "./overall";
import { openClarifyQuestions } from "./pendingWork";
import { changesAfter, latestVersion, somethingToPublish } from "./versions";

/** 「发布第 N 版」不能点的原因；能点时是 null。条件与绿色提示条相同：完成条件全部满足、有可以发布的改动、助手不在工作。 */
export function publishOff(task: Task, o: { readOnly: boolean; writesOff: boolean }): string | null {
  if (o.readOnly) return "助手现在不可用，不能发布。";
  const conditions = task.completion?.conditions ?? [];
  if (!task.completion?.all_met) return `完成条件还没有全部满足（现在满足 ${conditions.filter((one) => one.met).length} / ${conditions.length} 条，见本页「发布前检查」）。`;
  if (!somethingToPublish(task)) return `当前资产与第 ${latestVersion(task)!.version_no} 版相同，没有可发布的改动。`;
  if (o.writesOff) return "助手正在工作，等它做完这一轮再发布。";
  return null;
}

/** 「与上一版的差异」一句。 */
export function differenceLine(task: Task): string {
  const { version, items, diagrams } = changesAfter(task);
  if (!version) return "还没有发布过。发布之后，这里写当前资产比最近一版新在哪里。";
  const n = items.length + diagrams.length;
  return n === 0 ? `当前资产与第 ${version.version_no} 版相同。` : `有 ${n} 处改动在第 ${version.version_no} 版之后（${items.length} 个条目、${diagrams.length} 张图）。`;
}

/** 一个需求条目依据的业务说明的页与图：来源里种类为「条目」且是业务说明的页的，与种类为「图」的。 */
export function basisOf(task: Task, item: Item): { pages: string[]; diagrams: string[] } {
  const pageIds = new Set(task.items.filter((one) => isOverall(one.collection)).map((one) => one.item_id));
  const kinds = item.sources.map((one) => ({ kind: String(one.kind), locator: one.locator }));
  return {
    pages: kinds.filter((one) => one.kind === SOURCE_ITEM && pageIds.has(one.locator)).map((one) => one.locator),
    diagrams: kinds.filter((one) => one.kind === SOURCE_FIGURE).map((one) => one.locator),
  };
}

/** 追溯的事实：需求条目（按编号）、可追溯到业务说明的节或图的、例外的编号、依据的节上挂着未解决的待澄清问题的编号。 */
export function traceFacts(task: Task): { items: Item[]; traced: Item[]; missing: string[]; shaky: string[] } {
  const items = requirementItems(task).sort((a, b) => a.item_id.localeCompare(b.item_id, undefined, { numeric: true }));
  const traced = items.filter((one) => { const b = basisOf(task, one); return b.pages.length > 0 || b.diagrams.length > 0; });
  const missing = items.filter((one) => !traced.includes(one)).map((one) => one.item_id);
  // 问题挂在节上：问题条目的「关联条目」里写着那一页。
  const asked = new Set(openClarifyQuestions(task).flatMap((one) => issueRefs(task, one)));
  const shaky = traced.filter((one) => basisOf(task, one).pages.some((page) => asked.has(page))).map((one) => one.item_id);
  return { items, traced, missing, shaky };
}

/** 追溯一句：N 条需求条目中 M 条可追溯到业务说明的节或图，例外点名；依据的节上挂着还没解决的待澄清问题的，另注一句。 */
export function traceLine(task: Task): string {
  const { items, traced, missing, shaky } = traceFacts(task);
  if (items.length === 0) return "还没有需求条目。";
  const head = `${items.length} 条需求条目中 ${traced.length} 条可追溯到业务说明的节或图${missing.length ? `；例外：${missing.join("、")}` : ""}。`;
  return shaky.length ? `${head}其中 ${shaky.join("、")} 依据的节上有待澄清问题。` : head;
}
