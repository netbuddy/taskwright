/**
 * 给 pi 准备一个只认假端点的配置目录。
 *
 * pi 读配置目录的位置看环境变量 PI_CODING_AGENT_DIR；把它指到使用者自己的临时目录，
 * 里面只放一份 models.json，只登记假端点这一家模型服务，本机用户目录下 pi 的全局配置一概不碰。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_ID } from "./server.ts";

/** pi 的环境变量：配置目录在哪里。 */
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/** models.json 里登记的模型服务名。启动 pi 时 --model 写「服务名/模型编号」。 */
export const PROVIDER = "fake";

/** 启动 pi 时 --model 参数的值。 */
export const MODEL_ARG = `${PROVIDER}/${MODEL_ID}`;

/** 在 target 下写好 pi 的配置目录，返回目录路径。baseUrl 是假端点的地址，例如 http://127.0.0.1:43210/v1。三个文件与 Python 版写出的逐字相同。 */
export function writeAgentDir(target: string, baseUrl: string): string {
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
