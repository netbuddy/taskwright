// 对话区里的任务状况消息折叠成的那一行。这条消息是每条会话开头由程序写给助手看的（任务状况、材料清单、知识库清单、引用规矩），
// 全文有几百字；对话区默认只显示一行要点，点开才是全文。要点取自后端随消息给的 details（助手一侧写这条消息时一并记下的事实），
// 哪一项取不到就不写那一项，一项都取不到时只写前半句。助手没有用回复工具说话时系统提醒它的那一句也是系统说明，它不折叠：
// 带 kind 的对话区根本不画（见 components/work/Conversation.tsx），没有 kind 的旧数据整句显示。

import type { SystemNote } from "../api/types";

/** 开始会话那一种、续接那一种在页面上的开头（后端 taskStatusDisplayText 换成的写法）：没有 kind 的旧数据按它认。 */
const START_HEAD = "这条会话开始时（";
const RESUME_HEAD = "接着这条会话继续时（";

export const START_LINE = "助手开始这条会话时看到的任务状况";
export const RESUME_LINE = "助手续接这条会话时看到的变化";

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
const list = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** 材料清单里用户放进来的那几份的路径：由别的文件生成的（投影、分段清单，后端在 derived_from 里写明）不算。清单取不到时是 null。 */
function ownMaterialPaths(details: Dict): string[] | null {
  const files = list(dict(details.materials)?.files);
  if (files === null) return null;
  return files.map(dict).filter((file): file is Dict => file !== null && !file.derived_from).map((file) => String(file.path ?? ""));
}

/** 开始会话那一种的要点：几份材料 · 几个知识库几份文档 · 完成条件 · 未解决的问题。 */
function startPoints(details: Dict): string[] {
  const points: string[] = [];
  const own = ownMaterialPaths(details);
  if (own !== null) points.push(`${own.length} 份材料`);
  const libraries = list(details.knowledge);
  if (libraries !== null) {
    const documents = libraries.reduce<number>((sum, library) => sum + (list(dict(library)?.documents)?.length ?? 0), 0);
    points.push(`${libraries.length} 个知识库 ${documents} 份文档`);
  }
  // 分数的算法与任务页相同（model/completionLines.ts 的 completionScore）：集合还没有条目、暂时不用核对的条件不算在分母里。
  const [met, total] = [count(details.conditions_met), count(details.conditions_total)];
  if (met !== null && total !== null) points.push(`完成条件 ${met}/${total - (count(details.conditions_empty) ?? 0)}`);
  const unresolved = count(details.unresolved);
  if (unresolved !== null) points.push(`问题 ${unresolved} 条未解决`);
  return points;
}

/** 续接那一种的要点：只写不为零的项；带了知识库清单就是选用的知识库变过。 */
function resumePoints(details: Dict): string[] {
  const points: string[] = [];
  const add = (value: unknown, text: (n: number) => string) => {
    const n = list(value)?.length ?? 0;
    if (n > 0) points.push(text(n));
  };
  add(details.added, (n) => `新增 ${n} 条`);
  add(details.updated, (n) => `修改 ${n} 条`);
  add(details.deleted, (n) => `删除 ${n} 条`);
  // 新放进来的文件里也有由 Word、PDF 材料生成的文件：只数材料清单里标为用户放进来的；清单取不到时照原样数。
  const fresh = list(details.new_materials);
  const own = ownMaterialPaths(details);
  if (fresh !== null) add(own === null ? fresh : fresh.filter((path) => own.includes(String(path))), (n) => `新材料 ${n} 份`);
  if (list(details.knowledge) !== null) points.push("选用的知识库有变化");
  return points;
}

/**
 * 这条系统说明折叠成的那一行；不折叠的（兜底提醒那一句、认不出的）返回 null。
 * 是不是任务状况消息：有 kind 看 kind；没有（旧版后端的数据）看文字的开头。哪一种：先看 details.kind，再看文字的开头。
 */
export function statusNoteLine(note: Pick<SystemNote, "text" | "kind" | "details">): string | null {
  const text = note.text ?? "";
  const byHead = text.startsWith(RESUME_HEAD) ? "resume" : text.startsWith(START_HEAD) ? "start" : null;
  if (note.kind ? note.kind !== "task_status" : byHead === null) return null;
  const details = dict(note.details) ?? {};
  const variant = details.kind === "变化" ? "resume" : details.kind === "现状" ? "start" : byHead ?? "start";
  if (variant === "resume") {
    const points = resumePoints(details);
    return points.length ? `${RESUME_LINE}：${points.join("、")}` : RESUME_LINE;
  }
  const points = startPoints(details);
  return points.length ? `${START_LINE}：${points.join(" · ")}` : START_LINE;
}
