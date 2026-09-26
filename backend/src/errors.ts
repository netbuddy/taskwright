/** 统一的错误形状：{"ok": false, "error": {"code", "message", "data"}}。 */

/** 错误码到 HTTP 状态码。not_found 用于任务、会话、条目或接口不存在；not_implemented 是这一版还没有接上的接口。 */
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
  not_implemented: 501,
  executor_starting: 503,
  executor_unavailable: 503,
  busy_timeout: 503,
  too_large: 413,
  unsupported_type: 415,
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
