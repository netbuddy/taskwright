/**
 * 对话行为表的建表语句，以及对话理解给已有两张表加的两列。schema.ts 的 ensureSchema 调用这里的 ensureDialogueSchema，
 * 新库与旧库都经它补齐：表用 IF NOT EXISTS，列缺哪列补哪列，只加不改，已有的数据不动。
 *
 * 单独成文件、不写进 schema.ts，是为了让对话理解的库表改动集中在一处；本文件不导入任何别的模块。
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * 对话行为表：用户与执行者在会话里的对话行为，一项一行。
 *
 * 用户的行为有两个来处：执行者每轮第一段写的理解（origin 为 understanding），以及界面点击、「这几条都看过了」
 * 「先不管」之后系统替用户发的那句固定的话（origin 为 ui，由扩展按界面操作的事实直接写，执行者不写理解）。
 * 执行者的行为由「回复」工具写（origin 为 reply）：每条告知一行 inform，末位主行为一行。
 * 编号是「运行号-序号」，运行号是这条会话当前分支上第几句用户的话（r1 起），序号在一次运行里从 1 起，
 * 用户与执行者共用一个序号。「期待已满足」不存，现算：有用户行为的 responds_to 指向它就算满足。
 */
export const DIALOGUE_ACT_SQL = `
CREATE TABLE IF NOT EXISTS dialogue_act (
  task_id           TEXT NOT NULL,     -- 所属任务的任务编号
  session_id        TEXT NOT NULL,     -- 所在的 pi 会话编号
  act_id            TEXT NOT NULL,     -- 对话行为的编号：运行号-序号，例如 r13-2；同一会话里唯一
  run_id            TEXT NOT NULL,     -- 运行号：这条会话当前分支上第几句用户的话，例如 r13
  speaker           TEXT NOT NULL CHECK (speaker IN ('user', 'executor')),  -- 谁的行为
  function          TEXT NOT NULL,     -- 功能：用户侧九种，执行者侧告知 inform 与五种主行为，取值见 agent/prompts/schemas/user_intent.schema.json
  targets           TEXT NOT NULL,     -- 针对的条目与位置（JSON 列表，每项是 item_id，可带 field、index），可以是空列表
  responds_to       TEXT,              -- 回应的是哪一条对话行为的编号；没有为空
  expects_response  INTEGER NOT NULL CHECK (expects_response IN (0, 1)),  -- 是否期待回应：执行者的五种主行为为 1，告知与用户的行为为 0
  confidence        TEXT CHECK (confidence IN ('high', 'medium', 'low')),  -- 用户侧由执行者填的把握；执行者侧为空
  summary           TEXT NOT NULL,     -- 一句话内容摘要
  source_entry      TEXT,              -- 会话条目编号：用户侧是那句用户的话，执行者侧是调用「回复」的那条助手消息
  origin            TEXT NOT NULL CHECK (origin IN ('understanding', 'ui', 'reply')),  -- 怎样记下的：执行者写的理解、界面操作合成、回复工具
  event_seq         INTEGER NOT NULL,  -- 记下这一行的那条事件的序号
  created_at        TEXT NOT NULL,     -- 时刻（本地时间）
  PRIMARY KEY (task_id, session_id, act_id)
);
`;

/** 对话理解给已有的表加的列：表名、列名、类型。新库的建表语句里已经带着，旧库打开时补上。 */
export const DIALOGUE_ADDED_COLUMNS = [
  ["revision", "intent_act_id", "TEXT"],
  ["item_source", "normalized_value", "TEXT"],
] as const;

/** 建对话行为表、补两列。必须在调用方已经开好的事务里调用（ensureSchema 就是这样调用的）。 */
export function ensureDialogueSchema(db: DatabaseSync): void {
  db.exec(DIALOGUE_ACT_SQL);
  for (const [table, column, type] of DIALOGUE_ADDED_COLUMNS) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
    if (columns.length > 0 && !columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** 某张表有没有某一列。只读的一侧（查询工具、现状消息）遇到还没补过列的旧库时据此跳过。 */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
}

/** 库里有没有对话行为表。 */
export function hasDialogueTable(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dialogue_act'").get() !== undefined;
}
