// 各页的地址，用井号路由，不引入路由库：
//   #/tasks                                  任务列表页
//   #/tasks/{task_id}                        任务起点页
//   #/tasks/{task_id}/start/{键}             活动输入页：键是一条工作流程或一项单项活动的键；后面可以带 ?case=序号，
//                                            是从起点页三种常见起点里的第几种进来的（从 0 起），输入页据此先看那一块；
//                                            澄清的输入页还可以带 ?pick=编号,编号，是从起点页「待处理事项」进来时预先勾好的问题与待决定事项
//   #/tasks/{task_id}/sessions/{session_id}  工作视图；后面可以带 ?collection=集合名，条目区一打开就停在这个集合的页签；
//                                            ?tab=diagrams 停在「分析模型」页签（全部图的索引），?diagram=D-001 打开那张图在业务说明里
//                                            所在的节或章首（图不是集合，不借用 collection）
//   #/knowledge 与 #/knowledge/{库编号}       知识库页面（带库编号时选中那个库）
//   #/settings、#/settings/models            设置页面的「模型」一栏（设置页面现在只有这一栏）
import { useEffect, useState } from "react";

export type Route =
  | { page: "tasks" }
  | { page: "task"; taskId: string }
  | { page: "start"; taskId: string; key: string; startCase: number | null; pick?: string[] }
  | { page: "work"; taskId: string; sessionId: string; collection: string | null; diagrams: boolean; diagram: string | null }
  | { page: "knowledge"; libraryId: string | null }
  | { page: "settings"; section: "models" };

export function parseRoute(hash: string): Route {
  // 问号之后是参数（工作视图的 collection、tab、diagram，活动输入页的 case 与 pick），先分出来再按斜杠拆路径。
  const mark = hash.indexOf("?");
  const query = new URLSearchParams(mark < 0 ? "" : hash.slice(mark + 1));
  const parts = (mark < 0 ? hash : hash.slice(0, mark)).replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "tasks" && parts[1] && parts[2] === "sessions" && parts[3]) {
    return { page: "work", taskId: parts[1], sessionId: parts[3], collection: query.get("collection") || null,
      diagrams: query.get("tab") === "diagrams", diagram: query.get("diagram") || null };
  }
  if (parts[0] === "tasks" && parts[1] && parts[2] === "start" && parts[3]) {
    const startCase = query.get("case");
    const pick = (query.get("pick") ?? "").split(",").map((one) => one.trim()).filter(Boolean);
    return { page: "start", taskId: parts[1], key: parts[3], startCase: startCase !== null && /^[0-9]+$/.test(startCase) ? Number(startCase) : null,
      ...(pick.length ? { pick } : {}) };
  }
  if (parts[0] === "tasks" && parts[1]) return { page: "task", taskId: parts[1] };
  if (parts[0] === "knowledge") return { page: "knowledge", libraryId: parts[1] ?? null };
  if (parts[0] === "settings") return { page: "settings", section: "models" };
  return { page: "tasks" };
}

export const href = {
  tasks: () => "#/tasks",
  task: (taskId: string) => `#/tasks/${encodeURIComponent(taskId)}`,
  /** 活动输入页；startCase 是从三种常见起点里的第几种进来的，pick 是预先勾好的问题与待决定事项的编号（澄清的输入页用）。 */
  start: (taskId: string, key: string, startCase?: number | null, pick?: string[]) => {
    const query = [startCase === undefined || startCase === null ? "" : `case=${startCase}`, pick?.length ? `pick=${pick.map(encodeURIComponent).join(",")}` : ""].filter(Boolean);
    return `#/tasks/${encodeURIComponent(taskId)}/start/${encodeURIComponent(key)}${query.length ? `?${query.join("&")}` : ""}`;
  },
  work: (taskId: string, sessionId: string, collection?: string | null) =>
    `#/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}${collection ? `?collection=${encodeURIComponent(collection)}` : ""}`,
  /** 工作视图里看图的地址；给了图的编号就直接打开那张图。 */
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
