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
 *   4. 卡片上的话只是把某条告知再说一遍时拒绝（去掉空白与标点后比对文字，见 echoedAct）；
 *   5. 给建议值的依据按保存修订的来源同一套规则逐字核对（ReplyFacts.checkBasis，即 lib/save_revision.ts 的 checkQuotes）。
 * 不合格时抛出异常，异常文字用中文写明缺什么、多了什么，由 pi 交还模型重写。
 *
 * 连续被拒的上限：执行函数从会话当前分支数出这一次运行里「回复」已经连续被拒了几次
 * （consecutiveReplyRejections，不另存状态），交给 decideReply。第 3 次起拒绝理由改为只要成文正文、act 写 null；
 * 第 5 次仍不合格时放行一条纯文字回复，标 degraded，可读性优先于结构完整。
 *
 * 回复不写库，也不记事件（被拒时由工具登记处把拒绝记进 tool_rejection 表，见 lib/tool_rejection.ts）。本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { FALLBACK_TEXT } from "../hooks/reply_fallback.ts";
import { databasePath } from "./db.ts";
import { keepPendingField, validateDefinition } from "./definition.ts";
import { EXECUTOR_FUNCTIONS, understandingGateOf } from "./intent_schema.ts";
import { type TurnCall, isBlank, isObject, lastAssistantTurn, requireAlone } from "./speak.ts";
import { ToolRejection, codesOf, withCodes } from "./tool_rejection.ts";
import { GUIDANCE_PREFIX, problem, problemText, splitGuide } from "./save_revision.ts";
import { codeOf, fillText, refusalText } from "./texts.ts";
import type { Refusal } from "./stage.ts";
import { EXECUTOR_SOURCE_KINDS, SOURCE_SUPPLEMENT } from "./schema.ts";

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

/** 给建议值时依据的种类，与执行者能填的条目来源种类是同一份清单。 */
export const BASIS_KINDS = EXECUTOR_SOURCE_KINDS;

/** 每种要的回应除 kind、text、items 之外还允许写哪几项。items 五种都可以写。 */
const ALLOWED_EXTRA: Record<ActKind, string[]> = {
  ask: ["scope", "resends"],
  confirm: [],
  suggest: ["value", "basis", "scope"],
  choose: ["options", "multiple", "topic", "resends"],
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

/** 中文里怎样称呼每种要的回应，用在拒绝理由里（模板 part.kind_*）。 */
const KIND_NAME: Record<ActKind, string> = {
  get ask() { return fillText("part.kind_ask"); },
  get confirm() { return fillText("part.kind_confirm"); },
  get suggest() { return fillText("part.kind_suggest"); },
  get choose() { return fillText("part.kind_choose"); },
  get propose() { return fillText("part.kind_propose"); },
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
  /** 请选择的选项；reason 是这一项的出处或理由，写了的话界面在选项下面另起一行显示。 */
  options?: { key: string; text: string; reason?: string }[];
  /** 请选择可以选几项：写 true 是可以多选，不写是只选一项。 */
  multiple?: boolean;
  /** 请选择问的是哪件事：几个字，界面写在卡片顶上「提问 · 」之后。 */
  topic?: string;
  value?: string;
  basis?: { kind: string; locator: string; excerpt: string }[];
  preview?: { effect: string; text: string }[];
  scope?: typeof SCOPE_GENERAL;
  /** 这张卡片是把先前哪一张没有答的卡片重发一遍：那一张的行为编号（例如 r3-2）。只有提问与请选择可以写。 */
  resends?: string;
}

/** 一张卡片能不能被重发：能的话是哪一种；不能的话为什么。 */
export type ResendFact = { open: true; kind: string } | { open: false; why: string };

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
  /** 助手在这条回复里汇报本会话的工作项（单项活动）做完了。只有写了 true 才带这一项。 */
  activity_done?: true;
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
  /**
   * 核对给建议值时的依据：与保存修订的来源同一套逐字核对（lib/save_revision.ts 的 checkQuotes），通过时返回核对后的依据，
   * 不通过时把原因推进 errors 并返回 null。工具的执行函数按任务目录与当前会话分支接好；不给时只核对依据的形状
   * （种类、出处、摘录齐全），摘录不拿去比对，给直接调用本函数的单元测试用。
   */
  checkBasis?: (raw: unknown, errors: string[], whereOf: (index: number) => string) => ReplyAct["basis"] | null;
  /**
   * 查 act.resends 写的那个行为编号是不是一张还开着、可以重发的卡片（lib/dialogue_acts.ts 的 resendFact）。
   * 不给时只核对写了没有，给直接调用本函数的单元测试用。
   */
  resendFact?: (actId: string) => ResendFact;
  /**
   * 回复里写了 activity_done: true 时调用：这条会话正在做一个单项活动的工作项就返回 null（可以汇报做完），否则返回拒绝的事实与怎么办
   * （lib/stage.ts 的 activityDoneRefusal）。不给时不核对，给直接调用本函数的单元测试用。
   */
  activityDoneRefusal?: () => Refusal | null;
  /**
   * 某个条目是不是问题条目（所在集合由 lib/definition.ts 的 keepPendingField 认出）。提问点名的问题条目多于一个就拒绝。
   * 不给时不按条目核对，给直接调用本函数的单元测试用。
   */
  problemItem?: (itemId: string) => boolean;
}

