/**
 * 图：任务的一种要素（另一种是条目）。这里放图的种类、编号的写法、从库里读图，以及「图里画了哪些条目」的扫法。
 * 只读，不写库；写库在 lib/save_diagram.ts。库表见 lib/schema.ts 的 DIAGRAM_SQL。
 *
 * 图的修订号是这张图自己的（从 1 起连续），与任务的修订序号无关。一张图现在的样子是它修订号最大的那一行内容；
 * 删除也记一行（内容照删除之前的样子）。
 *
 * 图里画了哪些条目：助手按说明把条目编号写在节点的文字里（例如 `r1(["REQ-001 提交申请"])`）。五种图里节点名字能用的字符
 * 各不相同（有的不许连字符），所以不认节点的名字，只在整段 Mermaid 文本里找「集合的编号前缀-数字」形状的词，
 * 再到条目表里对。这是从文本里扫出来的补充视图，不存库；图依据了哪些条目以它的来源为准。
 *
 * 本模块不依赖 pi，后端与单元测试可以直接调用。
 */

import type { DatabaseSync } from "node:sqlite";

/** 图的编号前缀。图的编号是 D- 加三位流水号，例如 D-001；新建任务时集合的编号前缀不许单写它。 */
export const DIAGRAM_PREFIX = "D";
/** 图的编号的形状。 */
export const DIAGRAM_ID = /^D-\d{3,}$/;

/** 图的五个种类（与任务服务的校验模块 backend/src/diagram_validate.ts 的 DIAGRAM_KINDS 是一份约定，有测试核对两边相同）。 */
export const DIAGRAM_KINDS = ["use_case", "class", "state", "sequence", "flowchart"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
export const DIAGRAM_KIND_NAMES: Record<DiagramKind, string> = { use_case: "用例图", class: "类图", state: "状态图", sequence: "时序图", flowchart: "流程图" };

/** 种类的中文名；认不出的照原样。 */
export const kindName = (kind: string): string => (DIAGRAM_KIND_NAMES as Record<string, string>)[kind] ?? kind;

/** 图的编号：D- 加三位流水号。 */
export const diagramId = (serial: number): string => `${DIAGRAM_PREFIX}-${String(serial).padStart(3, "0")}`;

/** 图在它自己的某次修订下的内容。 */
export interface DiagramVersion {
  revision_no: number;
  op: "add" | "update" | "delete";
  name: string;
  kind: string;
  mermaid: string;
  note: string;
  actor: string;
  session_id: string;
  call_id: string;
  created_at: string;
  event_seq: number;
}

/** 一张图：身份，加它的每次修订（从早到晚）。 */
export interface DiagramRecord {
  diagram_id: string;
  serial: number;
  /** 在它自己的第几次修订里删除，没删为 null。 */
  deleted_in_revision: number | null;
  versions: DiagramVersion[];
}

/** 库里有没有图的两张表。还没有被写入一侧打开过的旧库没有。 */
export function hasDiagramTables(db: DatabaseSync): boolean {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('diagram', 'diagram_version')").all() as { name: string }[]).map((row) => row.name);
  return names.includes("diagram") && names.includes("diagram_version");
}

/** 任务里的全部图（删掉的也在），按流水号排；库里还没有图的表时是空列表。 */
export function readDiagrams(db: DatabaseSync, taskId: string): DiagramRecord[] {
  if (!hasDiagramTables(db)) return [];
  const rows = db.prepare("SELECT diagram_id, serial, deleted_in_revision FROM diagram WHERE task_id = ? ORDER BY serial").all(taskId) as
    { diagram_id: string; serial: number; deleted_in_revision: number | null }[];
  const versions = db.prepare(
    "SELECT diagram_id, revision_no, op, name, kind, mermaid, note, actor, session_id, call_id, created_at, event_seq FROM diagram_version " +
      "WHERE task_id = ? ORDER BY diagram_id, revision_no",
  ).all(taskId) as unknown as (DiagramVersion & { diagram_id: string })[];
  const byId = new Map<string, DiagramVersion[]>();
  for (const { diagram_id: id, ...version } of versions) {
    let list = byId.get(id);
    if (!list) byId.set(id, (list = []));
    list.push(version);
  }
  return rows.map((row) => ({ diagram_id: row.diagram_id, serial: row.serial, deleted_in_revision: row.deleted_in_revision, versions: byId.get(row.diagram_id) ?? [] }));
}

/** 一张图现在的内容：它修订号最大的那一行；一行都没有时为 null（库数据异常）。 */
export const latestVersion = (record: DiagramRecord): DiagramVersion | null => record.versions[record.versions.length - 1] ?? null;

/** 还在的图（没有删除的），按流水号排。 */
export const liveDiagrams = (records: DiagramRecord[]): DiagramRecord[] =>
  records.filter((one) => one.deleted_in_revision === null && one.versions.length > 0);

/**
 * Mermaid 文本里出现的条目编号，按第一次出现的先后，不重复。prefixes 是任务定义里各集合的编号前缀。
 * 认的是「前缀-至少三位数字」，前后不能紧挨着英文字母或数字（UC-0012 与 XUC-001 都不算 UC-001）。
 */
export function drawnItemIds(mermaid: string, prefixes: readonly string[]): string[] {
  const usable = prefixes.filter((one) => /^[A-Z][A-Z0-9]*$/.test(one)).sort((a, b) => b.length - a.length);
  if (usable.length === 0) return [];
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${usable.join("|")})-\\d{3,}(?![A-Za-z0-9])`, "g");
  const out: string[] = [];
  for (const hit of mermaid.match(pattern) ?? []) if (!out.includes(hit)) out.push(hit);
  return out;
}
