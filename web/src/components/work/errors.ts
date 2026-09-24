// 直接操作与说话被拒时给用户看的话。后端给了 message 就用后端的；几种前端必须自己说的补在这里。

import { ApiError } from "../../api/client";

export function errorText(error: ApiError): string {
  switch (error.code) {
    case "stale_version":
      return "这个条目刚被改过（可能是助手，也可能是另一个页面），请看最新内容后再改。";
    case "session_busy":
      return "执行者正在另一条会话里工作，做完才能在这里继续。";
    case "task_closed":
      return "这个任务已经结束，只能查看。";
    case "timeout":
      return "这次修改还没有得到确认，请稍后看是否已经生效。";
    case "executor_unavailable":
      return error.message || "助手现在不可用。";
    case "busy_timeout":
      return "数据库正忙，请稍后再试。";
    case "not_found":
      return error.message || "要找的任务、会话或条目不存在。";
    case "bad_request":
      return "出了一点问题，这次操作没有完成。";
    default:
      return error.message || "这次操作没有完成。";
  }
}
