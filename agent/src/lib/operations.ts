/**
 * 操作名单：会产生记录的动作，一行一个，是封闭的名单。名单之外的动作（读取、任务世界之外的管理）不是操作。
 * 每一列：
 * - initiator：谁发起，user、assistant 或 program；
 * - acts_on：作用于什么；
 * - record：落下哪一类记录，decision（决策记录，发起者只能是用户）、revision（修订与来源）或 event（事件）；
 * - place：在哪里可以发起，anywhere（任何位置）、activity-bound（受本会话活动实例可写的条目类型限制）或 user-only（只由用户在界面上发起）。
 *
 * 这一份只是数据，现在没有代码按它分派。工具、界面操作的 kind 与后端的写接口各自对应到哪一行，见 operations_map.ts，
 * 由 tests/operations_guard.test.ts 核对齐全。
 */

export type Initiator = "user" | "assistant" | "program";
export type RecordClass = "decision" | "revision" | "event";
export type Place = "anywhere" | "activity-bound" | "user-only";

export interface Operation {
  name: string;
  initiator: Initiator;
  acts_on: string;
  record: RecordClass;
  place: Place;
}

export const OPERATIONS = [
  { name: "write_page", initiator: "assistant", acts_on: "item", record: "revision", place: "activity-bound" },
  { name: "write_problem", initiator: "assistant", acts_on: "item", record: "revision", place: "anywhere" },
  { name: "write_diagram", initiator: "assistant", acts_on: "diagram", record: "revision", place: "activity-bound" },
  { name: "write_item", initiator: "assistant", acts_on: "item", record: "revision", place: "activity-bound" },
  { name: "write_review", initiator: "assistant", acts_on: "review", record: "revision", place: "activity-bound" },
  { name: "reply", initiator: "assistant", acts_on: "session", record: "event", place: "anywhere" },
  { name: "write_understanding", initiator: "assistant", acts_on: "session", record: "event", place: "anywhere" },
  // 新增、修改、删除与撤销修订都是这一行。
  { name: "edit_content", initiator: "user", acts_on: "item", record: "revision", place: "anywhere" },
  // 查看与接受都是这一行。
  { name: "confirm", initiator: "user", acts_on: "item_revision", record: "decision", place: "user-only" },
  { name: "waive", initiator: "user", acts_on: "review_finding", record: "decision", place: "user-only" },
  // 用户在卡片上点，修订由助手写。
  { name: "settle_problem", initiator: "user", acts_on: "problem_item", record: "decision", place: "anywhere" },
  { name: "start", initiator: "user", acts_on: "task", record: "decision", place: "user-only" },
  { name: "transition", initiator: "user", acts_on: "work_item", record: "decision", place: "user-only" },
  { name: "publish", initiator: "user", acts_on: "task", record: "decision", place: "user-only" },
  { name: "stop", initiator: "user", acts_on: "run", record: "event", place: "anywhere" },
  { name: "update_task_type", initiator: "user", acts_on: "task_type_copy", record: "event", place: "user-only" },
  { name: "load_task_type", initiator: "program", acts_on: "task_type", record: "event", place: "anywhere" },
  { name: "assemble_prompt", initiator: "program", acts_on: "run", record: "event", place: "anywhere" },
  { name: "generate", initiator: "program", acts_on: "deliverable", record: "event", place: "anywhere" },
  { name: "recheck_review", initiator: "program", acts_on: "review", record: "event", place: "anywhere" },
  { name: "supervise_abort", initiator: "program", acts_on: "run", record: "event", place: "anywhere" },
  { name: "verify_run", initiator: "program", acts_on: "run", record: "event", place: "anywhere" },
  { name: "rerun", initiator: "program", acts_on: "work_item", record: "event", place: "anywhere" },
] as const satisfies readonly Operation[];

export type OperationName = (typeof OPERATIONS)[number]["name"];
