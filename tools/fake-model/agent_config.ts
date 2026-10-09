/**
 * 给 pi 准备一个只认假端点的配置目录。
 *
 * pi 读配置目录的位置看环境变量 PI_CODING_AGENT_DIR；把它指到使用者自己的临时目录，
 * 里面只放一份 models.json，只登记假端点这一家模型服务，本机用户目录下 pi 的全局配置一概不碰。
 *
 * 只往新建的空目录里写：目标目录已经有任何东西（文件、目录、软链接），或者目标路径本身是软链接，就拒绝、什么都不写。
 * 这里会把 auth.json 写成空的；目录里要是放着真的登录凭据或者指向它的软链接，照写就把凭据清空了。
 */

import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_ID } from "./server.ts";

/** pi 的环境变量：配置目录在哪里。 */
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/** models.json 里登记的模型服务名。启动 pi 时 --model 写「服务名/模型编号」。 */
export const PROVIDER = "fake";

/** 启动 pi 时 --model 参数的值。 */
export const MODEL_ARG = `${PROVIDER}/${MODEL_ID}`;

/** 目标目录不能用来写配置：说明里写着原因与怎么办。 */
export class AgentDirRefused extends Error {}

const ADVICE = "假模型只往新建的空目录里写配置（models.json、settings.json、auth.json 三个文件，auth.json 会写成空的），请换一个新的目录";

/** 核对 target 能不能用来写配置：不存在，或者是一个空目录才行；不行时抛出 AgentDirRefused，什么都不动。 */
export function checkAgentDir(target: string): void {
  const found = lstatSync(target, { throwIfNoEntry: false });
  if (!found) return;
  if (found.isSymbolicLink()) throw new AgentDirRefused(`这个路径是一个软链接：${target}。${ADVICE}。`);
  if (!found.isDirectory()) throw new AgentDirRefused(`这个路径不是目录：${target}。${ADVICE}。`);
  const inside = readdirSync(target);
  if (inside.length > 0) {
    throw new AgentDirRefused(`这个目录不是空的：${target}（里面有 ${inside.slice(0, 3).join("、")}${inside.length > 3 ? ` 等 ${inside.length} 项` : ""}）。${ADVICE}。`);
  }
}

/**
 * 在 target 下写好 pi 的配置目录，返回目录路径。baseUrl 是假端点的地址，例如 http://127.0.0.1:43210/v1。三个文件的写法由期望值 fake_model_cli.json 固定。
 * target 要不存在或者是空目录（checkAgentDir），否则抛出 AgentDirRefused。
 */
export function writeAgentDir(target: string, baseUrl: string): string {
  checkAgentDir(target);
  mkdirSync(target, { recursive: true });
  const models = { providers: { [PROVIDER]: {
    baseUrl,
    api: "openai-completions",
    apiKey: "fake-placeholder-key",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: MODEL_ID, name: "按脚本回话的假模型", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } };
  writeFileSync(join(target, "models.json"), JSON.stringify(models, null, 1), "utf-8");
  writeFileSync(join(target, "settings.json"), "{}", "utf-8");
  writeFileSync(join(target, "auth.json"), "{}", "utf-8");
  return target;
}
