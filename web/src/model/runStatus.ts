// 对话区底部的运行状态条（components/work/RunStatusBar.tsx）要写的字：数都由后端随 run_status 推来（backend/src/run_watch.ts），
// 这里只把它写成一行给人看的话，并定这一行是平常、琥珀色（可能卡住了）还是红色（看门狗中止了）。

import type { RunStatus } from "../api/types";

/** 工具的叫法：助手常用的几个工具写成中文，别的照原名。 */
const TOOL_NAMES: Record<string, string> = {
  save_revision: "保存修订", reply: "回复", get_item: "查看", get_task_status: "查询任务状态", read: "读文件", grep: "搜索材料", ls: "列目录",
  find: "找文件", save_diagram: "保存图", search_knowledge: "查知识库", request_review: "请求评审", publish_version: "发布版本",
};
export const toolName = (name: string | null): string => (name ? TOOL_NAMES[name] ?? name : "工具");

/** 现在在哪一段。 */
export function phaseText(status: RunStatus): string {
  switch (status.phase) {
    case "waiting": return "等待模型";
    case "thinking": return "模型输出中：思考";
    case "text": return "模型输出中：文字";
    case "tool_args": return `模型输出中：${toolName(status.tool)}的参数 ${status.tool_args_chars} 字`;
    case "tool": return `执行工具：${toolName(status.tool)}`;
    default: return "空闲";
  }
}

export type BarTone = "normal" | "stalled" | "aborted";

/** 这一行显示什么、什么颜色；没有在运行、也没有刚中止时不显示（null）。 */
export function runStatusLine(status: RunStatus | null): { tone: BarTone; text: string } | null {
  if (!status) return null;
  if (status.aborted) return { tone: "aborted", text: `已中止：模型输出异常（${status.aborted}），没有写入任何内容；发一句「继续」即可接着做` };
  if (status.phase === "idle") return null;
  const base = `${phaseText(status)} · 本次运行已 ${status.run_seconds ?? 0} 秒 · 本轮已收到 ${status.received_chars} 字`;
  if (status.stalled) {
    return { tone: "stalled", text: `这一步可能卡住了：已 ${status.idle_seconds ?? 0} 秒没有新内容；可以点「停止」，再发一句「继续」。（${base}）` };
  }
  return { tone: "normal", text: base };
}
