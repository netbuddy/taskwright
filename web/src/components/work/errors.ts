// 直接操作与说话被拒时给用户看的话。后端给了 message 就用后端的；几种前端必须自己说的补在这里。

import { ApiError } from "../../api/client";

export function errorText(error: ApiError): string {
  switch (error.code) {
    case "stale_revision": {
      // 安全网：只在两个页面同时编辑同一任务时触发，只提示，不合并。
      const items = (error.data.items as { item_id: string; current_revision?: number }[] | undefined) ?? [];
      const now = items[0]?.current_revision;
      return now != null ? `这条已被改到修订 ${now}，请重新打开。` : "这条刚被改过，请重新打开。";
    }
    case "session_busy":
      // 执行者在同一条会话里工作（对话严格轮替）与在另一条会话里工作，后端各给了说法。
      return error.data.reason === "working" ? (error.message || "助手正在工作，这一轮做完之后才能发下一句。")
        : "助手正在另一条会话里工作，做完才能在这里继续。";
    case "task_closed":
      return "这个任务已经结束，只能查看。";
    case "old_format":
      return error.message || "这个任务是旧格式（修订统一之前建的），现在的程序不支持。请新建一个任务。";
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
