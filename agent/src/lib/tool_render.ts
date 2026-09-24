/**
 * 两个工具在终端里怎样显示：「回复」（reply）与「保存修订」（save_revision）。
 *
 * 这里只把工具的参数与结果排成几行纯文字，不带颜色，也不依赖 pi。显示的地方有两处，都用这里同一份：
 *
 *   1. pi 的终端界面（TUI，交互模式）：hooks/tui_render.ts 给两个工具登记渲染器，渲染器调这里的函数，
 *      再加上颜色交给 pi 画成工具块；
 *   2. 后端的终端对话客户端 server/taskwright_server/chat.py：它是 Python，经命令行入口 cli/render.mts 调这里的函数，
 *      把得到的几行原样打印。
 *
 * 显示的内容全部来自工具的返回值与库里的事实，这里不判断内容好坏。
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databasePath, load } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";

/** 末位主行为的五种在屏幕上怎样称呼。 */
export const ACT_TITLES: Record<string, string> = {
  ask: "提问",
  confirm: "请确认",
  suggest: "给建议值",
  choose: "请选择",
  propose: "提议",
};

/** 提议预览里每一项对条目的影响怎样称呼。 */
export const EFFECT_TITLES: Record<string, string> = { remove: "删掉", add: "新增", change: "改动" };

/** 「回复」工具块的标题行。 */
export const REPLY_HEADING = "助手（经回复工具）：";

/** 「保存修订」工具块的标题行。 */
export const SAVE_HEADING = "保存修订";

type Dict = Record<string, any>;

const asList = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

/**
 * 一次合格的回复排成的几行：告知逐条在前，末位主行为按种类排成一张文字卡片，成文的话在最后。
 * 全部完整显示，不截短。不含标题行，标题行由调用方加（终端界面里它是工具块的第一行）。
 */
export function replyBodyLines(reply: Dict): string[] {
  const lines: string[] = [];
  const informs = asList(reply.informs);
  if (informs.length > 0) {
    lines.push("  告知：");
    for (const one of informs) lines.push(`    · ${asText(one)}`);
  }
  const act = reply.act;
  if (act && typeof act === "object") {
    const kind = asText(act.kind);
    lines.push(`  【${ACT_TITLES[kind] ?? kind}】${asText(act.text)}`);
    for (const item of asList(act.items)) {
      const revision = item?.revision_no;
      lines.push(`      条目 ${asText(item?.item_id)}` + (revision !== undefined && revision !== null ? `（修订 ${revision}）` : ""));
    }
    if (kind === "suggest") {
      lines.push(`      建议值：${asText(act.value)}`);
      for (const basis of asList(act.basis)) {
        lines.push(`      依据（${asText(basis?.kind)}，${asText(basis?.locator)}）：「${asText(basis?.excerpt)}」`);
      }
    }
    for (const option of asList(act.options)) lines.push(`      ${asText(option?.key)}. ${asText(option?.text)}`);
    for (const one of asList(act.preview)) {
      const effect = asText(one?.effect);
      lines.push(`      ${EFFECT_TITLES[effect] ?? effect}：${asText(one?.text)}`);
    }
  }
  lines.push("  成文的话：");
  const text = asText(reply.text);
  for (const line of text === "" ? [""] : text.split("\n")) lines.push(`    ${line}`);
  return lines;
}

/** 一次合格的回复连同标题行。chat.py 打印的就是这几行。 */
export function replyLines(reply: Dict): string[] {
  return [REPLY_HEADING, ...replyBodyLines(reply)];
}

/** 被拒的回复：说明没有送达，再把拒绝原因逐行照录。 */
export function replyRejectedLines(reason: string): string[] {
  return ["  回复被拒绝，没有送达。拒绝的原因是：", ...reasonLines(reason)];
}

/** 条目的标题：取集合声明里第一个字段的值，列表就用分号接起来。与观测台看板的取法一致。 */
export function titleOf(fields: Dict | null | undefined, firstField: string | undefined): string {
  if (!fields || !firstField) return "";
  const value = fields[firstField];
  if (Array.isArray(value)) return value.map(asText).join("；");
  return asText(value);
}

