// 导入后补齐材料的结果怎样说（POST …/materials/replenish 的核对结果，后端见 backend/src/replenish.ts）：
// 已恢复用成功提示，与导出时不同用警示提示并列出哪几样不同与原因，没有可比的也用成功提示但写明没有校验值可比。

import type { ReplenishCheck } from "../api/types";

/** 已恢复时的那句话。 */
export const RESTORED_TEXT = "已恢复到导出时的状态";
/** 没有导出时的校验值可比时的那句话。 */
export const UNVERIFIED_TEXT = "已补齐（没有导出时的校验值可比）";
/** 与导出时不同、还没有接受的材料在材料行上的标记。 */
export const MISMATCH_TAG = "与导出时不同";

/** 派生文件的路径 → 它是哪一样（文字版、分段清单、位置表）。 */
function derivedKind(path: string): string {
  if (path.endsWith(".segments.json")) return "分段清单";
  if (path.endsWith(".locations.json")) return "位置表";
  return "文字版";
}

/** 与导出时不同的是哪几样：原件，或者派生文件里不同的那几样（按文字版、分段清单、位置表的次序）。 */
export function differingParts(check: ReplenishCheck): string[] {
  if (check.original === "different") return ["原件"];
  const kinds = check.derived.filter((one) => one.result === "different").map((one) => derivedKind(one.name));
  return ["文字版", "分段清单", "位置表"].filter((kind) => kinds.includes(kind));
}

/** 补齐之后的提示：语气（成功或警示）与文字。name 是材料的文件名。 */
export function replenishMessage(name: string, check: ReplenishCheck): { tone: "ok" | "warn"; text: string } {
  if (check.verdict === "restored") return { tone: "ok", text: `《${name}》${RESTORED_TEXT}。` };
  if (check.verdict === "unverified") return { tone: "ok", text: `《${name}》${UNVERIFIED_TEXT}。` };
  const reasons = check.reasons.length ? `：${check.reasons.join("；")}` : "";
  return { tone: "warn", text: `《${name}》已补齐，但${differingParts(check).join("、")}与导出时不同${reasons}。依据它的条目标了待核实；可以在材料行上接受，或者换回原件。` };
}

/** 这份材料现在是不是「补齐后与导出时不同、还没有接受」：材料行上留标记与「接受」「换回原件」两个操作。 */
export const awaitingDecision = (check: ReplenishCheck | null | undefined): boolean => !!check && check.verdict === "mismatch" && !check.accepted;
