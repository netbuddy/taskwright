/**
 * 只读地读任务库的几样公共函数：给后端服务（backend/）拼接口形状用，与观测台的 taskdb.py 是同一套读法。
 *
 * 本模块只读不写：连接以只读方式打开，代码里没有任何写语句，也不做核对、不评判内容。
 * 写库只在各写入工具与扩展命令里（save_revision.ts、user_ops.ts、create_task.ts 等），不在这里。
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { DEFAULT_MATERIALS_DIR } from "./definition.ts";
import { BUSY_TIMEOUT_MS, SOURCE_FIGURE, SOURCE_ITEM, SOURCE_USER_EDIT, sourceKindNow, sourceLocatorNow } from "./schema.ts";

export { DEFAULT_MATERIALS_DIR };

/** 一行库记录：列名到值。node:sqlite 读出的行没有原型，用前按普通对象看待。 */
export type Row = Record<string, any>;

/**
 * 只读方式打开一个库。库是 WAL 模式时只读连接也要用到 -wal 与 -shm 两个附属文件：任务目录可写时它们不存在会被建出来
 * （无害，下一次写入时合并清掉）；任务目录不可写、两个附属文件又都不存在时，只读打开会报「attempt to write a readonly
 * database」，这时库文件本身就是最新的，退一步用 immutable=1 再打开。目录不可写但 -wal 文件在时不退，免得漏读还没合并的改动。
 */
export function openReadonly(dbPath: string): DatabaseSync {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    try {
      db.prepare("SELECT count(*) FROM sqlite_master").get();
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  } catch (error) {
    if (existsSync(`${dbPath}-wal`)) throw error;
    const url = pathToFileURL(dbPath);
    url.searchParams.set("mode", "ro");
    url.searchParams.set("immutable", "1");
    return new DatabaseSync(url, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  }
}

/** 库里存的 JSON 文字还原成值；为空时是 null，不是合法 JSON 时原样返回文字。 */
export function jsonOrText(text: unknown): any {
  if (text === null || text === undefined) return null;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function tableNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => r.name as string));
}

export function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => r.name as string));
}

const isPlainObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 任务定义里的「材料目录」，缺省为 inputs/，结尾补上斜杠。形状的核对在写入一侧做，这里只照读。 */
export function materialsDir(raw: unknown): string {
  const value = isPlainObject(raw) ? raw["材料目录"] : null;
  if (typeof value !== "string" || !value.trim()) return DEFAULT_MATERIALS_DIR;
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : trimmed + "/";
}

/** 读取一侧用的任务定义：任务名、交付物名、每个集合的前缀与字段声明、完成条件等。 */
export interface ParsedDefinition {
  任务名: any;
  交付物名称: any;
  集合: { 名称: any; 编号前缀: any; 字段: { 名: any; 类型: any; 必填: boolean; 取值: any }[]; 界面: Record<string, any> }[];
  完成条件: Record<string, any>;
  执行方法: any;
  领域规矩: any;
  文档模板: any;
  材料目录: string;
  材料目录是不是缺省值: boolean;
}

/** 从任务定义的原文快照里取出读取一侧要用的几样。快照是建任务时校验过的，这里不再核对形状，读不出来的项留空。 */
export function parseDefinition(text: unknown): ParsedDefinition {
  const raw = jsonOrText(text);
  if (!isPlainObject(raw)) {
    return { 任务名: "", 交付物名称: "", 集合: [], 完成条件: {}, 执行方法: "", 领域规矩: [], 文档模板: "",
      材料目录: DEFAULT_MATERIALS_DIR, 材料目录是不是缺省值: true };
  }
  const deliverable = isPlainObject(raw["交付物"]) ? raw["交付物"] : {};
  const collections: ParsedDefinition["集合"] = [];
  for (const entry of (deliverable["条目集合"] || []) as unknown[]) {
    if (!isPlainObject(entry)) continue;
    collections.push({
      名称: "名称" in entry ? entry["名称"] : "",
      编号前缀: "编号前缀" in entry ? entry["编号前缀"] : "",
      字段: ((entry["字段"] || []) as unknown[]).filter(isPlainObject).map((f) => ({
        名: "名" in f ? f["名"] : "", 类型: "类型" in f ? f["类型"] : "", 必填: Boolean(f["必填"]), 取值: f["取值"] ?? null,
      })),
      界面: isPlainObject(entry["界面"]) ? entry["界面"] : {},
    });
  }
  const materials = raw["材料目录"];
  return {
    任务名: "任务名" in raw ? raw["任务名"] : "",
    交付物名称: "名称" in deliverable ? deliverable["名称"] : "",
    集合: collections,
    完成条件: isPlainObject(raw["完成条件"]) ? raw["完成条件"] : {},
    执行方法: "执行方法" in raw ? raw["执行方法"] : "",
    领域规矩: raw["领域规矩"] || [],
    文档模板: "文档模板" in deliverable ? deliverable["文档模板"] : "",
    材料目录: materialsDir(raw),
    材料目录是不是缺省值: typeof materials !== "string" || !materials.trim(),
  };
}