/** 保存修订的一个操作，取自工具返回值 details.operations。 */
export interface SavedOperation {
  op: string;
  item: string;
  collection?: string;
  /** 改前条目所在的修订；新增时为空。 */
  from_revision: number | null;
  /** 改后条目所在的修订，即这次修订；删除时为空。 */
  to_revision: number | null;
}

/**
 * 一次合格的保存修订排成的几行：修订号，然后每个操作一行，写明新增、修改、删除还是恢复了哪个条目，
 * 条目的编号与标题，改前条目在哪次修订。titles 给每个条目的标题（键是条目编号），取不到的条目只写编号。
 */
export function savedLines(details: Dict, titles: Record<string, string> = {}): string[] {
  const operations = asList(details.operations) as SavedOperation[];
  const undo = typeof details.undo_of_revision === "number" ? `，这是撤销修订 ${details.undo_of_revision}` : "";
  const lines = [
    `  已保存为任务 ${asText(details.task_id)} 的修订 ${asText(details.revision_no)}${undo}，` +
      `一共 ${operations.length} 个操作（事件序号 ${asText(details.event_seq)}）：`,
  ];
  for (const one of operations) {
    const title = titles[one.item] ? `「${titles[one.item]}」` : "";
    const name = `${one.item}${title}`;
    if (one.op === "add") {
      lines.push(`    新增 ${name}（集合「${asText(one.collection)}」）`);
    } else if (one.op === "update") {
      lines.push(`    修改 ${name}，修订 ${one.from_revision} → 修订 ${one.to_revision}`);
    } else if (one.op === "restore") {
      lines.push(`    恢复 ${name}，恢复成删除前的样子，修订 ${one.from_revision} → 修订 ${one.to_revision}`);
    } else if (one.op === "delete") {
      lines.push(`    删除 ${name}（删除前在修订 ${one.from_revision}）`);
    } else {
      lines.push(`    ${one.op} ${name}`);
    }
  }
  return lines;
}

/** 被拒的保存修订：说明什么都没有写入，再把拒绝原因逐行照录。 */
export function saveRejectedLines(reason: string): string[] {
  return ["  保存修订被拒绝，什么都没有写入。拒绝的原因是：", ...reasonLines(reason)];
}

function reasonLines(reason: string): string[] {
  const text = asText(reason).trim();
  return (text === "" ? ["（工具没有给出原因）"] : text.split("\n")).map((line) => `    ${line}`);
}

/**
 * 读库取一次保存修订涉及的每个条目的标题：新增与修改取改后的内容，删除取删除前的内容。
 * 库以只读方式打开；库不在、条目不在都不报错，只是取不到标题。
 */
export function titlesForOperations(workspaceDir: string, operations: SavedOperation[]): Record<string, string> {
  const path = databasePath(workspaceDir);
  const titles: Record<string, string> = {};
  if (operations.length === 0 || !existsSync(path) || statSync(path).size === 0) return titles;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      | { task_id: string; definition_text: string }
      | undefined;
    if (!task) return titles;
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const first = new Map(definition.collections.map((c) => [c.name, c.fields[0]?.name]));
    const itemRow = db.prepare("SELECT collection FROM item WHERE task_id = ? AND item_id = ?");
    const contentRow = db.prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no = ?");
    for (const one of operations) {
      const revision = one.op === "delete" ? one.from_revision : one.to_revision;
      if (revision === null || revision === undefined) continue;
      const item = itemRow.get(task.task_id, one.item) as { collection: string } | undefined;
      const row = contentRow.get(task.task_id, one.item, revision) as { fields: string } | undefined;
      if (!item || !row) continue;
      const title = titleOf(load(row.fields) as Dict, first.get(item.collection));
      if (title) titles[one.item] = title;
    }
  } catch {
    // 取不到标题不影响显示，只写编号。
  } finally {
    db?.close();
  }
  return titles;
}
