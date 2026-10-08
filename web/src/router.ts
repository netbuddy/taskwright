// 各页的地址，用井号路由，不引入路由库：
//   #/tasks                                  任务列表页
//   #/tasks/{task_id}                        任务页
//   #/tasks/{task_id}/sessions/{session_id}  工作视图；后面可以带 ?collection=集合名，条目区一打开就停在这个集合的页签；
//                                            ?tab=diagrams 停在图表页签，?diagram=D-001 直接打开那张图（图表不是集合，不借用 collection）
//   #/knowledge 与 #/knowledge/{库编号}       知识库页面（带库编号时选中那个库）
//   #/settings、#/settings/models            设置页面的「模型」一栏（设置页面现在只有这一栏）
import { useEffect, useState } from "react";

export type Route =
  | { page: "tasks" }
  | { page: "task"; taskId: string }
  | { page: "work"; taskId: string; sessionId: string; collection: string | null; diagrams: boolean; diagram: string | null }
  | { page: "knowledge"; libraryId: string | null }
  | { page: "settings"; section: "models" };

export function parseRoute(hash: string): Route {
  // 问号之后是参数（现在只有工作视图的 collection），先分出来再按斜杠拆路径。
  const mark = hash.indexOf("?");
  const query = new URLSearchParams(mark < 0 ? "" : hash.slice(mark + 1));
  const parts = (mark < 0 ? hash : hash.slice(0, mark)).replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "tasks" && parts[1] && parts[2] === "sessions" && parts[3]) {
    return { page: "work", taskId: parts[1], sessionId: parts[3], collection: query.get("collection") || null,
      diagrams: query.get("tab") === "diagrams", diagram: query.get("diagram") || null };
  }
  if (parts[0] === "tasks" && parts[1]) return { page: "task", taskId: parts[1] };
  if (parts[0] === "knowledge") return { page: "knowledge", libraryId: parts[1] ?? null };
  if (parts[0] === "settings") return { page: "settings", section: "models" };
  return { page: "tasks" };
}

export const href = {
  tasks: () => "#/tasks",
  task: (taskId: string) => `#/tasks/${encodeURIComponent(taskId)}`,
  work: (taskId: string, sessionId: string, collection?: string | null) =>
    `#/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}${collection ? `?collection=${encodeURIComponent(collection)}` : ""}`,
  /** 工作视图的图表页签；给了图的编号就直接打开那张图。 */
  diagrams: (taskId: string, sessionId: string, diagramId?: string | null) =>
    `#/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}?${diagramId ? `diagram=${encodeURIComponent(diagramId)}` : "tab=diagrams"}`,
  knowledge: (libraryId?: string | null) => (libraryId ? `#/knowledge/${encodeURIComponent(libraryId)}` : "#/knowledge"),
  settings: () => "#/settings/models",
};

/** 进设置页面之前所在的页面：设置页面左上角的「回到任务」回到这里；直接打开设置页面时回到任务列表页。 */
let beforeSettings: string | null = null;

/** 进设置页面，记下现在所在的页面。 */
export function openSettings() {
  if (!window.location.hash.startsWith("#/settings")) beforeSettings = window.location.hash || null;
  go(href.settings());
}

/** 设置页面的「回到任务」要去的地址。 */
export function leaveSettingsHref(): string {
  return beforeSettings ?? href.tasks();
}

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
