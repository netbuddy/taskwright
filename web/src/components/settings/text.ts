// 设置页面「模型」一栏里页面自己写的文字与几个小工具。后端给了说明的地方（被拒的原因、获取模型列表的结果、只读的说明）照后端的话显示，不在这里另写。
// 界面上的词：模型服务、语言模型、嵌入模型、接口地址、API 密钥、上下文长度、获取模型列表；「检索」在页面上写成「查找」。

import type { ModelConfig, ModelTestResult, ModelType, Provider, ProviderKind } from "../../api/types";

/** 种类的名字；short 是清单里种类那一行用的短写法。 */
export const KIND_NAME: Record<ProviderKind, string> = {
  ollama: "ollama",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  deepseek: "DeepSeek",
  aliyun: "阿里云百炼",
  openai_compatible: "别的兼容 OpenAI 接口的服务",
  codex: "Codex 订阅",
};
const KIND_SHORT: Partial<Record<ProviderKind, string>> = { openai_compatible: "兼容 OpenAI 接口的服务" };

export function kindName(kind: ProviderKind | null, short = false): string {
  if (kind === null) return "";
  return (short && KIND_SHORT[kind]) || KIND_NAME[kind];
}

/** 添加模型服务第一步的七个种类，各一句说明。 */
export const KIND_CHOICES: [ProviderKind, string][] = [
  ["ollama", "在本机或者内网里运行的 ollama。"],
  ["llamacpp", "在本机或者内网里运行的 llama.cpp 服务程序。"],
  ["vllm", "在本机或者内网里运行的 vLLM。"],
  ["deepseek", "DeepSeek 的在线接口，要用密钥。"],
  ["aliyun", "阿里云百炼按量付费的接口，要用密钥。"],
  ["openai_compatible", "任何提供兼容 OpenAI 接口的模型服务。"],
  ["codex", "用 ChatGPT 的订阅。要先在命令行里登录。"],
];

/** 添加时接口地址一栏预先填的值（与后端的缺省地址相同）；兼容服务要用户自己填，Codex 订阅没有地址。 */
export const DEFAULT_URL: Partial<Record<ProviderKind, string>> = {
  ollama: "http://127.0.0.1:11434",
  llamacpp: "http://127.0.0.1:8080",
  vllm: "http://127.0.0.1:8000",
  deepseek: "https://api.deepseek.com",
  aliyun: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};

export type KindGroup = "local" | "cloud" | "compatible" | "codex";
export function kindGroup(kind: ProviderKind): KindGroup {
  if (kind === "ollama" || kind === "llamacpp" || kind === "vllm") return "local";
  if (kind === "deepseek" || kind === "aliyun") return "cloud";
  return kind === "openai_compatible" ? "compatible" : "codex";
}

/** 这种模型服务能不能自己分辨模型的种类（能的话清单里「种类」只显示，不让选）。 */
export function kindKnown(kind: ProviderKind | null): boolean {
  return kind === "ollama" || kind === "codex" || kind === null;
}

/** 「到哪里看这个数字」展开的那段说明。 */
export function whereToFind(kind: ProviderKind | null): string {
  if (kind === "ollama") return "ollama 报告的是模型训练时的最大值，不是它实际分配的值，所以这里没有自动填上。请到运行 ollama 的那台电脑上，看 ollama 的设置里给模型分配的上下文长度；没有改过这项设置时，用的是 ollama 的默认值。";
  if (kind === "aliyun") return "请到阿里云百炼的模型说明里查这个模型的上下文长度。";
  return "这个模型服务没有报告上下文长度。请查看模型服务的设置或者它的说明文档，填上它实际分配给这个模型的上下文长度。";
}

export const LANGUAGE_LABEL = "助手用的语言模型";
export const EMBEDDING_LABEL = "查找用的嵌入模型";
export const TYPE_NAME: Record<ModelType, string> = { language: "语言模型", embedding: "嵌入模型" };

/** 「现在用的模型」下面那句灰字；选定之后换成接口返回的 note（同一句话）。 */
export const APPLIES_TEXT = "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。";
export const READONLY_PROVIDER_TEXT = "这个模型服务是在配置文件里手工登记的，这里只能看，不能改。";
export const LOGIN_NOTE = "这里只能看出登录凭据在不在，看不出它是否还有效。要确认能用，请选定模型后到任务里试着让助手说一句话。";
/** 登录分两步：先在命令行里运行启动的命令，再在它的界面里输入登录的指令。命令的字面绕不开程序名，别的页面文字不写它。 */
export const LOGIN_COMMAND = "pi";
export const LOGIN_INSTRUCTION = "/login";
export const LOGIN_INSTRUCTION_HINT = "输入后在列表里选 ChatGPT Plus/Pro (Codex)";
/** 测试语言模型之前确认框里的那句：写明会发一次真实的请求。 */
export function testConfirmText(model: string): string {
  return `会用「${model}」发一次真实的请求：让模型读一个小文件并回一句话。商业接口可能产生很少的费用。`;
}
/** 测试结果的那一行。只说这一次，不说这个模型以后都可以用。 */
export function testResultText(result: ModelTestResult): string {
  return result.result === "passed" ? `这一次测试通过，用时 ${result.seconds} 秒。模型回复：${result.reply}` : `这一次测试没有通过：${result.reason ?? ""}`;
}
/** 模型超过这么多个时，清单平时只列出勾上的。 */
export const MANY_MODELS = 10;

export function formatNumber(n: number | null | undefined): string {
  return n == null ? "" : n.toLocaleString("en-US");
}

/** 选定的某种模型所在的模型服务与模型名。 */
export function selected(config: ModelConfig, type: ModelType): { provider: Provider | null; providerId: string; modelId: string } | null {
  const ref = type === "language" ? config.selection.language : config.selection.embedding;
  if (!ref) return null;
  return { provider: config.providers.find((p) => p.id === ref.provider_id) ?? null, providerId: ref.provider_id, modelId: ref.model_id };
}

/** 删除按钮灰着时旁边那句原因：这个模型服务的哪一个模型正被选用。 */
export function inUseText(config: ModelConfig, provider: Provider): string {
  const parts = provider.in_use.map((type) => {
    const ref = selected(config, type);
    return `${type === "language" ? LANGUAGE_LABEL : EMBEDDING_LABEL} ${ref?.modelId ?? ""}`.trim();
  });
  return `这个模型服务的模型正在被使用（${parts.join("、")}），不能删除。要删除，先在「现在用的模型」里换成别的模型。`;
}
