/**
 * 「回复」的核心逻辑：核对一次回复的形式，合格时整理出要送达的内容。
 *
 * 执行者对用户说话一律经「回复」工具。一次回复由三部分组成：零到多条告知（informs，每条一句话，说到某个条目时
 * 在 items 里点名它），至多一个向用户要的回应（act，提问、请确认、给建议值、请选择、提议五种之一，只在执行者
 * 等用户的一个具体回应时才有），以及一段成文的话（text）。
 *
 * 这里只做形式与事实核对，不做任何语义判断，也没有关键词清单：
 *   1. 同一轮里有别的工具调用时拒绝（回复必须单独调用，才能让 pi 在这一轮之后结束本次运行）；
 *   2. 各项该有的有、不该有的没有，类型对得上；
 *   3. 提问、请确认、给建议值、提议四种要的回应必须在 items 里点名关联的条目与修订号，点名的条目在库里真实存在、
 *      修订号是它当前所在的修订（读库核对，不判断内容）；与任何条目都无关的提问、建议、提议写 scope: "general"，
 *      这时 items 可以不写。告知的 items 可以不写，写了就按同一条规矩核对；
 *   4. 卡片上的话只是把某条告知再说一遍时拒绝（去掉空白与标点后比对文字，见 echoedAct）。
 * 不合格时抛出异常，异常文字用中文写明缺什么、多了什么，由 pi 交还模型重写。
 *
 * 连续被拒的上限：执行函数从会话当前分支数出这一次运行里「回复」已经连续被拒了几次
 * （consecutiveReplyRejections，不另存状态），交给 decideReply。第 3 次起拒绝理由改为只要成文正文、act 写 null；
 * 第 5 次仍不合格时放行一条纯文字回复，标 degraded，可读性优先于结构完整。
 *
 * 回复不写库，也不记事件。本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { FALLBACK_TEXT } from "../hooks/reply_fallback.ts";
import { databasePath } from "./db.ts";
import { EXECUTOR_FUNCTIONS, INTENT_GATE_TEXT } from "./intent_schema.ts";
import { type TurnCall, isBlank, isObject, lastAssistantTurn, requireAlone } from "./speak.ts";

// 「说话」类工具的公共骨架在 speak.ts；这里再导出一次，原来从本文件引用它们的代码不用改。
export { type TurnCall, lastAssistantTurn };

/** 工具名。同一轮的调用列表里按它认出自己。 */
export const REPLY_TOOL_NAME = "reply";

/** 向用户要的回应的五种：取自理解格式的 schema（agent/prompts/schemas/user_intent.schema.json 的 $defs.executor_function），
 *  与对话行为表里执行者侧的功能是同一份清单。 */
export const ACT_KINDS = EXECUTOR_FUNCTIONS as readonly ("ask" | "confirm" | "suggest" | "choose" | "propose")[];
export type ActKind = (typeof ACT_KINDS)[number];

/** 提议的预览里，每一项对条目的影响。 */
export const PREVIEW_EFFECTS = ["remove", "add", "change"] as const;

/** 给建议值时依据的种类，与条目来源的种类一致。 */
export const BASIS_KINDS = ["文档原文", "用户的话", "执行者补充"] as const;

/** 每种要的回应除 kind、text、items 之外还允许写哪几项。items 五种都可以写。 */
const ALLOWED_EXTRA: Record<ActKind, string[]> = {
  ask: ["scope"],
  confirm: [],
  suggest: ["value", "basis", "scope"],
  choose: ["options"],
  propose: ["preview", "scope"],
};

/** 必须在 items 里点名关联条目的几种要的回应。其中提问、给建议值、提议写 scope: "general" 时可以不点名。 */
const ITEMS_REQUIRED: ActKind[] = ["ask", "confirm", "suggest", "propose"];

/** scope 唯一允许的取值：这一问、这条建议或提议与任何条目都无关。 */
export const SCOPE_GENERAL = "general";

/** 连续被拒到第几次起，拒绝理由改为只要成文正文。 */
export const PLAIN_TEXT_FROM = 3;