/** 键名里带引号、冒号或空白时，多半是模型把 JSON 写坏了（例如写成「text': 」）；拒绝理由里点明这一点。 */
function brokenKeyHint(key: string): string {
  return /["'`:\s]/.test(key) ? fillText("part.broken_key_hint") : "";
}

/**
 * 核对一次回复。合格时返回整理好的回复（只含形状里的那几项）；不合格时抛出异常，逐条写明哪里不对。
 */
export function checkReply(params: unknown, facts: ReplyFacts): Reply {
  // 第 1 条：单独调用。先查这一条，因为同一轮混入别的调用时，形式再对也送不出去。
  requireAlone("回复", REPLY_TOOL_NAME, facts.toolCallId, facts.callsThisTurn);

  const errors: string[] = [];
  if (!isObject(params)) {
    const refusal = refusalText("reply.params_not_object");
    throw withCodes(new Error(refusal.fact), [refusal.code]);
  }
  for (const key of Object.keys(params)) {
    if (!["informs", "act", "text", "activity_done"].includes(key)) {
      errors.push(problem(refusalText("reply.extra_key", { key, hint: brokenKeyHint(key) })));
    }
  }

  // activity_done：助手汇报本会话的工作项（单项活动）做完了。只认 true、false 与 null；写了 true 而这条会话不在做单项活动的工作项就拒绝。
  const done = params.activity_done;
  if (done !== undefined && done !== null && typeof done !== "boolean") {
    errors.push(problem(refusalText("reply.activity_done_invalid")));
  } else if (done === true) {
    const refusal = facts.activityDoneRefusal?.() ?? null;
    if (refusal !== null) errors.push(problemText(refusal));
  }

  // informs：每条是 { text, items? }；为兼容旧写法，一句纯文字也认，当作没有 items。
  let informs: Inform[] = [];
  if (!("informs" in params)) {
    errors.push(problem(refusalText("reply.informs_missing")));
  } else if (!Array.isArray(params.informs)) {
    errors.push(problem(refusalText("reply.informs_not_list")));
  } else {
    informs = params.informs.map((one, index) => checkInform(one, index, facts, errors));
  }

  // text
  if (!("text" in params) || isBlank(params.text)) {
    errors.push(problem(refusalText("reply.text_missing")));
  }

  // act
  let act: ReplyAct | null = null;
  if (!("act" in params)) {
    errors.push(problem(refusalText("reply.act_missing")));
  } else if (params.act !== null) {
    act = checkAct(params.act, facts, errors);
  }
  if (act && errors.length === 0 && echoedAct(act.text, informs)) errors.push(problem(refusalText("reply.act_echoes_inform")));

  if (errors.length > 0) {
    // 原因有的带两层（事实与指引，与保存修订同一套写法）：给模型的正文里指引另起一行写「怎么办：」。每条原因带着拒绝语的键，原因码按先后记下。
    const layers = errors.map(splitGuide);
    const numbered = layers.map((one, i) => `${i + 1}. ${one.fact}。${one.guidance ? `\n   ${GUIDANCE_PREFIX}${one.guidance}。` : ""}`).join("\n");
    const guides = layers.flatMap((one, i) => (one.guidance ? [`${i + 1}. ${one.guidance}。`] : []));
    throw new ToolRejection(
      `${fillText("part.reply_head")}\n${numbered}`,
      `${fillText("part.reply_fact_head")}\n${layers.map((one, i) => `${i + 1}. ${one.fact}。`).join("\n")}`,
      [fillText("part.reply_guide_head"), ...guides].join("\n"),
      layers.filter((one) => one.key).map((one) => codeOf(one.key)),
    );
  }
  return { informs, act, text: params.text as string, ...(done === true ? { activity_done: true as const } : {}) };
}

function checkInform(one: unknown, index: number, facts: ReplyFacts, errors: string[]): Inform {
  const where = fillText("part.inform_where", { no: index + 1 });
  if (typeof one === "string") {
    if (isBlank(one)) errors.push(problem(refusalText("reply.inform_empty", { where })));
    return { text: one };
  }
  if (!isObject(one)) {
    errors.push(problem(refusalText("reply.inform_not_object", { where })));
    return { text: "" };
  }
  for (const key of Object.keys(one)) {
    if (key !== "text" && key !== "items") errors.push(problem(refusalText("reply.inform_extra_key", { where, key, hint: brokenKeyHint(key) })));
  }
  if (isBlank(one.text)) errors.push(problem(refusalText("reply.inform_text_empty", { where })));
  const inform: Inform = { text: typeof one.text === "string" ? one.text : "" };
  if ("items" in one) {
    checkItemList(one.items, `${where}的 items`, true, facts, errors);
    if (Array.isArray(one.items)) inform.items = one.items as ItemRef[];
  }
  return inform;
}

/** 提问写成了是非题或征求同意的话时「怎么办」那一句（模板 reply.ask_closed_question.guide）。 */
export const CLOSED_QUESTION_GUIDANCE = fillText("reply.ask_closed_question.guide");

/** 是非题或征求同意的话里常见的词：句子里任何位置出现都算。 */
const CLOSED_WORDS = ["是否", "能不能", "要不要", "可不可以", "对不对", "行不行"];

/**
 * 一句话是不是是非题或者征求同意的话。只看字面：句子里任何位置出现「是否」「能不能」「要不要」「可不可以」「对不对」「行不行」，
 * 或者去掉首尾空白与结尾的标点（问号、句号、叹号、右引号、右括号）之后以「吗」收尾。
 * 字面规则有误伤：「能不能说说借书的流程」「罚款的上限是多少，你那边有规定吗」问的是要用户说出内容的事，也会被认成是非题，
 * 这时照拒绝里说的把问句改写成不带这些词的形式（「请说说借书的流程」）就过。也有漏掉的：「A 还是 B」这种选择问句认不出。
 */
export function closedQuestion(text: string): boolean {
  const bare = text.trim().replace(/[？?。.！!」』”"'’）)\s]+$/u, "");
  return bare.endsWith("吗") || CLOSED_WORDS.some((word) => bare.includes(word));
}

/** 分句开头的序号：「1）」「2)」「1.」「2．」这样的写法；前面是开头、空白或标点，「1.5」这样的小数不算。 */
const NUMBERED = /(?:^|[\s\p{P}])\d+[）)．.](?!\d)/gu;

/**
 * 一张提问卡片问了几件事：点名的问题条目有几个（多于一个才算）、正文里有几个序号起头的分句（两个以上才算）、有几个问号（两个以上才算），
 * 取其中最大的；只问了一件事时是 1。
 */
export function askedCount(text: string, items: readonly unknown[], problemItem?: (itemId: string) => boolean): number {
  const problems = problemItem
    ? items.filter((one) => isObject(one) && typeof one.item_id === "string" && problemItem(one.item_id)).length : 0;
  const numbered = [...text.matchAll(NUMBERED)].length;
  const marks = [...text.matchAll(/[？?]/g)].length;
  return Math.max(1, problems > 1 ? problems : 0, numbered >= 2 ? numbered : 0, marks >= 2 ? marks : 0);
}

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
    errors.push(problem(refusalText("reply.act_not_object")));
    return null;
  }
  // 写坏的键名先单独报出来：kind 的键名写坏时，下面会因为「没有 kind」提前返回，不先报就看不到真正的原因。
  const broken = Object.keys(raw).filter((key) => brokenKeyHint(key) !== "");
  for (const key of broken) {
    errors.push(problem(refusalText("reply.act_broken_key", { key, hint: brokenKeyHint(key) })));
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !(ACT_KINDS as readonly string[]).includes(kind)) {
    errors.push(problem(refusalText("reply.act_kind_invalid", { given: String(JSON.stringify(kind)), kinds: ACT_KINDS.join("、") })));
    return null;
  }
  const k = kind as ActKind;
  const name = KIND_NAME[k];
  const allowed = new Set(["kind", "text", "items", ...ALLOWED_EXTRA[k]]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key) && !broken.includes(key)) {
      const owner = (Object.keys(ALLOWED_EXTRA) as ActKind[]).filter((x) => ALLOWED_EXTRA[x].includes(key));
      errors.push(owner.length > 0
        ? problem(refusalText("reply.act_key_not_for_kind", { name, key, owners: owner.map((x) => KIND_NAME[x]).join("、") }))
        : problem(refusalText("reply.act_extra_key", { key })));
    }
  }
  if (isBlank(raw.text)) errors.push(problem(refusalText("reply.act_text_empty", { name })));
  // 提问只给开放问题：写成了是非题或者征求同意的话就拒绝（字面规则，见 closedQuestion）。
  if (k === "ask" && typeof raw.text === "string" && closedQuestion(raw.text)) {
    const said = raw.text.trim();
    errors.push(problem(refusalText("reply.ask_closed_question", { said: [...said].length > 40 ? `${[...said].slice(0, 40).join("")}…` : said })));
  }
  // 提问一次只问一件事：点名了几个问题条目、正文里列了几问，都算问了几件（见 askedCount）。
  const asked = k === "ask" && typeof raw.text === "string" ? askedCount(raw.text, Array.isArray(raw.items) ? raw.items : [], facts.problemItem) : 1;
  if (asked > 1) errors.push(problem(refusalText("reply.ask_many_questions", { count: asked })));

  // 重发：写了 resends 就要指向一张还开着的、同一种的卡片。
  if ((k === "ask" || k === "choose") && "resends" in raw) {
    if (isBlank(raw.resends)) {
      errors.push(problem(refusalText("reply.resends_blank")));
    } else if (facts.resendFact) {
      const fact = facts.resendFact(raw.resends as string);
      if (!fact.open) errors.push(problem(refusalText("reply.resends_not_open", { given: String(raw.resends), why: fact.why })));
      else if (fact.kind !== k) {
        errors.push(problem(refusalText("reply.resends_kind_mismatch", { given: String(raw.resends), was: KIND_NAME[fact.kind as ActKind] ?? fact.kind, name })));
      }
    }
  }

  // scope 只有一个取值；写了 general 就表示与条目无关，不要再点名条目。
  const general = raw.scope === SCOPE_GENERAL;
  if ("scope" in raw && !general) {
    errors.push(problem(refusalText("reply.scope_invalid", { given: String(JSON.stringify(raw.scope)) })));
  }
  if (general && Array.isArray(raw.items) && raw.items.length > 0) {
    errors.push(problem(refusalText("reply.scope_general_with_items")));
  }
  // items：五种都可以写；提问、请确认、给建议值、提议必填（前三种写了 scope: "general" 时除外）
  const required = ITEMS_REQUIRED.includes(k) && !(general && k !== "confirm");
  if (!general && ("items" in raw || required)) {
    if (required && (!Array.isArray(raw.items) || raw.items.length === 0)) errors.push(missingItemsText(k));
    else checkItemList(raw.items, "act.items", required, facts, errors);
  }

  if (k === "choose") {
    const options = raw.options;
    // 写了 topic 的请选择是一个问题加候选答案：候选可以一个也不给（开放问，只留自由回答），给了就至少两个。
    const open = typeof raw.topic === "string" && !isBlank(raw.topic) && (options === undefined || (Array.isArray(options) && options.length === 0));
    if (open) {
      // 不给候选：卡片上只有自由回答与「先跳过」。
    } else if (!Array.isArray(options) || options.length < 2) {
      errors.push(problem(refusalText("reply.options_too_few")));
    } else {
      const seen = new Set<string>();
      options.forEach((one, index) => {
        if (!isObject(one) || isBlank(one.key) || isBlank(one.text)) {
          errors.push(problem(refusalText("reply.option_incomplete", { no: index + 1 })));
          return;
        }
        if (seen.has(one.key as string)) errors.push(problem(refusalText("reply.option_key_duplicate", { key: String(one.key) })));
        seen.add(one.key as string);
        if ("reason" in one && (typeof one.reason !== "string" || isBlank(one.reason))) {
          errors.push(problem(refusalText("reply.option_reason_invalid", { no: index + 1 })));
        }
      });
    }
    if ("multiple" in raw && typeof raw.multiple !== "boolean") errors.push(problem(refusalText("reply.multiple_invalid")));
    if ("topic" in raw && (typeof raw.topic !== "string" || isBlank(raw.topic))) errors.push(problem(refusalText("reply.topic_invalid")));
  }

  // 给建议值的依据：交给 checkBasis 按保存修订的来源同一套规则逐字核对（文档原文、用户的话、条目等），核对后的依据替换模型写的
  // （用户的话的出处由工具代填；一条依据的摘录是材料里连续的一段，引几处就写几条）。
  let checkedBasis: ReplyAct["basis"] | null = null;
  if (k === "suggest") {
    if (isBlank(raw.value)) errors.push(problem(refusalText("reply.suggest_value_missing")));
    const basis = raw.basis;
    if (!Array.isArray(basis) || basis.length === 0) {
      errors.push(problem(refusalText("reply.suggest_basis_missing")));
    } else {
      const whereOf = (index: number) => fillText("part.basis_where", { no: index + 1 });
      checkedBasis = facts.checkBasis ? facts.checkBasis(basis, errors, whereOf) : basisShape(basis, errors, whereOf);
    }
  }

  if (k === "propose" && "preview" in raw) {
    const preview = raw.preview;
    if (!Array.isArray(preview) || preview.length === 0) {
      errors.push(problem(refusalText("reply.preview_not_list")));
    } else {
      preview.forEach((one, index) => {
        const where = fillText("part.preview_where", { no: index + 1 });
        if (!isObject(one)) {
          errors.push(problem(refusalText("reply.preview_item_not_object", { where })));
          return;
        }
        if (typeof one.effect !== "string" || !(PREVIEW_EFFECTS as readonly string[]).includes(one.effect)) {
          errors.push(problem(refusalText("reply.preview_effect_invalid", { where, given: String(JSON.stringify(one.effect)), effects: PREVIEW_EFFECTS.join("、") })));
        }
        if (isBlank(one.text)) errors.push(problem(refusalText("reply.preview_text_empty", { where })));
      });
    }
  }

  const act: ReplyAct = { kind: k, text: raw.text as string };
  for (const key of ["items", ...ALLOWED_EXTRA[k]] as const) {
    if (key in raw) (act as unknown as Record<string, unknown>)[key] = raw[key];
  }
  if (checkedBasis) act.basis = checkedBasis;
  return act;
}

