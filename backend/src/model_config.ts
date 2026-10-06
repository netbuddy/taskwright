/**
 * 在界面上配置模型服务（docs/api.md §10）。
 *
 * 两种模型的调用者不同：语言模型由 pi 调用，模型服务的连接写进 pi 配置目录里的模型登记文件 models.json，密钥写进登录凭据文件
 * auth.json；嵌入模型由任务服务自己调用（embedding.ts，连接从这里的 embeddingTarget 取）。「选了哪一个」记在产品自己的设置文件里
 * （product_settings.ts）。
 *
 * 一个模型服务只有一种用途（purpose）：它提供哪一类模型。模型的类型就是所在模型服务的用途，清单里不再逐个标；同一个地址
 * 两类都提供时登记成两个模型服务。用途添加时定下，之后不改。
 *
 * 产品只增改自己登记的那几项（服务名以 taskwright- 开头、并且在产品设置的名单上）；两个共用文件里别的内容原样保留，
 * 写之前备份、照 pi 的办法加锁（config_files.ts）。用户自己在 models.json 里写的服务在接口里单列成只读的一组（managed 为假）。
 *
 * 向模型服务发的请求都有时限（REQUEST_TIMEOUT_MS；载入 ollama 的模型是 LOAD_TIMEOUT_MS），只用 fetch，不引入依赖。
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readForView, readForWrite, updateJsonFile } from "./config_files.ts";
import { ApiError } from "./errors.ts";
import * as clock from "./clock.ts";
import { type Profile, buildEnvironment, piAgentDir, piLauncher, resolveModel } from "./launch.ts";
import {
  type Kind, type ModelType, type PiDirSettings, type ProviderStatus, type Purpose, type Selection, type StoredModel, type StoredProvider,
  DEFAULT_PURPOSE, ID_PREFIX, PURPOSES, PURPOSE_INFO, checkWritable, isPurpose, migratePurposes, nameWithPurpose, needsPurposeMigration,
  newProviderId, readPiDirSettings, updatePiDirSettings,
} from "./product_settings.ts";

export { ID_PREFIX };

export const REQUEST_TIMEOUT_MS = 5_000;
export const LOAD_TIMEOUT_MS = 120_000;
/** 没有密钥的服务在 models.json 里写的占位值：pi 要有凭据才把模型列为可用（本地服务不检查它）。 */
export const NO_KEY = "taskwright-no-key";
/** pi 里 Codex 订阅的服务名。 */
export const CODEX_PROVIDER = "openai-codex";

export const APPLIES_TEXT = "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。";
export const UNREACHABLE_TEXT = "连不上这个地址。请确认模型服务已经启动，地址与端口没有写错。";
export const KEY_REJECTED_TEXT = "模型服务拒绝了这个密钥。";
export const NOT_OFFERED_TEXT = "这个模型服务没有提供模型的清单，请手工添加。";

interface KindInfo {
  /** 缺省的显示名。 */
  name: string;
  /** 缺省地址；null 表示必须填（兼容 OpenAI 接口的服务），Codex 订阅不用地址。 */
  base_url: string | null;
  key: "required" | "optional" | "none";
  /** 本地运行的三种：用户填服务的根地址，产品在后面加 /v1；关掉 pi 对 developer 角色与思考参数的使用。 */
  local: boolean;
}

export const KINDS: Record<Kind, KindInfo> = {
  ollama: { name: "ollama", base_url: "http://127.0.0.1:11434", key: "optional", local: true },
  llamacpp: { name: "llama.cpp", base_url: "http://127.0.0.1:8080", key: "optional", local: true },
  vllm: { name: "vLLM", base_url: "http://127.0.0.1:8000", key: "optional", local: true },
  deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com", key: "required", local: false },
  aliyun: { name: "阿里云百炼", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", key: "required", local: false },
  openai_compatible: { name: "兼容 OpenAI 接口的服务", base_url: null, key: "optional", local: false },
  codex: { name: "Codex 订阅", base_url: null, key: "none", local: false },
};

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && Object.hasOwn(KINDS, value);
}

// ───────────── 环境：pi 配置目录与两个共用文件 ─────────────

export interface Context {
  env: NodeJS.ProcessEnv;
  profile: Profile;
}

function agentDir(ctx: Context): string {
  return resolve(piAgentDir(ctx.env));
}
function modelsFile(ctx: Context): string {
  return join(agentDir(ctx), "models.json");
}
function authFile(ctx: Context): string {
  return join(agentDir(ctx), "auth.json");
}

