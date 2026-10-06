/**
 * 产品自己的设置文件：记「助手用哪个语言模型、检索用哪个嵌入模型」、嵌入模型的查询前缀，以及产品在 pi 配置目录里登记过的
 * 模型服务的名单（凭它分清共用的模型登记文件里哪些项是产品写的、哪些是用户自己写的）。文件里不存任何密钥。
 *
 * 位置：环境变量 TASKWRIGHT_SETTINGS_FILE 给了就用它，否则是用户数据目录（paths.ts 的 userDataDir）下的 settings.json。
 * 测试与验证环境一律用这个环境变量指到自己的临时目录。
 *
 * 整份内容按 pi 配置目录的绝对路径分开记：PI_CODING_AGENT_DIR 可以把 pi 的配置目录指到别处，登记过哪些服务、
 * 选了哪个模型都是对某一个 pi 配置目录说的；换了目录就等于还没有配置过，照 0.3 的规则办。
 *
 *   { "version": 2, "pi_dirs": { "<pi 配置目录>": { "selection": {language, embedding}, "providers": { "<服务名>": {purpose, …} } } } }
 *
 * 一个模型服务只有一种用途（purpose）：它提供哪一类模型。同一个地址既提供语言模型又提供嵌入模型时，登记成两个模型服务。
 * 第 1 版的文件里模型服务没有用途，每个模型各自标类型；迁移的规则见 migratePurposes。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODEX_PROVIDER } from "./codex.ts";
import { readForView, readForWrite, updateJsonFile } from "./config_files.ts";
import { userDataDir } from "./paths.ts";

export const ENV_SETTINGS_FILE = "TASKWRIGHT_SETTINGS_FILE";
export const SETTINGS_VERSION = 2;

export type Kind = "ollama" | "llamacpp" | "vllm" | "deepseek" | "aliyun" | "openai_compatible" | "codex";

/** 模型服务的用途。以后多一类模型，在这里加一个值，并在 PURPOSE_INFO 里加一行。 */
export const PURPOSES = ["language", "embedding"] as const;
export type Purpose = (typeof PURPOSES)[number];
/** 模型的类型就是它所在模型服务的用途；选定模型的键与测试接口的 type 用的是同一组值。 */
export type ModelType = Purpose;
/** 没有另外说明时的用途：手工登记的模型服务、第 1 版里清单为空的模型服务都算它；缺省名称与编号不带用途的也是它。 */
export const DEFAULT_PURPOSE: Purpose = "language";

export interface PurposeInfo {
  /** 这类模型的叫法。 */
  name: string;
  /** 选定的这类模型在界面上的叫法。 */
  role: string;
  /** 这类模型要不要上下文长度：要的话，填了才能勾选、才能选定。 */
  needs_context_window: boolean;
  /** 勾选的模型写不写进 pi 的模型登记文件：只有助手自己调用的那一类要写。 */
  registered_with_pi: boolean;
  /** 不提供这类模型的种类。 */
  not_offered_by: readonly Kind[];
}

export const PURPOSE_INFO: Record<Purpose, PurposeInfo> = {
  language: { name: "语言模型", role: "助手用的语言模型", needs_context_window: true, registered_with_pi: true, not_offered_by: [] },
  embedding: { name: "嵌入模型", role: "查找用的嵌入模型", needs_context_window: false, registered_with_pi: false, not_offered_by: ["codex"] },
};

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === "string" && (PURPOSES as readonly string[]).includes(value);
}

/** 产品登记的服务名的前缀：不会与 pi 内置的服务名（例如 deepseek）重名。 */
export const ID_PREFIX = "taskwright-";