/** 没有接任务目录时（单元测试直接调用 checkReply）只核对依据的形状：种类是执行者能填的来源种类之一、出处与摘录齐全。 */
function basisShape(basis: unknown[], errors: string[], whereOf: (index: number) => string): null {
  basis.forEach((one, index) => {
    const where = whereOf(index);
    if (!isObject(one)) {
      errors.push(problem(refusalText("source.item_not_object", { where })));
      return;
    }
    const kind = one.kind;
    if (typeof kind !== "string" || !(BASIS_KINDS as readonly string[]).includes(kind)) {
      errors.push(problem(refusalText("source.kind_invalid", { where, given: String(JSON.stringify(one.kind)), kinds: BASIS_KINDS.map((x) => `「${x}」`).join("、") })));
    }
    if (kind === SOURCE_SUPPLEMENT) {
      // 助手补充的出处不用写；摘录是理由。
      if (isBlank(one.excerpt)) errors.push(problem(refusalText("reply.basis_supplement_no_reason", { where, kind: SOURCE_SUPPLEMENT })));
      return;
    }
    if (kind !== "用户的话" && isBlank(one.locator)) errors.push(problem(refusalText("source.locator_or_excerpt_missing", { where, missing: fillText("part.missing_locator") })));
    if (isBlank(one.excerpt)) errors.push(problem(refusalText("source.locator_or_excerpt_missing", { where, missing: fillText("part.missing_excerpt") })));
  });
  return null;
}