// ───────────── 地址 ─────────────

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 本地三种服务的根地址（去掉末尾的 /v1）。 */
function rootOf(base: string): string {
  return trimSlash(base).replace(/\/v1$/, "");
}

/** 写进 pi 模型登记文件的 baseUrl：本地三种是根地址加 /v1，别的照用户填的。 */
export function piBaseUrl(kind: Kind, base: string): string {
  return KINDS[kind].local ? `${rootOf(base)}/v1` : trimSlash(base);
}

/** 列出模型用的地址：兼容 OpenAI 接口的 …/models（ollama 另用它自己的接口，见 listModels）。 */
function modelsUrl(kind: Kind, base: string): string {
  return `${piBaseUrl(kind, base)}/models`;
}

/** 调嵌入模型用的地址：ollama 用它自己的接口，别的是兼容 OpenAI 接口的 …/embeddings。 */
function embeddingsUrl(kind: Kind, base: string): string {
  return kind === "ollama" ? `${rootOf(base)}/api/embed` : `${piBaseUrl(kind, base)}/embeddings`;
}

function checkBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw rejected("base_url", "请填写接口地址。");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw rejected("base_url", "接口地址的写法不对，应当以 http:// 或 https:// 开头。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw rejected("base_url", "接口地址的写法不对，应当以 http:// 或 https:// 开头。");
  return trimSlash(value.trim());
}

function rejected(field: string, message: string): ApiError {
  return new ApiError("rejected", message, { field, reasons: [message] });
}

// ───────────── 向模型服务发请求 ─────────────

interface Answer {
  /** HTTP 状态码；连不上或超时时是 0。 */
  status: number;
  body: any;
  /** 连不上时的原因（给排查用）。 */
  error?: string;
}

