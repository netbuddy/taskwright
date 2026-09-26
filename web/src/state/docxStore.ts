// Word 材料的原始字节与派生表，按「任务编号 + 材料路径」各读一次、缓存起来（材料上传后不再改，重名的会另起名字）。
// 条目区的来源标签要写「第几页 · 哪一节 · 页上中下」，材料区不一定正显示这份材料，所以派生表在页面外的元素里渲染一遍算出来；
// 材料区显示时拿同一份字节另渲染一遍。

import { createContext, useSyncExternalStore } from "react";
import { api, ApiError } from "../api/client";
import { renderDocx, tableOf, tablePositions, type DocxTable } from "../model/docx";

export interface DocxEntry {
  status: "loading" | "ready" | "error";
  bytes?: ArrayBuffer;
  table?: DocxTable;
  /** 表格里的段落的位置（「表 3 第 2 行第 2 列」），取自后端生成的投影。 */
  tablePos?: Map<number, string>;
  error?: string;
}

/** 条目详情里的来源标签要知道是哪个任务的材料：由条目详情提供。 */
export const TaskIdContext = createContext<string | null>(null);

const entries = new Map<string, DocxEntry>();
const listeners = new Set<() => void>();
const keyOf = (taskId: string, path: string) => `${taskId}\u0000${path}`;

function set(key: string, entry: DocxEntry) {
  entries.set(key, entry);
  for (const l of listeners) l();
}

async function load(taskId: string, path: string, key: string) {
  try {
    const [bytes, content] = await Promise.all([api.materialRaw(taskId, path), api.materialContent(taskId, path)]);
    const table = tableOf(await renderDocx(bytes, document.createElement("div")));
    set(key, { status: "ready", bytes, table, tablePos: tablePositions(content.text) });
  } catch (e) {
    set(key, { status: "error", error: e instanceof ApiError ? e.message : String(e) });
  }
}

/** 取这份 Word 材料的缓存项；还没读过就开始读（读完通知订阅者）。 */
export function docxEntry(taskId: string, path: string): DocxEntry {
  const key = keyOf(taskId, path);
  let entry = entries.get(key);
  if (!entry) {
    entry = { status: "loading" };
    entries.set(key, entry);
    void load(taskId, path, key);
  }
  return entry;
}

/** 组件里用：path 为 null 时不读，返回 null。 */
export function useDocx(taskId: string | null | undefined, path: string | null | undefined): DocxEntry | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => (taskId && path ? docxEntry(taskId, path) : null),
  );
}

/** 测试用：清空缓存。 */
export function resetDocxStore(): void {
  entries.clear();
}
