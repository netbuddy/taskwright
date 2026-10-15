// 打开一条会话、整份数据一时读不到时的等待：哪几种错误过一会儿自然会好、隔多久再读、等待期间页面上写什么。
// useWorkView 按这里的规矩自动再读，工作视图按这里的文字显示。

/** 读整份数据被拒、过一会儿自然会好的两种错误码：隔 SNAPSHOT_RETRY_MS 自动再读。 */
export const SNAPSHOT_RETRY_CODES = ["executor_starting", "session_busy"];
export const SNAPSHOT_RETRY_MS = 3000;
/** 整份数据还没有读到、事件流说助手正在启动时，对话区的那句（打开会话时任务服务要先启动助手，可能要几十秒）。 */
export const STARTING_WAIT_TEXT = "助手正在启动，请稍候。";

/** 自动再读期间整页显示的那句；不是这两种错误时为 null（照旧写「读不到这条会话的数据」）。 */
export function snapshotRetryText(code: string | null | undefined): string | null {
  if (code === "executor_starting") return "助手正在启动，几秒后自动重试。";
  if (code === "session_busy") return "助手正在另一条会话里工作，做完之后自动打开这条会话。";
  return null;
}
