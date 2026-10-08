// 全部 HTTP 请求都经这一层发出，组件不直接 fetch。
// 错误统一成 ApiError：后端按接口约定返回 { ok: false, error: { code, message, data } }；
// 连不上后端、超时、返回的不是 JSON 时，也折成同一种形状，code 用前端自己的几个值（network、timeout、bad_response）。

import { dispositionFileName } from "../model/download";
import type {
  ActionRequest,
  ApiErrorBody,
  ContextWindowResult,
  DiagramDetail,
  FetchModelsResult, RefreshCatalogResult,
  ModelConfig,
  ModelSelection,
  ModelTestResult,
  ModelType,
  Provider,
  ProviderKind,
  ItemRevision,
  KnowledgeDocument,
  KnowledgeKind,
  KnowledgeEmbedding,
  KnowledgeLibrary,
  KnowledgeOverview,
  KnowledgeSearchResult,
  RevisionLog,
  ServiceInfo,
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
/** 请求发不出去（服务停了或网络断了）时的那句话。 */
export const NETWORK_TEXT = "连不上服务，请检查服务是否在运行。";
/**
 * 页面与任务服务之间隔着一层转发（开发服务器的代理、反向代理）时，任务服务停了或正在重启，转发的那一层回 502、503、504，
 * 返回体里没有接口约定的说明；这时用这句话，不写状态码。任务服务自己回的 503 带说明，照它的说明写。
 */
export const GATEWAY_TEXT = "连不上任务服务，可能正在重启。请稍后再试；一直不行，请告诉管理员。";
const gatewayStatus = (status: number) => status === 502 || status === 503 || status === 504;
/** 返回体里没有说明时的兜底句：502、503、504 用 GATEWAY_TEXT，其余用各处自己那句带状态码的话。 */
function fallbackText(status: number, text: string): string {
  return gatewayStatus(status) ? GATEWAY_TEXT : text;
}

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
    throw new ApiError("network", NETWORK_TEXT, 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) throw new ApiError("bad_response", fallbackText(response.status, `服务返回了看不懂的内容（HTTP ${response.status}）。`), response.status);
    return text as unknown as T;
  }
  const maybeError = parsed as Partial<ApiErrorBody> | null;
  if (!response.ok || (maybeError && maybeError.ok === false)) {
    const error = maybeError?.error;
    if (error?.code === "bad_request") console.error("接口说请求的形状不对：", method, path, error);
    throw new ApiError(error?.code ?? "bad_response", error?.message ?? fallbackText(response.status, `请求没有成功（HTTP ${response.status}）。`),
      response.status, (error?.data as Record<string, unknown>) ?? {});
  }
  return parsed as T;
}

const task = (taskId: string) => `/tasks/${encodeURIComponent(taskId)}`;
const provider = (id: string) => `/model-config/providers/${encodeURIComponent(id)}`;
/** 添加、修改模型服务时后端先检查连得上（每个请求最多等 5 秒），获取模型列表时 ollama 要逐个查模型，所以多等一些。 */
const PROVIDER_TIMEOUT_MS = 60_000;
/** 查 ollama 的上下文长度要先载入模型，后端最多等两分钟。 */
const CONTEXT_TIMEOUT_MS = 150_000;
/**
 * 测试语言模型要起一次助手、发一次模型请求：后端最多等 90 秒，到时间后停助手最多还要 20 多秒，所以这里等 120 秒。
 * 测试嵌入模型后端最多等 60 秒，用同一个时限。
 */
const MODEL_TEST_TIMEOUT_MS = 120_000;
/** 按意思查找最多等多久：后端换算要找的那句话最多等模型服务 60 秒（本地的模型服务第一次载入模型要几十秒）。 */
const KNOWLEDGE_SEARCH_TIMEOUT_MS = 70_000;

/** 材料文件的原始字节（GET …/materials/raw）：Word 材料要在浏览器里按原版式渲染。出错时按接口约定的错误体折成 ApiError。 */
async function rawBytes(path: string, timeoutMs = 30_000): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(BASE + path, { signal: controller.signal });
    if (response.ok) return await response.arrayBuffer();
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new ApiError("timeout", "等了太久没有得到回应。", 0);
    throw new ApiError("network", NETWORK_TEXT, 0);
  } finally {
    clearTimeout(timer);
  }
  let body: Partial<ApiErrorBody> | null = null;
  try { body = await response.json(); } catch { body = null; }
  throw new ApiError(body?.error?.code ?? "bad_response", body?.error?.message ?? fallbackText(response.status, `请求没有成功（HTTP ${response.status}）。`), response.status);
}