/** 连续被拒到第几次仍不合格时，放行一条纯文字回复。 */
export const DEGRADE_AT = 5;

/** 中文里怎样称呼每种要的回应，用在拒绝理由里。 */
const KIND_NAME: Record<ActKind, string> = {
  ask: "提问（ask）",
  confirm: "请确认（confirm）",
  suggest: "给建议值（suggest）",
  choose: "请选择（choose）",
  propose: "提议（propose）",
};

export interface ItemRef {
  item_id: string;
  /** 条目当前所在的修订号。 */
  revision_no: number;
}

export interface ReplyAct {
  kind: ActKind;
  text: string;
  items?: ItemRef[];
  options?: { key: string; text: string }[];
  value?: string;
  basis?: { kind: string; locator: string; excerpt: string }[];
  preview?: { effect: string; text: string }[];
  scope?: typeof SCOPE_GENERAL;
}

/** 一条告知：一句话，说到某个条目时在 items 里点名它（界面画成链接）。告知不等用户回应。 */
export interface Inform {
  text: string;
  items?: ItemRef[];
}

/** 告知的文字：旧的会话记录里告知是一句纯文字，新的是 { text, items }。两种都认。 */
export function informText(one: unknown): string {
  if (typeof one === "string") return one;
  return isObject(one) && typeof one.text === "string" ? one.text : "";
}

export interface Reply {
  informs: Inform[];
  act: ReplyAct | null;
  text: string;
}

/** 某个条目在某次修订下在库里的情况。 */
export type RevisionFact = "是当前所在的修订" | "不是当前所在的修订" | "没有这个条目" | "条目已删除" | "这次修订没有改动它" | "还没有库";

export interface ReplyFacts {
  /** 这次调用的编号。 */
  toolCallId: string;
  /** 这一轮助手消息里的全部工具调用，由工具的执行函数从会话当前分支读出。 */
  callsThisTurn: TurnCall[];
  /** 查某个条目在某次修订下在库里的情况。 */
  revisionFact: (itemId: string, revisionNo: number) => RevisionFact;
  /** 查某个条目当前所在的修订号，拒绝理由里用；不给就不写它现在是哪次修订。 */
  currentRevisionOf?: (itemId: string) => number | null;
  /** 这一次运行里「回复」在这次调用之前已经连续被拒了几次，不给按 0 算。 */
  priorRejections?: number;
}

