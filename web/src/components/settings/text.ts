// 设置页面「模型」一栏里页面自己写的文字与几个小工具。后端给了说明的地方（被拒的原因、获取模型列表的结果、只读的说明）照后端的话显示，不在这里另写。
// 界面上的词：模型服务、用途、语言模型、嵌入模型、接口地址、API 密钥、上下文长度、获取模型列表；「检索」在页面上写成「查找」。

import type { ModelConfig, ModelTestResult, ModelType, Provider, ProviderKind } from "../../api/types";

/**
 * 模型服务的用途：它提供哪一类模型。一个模型服务只有一种用途。每一行是：这类模型的名字、添加时的一句说明、选定的这类模型在页面上的叫法、
 * 这类模型要不要填上下文长度、哪些种类没有这类模型。以后多一类模型，在这里加一行（后端的用途表也加一行）。
 */
export const PURPOSES: Record<ModelType, { name: string; choice: string; label: string; needsContextWindow: boolean; notOfferedBy: ProviderKind[] }> = {
  language: { name: "语言模型", choice: "助手靠它工作。", label: "助手用的语言模型", needsContextWindow: true, notOfferedBy: [] },
  embedding: { name: "嵌入模型", choice: "知识库按意思查找时用它。", label: "查找用的嵌入模型", needsContextWindow: false, notOfferedBy: ["codex"] },
};
/** 用途在页面上出现的先后：添加时的选项、模型服务清单的分组。 */
export const PURPOSE_ORDER = Object.keys(PURPOSES) as ModelType[];
/** 添加模型服务第一步下面的那句说明。 */
export const ONE_PURPOSE_TEXT = "一个模型服务只提供一类模型。同一个地址两类模型都有时，添加两次。";

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

/** 添加模型服务第二步的七个种类，各一句说明。 */
export const KIND_CHOICES: [ProviderKind, string][] = [
  ["ollama", "在本机或者内网里运行的 ollama。"],
  ["llamacpp", "在本机或者内网里运行的 llama.cpp 服务程序。"],
  ["vllm", "在本机或者内网里运行的 vLLM。"],
  ["deepseek", "DeepSeek 的在线接口，要用密钥。"],
  ["aliyun", "阿里云百炼按量付费的接口，要用密钥。"],
  ["openai_compatible", "任何提供兼容 OpenAI 接口的模型服务。"],
  ["codex", "用 ChatGPT 的订阅。要先在命令行里登录。"],
];

/** 添加某种用途的模型服务时可选的种类：没有这类模型的种类不列。 */
export function kindChoices(purpose: ModelType): [ProviderKind, string][] {
  return KIND_CHOICES.filter(([kind]) => !PURPOSES[purpose].notOfferedBy.includes(kind));
}

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

/** 这种模型服务分辨得出模型是哪一类吗：分辨得出的，取回的清单里只有与用途对得上的模型；分辨不出的，清单里是它的全部模型。 */
export function tellsModelType(kind: ProviderKind | null): boolean {
  return kind === "ollama" || kind === "aliyun" || kind === "codex" || kind === null;
}
/** 分辨不出的模型服务，清单上面的那句提醒。 */
export function allModelsListedText(purpose: ModelType): string {
  return `这个模型服务分辨不出哪些是${PURPOSES[purpose].name}，清单里列的是它的全部模型，请只勾${PURPOSES[purpose].name}。`;
}

/** 「到哪里看这个数字」展开的那段说明。 */
export function whereToFind(kind: ProviderKind | null): string {
  if (kind === "ollama") return "ollama 报告的是模型训练时的最大值，不是它实际分配的值，所以这里没有自动填上。请到运行 ollama 的那台电脑上，看 ollama 的设置里给模型分配的上下文长度；没有改过这项设置时，用的是 ollama 的默认值。";
  if (kind === "aliyun") return "请到阿里云百炼的模型说明里查这个模型的上下文长度。";
  return "这个模型服务没有报告上下文长度。请查看模型服务的设置或者它的说明文档，填上它实际分配给这个模型的上下文长度。";
}

export const LANGUAGE_LABEL = PURPOSES.language.label;
export const EMBEDDING_LABEL = PURPOSES.embedding.label;
export const TYPE_NAME: Record<ModelType, string> = { language: PURPOSES.language.name, embedding: PURPOSES.embedding.name };

