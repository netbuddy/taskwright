/**
 * 「Codex 订阅」这个模型服务在 pi 里是哪个服务商。
 *
 * 产品给它起的服务名（taskwright-codex）只在产品自己的设置里用：它不写进 pi 的模型登记文件，pi 不认识这个名字。
 * 交给 pi 的模型名、让 pi 列模型时用的名字、在凭据文件里找登录凭据时用的名字，都要换成 pi 自己的服务商名。
 *
 * pi 里有两个登录入口，各是一个服务商，各有自己的登录凭据与模型目录，互不相通：旧的入口是 openai-codex；pi 1.0.4 起另有
 * 「用 ChatGPT 登录」，凭据记在 openai 名下。用哪一个看凭据文件：旧入口登录了就是它（已经在用的不受影响）；否则新入口登录了
 * 就是新入口；两个都没有登录时按旧入口算。列模型、判断登录、交给 pi 的模型名都用这里的结果。
 */

import { join } from "node:path";
import { readForView } from "./config_files.ts";

/** pi 里 Codex 订阅的服务商名（旧的登录入口）。 */
export const CODEX_PROVIDER = "openai-codex";
/** pi 1.0.4 起「用 ChatGPT 登录」的凭据记在这个服务商名下。同一个名下也可以是按量付费的 API 密钥，那不算订阅。 */
export const CHATGPT_PROVIDER = "openai";

export interface CodexAccess {
  /** pi 的服务商名。 */
  provider: string;
  /** 凭据文件里有没有这个服务商的登录凭据（只看在不在，看不出是否还有效）。 */
  logged_in: boolean;
}

function hasLogin(auth: Record<string, any> | null, provider: string): boolean {
  const entry = auth?.[provider];
  return !!entry && typeof entry === "object" && entry.type === "oauth";
}

/** 按凭据文件的内容定：auth 是读出来的凭据文件，读不出时给 null。 */
export function codexAccess(auth: Record<string, any> | null): CodexAccess {
  if (hasLogin(auth, CODEX_PROVIDER)) return { provider: CODEX_PROVIDER, logged_in: true };
  if (hasLogin(auth, CHATGPT_PROVIDER)) return { provider: CHATGPT_PROVIDER, logged_in: true };
  return { provider: CODEX_PROVIDER, logged_in: false };
}

/** 读某个 pi 配置目录里的凭据文件来定。只读。 */
export function codexAccessIn(agentDir: string): CodexAccess {
  return codexAccess(readForView(join(agentDir, "auth.json")));
}