export const api = {
  // 服务信息与退出（退出只在桌面形态有）
  serviceInfo: () => request<ServiceInfo>("GET", "/service", undefined, 5_000),
  exitService: () => request<{ ok: true }>("POST", "/service/exit", {}, 10_000),

  // 模型配置（接口文档第 10 节）：从哪台电脑打开页面都可以读、可以改。
  modelConfig: () => request<ModelConfig>("GET", "/model-config"),
  addProvider: (body: { purpose: ModelType; kind: ProviderKind; name?: string; base_url?: string; api_key?: string }) =>
    request<{ ok: true; provider: Provider }>("POST", "/model-config/providers", body, PROVIDER_TIMEOUT_MS),
  updateProvider: (id: string, body: { name?: string; base_url?: string; api_key?: string;
    models?: { id: string; enabled: boolean; context_window: number | null }[] }) =>
    request<{ ok: true; provider: Provider }>("POST", provider(id), body, PROVIDER_TIMEOUT_MS),
  deleteProvider: (id: string) => request<{ ok: true }>("POST", `${provider(id)}/delete`, {}),
  checkProvider: (id: string) => request<{ ok: true; provider: Provider }>("POST", `${provider(id)}/check`, {}, PROVIDER_TIMEOUT_MS),
  fetchModels: (id: string) => request<FetchModelsResult>("POST", `${provider(id)}/fetch-models`, {}, PROVIDER_TIMEOUT_MS),
  // 更新模型目录：后端最多等 30 秒，这里留够余量。
  refreshCatalog: (id: string) => request<RefreshCatalogResult>("POST", `${provider(id)}/refresh-catalog`, {}, PROVIDER_TIMEOUT_MS),
  contextWindow: (id: string, modelId: string) =>
    request<ContextWindowResult>("POST", `${provider(id)}/context-window`, { model_id: modelId }, CONTEXT_TIMEOUT_MS),
  selectModels: (selection: ModelSelection) =>
    request<{ ok: true; selection: ModelSelection; note: string }>("POST", "/model-config/selection", selection),
  testModel: (type: ModelType) => request<ModelTestResult>("POST", "/model-config/test", { type }, MODEL_TEST_TIMEOUT_MS),

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
  itemRevisions: (taskId: string, itemId: string) =>
    request<{ revisions: ItemRevision[] }>("GET", `${task(taskId)}/items/${encodeURIComponent(itemId)}/revisions`).then((r) => r.revisions),
  revisionLog: (taskId: string) => request<RevisionLog>("GET", `${task(taskId)}/revisions`),
  /** 一张图的详情：Mermaid 文本、说明、来源（带依据的现状）与图里画了谁。已经删除的图也取得到（deleted 为真）。 */
  diagram: (taskId: string, diagramId: string) =>
    request<{ diagram: DiagramDetail }>("GET", `${task(taskId)}/diagrams/${encodeURIComponent(diagramId)}`).then((r) => r.diagram),
  materialContent: (taskId: string, path: string) =>
    request<{ path: string; text: string }>("GET", `${task(taskId)}/materials/content?path=${encodeURIComponent(path)}`),
  materialRaw: (taskId: string, path: string) => rawBytes(`${task(taskId)}/materials/raw?path=${encodeURIComponent(path)}`),
  earlierConversation: (taskId: string, sessionId: string, before: string) =>
    request<Snapshot["conversation"]>(
      "GET",
      `${task(taskId)}/conversation?session=${encodeURIComponent(sessionId)}&before=${encodeURIComponent(before)}&limit=100`,
    ),
  // 生成文档：按一次修订整体导出（revision_no 不写就是最新），items 不写就是那次修订时的全部条目。
  previewDocument: (taskId: string, pick: DocumentPick) =>
    request<{ text: string }>("POST", `${task(taskId)}/documents/preview`, { ...pick, format: "markdown" }),
  downloadDocument: async (taskId: string, pick: DocumentPick) => {
    const response = await fetch(`${BASE}${task(taskId)}/documents/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pick, format: "markdown" }),
    });
    if (!response.ok) {
      // 502、503、504 时看一眼返回体：任务服务自己回的带说明，照说明写；转发层回的没有说明，写 GATEWAY_TEXT。其余状态码照旧。
      const said = gatewayStatus(response.status) ? ((await response.json().catch(() => null)) as Partial<ApiErrorBody> | null)?.error?.message : undefined;
      throw new ApiError("bad_response", said ?? fallbackText(response.status, `下载没有成功（HTTP ${response.status}）。`), response.status);
    }
    return response.blob();
  },
  // 导出 Word：选中的条目各取最新的修订，生成一份 .docx。文件名由任务服务定，写在响应头里；读不到时用 fallbackName。
  // 被拒绝时（例如选中的条目都已经删除）照任务服务说的原因写。
  exportItemsDocx: async (taskId: string, items: string[], withSources: boolean, fallbackName: string) => {
    const response = await fetch(`${BASE}${task(taskId)}/documents/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "docx", items, with_sources: withSources }),
    });
    if (!response.ok) {
      const said = ((await response.json().catch(() => null)) as Partial<ApiErrorBody> | null)?.error?.message;
      throw new ApiError("bad_response", said ?? fallbackText(response.status, `导出没有成功（HTTP ${response.status}）。`), response.status);
    }
    return { blob: await response.blob(), fileName: dispositionFileName(response.headers.get("Content-Disposition")) ?? fallbackName };
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
  deleteMaterial: (taskId: string, path: string) => request<{ ok: true; path: string }>("POST", `${task(taskId)}/materials/delete`, { path }),
  control: (taskId: string, sessionId: string, action: "stop") =>
    request<{ ok: true; cleared?: string[] }>("POST", `${task(taskId)}/control?session=${encodeURIComponent(sessionId)}`, { action }),

  // 知识库
  knowledge: () => request<{ libraries: KnowledgeLibrary[] }>("GET", "/knowledge").then((r) => r.libraries),
  /** 同一个接口的全部内容：各知识库与各文档的换算状态，以及合起来的换算情况。知识库页面用。 */
  knowledgeOverview: () => request<KnowledgeOverview>("GET", "/knowledge"),
  /** 开始换算：不给范围是全部知识库，给 library 是那一个知识库，再给 name 是那一份文档（没算成之后重试用）。queued 是这一次新排进去几份。 */
  embedKnowledge: (scope: { library?: string; name?: string } = {}) =>
    request<{ queued: number; embedding: KnowledgeEmbedding }>("POST", "/knowledge/embed", scope),
  /** 按意思查找：在这几个知识库里找与这句话意思最相近的几个片段；不给 libraries 是全部知识库。等模型服务换算这句话，所以等得久一些。 */
  searchKnowledge: (query: string, libraries?: string[]) =>
    request<KnowledgeSearchResult>("POST", "/knowledge/search", libraries ? { query, libraries } : { query }, KNOWLEDGE_SEARCH_TIMEOUT_MS),
  createLibrary: (name: string) =>
    request<{ library: Omit<KnowledgeLibrary, "used_by_tasks" | "documents"> }>("POST", "/knowledge/libraries", { name }).then((r) => r.library),
  renameLibrary: (id: string, name: string) => request<{ library: { id: string; name: string } }>("POST", `/knowledge/libraries/${encodeURIComponent(id)}`, { name }),
  deleteLibrary: (id: string) => request<{ ok: true }>("POST", `/knowledge/libraries/${encodeURIComponent(id)}/delete`, {}),
  uploadDocument: (id: string, file: File, kind: KnowledgeKind) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file, file.name);
    return request<{ document: KnowledgeDocument }>("POST", `/knowledge/libraries/${encodeURIComponent(id)}/documents`, form).then((r) => r.document);
  },
  /** 知识库文档的正文：Word 文档给由它生成的文字（每段一行，段落号写在方括号里）。 */
  documentText: (id: string, name: string) =>
    request<{ name: string; text: string }>("GET", `/knowledge/libraries/${encodeURIComponent(id)}/documents/content?name=${encodeURIComponent(name)}`),
  deleteDocument: (id: string, name: string) => request<{ ok: true }>("POST", `/knowledge/libraries/${encodeURIComponent(id)}/documents/delete`, { name }),
  setTaskKnowledge: (taskId: string, libraries: string[]) =>
    request<{ libraries: string[] }>("POST", `${task(taskId)}/knowledge`, { libraries }).then((r) => r.libraries),

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

export interface DocumentPick {
  revision_no?: number;
  items?: string[];
}

/** 前端生成的临时编号（client_id）。 */
export function clientId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
