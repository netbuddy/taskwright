/**
 * 工具、界面操作的 kind 与后端写接口各自对应到操作名单（operations.ts）的哪一行。
 * 每个工具文件（tools/*.ts）、USER_OP_KINDS 的每个值、不在 USER_OP_KINDS 里的另几个界面操作的 kind（定义在 user_ops.ts、
 * user_stage.ts 与 user_diagram.ts 里，名字以 _KIND 结尾的常量）、后端每个 POST 接口，要么在 OPERATION_MAP 里对应恰好一行，
 * 要么在 NOT_IN_TABLE 里写明为什么不对应任何一行；两边不重复。后端的 GET 接口都只读，不列。
 * 后端接口按 backend/src/http.ts 路由表里的名字写，数据包导入不在路由表里，按它的路径写。
 *
 * 这一份只是数据：现在没有代码按它分派，改了工具或接口要同步这里，tests/operations_guard.test.ts 核对齐全。
 */

import type { OperationName } from "./operations.ts";
import type { UserOpKind } from "./user_ops.ts";

export interface Mapped {
  operation: OperationName;
  note?: string;
}

/**
 * 不对应任何一行的理由：
 * - read_only：只读或不产生记录；
 * - outside_task：不写任务库，在任务世界之外；
 * - pending：写任务目录，但名单里还没有对应的行，待定；
 * - dispatch：按请求体里的 kind 分派，各个 kind 的归属见 USER_OP_KINDS 那一组。
 */
export type Reason = "read_only" | "outside_task" | "pending" | "dispatch";

export interface Unmapped {
  reason: Reason;
  note?: string;
}

export const OPERATION_MAP: {
  tools: Record<string, Mapped>;
  user_op_kinds: Partial<Record<UserOpKind, Mapped>>;
  other_user_op_kinds: Record<string, Mapped>;
  backend: Record<string, Mapped>;
} = {
  tools: {
    save_revision: { operation: "write_item", note: "write_problem 与 write_page 两行现在也由这个工具写：一个工具写全部集合" },
    save_diagram: { operation: "write_diagram" },
    request_review: { operation: "write_review", note: "工具只发起评审，评审结论由评审者写" },
    reply: { operation: "reply" },
    publish_version: { operation: "publish", note: "待撤：发布改由用户点按钮、程序生成，以后撤掉这个工具" },
  },
  user_op_kinds: {
    edit_fields: { operation: "edit_content" },
    delete_item: { operation: "edit_content" },
    undo: { operation: "edit_content" },
    mark_viewed: { operation: "confirm" },
    keep_pending: { operation: "settle_problem", note: "用户选择把这一项留着、不再追究" },
    waive_review: { operation: "waive" },
    unwaive_review: { operation: "waive", note: "撤销豁免" },
    publish_version: { operation: "publish" },
    move_stage: { operation: "transition" },
    start_activity: { operation: "start" },
    continue_activity: { operation: "start", note: "换一条会话接着做进行中的工作项" },
  },
  other_user_op_kinds: {
    request_review: { operation: "write_review", note: "发起者是用户：在界面上点评审；与工具 request_review 那一行并存" },
    stop_run: { operation: "stop" },
    continue_stage: { operation: "transition" },
    edit_diagram: { operation: "edit_content" },
    mark_diagram_viewed: { operation: "confirm" },
  },
  backend: {
    publish_version: { operation: "publish" },
    archive_version: { operation: "publish", note: "待撤：助手的发布工具先调它存下文档，随那个工具一起撤" },
    control: { operation: "stop" },
  },
};

export const NOT_IN_TABLE: {
  tools: Record<string, Unmapped>;
  user_op_kinds: Partial<Record<UserOpKind, Unmapped>>;
  other_user_op_kinds: Record<string, Unmapped>;
  backend: Record<string, Unmapped>;
} = {
  tools: {
    get_item: { reason: "read_only" },
    get_task_status: { reason: "read_only" },
    search_knowledge: { reason: "read_only" },
  },
  user_op_kinds: {
    set_review_rules: { reason: "pending", note: "改这个任务的评审规矩" },
    delete_work_item: { reason: "pending", note: "删除即归档这个工作项" },
  },
  other_user_op_kinds: {},
  backend: {
    search_knowledge: { reason: "read_only" },
    messages: { reason: "read_only", note: "用户发话是运行的输入，进会话历史不进任务库，不产生记录" },
    service_exit: { reason: "outside_task" },
    service_upgrade_start: { reason: "outside_task" },
    model_provider_add: { reason: "outside_task" },
    model_provider_update: { reason: "outside_task" },
    model_provider_delete: { reason: "outside_task" },
    model_provider_check: { reason: "outside_task" },
    model_provider_fetch: { reason: "outside_task" },
    model_provider_refresh: { reason: "outside_task" },
    model_provider_context: { reason: "outside_task" },
    model_selection: { reason: "outside_task" },
    model_test: { reason: "outside_task" },
    debug_prompt_dir_set: { reason: "outside_task" },
    upload_limits_set: { reason: "outside_task" },
    validate_diagram: { reason: "outside_task", note: "只核对图的写法，不写库" },
    documents: { reason: "outside_task", note: "文档的预览与下载，不写库" },
    embed_knowledge: { reason: "outside_task" },
    create_library: { reason: "outside_task" },
    rename_library: { reason: "outside_task" },
    delete_library: { reason: "outside_task" },
    upload_document: { reason: "outside_task" },
    delete_document: { reason: "outside_task" },
    "/api/v1/knowledge/import": { reason: "outside_task", note: "导入知识库的数据包" },
    create_task: { reason: "pending" },
    delete_task: { reason: "pending" },
    new_session: { reason: "pending", note: "带工作项的记录号时另做一次 continue_activity" },
    upload: { reason: "pending", note: "上传材料" },
    delete_material: { reason: "pending" },
    replace_material: { reason: "pending" },
    set_task_knowledge: { reason: "pending" },
    "/api/v1/tasks/import": { reason: "pending", note: "导入任务的数据包" },
    actions: { reason: "dispatch" },
  },
};
