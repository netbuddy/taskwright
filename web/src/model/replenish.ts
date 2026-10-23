// 导入后补齐材料的结果怎样说（POST …/materials/replenish 的核对结果，后端见 backend/src/replenish.ts）：
// 原件与导出时相同的已恢复，没有可比的已补齐，都用成功提示。原件的校验值与导出时不同的，后端直接拒绝（replenish_mismatch），
// 页面照错误提示显示它的原话。本机重算的派生文件与导出时不同不告诉用户（后端只记日志）。

import type { ReplenishCheck } from "../api/types";

/** 已恢复时的那句话。 */
export const RESTORED_TEXT = "已恢复到导出时的状态";
/** 没有导出时的校验值可比时的那句话。 */
export const UNVERIFIED_TEXT = "已补齐（没有导出时的校验值可比）";

/** 补齐之后的提示文字。name 是材料的文件名。 */
export function replenishMessage(name: string, check: ReplenishCheck): string {
  return `《${name}》${check.verdict === "unverified" ? UNVERIFIED_TEXT : RESTORED_TEXT}。`;
}
