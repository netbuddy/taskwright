/** 统一的错误形状：{"ok": false, "error": {"code", "message", "data"}}。 */

/** 错误码到 HTTP 状态码。not_found 用于任务、会话、条目或接口不存在；forbidden 是只接受本机请求的接口收到了别处来的请求。 */
export const STATUS: Record<string, number> = {
  bad_request: 400,
  not_found: 404,
  rejected: 422,
  stale_revision: 409,
  old_format: 409,
  undo_conflict: 409,
  task_closed: 409,
  no_task: 409,
  session_busy: 409,
  task_occupied: 409,
  forbidden: 403,
  executor_starting: 503,
  executor_unavailable: 503,
  session_resume_failed: 503,
  busy_timeout: 503,
  too_large: 413,
  duplicate_content: 409,
  name_taken: 409,
  unsupported_type: 415,
  // 模型配置（docs/api.md §10）：选中的模型属于这个服务或者正要停用它；共用配置文件不能改写；共用配置文件的锁等不到。
  in_use: 409,
  config_unwritable: 409,
  config_locked: 503,
  // 测试模型（docs/api.md §10）：已经有一个测试在跑。
  busy: 409,
  // 知识库按意思查找（docs/api.md §11）：换算要找的那句话时模型服务出了事（连不上、到时间没有回答、回答了错误）。
  embedding_failed: 502,
};

/** 接口拒绝一个请求。message 是给用户看的一句中文。 */
export class ApiError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;

  constructor(code: string, message: string, data?: Record<string, unknown> | null) {
    super(message);
    this.code = code;
    this.data = data ?? {};
  }

  get status(): number {
    return STATUS[this.code] ?? 500;
  }

  body() {
    return { ok: false, error: { code: this.code, message: this.message, data: this.data } };
  }
}
