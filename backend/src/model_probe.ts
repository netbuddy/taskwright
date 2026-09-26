/**
 * 模型可用性探测：启动配置写的模型（「服务商/型号」）在 pi 的配置目录里有没有着落。只读两个文件，不起 pi：
 *   1. 模型登记文件 models.json：providers 下有这个服务商，且它的 models 里有这个型号；
 *   2. 登录凭据文件 auth.json：有以这个服务商为名的一项（pi 内置服务商登录后写在这里）。只看键名，不读凭据内容。
 * 二者之一满足即判「有」。识别不了的情形：内置服务商的密钥只放在环境变量里，这时会判「没有」，原因句里写明。
 * pi 的配置目录取环境变量 PI_CODING_AGENT_DIR，没设时是用户主目录下的 .pi/agent（与 pi 自己的规则相同）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Profile } from "./launch.ts";

export interface ModelProbe {
  /** 启动配置写的模型「服务商/型号」；没写时是空串。 */
  name: string;
  available: boolean;
  /** 一句给人看的原因，写明查过的文件在哪里。 */
  reason: string;
}

/** pi 的配置目录：与 pi 相同，PI_CODING_AGENT_DIR 优先（开头的 ~ 展开成主目录），否则是 ~/.pi/agent。 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured) return configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured;
  return join(homedir(), ".pi", "agent");
}

/** 读一个 JSON 对象文件：没有文件时是 null，读不出或不是对象时是 "bad"。 */
function readObject(path: string): Record<string, any> | null | "bad" {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : "bad";
  } catch {
    return "bad";
  }
}

export function probeModel(profile: Profile, env: NodeJS.ProcessEnv = process.env): ModelProbe {
  const name = typeof profile.model === "string" ? profile.model : "";
  const dir = piAgentDir(env);
  const modelsPath = join(dir, "models.json");
  const authPath = join(dir, "auth.json");
  if (!name) return { name, available: false, reason: "启动配置里没有写模型。" };
  const slash = name.indexOf("/");
  const provider = slash > 0 ? name.slice(0, slash) : name;
  const modelId = slash > 0 ? name.slice(slash + 1) : "";

  const models = readObject(modelsPath);
  if (models !== null && models !== "bad") {
    const entry = models.providers?.[provider];
    const ids = Array.isArray(entry?.models) ? entry.models.map((m: any) => m?.id) : [];
    if (modelId && ids.includes(modelId)) return { name, available: true, reason: `在模型登记文件 ${modelsPath} 里找到了「${name}」。` };
  }
  const auth = readObject(authPath);
  if (auth !== null && auth !== "bad" && Object.hasOwn(auth, provider)) {
    return { name, available: true, reason: `模型服务「${provider}」已经登录，登录凭据文件 ${authPath} 里有它。` };
  }
  const unreadable = [models === "bad" ? modelsPath : null, auth === "bad" ? authPath : null].filter(Boolean);
  const note = unreadable.length ? `（其中 ${unreadable.join("、")} 读不出来，不是有效的 JSON 对象）` : "";
  return {
    name, available: false,
    reason: `在模型登记文件 ${modelsPath} 和登录凭据文件 ${authPath} 里都没有找到「${name}」${note}。如果这个模型服务的密钥只放在环境变量里，这里也会显示没有找到。`,
  };
}