/** 键名里带引号、冒号或空白时，多半是模型把 JSON 写坏了（例如写成「text': 」）；拒绝理由里点明这一点。 */
function brokenKeyHint(key: string): string {
  return /["'`:\s]/.test(key)
    ? `；这个键名里带着引号、冒号或空白，像是 JSON 写坏了，请把整个 act 重新写一遍，键名里只写字母`
    : "";
}

/**
 * 核对一次回复。合格时返回整理好的回复（只含形状里的那几项）；不合格时抛出异常，逐条写明哪里不对。
 */
export function checkReply(params: unknown, facts: ReplyFacts): Reply {
  // 第 1 条：单独调用。先查这一条，因为同一轮混入别的调用时，形式再对也送不出去。
  requireAlone("回复", REPLY_TOOL_NAME, facts.toolCallId, facts.callsThisTurn);

  const errors: string[] = [];
  if (!isObject(params)) {
    throw new Error("回复的参数应当是一个对象，有 informs、act、text 三项。这次回复没有送达。");
  }
  for (const key of Object.keys(params)) {
    if (!["informs", "act", "text"].includes(key)) {
      errors.push(`多了「${key}」这一项，回复只有 informs、act、text 三项${brokenKeyHint(key)}`);
    }
  }

  // informs：每条是 { text, items? }；为兼容旧写法，一句纯文字也认，当作没有 items。
  let informs: Inform[] = [];
  if (!("informs" in params)) {
    errors.push("缺少 informs；没有要告知的事时写空列表 []");
  } else if (!Array.isArray(params.informs)) {
    errors.push("informs 应当是一个列表，每条是 { text, items }");
  } else {
    informs = params.informs.map((one, index) => checkInform(one, index, facts, errors));
  }

  // text
  if (!("text" in params) || isBlank(params.text)) {
    errors.push("缺少 text，或者 text 全是空白；text 是给用户读的成文的话，必须写");
  }

  // act
  let act: ReplyAct | null = null;
  if (!("act" in params)) {
    errors.push("缺少 act；你不等用户回应时写 null");
  } else if (params.act !== null) {
    act = checkAct(params.act, facts, errors);
  }
  if (act && errors.length === 0 && echoedAct(act.text, informs)) errors.push(ECHO_TEXT);

  if (errors.length > 0) {
    throw new Error(
      `这次回复的形式不对，没有送达。请按下面几处改好后重新单独调用 reply：\n` +
        errors.map((e, i) => `${i + 1}. ${e}。`).join("\n"),
    );
  }
  return { informs, act, text: params.text as string };
}

function checkInform(one: unknown, index: number, facts: ReplyFacts, errors: string[]): Inform {
  const where = `informs 的第 ${index + 1} 条`;
  if (typeof one === "string") {
    if (isBlank(one)) errors.push(`${where}是空的，每条告知都要是一句完整的话`);
    return { text: one };
  }
  if (!isObject(one)) {
    errors.push(`${where}应当是 { text, items }，text 是一句完整的话`);
    return { text: "" };
  }
  for (const key of Object.keys(one)) {
    if (key !== "text" && key !== "items") errors.push(`${where}里多了「${key}」这一项，告知只有 text 与 items 两项${brokenKeyHint(key)}`);
  }
  if (isBlank(one.text)) errors.push(`${where}的 text 是空的或者不是文字，每条告知都要是一句完整的话`);
  const inform: Inform = { text: typeof one.text === "string" ? one.text : "" };
  if ("items" in one) {
    checkItemList(one.items, `${where}的 items`, true, facts, errors);
    if (Array.isArray(one.items)) inform.items = one.items as ItemRef[];
  }
  return inform;
}

/** 卡片上的话只是把刚说过的话再说一遍时的拒绝理由。 */
export const ECHO_TEXT =
  "卡片里写的是你刚说过的话，不是要用户回应的东西；不需要用户回应就把 act 写 null，要回应就把要用户回答的那句话写进 act";

/** 比对文字时去掉空白与标点，只看剩下的字。 */
function bareText(text: string): string {
  return text.replace(/[\s\p{P}]/gu, "");
}

/**
 * 卡片上的话是不是只把某条告知再说一遍：与某条告知相同，或者被它完整包含。告知是已经说出的事实，
 * 要用户回应的那句话不该是其中一条。成文的话不比：它本来就要把要用户回应的那句话连进去，整段只有这一句问话也合法。
 * 不做任何语法判断（陈述式的问法合法）。
 */
export function echoedAct(actText: string, informs: Inform[]): boolean {
  const card = bareText(actText);
  if (!card) return false;
  return informs.some((one) => bareText(one.text).includes(card));
}

function checkAct(raw: unknown, facts: ReplyFacts, errors: string[]): ReplyAct | null {
  if (!isObject(raw)) {
    errors.push("act 应当是 null 或者一个对象");
    return null;
  }
  // 写坏的键名先单独报出来：kind 的键名写坏时，下面会因为「没有 kind」提前返回，不先报就看不到真正的原因。
  const broken = Object.keys(raw).filter((key) => brokenKeyHint(key) !== "");
  for (const key of broken) {
    errors.push(`act 里有一个键名写成了「${key}」${brokenKeyHint(key)}`);
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !(ACT_KINDS as readonly string[]).includes(kind)) {
    errors.push(`act.kind 写的是 ${JSON.stringify(kind)}，只能是 ${ACT_KINDS.join("、")} 五者之一`);
    return null;
  }
  const k = kind as ActKind;
  const name = KIND_NAME[k];
  const allowed = new Set(["kind", "text", "items", ...ALLOWED_EXTRA[k]]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key) && !broken.includes(key)) {
      const owner = (Object.keys(ALLOWED_EXTRA) as ActKind[]).filter((x) => ALLOWED_EXTRA[x].includes(key));
      errors.push(
        owner.length > 0
          ? `${name}不写 act.${key}；${key} 只属于${owner.map((x) => KIND_NAME[x]).join("、")}`
          : `act 里多了「${key}」这一项，act 只有 kind、text、items、options、value、basis、preview 这几项`,
      );
    }
  }
  if (isBlank(raw.text)) errors.push(`act.text 是空的；${name}要写明问的、请确认的、建议的或提议的是什么`);

  // scope 只有一个取值；写了 general 就表示与条目无关，不要再点名条目。
  const general = raw.scope === SCOPE_GENERAL;
  if ("scope" in raw && !general) {
    errors.push(`act.scope 写的是 ${JSON.stringify(raw.scope)}，只能写 "general"（表示与任何条目都无关），或者不写`);
  }
  if (general && Array.isArray(raw.items) && raw.items.length > 0) {
    errors.push(`act.scope 写了 "general"，表示与任何条目都无关，就不要再在 items 里点名条目；二者只能选一个`);
  }
  // items：五种都可以写；提问、请确认、给建议值、提议必填（前三种写了 scope: "general" 时除外）
  const required = ITEMS_REQUIRED.includes(k) && !(general && k !== "confirm");
  if (!general && ("items" in raw || required)) {
    if (required && (!Array.isArray(raw.items) || raw.items.length === 0)) errors.push(missingItemsText(k));
    else checkItemList(raw.items, "act.items", required, facts, errors);
  }

  if (k === "choose") {
    const options = raw.options;
    if (!Array.isArray(options) || options.length < 2) {
      errors.push("请选择（choose）要写 act.options，至少两个选项，每项是 { key, text }");
    } else {
      const seen = new Set<string>();
      options.forEach((one, index) => {
        if (!isObject(one) || isBlank(one.key) || isBlank(one.text)) {
          errors.push(`act.options 的第 ${index + 1} 项要有不为空的 key 与 text`);
          return;
        }
        if (seen.has(one.key as string)) errors.push(`act.options 里的 key「${one.key}」重复了，每个选项的 key 要不一样`);
        seen.add(one.key as string);
      });
    }
  }

  if (k === "suggest") {
    if (isBlank(raw.value)) errors.push("给建议值（suggest）要写 act.value，也就是你建议的那个值");
    const basis = raw.basis;
    if (!Array.isArray(basis) || basis.length === 0) {
      errors.push("给建议值（suggest）要写 act.basis，至少一条依据，每条是 { kind, locator, excerpt }");
    } else {
      basis.forEach((one, index) => {
        const where = `act.basis 的第 ${index + 1} 条`;
        if (!isObject(one)) {
          errors.push(`${where}应当是一个对象，有 kind、locator、excerpt 三项`);
          return;
        }
        if (typeof one.kind !== "string" || !(BASIS_KINDS as readonly string[]).includes(one.kind)) {
          errors.push(`${where}的 kind 写的是 ${JSON.stringify(one.kind)}，只能是${BASIS_KINDS.map((x) => `「${x}」`).join("、")}之一`);
        }
        if (isBlank(one.locator)) errors.push(`${where}缺少 locator（出处：文档原文写文件路径，用户的话写会话条目编号）`);
        if (isBlank(one.excerpt)) errors.push(`${where}缺少 excerpt（摘录的原文）`);
      });
    }
  }

  if (k === "propose" && "preview" in raw) {
    const preview = raw.preview;
    if (!Array.isArray(preview) || preview.length === 0) {
      errors.push("act.preview 写了就应当是一个不为空的列表，每项是 { effect, text }");
    } else {
      preview.forEach((one, index) => {
        const where = `act.preview 的第 ${index + 1} 项`;
        if (!isObject(one)) {
          errors.push(`${where}应当是一个对象，有 effect 与 text 两项`);
          return;
        }
        if (typeof one.effect !== "string" || !(PREVIEW_EFFECTS as readonly string[]).includes(one.effect)) {
          errors.push(`${where}的 effect 写的是 ${JSON.stringify(one.effect)}，只能是 ${PREVIEW_EFFECTS.join("、")} 之一`);
        }
        if (isBlank(one.text)) errors.push(`${where}的 text 是空的`);
      });
    }
  }

  const act: ReplyAct = { kind: k, text: raw.text as string };
  for (const key of ["items", ...ALLOWED_EXTRA[k]] as const) {
    if (key in raw) (act as unknown as Record<string, unknown>)[key] = raw[key];
  }
  return act;
}

