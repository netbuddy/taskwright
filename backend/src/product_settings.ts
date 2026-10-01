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
 *   { "version": 1, "pi_dirs": { "<pi 配置目录>": { "selection": {language, embedding}, "providers": { "<服务名>": {…} } } } }
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readForView, readForWrite, updateJsonFile } from "./config_files.ts";
import { userDataDir } from "./paths.ts";

export const ENV_SETTINGS_FILE = "TASKWRIGHT_SETTINGS_FILE";
export const SETTINGS_VERSION = 1;

export type Kind = "ollama" | "llamacpp" | "vllm" | "deepseek" | "aliyun" | "openai_compatible" | "codex";
export type ModelType = "language" | "embedding";

export interface StoredModel {
  id: string;
  type: ModelType;
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
      out.providers[id] = {
        kind: p.kind, name: typeof p.name === "string" ? p.name : id, base_url: typeof p.base_url === "string" ? p.base_url : null,
        models_fetched_at: typeof p.models_fetched_at === "string" ? p.models_fetched_at : null,
        status: p.status && typeof p.status === "object" ? p.status : null,
        models: Array.isArray(p.models) ? p.models.filter((m: any) => m && typeof m.id === "string").map((m: any) => ({
          id: m.id, type: m.type === "embedding" ? "embedding" : "language", enabled: m.enabled === true,
          context_window: Number.isInteger(m.context_window) && m.context_window > 0 ? m.context_window : null,
          context_source: m.context_source === "service" || m.context_source === "user" ? m.context_source : null,
        })) : [],
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

/** 选中的语言模型「服务名/模型」；没有选过时是 null。 */
export function selectedLanguageModel(agentDir: string, env: NodeJS.ProcessEnv | Record<string, string> = process.env): string | null {
  const language = readPiDirSettings(agentDir, env).selection.language;
  return language ? `${language.provider}/${language.model}` : null;
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
