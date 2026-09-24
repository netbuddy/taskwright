// 跟后端读取接口打交道的地方。只有读，没有写。

async function get(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(value["出错了"] || `读取接口 ${path} 回了 ${response.status}`);
  }
  return value;
}

export const api = {
  overview: () => get("/api/overview"),
  sessions: () => get("/api/sessions"),
  session: (id) => get(`/api/sessions/${encodeURIComponent(id)}`),
  taskpageSession: (id) => get(`/api/taskpage/session/${encodeURIComponent(id)}`),
  taskpageTask: (key) => get(`/api/taskpage/task/${key.split("/").map(encodeURIComponent).join("/")}`),
  tasklist: () => get("/api/tasklist"),
  health: (scope) => get(`/api/health?scope=${encodeURIComponent(scope || "all")}`),
  concepts: () => get("/api/concepts"),
  sessionOptions: () => get("/api/session-options"),
};

/** 工具的显示名。映射表里查不到就只显示英文标识，不编一个中文名出来。 */
export function toolLabel(name, chineseNames) {
  const chinese = (chineseNames || {})[name];
  return chinese ? `${chinese}（${name}）` : name;
}