/** 必须点名条目却没有点名时的拒绝理由。 */
function missingItemsText(kind: ActKind): string {
  if (kind === "confirm") return "请确认（confirm）要写 act.items，点名要确认的是哪几个条目，每项是 { item_id, revision_no }，revision_no 写条目当前所在的修订";
  const what = kind === "ask" ? "提问" : kind === "suggest" ? "建议" : "提议";
  return (
    `${what}要写明${kind === "ask" ? "问" : "说"}的是哪个条目或问题条目：在 act.items 里点名，每项是 { item_id, revision_no }，` +
    `revision_no 写它当前所在的修订；与条目无关的${kind === "ask" ? "问题" : what}请写 scope: "general"`
  );
}

/**
 * 核对一串条目点名（act.items 或某条告知的 items）。check 为真时每项都要有修订号，并读库核对条目存在、
 * 修订号是它当前所在的修订；为假时只核对形状（请选择的 items 可以不写修订号，也不读库）。
 */
function checkItemList(items: unknown, label: string, check: boolean, facts: ReplyFacts, errors: string[]): void {
  if (!Array.isArray(items)) {
    errors.push(`${label}写了就应当是一个列表，每项是 { item_id, revision_no }`);
    return;
  }
  const required = check;
  items.forEach((one, index) => {
    const where = `${label} 的第 ${index + 1} 项`;
    if (!isObject(one) || isBlank(one.item_id)) {
      errors.push(`${where}要写 item_id（条目编号，例如 UC-001）`);
      return;
    }
    const revision = one.revision_no;
    if (revision === undefined || revision === null) {
      if (required) errors.push(`${where}（${one.item_id}）缺少 revision_no；写这个条目当前所在的修订号`);
      return;
    }
    if (!Number.isInteger(revision) || (revision as number) < 1) {
      errors.push(`${where}（${one.item_id}）的 revision_no 应当是一个从 1 起的整数，现在写的是 ${JSON.stringify(revision)}`);
      return;
    }
    if (!required) return;
    const fact = facts.revisionFact(one.item_id as string, revision as number);
    if (fact === "还没有库") errors.push("这个任务目录还没有任务数据库，库里没有任何条目，没有东西可以点名");
    else if (fact === "没有这个条目") errors.push(`${where}：库里没有条目 ${one.item_id}`);
    else if (fact === "条目已删除") errors.push(`${where}：条目 ${one.item_id} 已经删除了，不能再点名它`);
    else if (fact === "这次修订没有改动它" || fact === "不是当前所在的修订") {
      const current = facts.currentRevisionOf?.(one.item_id as string);
      errors.push(
        `${where}：条目 ${one.item_id} 现在不是修订 ${revision}${current ? `，它现在是修订 ${current}` : ""}；只能点名条目当前所在的修订`,
      );
    }
  });
}

