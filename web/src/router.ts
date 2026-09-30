// 各页的地址，用井号路由，不引入路由库：
//   #/tasks                                  任务列表页
//   #/tasks/{task_id}                        任务页
//   #/tasks/{task_id}/sessions/{session_id}  工作视图
//   #/knowledge 与 #/knowledge/{库编号}       知识库页面（带库编号时选中那个库）
import { useEffect, useState } from "react";

export type Route =
  | { page: "tasks" }
  | { page: "task"; taskId: string }
  | { page: "work"; taskId: string; sessionId: string }
  | { page: "knowledge"; libraryId: string | null };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "tasks" && parts[1] && parts[2] === "sessions" && parts[3]) {
    return { page: "work", taskId: parts[1], sessionId: parts[3] };
  }
  if (parts[0] === "tasks" && parts[1]) return { page: "task", taskId: parts[1] };
  if (parts[0] === "knowledge") return { page: "knowledge", libraryId: parts[1] ?? null };
  return { page: "tasks" };
}

export const href = {
  tasks: () => "#/tasks",
  task: (taskId: string) => `#/tasks/${encodeURIComponent(taskId)}`,
  work: (taskId: string, sessionId: string) =>
    `#/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`,
  knowledge: (libraryId?: string | null) => (libraryId ? `#/knowledge/${encodeURIComponent(libraryId)}` : "#/knowledge"),
};

export function go(to: string) {
  window.location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
