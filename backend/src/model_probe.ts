/**
 * 模型可用性探测：启动配置写的模型（「服务商/型号」）在 pi 的配置目录里有没有着落。只读两个文件，不起 pi：
 *   1. 模型登记文件 models.json：providers 下有这个服务商，且它的 models 里有这个型号；
 *   2. 登录凭据文件 auth.json：有以这个服务商为名的一项（pi 内置服务商登录后写在这里）。只看键名，不读凭据内容。
 * 二者之一满足即判「有」。识别不了的情形：内置服务商的密钥只放在环境变量里，这时会判「没有」，原因句里写明。
 * pi 的配置目录取环境变量 PI_CODING_AGENT_DIR，没设时是用户主目录下的 .pi/agent（与 pi 自己的规则相同）。
 * 要探测的模型与起 pi 时用的相同（launch.ts 的 resolveModel）：先看产品设置里在界面上选定的语言模型；没有选过时，
 * 桌面形态下 pi 设置文件指定了模型就探测那一个，否则是启动配置里的。
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Profile, piAgentDir, resolveModel } from "./launch.ts";

export interface ModelProbe {
  /** 启动配置写的模型「服务商/型号」；没写时是空串。 */
  name: string;
  available: boolean;
  /** 一句给人看的原因，写明查过的文件在哪里。 */
  reason: string;
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

/**
 * paths 为真时原因句写出两个文件的完整路径（桌面形态：用户要知道往哪里放文件）；为假时只写文件名（服务器形态：
 * 服务信息远程也看得到，不带出服务器上的目录）。
 */
export function probeModel(profile: Profile, env: NodeJS.ProcessEnv = process.env, options: { paths?: boolean } = {}): ModelProbe {
  const paths = options.paths ?? true;
  const resolved = resolveModel(profile, env);
  const name = resolved.model;
  const dir = piAgentDir(env);
  const modelsPath = join(dir, "models.json");
  const authPath = join(dir, "auth.json");
  const shown = (path: string) => (paths ? path : basename(path));
  if (!name) return { name, available: false, reason: "启动配置里没有写模型。" };
  const picked = resolved.from === "pi 设置" ? `（由 pi 设置文件 ${resolved.settings} 指定）`
    : resolved.from === "产品设置" ? "（在设置的「模型」一栏选定）" : "";
  const slash = name.indexOf("/");
  const provider = slash > 0 ? name.slice(0, slash) : name;
  const modelId = slash > 0 ? name.slice(slash + 1) : "";

  const models = readObject(modelsPath);
  if (models !== null && models !== "bad") {
    const entry = models.providers?.[provider];
    const ids = Array.isArray(entry?.models) ? entry.models.map((m: any) => m?.id) : [];
    if (modelId && ids.includes(modelId)) return { name, available: true, reason: `在模型登记文件 ${shown(modelsPath)} 里找到了「${name}」${picked}。` };
  }
  const auth = readObject(authPath);
  if (auth !== null && auth !== "bad" && Object.hasOwn(auth, provider)) {
    return { name, available: true, reason: `模型服务「${provider}」已经登录，登录凭据文件 ${shown(authPath)} 里有它${picked ? `；模型「${name}」${picked}` : ""}。` };
  }
  const unreadable = [models === "bad" ? shown(modelsPath) : null, auth === "bad" ? shown(authPath) : null].filter(Boolean);
  const note = unreadable.length ? `（其中 ${unreadable.join("、")} 读不出来，不是有效的 JSON 对象）` : "";
  return {
    name, available: false,
    reason: `在模型登记文件 ${shown(modelsPath)} 和登录凭据文件 ${shown(authPath)} 里都没有找到「${name}」${picked}${note}。如果这个模型服务的密钥只放在环境变量里，这里也会显示没有找到。`,
  };
}
