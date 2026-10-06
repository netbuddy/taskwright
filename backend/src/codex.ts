/**
 * 「Codex 订阅」这个模型服务在 pi 里是哪个服务商。
 *
 * 产品给它起的服务名（taskwright-codex）只在产品自己的设置里用：它不写进 pi 的模型登记文件，pi 不认识这个名字。
 * 交给 pi 的模型名、让 pi 列模型时用的名字、在凭据文件里找登录凭据时用的名字，都要换成 pi 自己的服务商名。
 */

/** pi 里 Codex 订阅的服务商名。 */
export const CODEX_PROVIDER = "openai-codex";
