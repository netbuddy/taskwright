// 全部 HTTP 请求都经这一层发出，组件不直接 fetch。
// 错误统一成 ApiError：后端按接口约定返回 { ok: false, error: { code, message, data } }；
// 连不上后端、超时、返回的不是 JSON 时，也折成同一种形状，code 用前端自己的几个值（network、timeout、bad_response）。

import type {
  ActionRequest,
  ApiErrorBody,
  ItemVersion,
  TaskType,
  MessageRequest,
  SessionListEntry,
  Snapshot,
  TaskDetail,
  TaskListEntry,
} from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  data: Record<string, unknown>;

  constructor(code: string, message: string, status = 0, data: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** 直接操作的超时（第 6 节规则 1）：数据库忙等待是 5 秒，前端等 10 秒。 */
export const ACTION_TIMEOUT_MS = 10_000;

const BASE = "/api/v1";

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const init: RequestInit = { method, signal: controller.signal };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    response = await fetch(BASE + path, init);
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new ApiError("timeout", "等了太久没有得到回应。", 0);
    }
    throw new ApiError("network", "连不上服务，请检查后端是否在运行。", 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) throw new ApiError("bad_response", `服务返回了看不懂的内容（HTTP ${response.status}）。`, response.status);
    return text as unknown as T;
  }
  const maybeError = parsed as Partial<ApiErrorBody> | null;
  if (!response.ok || (maybeError && maybeError.ok === false)) {
    const error = maybeError?.error;
    if (error?.code === "bad_request") console.error("接口说请求的形状不对：", method, path, error);
    throw new ApiError(error?.code ?? "bad_response", error?.message ?? `请求没有成功（HTTP ${response.status}）。`,
      response.status, (error?.data as Record<string, unknown>) ?? {});
  }
  return parsed as T;
}

const task = (taskId: string) => `/tasks/${encodeURIComponent(taskId)}`;

export const api = {
  // 任务类型（与后端对齐后新增的接口 GET /api/v1/task-types）
  taskTypes: () => request<{ task_types: TaskType[] }>("GET", "/task-types").then((r) => r.task_types),

  // 4.3 任务与会话
  listTasks: () => request<TaskListEntry[] | { tasks: TaskListEntry[] }>("GET", "/tasks").then(unwrapList),
  createTask: (body: { task_type: string; task_name: string; domain_tag: string | null }) =>
    request<{ task_id: string }>("POST", "/tasks", body),
  getTask: (taskId: string) => request<TaskDetail>("GET", task(taskId)),
  listSessions: (taskId: string) =>
    request<SessionListEntry[] | { sessions: SessionListEntry[] }>("GET", `${task(taskId)}/sessions`).then(unwrapSessions),
  createSession: (taskId: string) => request<{ session_id: string }>("POST", `${task(taskId)}/sessions`, {}),

  // 4.1 整份数据
  snapshot: (taskId: string, sessionId: string) =>
    request<Snapshot>("GET", `${task(taskId)}/snapshot?session=${encodeURIComponent(sessionId)}`),

  // 4.3 按需读取
  itemVersions: (taskId: string, itemId: string) =>
    request<ItemVersion[] | { versions: ItemVersion[] }>("GET", `${task(taskId)}/items/${encodeURIComponent(itemId)}/versions`)
      .then((r) => (Array.isArray(r) ? r : r.versions)),
  materialContent: (taskId: string, path: string) =>
    request<{ path: string; text: string }>("GET", `${task(taskId)}/materials/content?path=${encodeURIComponent(path)}`),
  earlierConversation: (taskId: string, sessionId: string, before: string) =>
    request<Snapshot["conversation"]>(
      "GET",
      `${task(taskId)}/conversation?session=${encodeURIComponent(sessionId)}&before=${encodeURIComponent(before)}&limit=100`,
    ),
  previewDocument: (taskId: string, selection: { item_id: string; version_no: number }[]) =>
    request<{ text: string }>("POST", `${task(taskId)}/documents/preview`, { selection, format: "markdown" }),
  downloadDocument: async (taskId: string, selection: { item_id: string; version_no: number }[]) => {
    const response = await fetch(`${BASE}${task(taskId)}/documents/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection, format: "markdown" }),
    });
    if (!response.ok) throw new ApiError("bad_response", `下载没有成功（HTTP ${response.status}）。`, response.status);
    return response.blob();
  },

  // 5 对话
  sendMessage: (taskId: string, sessionId: string, body: MessageRequest) =>
    request<{ ok: true; client_id: string; queued: boolean }>(
      "POST", `${task(taskId)}/messages?session=${encodeURIComponent(sessionId)}`, body),
  uploadMaterial: (taskId: string, file: File, sessionId?: string) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    return request<{ path: string }>("POST", `${task(taskId)}/materials${query}`, form);
  },
  control: (taskId: string, sessionId: string, action: "stop") =>
    request<{ ok: true; cleared?: string[] }>("POST", `${task(taskId)}/control?session=${encodeURIComponent(sessionId)}`, { action }),

  // 6 直接操作
  action: (taskId: string, sessionId: string, body: ActionRequest) =>
    request<{ ok: true; client_id: string; op_id: string }>(
      "POST", `${task(taskId)}/actions?session=${encodeURIComponent(sessionId)}`, body, ACTION_TIMEOUT_MS),
};

function unwrapList(r: TaskListEntry[] | { tasks: TaskListEntry[] }): TaskListEntry[] {
  return Array.isArray(r) ? r : r.tasks;
}

function unwrapSessions(r: SessionListEntry[] | { sessions: SessionListEntry[] }): SessionListEntry[] {
  return Array.isArray(r) ? r : r.sessions;
}

/** 前端生成的临时编号（client_id）。 */
export function clientId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
