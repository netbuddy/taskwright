/**
 * 图：任务的一种要素（另一种是条目）。这里放图的种类、编号的写法、从库里读图，以及「图里画了哪些条目」的扫法。
 * 只读，不写库；写库在 lib/save_diagram.ts。库表见 lib/schema.ts 的 DIAGRAM_SQL。从 Mermaid 文本里扫东西的几个函数在 lib/diagram_scan.ts。
 *
 * 图的修订号是这张图自己的（从 1 起连续），与任务的修订序号无关。一张图现在的样子是它修订号最大的那一行内容；
 * 删除也记一行（内容照删除之前的样子）。
 *
 * 图里画了哪些条目：助手按说明把条目编号写在节点的文字里（例如 `r1(["REQ-001 提交申请"])`）。各种图里节点名字能用的字符
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

/**
 * 图的六个种类（与任务服务的校验模块 backend/src/diagram_validate.ts 的 DIAGRAM_KINDS 是一份约定，有测试核对两边相同）。
 * context 是系统边界图：系统画成一个子图，外面是与它打交道的角色与外部系统；class 是对象关系图，用 Mermaid 的类图写法画。
 * 库里不检查种类（见 lib/schema.ts 的 diagramVersionSql），有哪几种以这里为准。
 */
export const DIAGRAM_KINDS = ["context", "use_case", "class", "state", "sequence", "flowchart"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
export const DIAGRAM_KIND_NAMES: Record<DiagramKind, string> = {
  context: "系统边界图", use_case: "用例图", class: "对象关系图", state: "状态图", sequence: "时序图", flowchart: "流程图",
};

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

/** 任务里的全部图（删掉的也在），按流水号排。 */
export function readDiagrams(db: DatabaseSync, taskId: string): DiagramRecord[] {
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

/** Mermaid 文本里出现的条目编号：算法在 lib/diagram_scan.ts（那个文件不碰库，页面也可以导入），这里照旧给出这个名字。 */
export { drawnItemIds } from "./diagram_scan.ts";

// ───────────── 用户看没看过一张图 ─────────────

/**
 * 用户打开看过一张图时记的事件（界面操作 mark_diagram_viewed，lib/user_diagram.ts）。内容是 { diagrams: [{ diagram_id, revision_no }] }：
 * 看的是哪张图、当时它是第几次修订。图的看过只记成事件，不另设表：条目的确认标记表（judgement_item）指到的每一行都要在条目内容表里，
 * 放不下图。
 */
export const EVENT_DIAGRAM_VIEWED = "DIAGRAM_VIEWED";

const viewKey = (diagramId: string, revisionNo: number): string => `${diagramId}\u0000${revisionNo}`;

/** 任务里用户看过的「图加修订」：每项是图的编号与修订号拼成的键（见 diagramViewed）。一条这样的事件都没有时是空集合。 */
export function viewedDiagramRevisions(db: DatabaseSync, taskId: string): Set<string> {
  const rows = db.prepare("SELECT payload FROM event WHERE task_id = ? AND name = ? ORDER BY seq").all(taskId, EVENT_DIAGRAM_VIEWED) as { payload: string }[];
  const seen = new Set<string>();
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const list = (payload as { diagrams?: unknown } | null)?.diagrams;
    if (!Array.isArray(list)) continue;
    for (const one of list as { diagram_id?: unknown; revision_no?: unknown }[]) {
      if (typeof one?.diagram_id === "string" && Number.isInteger(one.revision_no)) seen.add(viewKey(one.diagram_id, one.revision_no as number));
    }
  }
  return seen;
}

/**
 * 用户看没看过一张图现在的内容，与条目的判法相同（lib/overall_analysis.ts 的 viewedIn）：从最近一次不是用户亲手改出来的修订起、
 * 到它现在的修订为止的这一段里，有一次修订用户打开看过。用户看过之后自己再改，仍算看过；助手又改出新的修订，就要再看一次；
 * 用户亲手改不等于看过。seen 是 viewedDiagramRevisions 读出来的集合。
 */
export function diagramViewed(record: DiagramRecord, seen: ReadonlySet<string>): boolean {
  let from = 0;
  record.versions.forEach((one, index) => {
    if (one.actor !== "user") from = index;
  });
  return record.versions.slice(from).some((one) => seen.has(viewKey(record.diagram_id, one.revision_no)));
}