/** 一次「回复」调用的结果：送达的回复，以及它是不是连续被拒到上限之后放行的纯文字回复。 */
export interface ReplyDecision {
  reply: Reply;
  degraded: boolean;
}

/**
 * 按连续被拒的次数决定这次回复怎样处理：合格就送达；不合格时，这是第 3 次起的被拒就改为只要成文正文，
 * 这是第 5 次被拒就放行一条纯文字回复（正文取 text，没有就取告知与要的回应的文字），标 degraded。
 * 单独调用的核对（同一轮混入别的工具）不放行：那时 pi 本来也结束不了这一轮。
 */
export function decideReply(params: unknown, facts: ReplyFacts): ReplyDecision {
  try {
    return { reply: checkReply(params, facts), degraded: false };
  } catch (error) {
    const attempt = (facts.priorRejections ?? 0) + 1;
    const message = (error as Error).message;
    const alone = message.includes("必须单独调用");
    if (attempt >= DEGRADE_AT && !alone) {
      const text = plainTextOf(params);
      if (text) return { reply: { informs: [], act: null, text }, degraded: true };
    }
    if (attempt >= PLAIN_TEXT_FROM) {
      throw new Error(
        `这是这一次回应里「回复」连续第 ${attempt} 次没有送达。请不要再写告知与要的回应：只写成文的话 text，` +
          `informs 写 []，act 写 null，单独调用 reply。上一次的问题是：\n${message}`,
      );
    }
    throw error;
  }
}