/** 必须点名条目却没有点名时的拒绝理由。 */
function missingItemsText(kind: ActKind): string {
  if (kind === "confirm") return problem(refusalText("reply.items_missing.confirm"));
  const what = kind === "ask" ? "提问" : kind === "suggest" ? "建议" : "提议";
  return problem(refusalText("reply.items_missing", { what, verb: kind === "ask" ? "问" : "说", unrelated: kind === "ask" ? "问题" : what }));
}

/**
 * 核对一串条目点名（act.items 或某条告知的 items）。check 为真时每项都要有修订号，并读库核对条目存在、
 * 修订号是它当前所在的修订；为假时只核对形状（请选择的 items 可以不写修订号，也不读库）。
 */
function checkItemList(items: unknown, label: string, check: boolean, facts: ReplyFacts, errors: string[]): void {
  if (!Array.isArray(items)) {
    errors.push(problem(refusalText("reply.items_not_list", { label })));
    return;
  }
  const required = check;
  items.forEach((one, index) => {
    const where = fillText("part.list_item_where", { label, no: index + 1 });
    if (!isObject(one) || isBlank(one.item_id)) {
      errors.push(problem(refusalText("reply.item_id_missing", { where })));
      return;
    }
    const item = String(one.item_id);
    const revision = one.revision_no;
    if (revision === undefined || revision === null) {
      if (required) errors.push(problem(refusalText("reply.item_revision_missing", { where, item })));
      return;
    }
    if (!Number.isInteger(revision) || (revision as number) < 1) {
      errors.push(problem(refusalText("reply.item_revision_invalid", { where, item, given: String(JSON.stringify(revision)) })));
      return;
    }
    if (!required) return;
    const fact = facts.revisionFact(one.item_id as string, revision as number);
    if (fact === "还没有库") errors.push(problem(refusalText("reply.no_database")));
    else if (fact === "没有这个条目") errors.push(problem(refusalText("reply.item_not_found", { where, item })));
    else if (fact === "条目已删除") errors.push(problem(refusalText("reply.item_deleted", { where, item })));
    else if (fact === "这次修订没有改动它" || fact === "不是当前所在的修订") {
      const current = facts.currentRevisionOf?.(one.item_id as string);
      errors.push(problem(refusalText("reply.item_revision_not_current", {
        where, item, revision: revision as number, now: current ? fillText("part.now_at", { revision: current }) : "",
      })));
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
    const codes = codesOf(error);
    const alone = codes.includes("reply.not_alone");
    if (attempt >= DEGRADE_AT && !alone) {
      const text = plainTextOf(params);
      if (text) return { reply: { informs: [], act: null, text }, degraded: true };
    }
    if (attempt >= PLAIN_TEXT_FROM) {
      // 原因码：先记「只要成文正文」这一条，后面接上一次拒绝自己的原因码。
      throw new ToolRejection(
        fillText("reply.plain_text_only", { attempt, previous: message }),
        fillText("part.plain_text_only_fact", { attempt, previous: error instanceof ToolRejection ? error.fact : message }),
        fillText("part.plain_text_only_guide"),
        ["reply.plain_text_only", ...codes],
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
      if (understandingGateOf(textOfContent(entry.message.content)) !== null) continue;
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
  problemItem: (itemId: string) => boolean;
  close: () => void;
} {
  const path = databasePath(workspaceDir);
  if (!existsSync(path)) return { revisionFact: () => "还没有库", currentRevisionOf: () => null, problemItem: () => false, close: () => {} };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  const itemRow = db.prepare("SELECT deleted_in_revision FROM item WHERE item_id = ?");
  const revisionRow = db.prepare("SELECT 1 FROM item_version WHERE item_id = ? AND revision_no = ?");
  const latestRow = db.prepare("SELECT MAX(revision_no) AS v FROM item_version WHERE item_id = ?");
  const currentRevisionOf = (itemId: string) => ((latestRow.get(itemId) as { v: number | null } | undefined)?.v ?? null);
  // 问题条目所在的集合：照任务定义，keepPendingField 认得的那些。用到时读一次定义。
  let problemSets: Set<string> | null = null;
  const collectionRow = db.prepare("SELECT collection FROM item WHERE item_id = ?");
  const problemItem = (itemId: string) => {
    if (problemSets === null) {
      const task = db.prepare("SELECT definition_text FROM task LIMIT 1").get() as { definition_text: string } | undefined;
      problemSets = new Set(task ? validateDefinition(JSON.parse(task.definition_text)).collections.filter((one) => keepPendingField(one)).map((one) => one.name) : []);
    }
    const row = collectionRow.get(itemId) as { collection: string } | undefined;
    return row !== undefined && problemSets.has(row.collection);
  };
  return {
    revisionFact(itemId, revisionNo) {
      const item = itemRow.get(itemId) as { deleted_in_revision: number | null } | undefined;
      if (!item) return "没有这个条目";
      if (item.deleted_in_revision !== null) return "条目已删除";
      if (!revisionRow.get(itemId, revisionNo)) return "这次修订没有改动它";
      return currentRevisionOf(itemId) === revisionNo ? "是当前所在的修订" : "不是当前所在的修订";
    },
    currentRevisionOf,
    problemItem,
    close: () => db.close(),
  };
}