/** 给新的模型服务起服务名：taskwright-<种类>，用途不是缺省的那一种时再加 -<用途>；已经有了就加 -2、-3。 */
export function newProviderId(kind: Kind, purpose: Purpose, taken: ReadonlySet<string>): string {
  const base = `${ID_PREFIX}${kind}${purpose === DEFAULT_PURPOSE ? "" : `-${purpose}`}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** 名称后面注明用途的写法：用途是缺省的那一种时不加。 */
export function nameWithPurpose(name: string, purpose: Purpose): string {
  return purpose === DEFAULT_PURPOSE ? name : `${name}（${PURPOSE_INFO[purpose].name}）`;
}

export interface StoredModel {
  id: string;
  enabled: boolean;
  context_window: number | null;
  /** service：从模型服务查到的；user：用户填的；null：还没有。 */
  context_source: "service" | "user" | null;
}

export interface ProviderStatus {
  checked_at: string;
  ok: boolean;
  message: string;
  /** 只有 Codex 订阅有：pi 的凭据文件里有没有它的登录凭据。 */
  logged_in?: boolean;
}

export interface StoredProvider {
  kind: Kind;
  /** 这个模型服务提供哪一类模型；添加时定下，之后不改。 */
  purpose: Purpose;
  name: string;
  /** 用户填的地址（Codex 订阅是 null）。写进 pi 模型登记文件的 baseUrl 由它推出来（见 model_config.ts）。 */
  base_url: string | null;
  models_fetched_at: string | null;
  status: ProviderStatus | null;
  models: StoredModel[];
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface Selection {
  language: ModelRef | null;
  embedding: (ModelRef & { query_prefix: string }) | null;
}

export interface PiDirSettings {
  selection: Selection;
  providers: Record<string, StoredProvider>;
}

export function settingsFile(env: NodeJS.ProcessEnv | Record<string, string> = process.env): string {
  const given = (env[ENV_SETTINGS_FILE] ?? "").trim();
  return given ? resolve(given) : join(userDataDir(), "settings.json");
}

function emptyDir(): PiDirSettings {
  return { selection: { language: null, embedding: null }, providers: {} };
}

/** 文件里的一个模型：缺的项补上缺省值。第 1 版里每个模型标着的类型留在 type 上，只给迁移与兜底用。 */
function normalizeModels(value: unknown): (StoredModel & { type: Purpose })[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m: any) => m && typeof m.id === "string").map((m: any) => ({
    id: m.id, type: isPurpose(m.type) ? m.type : DEFAULT_PURPOSE, enabled: m.enabled === true,
    context_window: Number.isInteger(m.context_window) && m.context_window > 0 ? m.context_window : null,
    context_source: m.context_source === "service" || m.context_source === "user" ? m.context_source : null,
  }));
}

function withoutType(m: StoredModel & { type?: Purpose }): StoredModel {
  return { id: m.id, enabled: m.enabled, context_window: m.context_window, context_source: m.context_source };
}

/** 整理读到的一份：缺的项补上缺省值，免得调用方处处判空。 */
function normalize(value: any): PiDirSettings {
  const out = emptyDir();
  if (!value || typeof value !== "object") return out;
  const sel = value.selection ?? {};
  if (sel.language && typeof sel.language.provider === "string" && typeof sel.language.model === "string") {
    out.selection.language = { provider: sel.language.provider, model: sel.language.model };
  }
  if (sel.embedding && typeof sel.embedding.provider === "string" && typeof sel.embedding.model === "string") {
    out.selection.embedding = { provider: sel.embedding.provider, model: sel.embedding.model, query_prefix: typeof sel.embedding.query_prefix === "string" ? sel.embedding.query_prefix : "" };
  }
  if (value.providers && typeof value.providers === "object") {
    for (const [id, p] of Object.entries<any>(value.providers)) {
      if (!p || typeof p !== "object" || typeof p.kind !== "string") continue;
      const models = normalizeModels(p.models);
      // 还没有迁移的一项（第 1 版，没有用途）：不写文件的兜底，全是嵌入模型的当嵌入模型，其余当缺省的用途；
      // 清单里与这个用途对不上的模型先不列，等迁移把它们拆到另一个模型服务上。
      const purpose: Purpose = isPurpose(p.purpose) ? p.purpose
        : models.length > 0 && models.every((m) => m.type === "embedding") ? "embedding" : DEFAULT_PURPOSE;
      out.providers[id] = {
        kind: p.kind, purpose, name: typeof p.name === "string" ? p.name : id, base_url: typeof p.base_url === "string" ? p.base_url : null,
        models_fetched_at: typeof p.models_fetched_at === "string" ? p.models_fetched_at : null,
        status: p.status && typeof p.status === "object" ? p.status : null,
        models: (isPurpose(p.purpose) ? models : models.filter((m) => m.type === purpose)).map(withoutType),
      };
    }
  }
  return out;
}

/** 读某个 pi 配置目录的那一份设置；文件不在、读不出或没有这一份时是空的一份。只读，不改文件。 */
export function readPiDirSettings(agentDir: string, env: NodeJS.ProcessEnv | Record<string, string> = process.env): PiDirSettings {
  const file = settingsFile(env);
  if (!existsSync(file)) return emptyDir();
  const value = readForView(file);
  return normalize(value?.pi_dirs?.[resolve(agentDir)]);
}

/**
 * 选中的语言模型，写成交给 pi 的「服务商/模型」；没有选过时是 null。选中的模型服务在名单上而它提供的不是语言模型时，也当作没有选。
 * 服务商那一段一般就是模型服务的服务名（它在 pi 的模型登记文件里登记的名字）；Codex 订阅不登记，pi 不认识产品给它起的服务名，
 * 要换成 pi 自己的服务商名（见 codex.ts）。
 */
export function selectedLanguageModel(agentDir: string, env: NodeJS.ProcessEnv | Record<string, string> = process.env): string | null {
  const dir = readPiDirSettings(agentDir, env);
  const language = dir.selection.language;
  if (!language) return null;
  const provider = dir.providers[language.provider];
  if (provider && provider.purpose !== "language") return null;
  return `${provider?.kind === "codex" ? CODEX_PROVIDER : language.provider}/${language.model}`;
}

/**
 * 在锁里改某个 pi 配置目录的那一份设置并写回（写前备份，别的 pi 配置目录的内容与文件里别的键原样保留）。
 * change 就地修改拿到的那一份；返回值原样交回调用方。
 */
export async function updatePiDirSettings<T>(agentDir: string, change: (dir: PiDirSettings) => T, env: NodeJS.ProcessEnv | Record<string, string> = process.env): Promise<T> {
  const file = settingsFile(env);
  let result!: T;
  await updateJsonFile(file, (value) => {
    const key = resolve(agentDir);
    const dirs = value.pi_dirs && typeof value.pi_dirs === "object" && !Array.isArray(value.pi_dirs) ? value.pi_dirs : {};
    const current = normalize(dirs[key]);
    result = change(current);
    value.version = SETTINGS_VERSION;
    value.pi_dirs = { ...dirs, [key]: current };
    return true;
  });
  return result;
}

/** 设置文件能不能写：读不出来时抛 config_unwritable（与写入时同样的检查），先于别的改动做。 */
export function checkWritable(env: NodeJS.ProcessEnv | Record<string, string> = process.env): void {
  readForWrite(settingsFile(env));
}

// ───────────── 第 1 版到第 2 版：给模型服务定用途 ─────────────

function providersWithoutPurpose(value: any): string[] {
  const providers = value?.providers;
  if (!providers || typeof providers !== "object") return [];
  return Object.entries<any>(providers).filter(([, p]) => p && typeof p === "object" && typeof p.kind === "string" && !isPurpose(p.purpose)).map(([id]) => id);
}

/** 某个 pi 配置目录的那一份设置里，有没有还没定用途的模型服务。只读。 */
export function needsPurposeMigration(agentDir: string, env: NodeJS.ProcessEnv | Record<string, string> = process.env): boolean {
  const file = settingsFile(env);
  if (!existsSync(file)) return false;
  return providersWithoutPurpose(readForView(file)?.pi_dirs?.[resolve(agentDir)]).length > 0;
}

export interface PurposeMigration {
  /** 拆出来的模型服务：from 是原来的服务名，to 是新起的服务名。密钥与模型登记文件里的那一项由调用方照着补。 */
  split: { from: string; to: string }[];
  /** 给日志的话，一个模型服务一句。 */
  notes: string[];
}

/**
 * 在锁里给某个 pi 配置目录的那一份设置里还没定用途的模型服务定用途并写回：
 * · 清单里全是语言模型的，是语言模型；全是嵌入模型的，是嵌入模型；清单是空的，是缺省的用途；这三种服务名与名称都不变。
 * · 两类都有的拆成两个：原来的留下语言模型，新起一个服务名拿走嵌入模型，名称后面注明用途，地址、检查结果、获取时间照抄；
 *   选定的嵌入模型原来指着它的，改指新的那一个。
 * taken 是不能再用的服务名（模型登记文件里已经有的）；设置里已经有的服务名不用给。没有要迁移的就不写文件。
 */
export async function migratePurposes(agentDir: string, taken: ReadonlySet<string>, env: NodeJS.ProcessEnv | Record<string, string> = process.env): Promise<PurposeMigration> {
  const outcome: PurposeMigration = { split: [], notes: [] };
  if (!needsPurposeMigration(agentDir, env)) return outcome;
  const key = resolve(agentDir);
  await updateJsonFile(settingsFile(env), (value) => {
    const raw = value.pi_dirs?.[key];
    const pending = providersWithoutPurpose(raw);
    if (!pending.length) return false;
    const current = normalize(raw);
    const used = new Set([...taken, ...Object.keys(current.providers)]);
    for (const id of pending) {
      const p = current.providers[id];
      const models = normalizeModels(raw.providers[id].models);
      const kept = models.filter((m) => m.type === DEFAULT_PURPOSE);
      const moved = models.filter((m) => m.type !== DEFAULT_PURPOSE);
      if (kept.length > 0 && moved.length > 0) {
        const to = newProviderId(p.kind, "embedding", used);
        used.add(to);
        p.purpose = DEFAULT_PURPOSE;
        p.models = kept.map(withoutType);
        current.providers[to] = { ...p, purpose: "embedding", name: nameWithPurpose(p.name, "embedding"), models: moved.map(withoutType) };
        if (current.selection.embedding?.provider === id) current.selection.embedding.provider = to;
        outcome.split.push({ from: id, to });
        outcome.notes.push(`模型服务「${p.name}」（${id}）里既有语言模型又有嵌入模型，已经拆成两个：语言模型留在原处，嵌入模型移到「${current.providers[to].name}」（${to}）。`);
      } else {
        // 只有一类或者清单是空的：normalize 定的用途就是它的用途，清单原样留下。
        p.models = models.map(withoutType);
        outcome.notes.push(`模型服务「${p.name}」（${id}）的用途定为${PURPOSE_INFO[p.purpose].name}。`);
      }
    }
    value.version = SETTINGS_VERSION;
    value.pi_dirs = { ...value.pi_dirs, [key]: current };
    return true;
  });
  return outcome;
}
