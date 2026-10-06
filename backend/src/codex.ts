/**
 * 「Codex 订阅」这个模型服务在 pi 里是哪个服务商。
 *
 * 产品给它起的服务名（taskwright-codex）只在产品自己的设置里用：它不写进 pi 的模型登记文件，pi 不认识这个名字。
 * 交给 pi 的模型名、让 pi 列模型时用的名字、在凭据文件里找登录凭据时用的名字，都要换成 pi 自己的服务商名。
 *
 * pi 里用 ChatGPT 订阅登录的入口在 OpenAI 这个服务商下，登录凭据记在 openai 名下；产品只认这一个入口。
 * pi 更早的版本另有一个入口，凭据记在 openai-codex 名下，那是另一个服务商，凭据与模型目录都不相通；产品不用它，
 * 只用来认出「在旧的入口登录过、还没有在现在的入口登录」的情形，提示重新登录一次。
 */

/** pi 里 ChatGPT 订阅的服务商名。 */
export const CODEX_PROVIDER = "openai";
/** pi 更早的登录入口的服务商名。 */
export const LEGACY_CODEX_PROVIDER = "openai-codex";

export interface CodexLogin {
  /** 凭据文件里有没有现在的入口的登录凭据（只看在不在，看不出是否还有效）。 */
  logged_in: boolean;
  /** 只在旧的入口登录过：要用现在的入口重新登录一次。 */
  relogin: boolean;
}

/** 这个服务商名下是不是订阅的登录凭据。同一个名下也可以是按量付费的 API 密钥，那不算订阅的登录。 */
function hasLogin(auth: Record<string, any> | null, provider: string): boolean {
  const entry = auth?.[provider];
  return !!entry && typeof entry === "object" && entry.type === "oauth";
}

/** 按凭据文件的内容看登录的情形：auth 是读出来的凭据文件，读不出时给 null。 */
export function codexLogin(auth: Record<string, any> | null): CodexLogin {
  const logged_in = hasLogin(auth, CODEX_PROVIDER);
  return { logged_in, relogin: !logged_in && hasLogin(auth, LEGACY_CODEX_PROVIDER) };
}