/** 「用户的话」的出处「会话编号#会话条目编号」拆成两半；拆不开返回 null。 */
export function splitUserWordsLocator(locator: unknown): [string, string] | null {
  if (typeof locator !== "string" || locator.split("#").length !== 2) return null;
  const [sessionId, entryId] = locator.split("#");
  return sessionId && entryId ? [sessionId, entryId] : null;
}

/** 一条来源：库里一条来源支持几处字段就展开成几行，这里按「第几条」合回一条。 */
export interface SourceRow {
  种类: string;
  出处: string;
  摘录: string;
  第几条: number;
  事件序号: number;
  支持: { 字段: string; 第几项: number | null }[];
  对话出处?: { 会话编号: string; 条目编号: string } | null;
  /** 只有种类为「条目」或「图」时有：引用那一刻对方的修订号；库里没有记下时为 null。 */
  依据的修订?: number | null;
}

/** 「条目编号 修订号」拼成的键，给按（条目, 修订）分组的表用。 */
export const itemKey = (itemId: string, revisionNo: number | null | undefined) => `${itemId}\u0000${revisionNo}`;

/**
 * 按（条目编号, 修订号）取条目在每次修订下的来源，键见 itemKey。所支持的字段放进「支持」列表：每项是字段名与列表里的
 * 第几项（从 0 起，为空表示整个字段）；列表为空表示这条来源支持整个条目。最早格式的库没有这几列，「支持」一律为空列表。
 * 早期版本写下的「用户直接修改」不读出：页面、生成的文档都不再显示它（条目上的话都算用户自己的，谁改的看修订）。
 *
 * 读出的种类一律是现在的名字。来源表的迁移只在这个库下一次被写入时发生（读取一侧只读、不改库），在那之前库里还是早期版本的
 * 样子，这里照迁移的规矩现算：「执行者补充」读成「助手补充」，出处正好是「执行者补充」的也读成「助手补充」；「领域说明」读成
 * 「条目」，依据的修订取被引用的条目在这条来源所在修订当时的最新修订号。迁过之后读到的与这里现算的一样。
 */
export function readSources(db: DatabaseSync, taskId: string): Map<string, SourceRow[]> {
  const columns = columnNames(db, "item_source");
  const fieldLevel = ["support_no", "field", "field_index"].every((c) => columns.has(c));
  const order = "item_id, revision_no, position" + (fieldLevel ? ", support_no" : "");
  const grouped = new Map<string, SourceRow[]>();
  const migrated = columns.has("depends_revision");
  const revisionThen = db.prepare("SELECT MAX(revision_no) AS no FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no <= ?");
  for (const row of db.prepare(`SELECT * FROM item_source WHERE task_id = ? AND kind <> ? ORDER BY ${order}`).all(taskId, SOURCE_USER_EDIT) as Row[]) {
    const key = itemKey(row.item_id, row.revision_no);
    let bucket = grouped.get(key);
    if (!bucket) grouped.set(key, (bucket = []));
    if (bucket.length === 0 || bucket[bucket.length - 1]["第几条"] !== row.position) {
      const kind = sourceKindNow(row.kind);
      const one: SourceRow = { 种类: kind, 出处: sourceLocatorNow(row.kind, row.locator), 摘录: row.excerpt, 第几条: row.position, 事件序号: row.event_seq, 支持: [] };
      if (kind === SOURCE_ITEM || kind === SOURCE_FIGURE) {
        one["依据的修订"] = migrated ? row.depends_revision ?? null
          : (revisionThen.get(taskId, String(row.locator).trim(), row.revision_no) as { no: number | null }).no;
      }
      if (row.kind === "用户的话") {
        const split = splitUserWordsLocator(row.locator);
        one["对话出处"] = split ? { 会话编号: split[0], 条目编号: split[1] } : null;
      }
      bucket.push(one);
    }
    if (fieldLevel && row.field !== null) bucket[bucket.length - 1]["支持"].push({ 字段: row.field, 第几项: row.field_index });
  }
  return grouped;
}