async function call(url: string, options: { key?: string | null; method?: string; body?: unknown; timeout?: number } = {}): Promise<Answer> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.key) headers.Authorization = `Bearer ${options.key}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(url, {
      method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout ?? REQUEST_TIMEOUT_MS), redirect: "follow",
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: null, error: String((error as Error)?.message ?? error) };
  }
}

/** 连通检查（只连一次，不发模型请求）：ollama 查它的模型清单，别的查兼容 OpenAI 接口的模型清单。 */
async function checkConnection(kind: Kind, base: string, key: string | null): Promise<{ ok: boolean; field: "base_url" | "api_key" | null; message: string }> {
  const url = kind === "ollama" ? `${rootOf(base)}/api/tags` : modelsUrl(kind, base);
  const answer = await call(url, { key });
  if (answer.status === 0) return { ok: false, field: "base_url", message: UNREACHABLE_TEXT };
  if (answer.status === 401 || answer.status === 403) return { ok: false, field: "api_key", message: KEY_REJECTED_TEXT };
  return { ok: true, field: null, message: "" };
}

interface Listed {
  result: "listed" | "not_offered" | "failed";
  message: string;
  models: { id: string; type: ModelType; context_window: number | null }[];
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** 兼容 OpenAI 接口的模型清单里每一项的上下文长度：vLLM 的 max_model_len、DeepSeek 的 context_window、llama.cpp 的 meta.n_ctx。 */
function contextOf(entry: any): number | null {
  return positive(entry?.max_model_len) ?? positive(entry?.context_window) ?? positive(entry?.meta?.n_ctx) ?? positive(entry?.context_length);
}

/** 获取模型列表没有成功时的说明：原因后面跟一句建议。 */
function failed(reason: string, advice = "可以稍后再试，或者手工添加。"): Listed {
  return { result: "failed", message: `获取模型列表没有成功：${reason}。${advice}`, models: [] };
}

function reasonOf(answer: Answer): string {
  if (answer.status === 0) return "连不上这个模型服务";
  if (answer.status === 401 || answer.status === 403) return "模型服务拒绝了这个密钥";
  return `模型服务回答了错误（HTTP ${answer.status}）`;
}

/** 这种模型服务分辨得出模型的类型吗：分辨得出的，取回的清单只留与模型服务的用途对得上的；分辨不出的全留。 */
function tellsModelType(kind: Kind): boolean {
  return kind === "ollama" || kind === "aliyun" || kind === "codex";
}

/** 按种类向模型服务查询模型清单。每个模型标着查到（或者猜到）的类型，只用来按用途筛选。 */
async function listModels(ctx: Context, kind: Kind, base: string | null, key: string | null): Promise<Listed> {
  if (kind === "codex") return listCodexModels(ctx);
  if (base === null) return failed("没有接口地址");
  if (kind === "ollama") {
    const root = rootOf(base);
    const tags = await call(`${root}/api/tags`, { key });
    if (tags.status !== 200 || !Array.isArray(tags.body?.models)) return failed(reasonOf(tags));
    const models: Listed["models"] = [];
    for (const entry of tags.body.models) {
      const id = typeof entry?.name === "string" ? entry.name : typeof entry?.model === "string" ? entry.model : null;
      if (!id) continue;
      const show = await call(`${root}/api/show`, { key, method: "POST", body: { model: id } });
      const caps: unknown = show.body?.capabilities;
      const embedding = Array.isArray(caps) && caps.includes("embedding") && !caps.includes("completion");
      // ollama 的 /api/show 给的是训练时的最大上下文，不是服务实际分配的，所以不填（见 contextWindow）。
      models.push({ id, type: embedding ? "embedding" : "language", context_window: null });
    }
    return { result: "listed", message: "", models };
  }
  const answer = await call(modelsUrl(kind, base), { key });
  if (answer.status === 404 || (answer.status === 200 && !Array.isArray(answer.body?.data))) return { result: "not_offered", message: NOT_OFFERED_TEXT, models: [] };
  if (answer.status !== 200) return failed(reasonOf(answer));
  const models: Listed["models"] = [];
  for (const entry of answer.body.data) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    const guess: ModelType = kind === "aliyun" && entry.id.includes("embedding") ? "embedding" : "language";
    models.push({ id: entry.id, type: guess, context_window: contextOf(entry) });
  }
  return { result: "listed", message: "", models };
}

/** pi 列出模型的输出里的「272K」「1.1M」换成整数。 */
function tokens(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Codex 订阅的模型在页面上不能手工添加，所以它的建议里不提手工添加；没有登录时的建议是先登录。 */
const CODEX_RETRY = "可以稍后再试。";
const CODEX_LOGIN = "请先在命令行里登录，再回到这里点「获取模型列表」。";

/** Codex 订阅的模型：让 pi 按它自己的目录列出（不联网；只列已经登录的服务的模型）。 */
async function listCodexModels(ctx: Context): Promise<Listed> {
  let launcher: ReturnType<typeof piLauncher>;
  try {
    launcher = piLauncher(ctx.profile);
  } catch {
    return failed("找不到助手的程序", CODEX_RETRY);
  }
  const env = { ...buildEnvironment(ctx.profile), ...launcher.env, PI_OFFLINE: "1" };
  const args = [...launcher.prefix, "--offline", "--no-extensions", "--no-skills", "--list-models", CODEX_PROVIDER];
  const output = await new Promise<{ code: number | null; text: string }>((done) => {
    const child = spawn(launcher.command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => done({ code: -1, text: "" }));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, text });
    });
  });
  if (output.code !== 0) return failed("没能读出 Codex 订阅的模型目录", CODEX_RETRY);
  const models: Listed["models"] = [];
  for (const line of output.text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3 && cols[0] === CODEX_PROVIDER) models.push({ id: cols[1], type: "language", context_window: tokens(cols[2]) });
  }
  if (!models.length) return failed("还没有登录 Codex 订阅", CODEX_LOGIN);
  return { result: "listed", message: "", models };
}

// ───────────── 读两个共用文件里产品关心的部分 ─────────────

/** 凭据文件里某个服务的密钥（只认 api_key 一种）；没有时是 null。 */
function keyOf(auth: Record<string, any> | null, id: string): string | null {
  const entry = auth?.[id];
  return entry && entry.type === "api_key" && typeof entry.key === "string" && entry.key ? entry.key : null;
}

function codexLoggedIn(auth: Record<string, any> | null): boolean {
  const entry = auth?.[CODEX_PROVIDER];
  return !!entry && typeof entry === "object" && entry.type === "oauth";
}

// ───────────── 对外的视图 ─────────────

export interface ProviderView {
  id: string;
  managed: boolean;
  kind: Kind | null;
  purpose: Purpose;
  name: string;
  base_url: string | null;
  key: { set: boolean; last4: string | null } | null;
  status: ProviderStatus | null;
  models: StoredModel[];
  models_fetched_at: string | null;
  in_use: ModelType[];
}

function inUse(selection: Selection, id: string): ModelType[] {
  return PURPOSES.filter((what) => selection[what]?.provider === id);
}

function managedView(id: string, p: StoredProvider, auth: Record<string, any> | null, selection: Selection): ProviderView {
  const key = keyOf(auth, id);
  const status = p.kind === "codex" && p.status ? { ...p.status, logged_in: codexLoggedIn(auth) } : p.status;
  return {
    id, managed: true, kind: p.kind, purpose: p.purpose, name: p.name, base_url: p.base_url,
    key: p.kind === "codex" ? null : { set: key !== null, last4: key !== null ? key.slice(-4) : null },
    status, models: p.models, models_fetched_at: p.models_fetched_at, in_use: inUse(selection, id),
  };
}

/** 用户自己在模型登记文件里写的服务：只读，列出显示名与模型；不查它的密钥。模型登记文件里只有助手用的那一类模型，所以用途是缺省的那一种。 */
function externalViews(models: Record<string, any> | null, dir: PiDirSettings): ProviderView[] {
  const providers = models?.providers;
  if (!providers || typeof providers !== "object") return [];
  const out: ProviderView[] = [];
  for (const [id, entry] of Object.entries<any>(providers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (Object.hasOwn(dir.providers, id) || !entry || !Array.isArray(entry.models)) continue;
    out.push({
      id, managed: false, kind: null, purpose: DEFAULT_PURPOSE, name: typeof entry.name === "string" && entry.name ? entry.name : id,
      base_url: null, key: null, status: null, models_fetched_at: null, in_use: inUse(dir.selection, id),
      models: entry.models.filter((m: any) => m && typeof m.id === "string").map((m: any) => ({
        id: m.id, enabled: true, context_window: positive(m.contextWindow), context_source: null,
      })),
    });
  }
  return out;
}

/** GET /api/v1/model-config */
export function view(ctx: Context) {
  const dir = readPiDirSettings(agentDir(ctx), ctx.env);
  const auth = readForView(authFile(ctx));
  const models = readForView(modelsFile(ctx));
  const providers = Object.entries(dir.providers).map(([id, p]) => managedView(id, p, auth, dir.selection));
  const selection = {
    language: dir.selection.language ? { provider_id: dir.selection.language.provider, model_id: dir.selection.language.model } : null,
    embedding: dir.selection.embedding
      ? { provider_id: dir.selection.embedding.provider, model_id: dir.selection.embedding.model, query_prefix: dir.selection.embedding.query_prefix }
      : null,
  };
  let fallback: { model: string; from: string } | null = null;
  if (!selection.language) {
    const resolved = resolveModel(ctx.profile, ctx.env);
    fallback = { model: resolved.model, from: resolved.from };
  }
  return {
    ok: true, editable: true, notice: null, selection, fallback,
    providers: [...providers, ...externalViews(models, dir)],
  };
}

/** 选定的嵌入模型连到哪里。 */
export interface EmbeddingTarget {
  provider_id: string;
  model: string;
  query_prefix: string;
  /** 模型服务的种类；这个模型服务已经不在产品设置的名单上时是 null。 */
  kind: Kind | null;
  /** 模型服务的显示名；不在名单上时是服务名。 */
  name: string;
  /** 调嵌入模型的地址；不在名单上的、提供的不是嵌入模型的模型服务是 null。 */
  url: string | null;
  key: string | null;
}

/** 选定的嵌入模型所在的模型服务、地址与密钥；没有选嵌入模型时是 null。只读，不改任何文件。 */
export function embeddingTarget(ctx: Context): EmbeddingTarget | null {
  const dir = readPiDirSettings(agentDir(ctx), ctx.env);
  const ref = dir.selection.embedding;
  if (!ref) return null;
  const chosen = { provider_id: ref.provider, model: ref.model, query_prefix: ref.query_prefix };
  const p = dir.providers[ref.provider];
  if (!p) return { ...chosen, kind: null, name: ref.provider, url: null, key: null };
  if (p.purpose !== "embedding" || p.base_url === null) return { ...chosen, kind: p.kind, name: p.name, url: null, key: null };
  return { ...chosen, kind: p.kind, name: p.name, url: embeddingsUrl(p.kind, p.base_url), key: keyOf(readForView(authFile(ctx)), ref.provider) };
}

// ───────────── 写：先查共用文件能不能写，再改产品设置，最后改共用文件 ─────────────

function checkFilesWritable(ctx: Context): void {
  checkWritable(ctx.env);
  readForWrite(modelsFile(ctx));
  readForWrite(authFile(ctx));
}

/**
 * 给还没定用途的模型服务定用途（设置文件第 1 版留下的；规则见 product_settings.ts 的 migratePurposes）。拆出来的模型服务照抄原来的
 * 密钥，并在模型登记文件里写上它那一项。返回给日志的话，没有要迁移的时候是空的，也不碰任何文件。任务服务启动时调用一次。
 */
export async function migrateProviderPurposes(ctx: Context): Promise<string[]> {
  if (!needsPurposeMigration(agentDir(ctx), ctx.env)) return [];
  checkFilesWritable(ctx);
  const taken = new Set(Object.keys(readForView(modelsFile(ctx))?.providers ?? {}));
  const outcome = await migratePurposes(agentDir(ctx), taken, ctx.env);
  if (outcome.split.length) {
    const auth = readForView(authFile(ctx));
    for (const { from, to } of outcome.split) {
      const key = keyOf(auth, from);
      if (key !== null) await syncKey(ctx, to, key);
    }
    await syncModels(ctx, readPiDirSettings(agentDir(ctx), ctx.env), outcome.split.map((s) => s.to));
  }
  return outcome.notes;
}

/** 改模型配置之前先保证用途都定了：任务服务启动时已经迁移过，这里给没有经过启动就改配置的情形兜底（没有要迁移的时候只读一次设置文件）。 */
async function ensurePurposes(ctx: Context): Promise<void> {
  for (const note of await migrateProviderPurposes(ctx)) console.log(note);
}

/** 写进模型登记文件的那一项：只动产品管的几个字段，这一项里用户另加的字段保留。提供的不是助手用的那一类模型时，模型清单是空的。 */
function piEntry(p: StoredProvider, existing: any): Record<string, any> {
  const entry: Record<string, any> = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  entry.baseUrl = piBaseUrl(p.kind, p.base_url!);
  entry.api = "openai-completions";
  entry.apiKey = NO_KEY;
  if (KINDS[p.kind].local) entry.compat = { ...(entry.compat ?? {}), supportsDeveloperRole: false, supportsReasoningEffort: false };
  entry.models = PURPOSE_INFO[p.purpose].registered_with_pi
    ? p.models.filter((m) => m.enabled).map((m) => ({ id: m.id, ...(m.context_window ? { contextWindow: m.context_window } : {}) }))
    : [];
  return entry;
}

/** 按产品设置改写模型登记文件里产品管的那几项；removed 里的服务名从文件里删掉。别的项原样保留。 */
async function syncModels(ctx: Context, dir: PiDirSettings, touched: string[], removed: string[] = []): Promise<void> {
  await updateJsonFile(modelsFile(ctx), (value) => {
    const providers = value.providers && typeof value.providers === "object" && !Array.isArray(value.providers) ? value.providers : {};
    let changed = false;
    for (const id of removed) {
      if (Object.hasOwn(providers, id)) {
        delete providers[id];
        changed = true;
      }
    }
    for (const id of touched) {
      const p = dir.providers[id];
      if (!p || p.kind === "codex") continue;
      providers[id] = piEntry(p, providers[id]);
      changed = true;
    }
    value.providers = providers;
    return changed;
  });
}

/** 改凭据文件里某个服务的密钥：key 为 null 时删掉这一项（只删 api_key 一种，别的原样保留）。 */
async function syncKey(ctx: Context, id: string, key: string | null): Promise<void> {
  await updateJsonFile(authFile(ctx), (value) => {
    if (key === null) {
      if (value[id]?.type !== "api_key") return false;
      delete value[id];
      return true;
    }
    value[id] = { type: "api_key", key };
    return true;
  }, 0o600);
}

function newId(kind: Kind, purpose: Purpose, dir: PiDirSettings, models: Record<string, any> | null): string {
  return newProviderId(kind, purpose, new Set([...Object.keys(dir.providers), ...Object.keys(models?.providers ?? {})]));
}

function textField(body: Record<string, any>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw rejected(name, `${name} 应当是一段文字。`);
  return value;
}

function status(ok: boolean, message: string, extra: Partial<ProviderStatus> = {}): ProviderStatus {
  return { checked_at: clock.now(), ok, message, ...extra };
}

async function providerView(ctx: Context, id: string) {
  const dir = readPiDirSettings(agentDir(ctx), ctx.env);
  return managedView(id, dir.providers[id], readForView(authFile(ctx)), dir.selection);
}

function managedOrThrow(dir: PiDirSettings, id: string): StoredProvider {
  const p = dir.providers[id];
  if (!p) throw new ApiError("not_found", `没有这个模型服务：${id}。只有在这里添加的模型服务可以修改。`);
  return p;
}

/** POST /api/v1/model-config/providers */
export async function addProvider(ctx: Context, body: Record<string, any>) {
  if (!isPurpose(body.purpose)) throw rejected("purpose", "请选择这个模型服务提供哪一类模型。");
  const purpose = body.purpose;
  if (!isKind(body.kind)) throw rejected("kind", "请选择模型服务的种类。");
  const kind = body.kind;
  const info = KINDS[kind];
  if (PURPOSE_INFO[purpose].not_offered_by.includes(kind)) throw rejected("kind", `${info.name}没有${PURPOSE_INFO[purpose].name}。`);
  await ensurePurposes(ctx);
  const name = (textField(body, "name") ?? "").trim() || nameWithPurpose(info.name, purpose);
  let base: string | null = null;
  let key: string | null = null;
  if (kind !== "codex") {
    const given = textField(body, "base_url");
    base = given !== undefined && given.trim() ? checkBaseUrl(given) : info.base_url;
    if (base === null) throw rejected("base_url", "请填写接口地址。");
    key = (textField(body, "api_key") ?? "").trim() || null;
    if (info.key === "required" && key === null) throw rejected("api_key", "请填写 API 密钥。");
  }
  checkFilesWritable(ctx);
  let checked: ProviderStatus;
  if (kind === "codex") {
    const loggedIn = codexLoggedIn(readForView(authFile(ctx)));
    checked = status(loggedIn, loggedIn ? "" : "还没有登录 Codex 订阅。", { logged_in: loggedIn });
  } else {
    const result = await checkConnection(kind, base!, key);
    if (!result.ok) throw rejected(result.field!, result.message);
    checked = status(true, "");
  }
  const models = readForView(modelsFile(ctx));
  const id = await updatePiDirSettings(agentDir(ctx), (dir) => {
    const fresh = newId(kind, purpose, dir, models);
    dir.providers[fresh] = { kind, purpose, name, base_url: base, models_fetched_at: null, status: checked, models: [] };
    return fresh;
  }, ctx.env);
  if (kind !== "codex") {
    try {
      const dir = readPiDirSettings(agentDir(ctx), ctx.env);
      await syncModels(ctx, dir, [id]);
      if (key !== null) await syncKey(ctx, id, key);
    } catch (error) {
      // 共用文件没有写成（例如锁等不到）：撤回产品设置里的这一项和已经写进模型登记文件的那一项，免得名单与文件对不上。
      await updatePiDirSettings(agentDir(ctx), (d) => void delete d.providers[id], ctx.env).catch(() => undefined);
      await syncModels(ctx, readPiDirSettings(agentDir(ctx), ctx.env), [], [id]).catch(() => undefined);
      throw error;
    }
  }
  return { ok: true, provider: await providerView(ctx, id) };
}

function parseModels(value: unknown, purpose: Purpose): StoredModel[] {
  if (!Array.isArray(value)) throw rejected("models", "models 应当是一个列表。");
  const seen = new Set<string>();
  const out: StoredModel[] = [];
  for (const raw of value) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (!id) throw rejected("models", "每个模型都要有模型名。");
    if (seen.has(id)) throw rejected("models", `模型「${id}」写了两次。`);
    seen.add(id);
    const cw = raw.context_window;
    if (cw !== null && cw !== undefined && positive(cw) === null) throw rejected("models", `模型「${id}」的上下文长度应当是一个正整数。`);
    const enabled = raw.enabled === true;
    if (enabled && PURPOSE_INFO[purpose].needs_context_window && positive(cw) === null) throw rejected("models", `模型「${id}」还没有填上下文长度，填了才能保存。`);
    out.push({ id, enabled, context_window: positive(cw), context_source: positive(cw) === null ? null : raw.context_source === "service" ? "service" : "user" });
  }
  return out;
}

/** 选中的模型还在不在：停用或删掉被选中的模型时拒绝。 */
function guardSelection(dir: PiDirSettings, id: string, models: StoredModel[]): void {
  for (const what of PURPOSES) {
    const ref = dir.selection[what];
    if (!ref || ref.provider !== id) continue;
    const m = models.find((x) => x.id === ref.model);
    if (!m || !m.enabled) {
      throw new ApiError("in_use", `模型「${ref.model}」正被选为${PURPOSE_INFO[what].role}，先换成别的模型再停用它。`, { provider_id: id, model_id: ref.model });
    }
  }
}

/** POST /api/v1/model-config/providers/{id} */
export async function updateProvider(ctx: Context, id: string, body: Record<string, any>) {
  await ensurePurposes(ctx);
  const current = readPiDirSettings(agentDir(ctx), ctx.env);
  const p = managedOrThrow(current, id);
  const name = textField(body, "name");
  const givenBase = textField(body, "base_url");
  const givenKey = textField(body, "api_key");
  const base = p.kind === "codex" || givenBase === undefined ? p.base_url : checkBaseUrl(givenBase);
  const key = p.kind === "codex" || givenKey === undefined ? undefined : givenKey.trim() || null;
  if (key === null && KINDS[p.kind].key === "required") throw rejected("api_key", "请填写 API 密钥。");
  const models = body.models === undefined ? undefined : parseModels(body.models, p.purpose);
  if (models) guardSelection(current, id, models);
  checkFilesWritable(ctx);
  let checked: ProviderStatus | undefined;
  if (p.kind !== "codex" && (base !== p.base_url || key !== undefined)) {
    const useKey = key !== undefined ? key : keyOf(readForView(authFile(ctx)), id);
    const result = await checkConnection(p.kind, base!, useKey);
    if (!result.ok) throw rejected(result.field!, result.message);
    checked = status(true, "");
  }
  const dir = await updatePiDirSettings(agentDir(ctx), (d) => {
    const q = managedOrThrow(d, id);
    if (name !== undefined && name.trim()) q.name = name.trim();
    q.base_url = base;
    if (models) {
      guardSelection(d, id, models);
      q.models = models;
    }
    if (checked) q.status = checked;
    return d;
  }, ctx.env);
  if (p.kind !== "codex") {
    await syncModels(ctx, dir, [id]);
    if (key !== undefined) await syncKey(ctx, id, key);
  }
  return { ok: true, provider: await providerView(ctx, id) };
}

/** POST /api/v1/model-config/providers/{id}/delete */
export async function deleteProvider(ctx: Context, id: string) {
  await ensurePurposes(ctx);
  const current = readPiDirSettings(agentDir(ctx), ctx.env);
  const p = managedOrThrow(current, id);
  const using = inUse(current.selection, id);
  if (using.length) {
    throw new ApiError("in_use", `这个模型服务的模型正被选为${PURPOSE_INFO[using[0]].role}，先换成别的模型再删除它。`, { provider_id: id });
  }
  checkFilesWritable(ctx);
  const dir = await updatePiDirSettings(agentDir(ctx), (d) => {
    if (inUse(d.selection, id).length) throw new ApiError("in_use", "这个模型服务的模型正被选用，先换成别的模型再删除它。", { provider_id: id });
    delete d.providers[id];
    return d;
  }, ctx.env);
  if (p.kind !== "codex") {
    try {
      await syncModels(ctx, dir, [], [id]);
      await syncKey(ctx, id, null);
    } catch (error) {
      // 共用文件没有改成：把这一项放回产品设置的名单，免得模型登记文件里留下一项产品认不出的。
      await updatePiDirSettings(agentDir(ctx), (d) => void (d.providers[id] = p), ctx.env).catch(() => undefined);
      throw error;
    }
  }
  return { ok: true };
}

/** POST /api/v1/model-config/providers/{id}/check */
export async function checkProvider(ctx: Context, id: string) {
  await ensurePurposes(ctx);
  const current = readPiDirSettings(agentDir(ctx), ctx.env);
  const p = managedOrThrow(current, id);
  let checked: ProviderStatus;
  if (p.kind === "codex") {
    const loggedIn = codexLoggedIn(readForView(authFile(ctx)));
    checked = status(loggedIn, loggedIn ? "" : "还没有登录 Codex 订阅。", { logged_in: loggedIn });
  } else {
    const result = await checkConnection(p.kind, p.base_url!, keyOf(readForView(authFile(ctx)), id));
    checked = status(result.ok, result.message);
  }
  checkWritable(ctx.env);
  await updatePiDirSettings(agentDir(ctx), (d) => {
    managedOrThrow(d, id).status = checked;
  }, ctx.env);
  return { ok: true, provider: await providerView(ctx, id) };
}

/** 把取回的清单并进已有的：新的默认不勾选；已有的保留勾选，上下文长度只在不是用户填的时候用查到的值更新。清单里没有的已有模型保留。 */
export function mergeModels(existing: StoredModel[], listed: { id: string; context_window: number | null }[]): StoredModel[] {
  const out = existing.map((m) => ({ ...m }));
  for (const got of listed) {
    const known = out.find((m) => m.id === got.id);
    if (known) {
      if (known.context_source !== "user" && got.context_window !== null) {
        known.context_window = got.context_window;
        known.context_source = "service";
      }
    } else {
      out.push({ id: got.id, enabled: false, context_window: got.context_window, context_source: got.context_window === null ? null : "service" });
    }
  }
  return out;
}

/** POST /api/v1/model-config/providers/{id}/fetch-models */
export async function fetchModels(ctx: Context, id: string) {
  await ensurePurposes(ctx);
  const current = readPiDirSettings(agentDir(ctx), ctx.env);
  const p = managedOrThrow(current, id);
  const listed = await listModels(ctx, p.kind, p.base_url, keyOf(readForView(authFile(ctx)), id));
  if (listed.result === "listed") {
    // 分辨得出类型的模型服务，只留与这个模型服务的用途对得上的模型；分辨不出的全留。
    const offered = tellsModelType(p.kind) ? listed.models.filter((m) => m.type === p.purpose) : listed.models;
    checkWritable(ctx.env);
    await updatePiDirSettings(agentDir(ctx), (d) => {
      const q = managedOrThrow(d, id);
      q.models = mergeModels(q.models, offered);
      q.models_fetched_at = clock.now();
    }, ctx.env);
  }
  return { ok: true, result: listed.result, message: listed.message, provider: await providerView(ctx, id) };
}

/** POST /api/v1/model-config/providers/{id}/context-window：服务实际给这个模型的上下文长度；查不到时是 null。不保存。 */
export async function contextWindow(ctx: Context, id: string, body: Record<string, any>) {
  const modelId = typeof body.model_id === "string" ? body.model_id.trim() : "";
  if (!modelId) throw rejected("model_id", "请给出模型名。");
  const p = managedOrThrow(readPiDirSettings(agentDir(ctx), ctx.env), id);
  const key = keyOf(readForView(authFile(ctx)), id);
  const none = (message: string) => ({ ok: true, context_window: null, source: null, message });
  if (p.kind === "ollama") {
    const root = rootOf(p.base_url!);
    // 先让 ollama 载入这个模型（不带提示词的生成请求只载入），载入之后 /api/ps 才报它实际分配的上下文长度。
    const load = await call(`${root}/api/generate`, { key, method: "POST", body: { model: modelId, prompt: "", stream: false }, timeout: LOAD_TIMEOUT_MS });
    if (load.status !== 200) return none(`没能让 ollama 载入这个模型：${reasonOf(load)}。请手工填写上下文长度。`);
    const ps = await call(`${root}/api/ps`, { key });
    const entry = Array.isArray(ps.body?.models) ? ps.body.models.find((m: any) => m?.name === modelId || m?.model === modelId) : null;
    const value = positive(entry?.context_length);
    return value === null ? none("ollama 没有报告这个模型实际分配的上下文长度。请手工填写。") : { ok: true, context_window: value, source: "service", message: "" };
  }
  const listed = await listModels(ctx, p.kind, p.base_url, key);
  const value = listed.models.find((m) => m.id === modelId)?.context_window ?? null;
  return value === null ? none("这个模型服务没有报告这个模型的上下文长度。请手工填写。") : { ok: true, context_window: value, source: "service", message: "" };
}

/** POST /api/v1/model-config/selection */
export async function select(ctx: Context, body: Record<string, any>) {
  await ensurePurposes(ctx);
  const current = readPiDirSettings(agentDir(ctx), ctx.env);
  const external = externalViews(readForView(modelsFile(ctx)), current);
  /** 名单上的模型服务，或者手工登记的那一组里的。 */
  const providerOf = (id: string): { name: string; purpose: Purpose; managed: boolean; models: StoredModel[] } | undefined => {
    const managed = current.providers[id];
    if (managed) return { name: managed.name, purpose: managed.purpose, managed: true, models: managed.models };
    const found = external.find((e) => e.id === id);
    return found && { name: found.name, purpose: found.purpose, managed: false, models: found.models };
  };
  const pick = (value: any, type: ModelType) => {
    if (value === null || value === undefined) return null;
    const providerId = typeof value.provider_id === "string" ? value.provider_id : "";
    const modelId = typeof value.model_id === "string" ? value.model_id : "";
    const field = type;
    const from = providerOf(providerId);
    if (!from) throw rejected(field, `没有这个模型服务：${providerId}。`);
    if (from.purpose !== type) throw rejected(field, `模型服务「${from.name}」提供的不是${PURPOSE_INFO[type].name}。`);
    const m = from.models.find((x) => x.id === modelId);
    if (!m || !m.enabled) throw rejected(field, `模型服务「${from.name}」里没有勾选模型「${modelId}」。`);
    if (PURPOSE_INFO[type].needs_context_window && from.managed && m.context_window === null) throw rejected(field, `模型「${modelId}」还没有填上下文长度。`);
    return { provider: providerId, model: modelId };
  };
  const language = pick(body.language, "language");
  const embeddingRef = pick(body.embedding, "embedding");
  const prefix = body.embedding && typeof body.embedding.query_prefix === "string" ? body.embedding.query_prefix : "";
  checkWritable(ctx.env);
  await updatePiDirSettings(agentDir(ctx), (d) => {
    d.selection = { language, embedding: embeddingRef ? { ...embeddingRef, query_prefix: prefix } : null };
  }, ctx.env);
  const after = view(ctx);
  return { ok: true, selection: after.selection, note: APPLIES_TEXT };
}