/** 「现在用的模型」下面那句灰字；选定之后换成接口返回的 note（同一句话）。 */
export const APPLIES_TEXT = "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。";
export const READONLY_PROVIDER_TEXT = "这个模型服务是在配置文件里手工登记的，这里只能看，不能改。";
export const LOGIN_NOTE = "这里只能看出登录凭据在不在，看不出它是否还有效。要确认能用，请选定模型后到任务里试着让助手说一句话。";
/**
 * 登录分两步：先在命令行里运行启动的命令，再在它的界面里输入登录的指令。命令的字面绕不开程序名，别的页面文字不写它。
 * 登录的入口有两个，凭据各记各的，后端两个都认：新的入口是列表里的 OpenAI (ChatGPT subscription)，旧的是 OpenAI Codex (legacy)。
 */
export const LOGIN_COMMAND = "pi";
export const LOGIN_INSTRUCTION = "/login";
export const LOGIN_INSTRUCTION_HINT = "输入后在列表里选 OpenAI (ChatGPT subscription)；用旧入口 OpenAI Codex (legacy) 登录的也可以";
/**
 * 更换或者第一次选定嵌入模型之前确认框的标题、里面的话与确定按钮上的字：知识库里已经有文档时才问。changing 为真是更换（原来选着一个），
 * 为假是第一次选定；documents 是知识库里文档的份数。换算要向模型服务发请求，所以两种情形末尾都写明可能的费用，说法与「测试」的确认框一致。
 */
export function embedConfirmTitle(changing: boolean): string {
  return changing ? "更换嵌入模型？" : "选定嵌入模型？";
}
export function embedConfirmText(documents: number, changing: boolean): string {
  return changing
    ? `换了嵌入模型后，知识库里的 ${documents} 份文档要重新换算，换算完成前按意思查找暂时不可用。商业接口可能产生费用。`
    : `选定嵌入模型后，知识库里的 ${documents} 份文档要先换算，换算完成后才能按意思查找。商业接口可能产生费用。`;
}
export function embedConfirmOk(changing: boolean): string {
  return changing ? "更换并重新换算" : "选定并开始换算";
}
/** 选定之后已经让后台开始换算时的那句提示。 */
export function embedStartedText(documents: number): string {
  return `已开始换算知识库里的 ${documents} 份文档，进度在知识库页面上看。`;
}
/** Codex 订阅的「更新模型目录」：平时不访问外网，点了才访问一次。按钮的字、确认框里的那句、更新好之后的提示。 */
export const REFRESH_CATALOG_LABEL = "更新模型目录";
export const REFRESH_CATALOG_CONFIRM = "会访问一次外网，更新可选模型的目录。";
export const REFRESH_CATALOG_DONE = "模型目录已更新。";
/** 测试之前确认框的标题与里面的那句：写明会发一次真实的请求。 */
export function testConfirmTitle(type: ModelType): string {
  return `测试${TYPE_NAME[type]}`;
}
export function testConfirmText(type: ModelType, model: string): string {
  const what = type === "language" ? "让模型读一个小文件并回一句话" : "把一句话换算成一串数字";
  return `会用「${model}」发一次真实的请求：${what}。商业接口可能产生很少的费用。`;
}
/** 测试结果的头一行。只说这一次，不说这个模型以后都可以用。 */
export function testResultText(result: ModelTestResult): string {
  return result.result === "passed" ? `这一次测试通过，用时 ${result.seconds} 秒。` : `这一次测试没有通过：${result.reason ?? ""}`;
}
/** 语言模型的结果，头一行下面的两行：问了模型什么，模型答了什么。通过与没有通过都写；模型没有回答时照实说。 */
export function testQuestionText(result: ModelTestResult): string {
  return `问模型：${result.question}`;
}
export function testReplyText(result: ModelTestResult): string {
  return result.reply ? `模型回答：${result.reply}` : "模型没有回答";
}
/** 嵌入模型通过时的结果，头一行下面的两行：送去换算的是哪句话（前面带着查询前缀），算出来的数字串有多长。没有通过时只有头一行。 */
export function testSentText(result: ModelTestResult): string {
  return `送去换算的话：${result.question}`;
}
export function testDimensionsText(result: ModelTestResult): string {
  return `算出来的数字串长度：${result.dimensions ?? ""}`;
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
    return `${PURPOSES[type].label} ${ref?.modelId ?? ""}`.trim();
  });
  return `这个模型服务的模型正在被使用（${parts.join("、")}），不能删除。要删除，先在「现在用的模型」里换成别的模型。`;
}
