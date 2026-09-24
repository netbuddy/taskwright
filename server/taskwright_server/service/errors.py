"""统一的错误形状：{"ok": false, "error": {"code", "message", "data"}}。"""

from __future__ import annotations

#: 错误码到 HTTP 状态码。not_found 是约定之外补的一个（任务、会话、条目不存在时用）。
STATUS = {
    "bad_request": 400,
    "not_found": 404,
    "rejected": 422,
    "stale_revision": 409,
    "old_format": 409,
    "undo_conflict": 409,
    "task_closed": 409,
    "no_task": 409,
    "session_busy": 409,
    "executor_starting": 503,
    "executor_unavailable": 503,
    "busy_timeout": 503,
    "too_large": 413,
    "unsupported_type": 415,
}


class ApiError(Exception):
    """接口拒绝一个请求。message 是给用户看的一句中文。"""

    def __init__(self, code: str, message: str, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}

    @property
    def status(self) -> int:
        return STATUS.get(self.code, 500)

    def body(self) -> dict:
        return {"ok": False, "error": {"code": self.code, "message": self.message, "data": self.data}}