/** 放行纯文字回复时的正文：先取 text，没有就把告知与要的回应的文字接起来。 */
function plainTextOf(params: unknown): string {
  if (!isObject(params)) return "";
  if (!isBlank(params.text)) return (params.text as string).trim();
  const parts: string[] = [];
  if (Array.isArray(params.informs)) parts.push(...params.informs.map(informText).filter((one) => !isBlank(one)));
  if (isObject(params.act) && !isBlank(params.act.text)) parts.push(String(params.act.text));
  return parts.join("\n").trim();
}

type BranchEntry = { type: string; message?: { role?: string; toolName?: string; isError?: boolean; content?: unknown } };

/**
 * 从会话当前分支的末尾往回数：这一次运行里「回复」已经连续被拒了几次。
 * 遇到一次成功的「回复」、或者一条用户消息就停；兜底扩展追加的那句固定文字不算用户消息，因为兜底之后的续跑
 * 仍属于同一次运行。别的工具调用与扩展写入的自定义消息不打断连续。因为这一轮还没有写理解而被拒的那几次不算：
 * 那不是回复的形式不对（见 lib/dialogue_acts.ts 的门禁）。
 */
export function consecutiveReplyRejections(branch: BranchEntry[]): number {
  let count = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || !entry.message) continue;
    const { role } = entry.message;
    if (role === "toolResult" && entry.message.toolName === REPLY_TOOL_NAME) {
      if (entry.message.isError !== true) break;
      if (textOfContent(entry.message.content).includes(INTENT_GATE_TEXT)) continue;
      count += 1;
    } else if (role === "user") {
      const content = entry.message.content;
      const text = typeof content === "string"
        ? content
        : (Array.isArray(content) ? content : []).map((part: any) => (part?.type === "text" ? part.text : "")).join("");
      if (text.trim() !== FALLBACK_TEXT) break;
    }
  }
  return count;
}

function textOfContent(content: unknown): string {
  return typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : []).map((part: any) => (part?.type === "text" ? part.text : "")).join("");
}

/**
 * 按库里的事实回答「某个条目在某次修订下有没有内容、是不是它当前所在的修订」。库以只读方式打开，查完就关。
 * 返回一个查询函数，同一次核对里的几次查询共用一个连接。
 */
export function openRevisionLookup(workspaceDir: string): {
  revisionFact: ReplyFacts["revisionFact"];
  currentRevisionOf: (itemId: string) => number | null;
  close: () => void;
} {
  const path = databasePath(workspaceDir);
  if (!existsSync(path)) return { revisionFact: () => "还没有库", currentRevisionOf: () => null, close: () => {} };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  const itemRow = db.prepare("SELECT deleted_in_revision FROM item WHERE item_id = ?");
  const revisionRow = db.prepare("SELECT 1 FROM item_version WHERE item_id = ? AND revision_no = ?");
  const latestRow = db.prepare("SELECT MAX(revision_no) AS v FROM item_version WHERE item_id = ?");
  const currentRevisionOf = (itemId: string) => ((latestRow.get(itemId) as { v: number | null } | undefined)?.v ?? null);
  return {
    revisionFact(itemId, revisionNo) {
      const item = itemRow.get(itemId) as { deleted_in_revision: number | null } | undefined;
      if (!item) return "没有这个条目";
      if (item.deleted_in_revision !== null) return "条目已删除";
      if (!revisionRow.get(itemId, revisionNo)) return "这次修订没有改动它";
      return currentRevisionOf(itemId) === revisionNo ? "是当前所在的修订" : "不是当前所在的修订";
    },
    currentRevisionOf,
    close: () => db.close(),
  };
}
