// Word 材料的原始字节、派生表与位置表，按「任务编号 + 材料路径」各读一次、缓存起来（材料上传后不再改：同名的文件再上传会被拒绝，不会覆盖）。
// 条目区的来源标签要写「第几页 · 哪一节 · 页上中下」：页码与页内位置取自派生表（材料区不一定正显示这份材料，所以在页面外的元素里
// 渲染一遍算出来），章节取自后端上传时写的位置表（x.docx.locations.json）。材料区显示时拿同一份字节另渲染一遍。

import { createContext, useSyncExternalStore } from "react";
import { api, ApiError } from "../api/client";
import { renderDocx, tableOf, tablePositions, type DocxTable } from "../model/docx";
import { LOCATIONS_SUFFIX, type LocationFile } from "../../../agent/src/lib/docx_locations";

export interface DocxEntry {
  /** error：读不到文件（接口出错），error 是后端给的说明；unrenderable：文件读到了，但排版库画不出来。 */
  status: "loading" | "ready" | "error" | "unrenderable";
  bytes?: ArrayBuffer;
  table?: DocxTable;
  /** 表格里的段落的位置（「表 3 第 2 行第 2 列」），取自后端生成的投影。 */
  tablePos?: Map<number, string>;
  /** 位置表（来源标签的章节查它）；读不到、不是合法的位置表时为 null，来源标签就不写章节。 */
  locations?: LocationFile | null;
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

/** 位置表的文字 → 位置表；不是合法的位置表时为 null。 */
export function parseLocations(text: string): LocationFile | null {
  try {
    const table = JSON.parse(text) as LocationFile;
    return Array.isArray(table?.headings) ? table : null;
  } catch {
    return null;
  }
}

async function load(taskId: string, path: string, key: string) {
  // 位置表单独接住：读不到（例如位置表出现之前建的任务）时只是来源标签不写章节，不影响材料的显示与页码。
  // 两种失败分开：读不到文件时显示后端的说明；读到了但排版库画不出来时，页面只显示一句固定的中文说明，错误原文写进浏览器的控制台。
  // 两种情况都留着位置表，来源标签照样写章节；表格里的段落的位置取自投影，画不出来时也留着。
  const locations = api.materialContent(taskId, `${path}${LOCATIONS_SUFFIX}`).then((r) => parseLocations(r.text), () => null);
  let bytes: ArrayBuffer, content: { text: string };
  try {
    [bytes, content] = await Promise.all([api.materialRaw(taskId, path), api.materialContent(taskId, path)]);
  } catch (e) {
    set(key, { status: "error", error: e instanceof ApiError ? e.message : String(e), locations: await locations });
    return;
  }
  const tablePos = tablePositions(content.text);
  try {
    const table = tableOf(await renderDocx(bytes, document.createElement("div")));
    set(key, { status: "ready", bytes, table, tablePos, locations: await locations });
  } catch (e) {
    reportUnrenderable(path, e);
    set(key, { status: "unrenderable", tablePos, locations: await locations });
  }
}

/** 排版库画不出这份 Word 文件：错误原文写进浏览器的控制台，供排查；页面上不显示。 */
export function reportUnrenderable(path: string, e: unknown): void {
  console.error(`Word 文件 ${path} 显示不出来，排版库的报错：`, e);
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
