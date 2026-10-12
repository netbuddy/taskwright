/**
 * 工作的阶段：任务定义里有「总体分析」集合的任务，工作分五个阶段——核读材料、澄清、整理建模、写条目、评审确认。
 * 阶段由用户或助手的动作移动，每次移动留一条记录；助手每次调用写入工具时能写什么，由最近一条记录决定。
 *
 * 本文件只放不读库的东西：五个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话、
 * 提议进入写条目的那张卡片的两个选项，以及每个阶段「这一段还差什么」的几盏灯（一共十六盏）怎样算。读写库的在 lib/stage_read.ts。
 *
 * 早先建的任务（任务定义里没有「总体分析」集合）没有阶段，这里的一切对它们都不生效；判据是 overall_analysis.ts 的 hasOverall。
 *
 * 本文件除了 overall_analysis.ts 不导入别的模块：助手的工具、后端的快照都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

import { OVERALL_FIELDS, isDeprecated, tagsOf } from "./overall_analysis.ts";

/** 五个阶段在库里与接口里的写法，按先后排。 */
export const STAGES = ["reading", "clarifying", "modeling", "writing", "reviewing"] as const;
export type Stage = (typeof STAGES)[number];

/** 五个阶段给人看的名字。助手在回复里写的、拒绝原话里说的都是这几个名字。 */
export const STAGE_NAMES: Record<Stage, string> = {
  reading: "核读材料",
  clarifying: "澄清",
  modeling: "整理建模",
  writing: "写条目",
  reviewing: "评审确认",
};

/** 谁移动的：助手或用户。取值与库事件的发起方一致。 */
export type StageActor = "executor" | "user";

/** 一个值是不是阶段的写法。 */
export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

/** 由给人看的名字（或库里的写法）得到阶段；认不出时是 null。 */
export function stageByName(name: unknown): Stage | null {
  if (typeof name !== "string") return null;
  const text = name.trim();
  if (isStage(text)) return text;
  return STAGES.find((one) => STAGE_NAMES[one] === text) ?? null;
}

/** 任务还没有任何阶段记录时在哪个阶段：有材料就先核读材料，没有材料就从澄清开始。 */
export function defaultStage(hasMaterials: boolean): Stage {
  return hasMaterials ? "reading" : "clarifying";
}

// ───────────── 移动 ─────────────

/**
 * 往前进入下一个阶段要由用户在卡片上点：助手做完这一段，发一张请选择卡片说清下一段要做什么，卡片上固定两个选项，
 * 「进入下一段」与「留在这一段」，键与文字都是固定的。用户点了「进入」，系统替用户记一次移动。
 * 进入写条目的那个键沿用早先的名字 start_items。
 */
export const START_ITEMS_KEY = "start_items";
export const START_ITEMS_TEXT = "开始写条目";
export const CONTINUE_CLARIFY_KEY = "continue_clarify";
export const CONTINUE_CLARIFY_TEXT = "继续澄清";

export interface CardOption {
  key: string;
  text: string;
}

/** 进入某个阶段的那个选项（核读材料是第一段，没有「进入」它的卡片）。 */
export const ENTER_OPTIONS: Record<Exclude<Stage, "reading">, CardOption> = {
  clarifying: { key: "enter_clarify", text: "进入澄清" },
  modeling: { key: "enter_consolidate", text: "进入整理建模" },
  writing: { key: START_ITEMS_KEY, text: START_ITEMS_TEXT },
  reviewing: { key: "enter_review", text: "进入评审确认" },
};

/** 留在这一段的那个选项在页面上的写法：四张卡片上都是这一句，不管助手在卡片里把它写成什么。 */
export const STAY_TEXT = "继续本阶段";

/** 留在某个阶段的那个选项（评审确认是最后一段，没有往前的卡片）。 */
export const STAY_OPTIONS: Record<Exclude<Stage, "reviewing">, CardOption> = {
  reading: { key: "continue_reading", text: "再核读一遍" },
  clarifying: { key: CONTINUE_CLARIFY_KEY, text: CONTINUE_CLARIFY_TEXT },
  modeling: { key: "continue_consolidate", text: "再整理一遍" },
  writing: { key: "continue_writing", text: "继续写条目" },
};

/**
 * 总体分析还没有一页主题时页面上的两个开头（「通读材料起草」「逐项澄清」）替用户发给助手的两句固定的话。
 * 页面点了按钮先把任务移到那个阶段、再发这一句；它们不是用户自己打的字，整理用户说过的话时要认出来。
 */
export const STAGE_START_TEXTS = {
  reading: "请通读材料，把材料里已经写明的概念、角色、流程与目标各立一页主题。",
  clarifying: "请逐项澄清：一次只问一件事，先给出候选再问。",
} as const;

/** 某个阶段的下一段；评审确认之后没有。 */
export function nextStage(stage: Stage): Stage | null {
  return STAGES[STAGES.indexOf(stage) + 1] ?? null;
}

/** 卡片上的一个选项键是「进入」哪个阶段的；不是这样的键时返回 null。 */
export function stageEnteredBy(key: unknown): Exclude<Stage, "reading"> | null {
  const found = (Object.keys(ENTER_OPTIONS) as Exclude<Stage, "reading">[]).find((stage) => ENTER_OPTIONS[stage].key === key);
  return found ?? null;
}

/**
 * 在某个阶段怎样提议进入下一段：告诉助手用哪张卡片、两个选项怎样写。评审确认是最后一段，没有下一段，返回空串。
 */
export function forwardCardGuidance(from: Stage): string {
  const next = nextStage(from);
  if (next === null || from === "reviewing" || next === "reading") return "";
  const enter = ENTER_OPTIONS[next], stay = STAY_OPTIONS[from];
  return `请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 ${enter.key}「${enter.text}」、${stay.key}「${stay.text}」`;
}

/**
 * 一次移动行不行。
 * - same：目标就是现在所在的阶段，原地不动不算移动，不记。
 * - user_only：往前移动（目标在现在这个阶段之后）要由用户在卡片上点，助手只能提议。
 * 用户的移动不设限；助手可以从任何阶段退回它前面的任何阶段。
 */
export type MoveVerdict = { ok: true } | { ok: false; why: "same" | "user_only" };

export function judgeMove(from: Stage, to: Stage, actor: StageActor): MoveVerdict {
  if (from === to) return { ok: false, why: "same" };
  if (actor === "user") return { ok: true };
  if (STAGES.indexOf(to) < STAGES.indexOf(from)) return { ok: true };
  return { ok: false, why: "user_only" };
}

/** 助手在回复里写了 stage 之后，工具返回里说明结果的那一句（接在「回复已送达。」后面）。 */
export function moveText(from: Stage, to: Stage, verdict: MoveVerdict): string {
  if (verdict.ok) return `任务已从${STAGE_NAMES[from]}移到${STAGE_NAMES[to]}。`;
  if (verdict.why === "same") return `任务本来就在${STAGE_NAMES[from]}阶段，没有记移动。`;
  const next = nextStage(from);
  const oneStep = next !== null && to !== next ? `一次只进入下一段，${STAGE_NAMES[from]}的下一段是${STAGE_NAMES[next]}。` : "";
  return `阶段没有移动：往前移动要由用户在卡片上点。${oneStep}${forwardCardGuidance(from)}。`;
}

/** 早先建的任务没有阶段，助手在回复里写了 stage 时的那一句。 */
export const NO_STAGES_TEXT = "阶段没有移动：这个任务没有阶段，不要写 stage。";

// ───────────── 每个阶段助手能写什么 ─────────────

/**
 * 助手的一次写入属于哪一类：
 * page 总体分析的页；problem 问题条目；diagram 图；item 别的集合的条目（用例、非功能需求、约束这一类）；
 * review 请求评审；complete 完成任务。
 */
export type WriteKind = "page" | "problem" | "diagram" | "item" | "review" | "complete";

/** 每一类写入从哪个阶段起可以做。页与问题任何阶段都可以写（评审确认阶段对页另有限制，见 pageRefusal）。 */
const ALLOWED_FROM: Record<WriteKind, Stage> = {
  page: "reading",
  problem: "reading",
  diagram: "modeling",
  item: "writing",
  review: "writing",
  complete: "reviewing",
};

/** 这个阶段助手能不能做这一类写入。 */
export function canWrite(stage: Stage, kind: WriteKind): boolean {
  return STAGES.indexOf(stage) >= STAGES.indexOf(ALLOWED_FROM[kind]);
}

/** 拒绝的两层文字：事实（现在在哪个阶段、拦下的是什么）与怎么办（这一步要先做什么、谁能移动）。 */
export type Refusal = [fact: string, guidance: string];

const OP_WORDS: Record<string, string> = { add: "新增", update: "修改", delete: "删除" };

/** 还没到写条目时，怎样才能到：这一句写在几种拒绝的「怎么办」里。 */
function howToReachWriting(): string {
  return `进入写条目要由用户在卡片上选「${START_ITEMS_TEXT}」：你可以先立页、请用户看，觉得理解够了就用请选择卡片提议`;
}

/**
 * 助手新增、修改或删除别的集合（不是总体分析、也不是问题）的条目：写条目之前的阶段都拦。
 * 可以写时返回 null。
 */
export function itemRefusal(stage: Stage, op: string, collection: string): Refusal | null {
  if (canWrite(stage, "item")) return null;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能${OP_WORDS[op] ?? "写"}「${collection}」的条目`,
    `「${collection}」的条目要到写条目阶段才能写。${howToReachWriting()}`,
  ];
}

/**
 * 助手新增、修改或删除总体分析的一页：前四个阶段都可以；评审确认阶段只能改「状态」与「改看」两个字段，
 * 不能新立页、不能删页。changed 是修改时这次改动了的字段名。可以写时返回 null。
 */
export function pageRefusal(stage: Stage, op: string, changed: readonly string[] = []): Refusal | null {
  if (stage !== "reviewing") return null;
  const guidance = "要动主题页的内容，先在回复里把任务移回澄清或整理建模";
  const head = `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段`;
  if (op === "add") return [`${head}不能新立主题页`, guidance];
  if (op === "delete") return [`${head}不能删除主题页`, guidance];
  const allowed: string[] = [OVERALL_FIELDS.status, OVERALL_FIELDS.seeAlso];
  const others = changed.filter((name) => !allowed.includes(name));
  if (others.length === 0) return null;
  return [`${head}主题页只能改「${OVERALL_FIELDS.status}」与「${OVERALL_FIELDS.seeAlso}」，这次还改了${others.map((name) => `「${name}」`).join("、")}`, guidance];
}

/**
 * 助手新画、修改或删除一张图：整理建模之前的阶段都拦。可以时返回 null。
 * 「怎么办」里说的是怎样走到整理建模：往前进入下一段要由用户在卡片上点，助手只能发卡片提议（forwardCardGuidance）。
 */
export function diagramRefusal(stage: Stage): Refusal | null {
  if (canWrite(stage, "diagram")) return null;
  const enterModeling = ENTER_OPTIONS.modeling.text;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能画图、改图或删图`,
    stage === "reading"
      ? `图要到整理建模阶段才能画。往前进入下一段要由用户在卡片上点，你只能提议：材料读完之后先提议进入澄清，${forwardCardGuidance("reading")}；澄清告一段落之后，再照同样的办法提议「${enterModeling}」`
      : `图要到整理建模阶段才能画。进入整理建模要由用户在卡片上选「${enterModeling}」，你只能提议：澄清告一段落之后，${forwardCardGuidance("clarifying")}`,
  ];
}

/** 助手请求评审：写条目之前的阶段都拦。可以时返回 null。 */
export function reviewRefusal(stage: Stage): Refusal | null {
  if (canWrite(stage, "review")) return null;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，评审要到写条目阶段才能请求`,
    `条目写出来之后再评审。${howToReachWriting()}`,
  ];
}

/** 助手完成任务：只有评审确认阶段可以。可以时返回 null。 */
export function completeRefusal(stage: Stage): Refusal | null {
  if (canWrite(stage, "complete")) return null;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，完成任务要在评审确认阶段`,
    stage === "writing"
      ? `条目写完之后，要由用户在卡片上选「${ENTER_OPTIONS.reviewing.text}」进入评审确认，再完成任务。${forwardCardGuidance("writing")}`
      : `要先写条目、再由用户进入评审确认，才能完成任务。${howToReachWriting()}`,
  ];
}

// ───────────── 每个阶段还差什么：灯 ─────────────

/**
 * 灯：每个阶段「做到什么算够」的判据，程序从任务现有的内容算出来，给用户与助手看这一段还差什么。灯不拦任何操作。
 * 下面几个名字出自需求规格这一类任务的定义（标签的取值、集合名、问题条目的字段），灯按它们认；别的任务类型里没有时，
 * 相应的灯是「不适用」。
 */
export const TAG_FLOW = "流程";
export const TAG_SCENE = "场景";
export const TAG_ROLE = "角色";
export const TAG_CONCEPT = "概念";
export const TAG_DECISION = "决定";
export const TAG_GOAL = "目标";
/** 功能用例所在的集合。 */
export const USE_CASE_COLLECTION = "功能用例";
/** 问题条目里说明它是哪一种的字段与「待澄清」这个取值；状态字段里表示还没解决的取值；指到相关条目的字段。 */
export const QUESTION_KIND_FIELD = "种类";
export const QUESTION_KIND_CLARIFY = "待澄清";
export const QUESTION_OPEN_STATUS = "未解决";
export const QUESTION_RELATED_FIELD = "关联条目";
/** 问题条目里写打算怎样处理的字段。 */
export const QUESTION_SUGGESTION_FIELD = "建议的处理";
/** 问题集合的状态字段里表示「用户决定先放着」的取值：有一个枚举字段的取值里含它的集合就是问题集合（与 lib/definition.ts 的 keepPendingField 同一个判据）。 */
export const QUESTION_KEEP_STATUS = "用户决定保留";

/**
 * 图的种类里灯要认的五种的写法（与 lib/diagram.ts 的 DIAGRAM_KINDS 一致；那个文件读库，本文件不导入它）：
 * 系统边界图、用例图、对象关系图、流程图、状态图。
 */
export const KIND_CONTEXT = "context";
export const KIND_USE_CASE = "use_case";
export const KIND_CLASS = "class";
export const KIND_FLOWCHART = "flowchart";
export const KIND_STATE = "state";

/** 一盏灯。ok 为真是通过，为假是不通过，为 null 是不适用（例如「每个流程页都……」而一页流程页都没有）。items 是差的页、条目或材料。 */
export interface Lamp {
  key: string;
  summary: string;
  ok: boolean | null;
  items: string[];
}

/** 算灯要的一页主题。 */
export interface LampPage {
  item_id: string;
  title: string;
  aliases: string[];
  tags: string[];
  deprecated: boolean;
  /** 上级主题的编号；没有写是 null。 */
  parent: string | null;
  examples: string[];
  /** 用户看没看过它现在的内容。 */
  viewed: boolean;
  /** 「已经定下的」有几条。 */
  settled: number;
  /** 这一页说没说到状态：「它是什么」或「已经定下的」里有「状态」二字、有「变成」，或者有「从……变为……」。按字面认，会漏也会多。 */
  stateful: boolean;
}

/** 算灯要的一张图（还在的图，取它现在的内容）。扫 Mermaid 文本在读库的一侧做（lib/diagram_scan.ts），这里拿到的是扫好的结果。 */
export interface LampDiagram {
  diagram_id: string;
  /** 图的种类的写法。 */
  kind: string;
  /** 它当前修订上种类为「条目」的来源指到的条目编号。 */
  sources: string[];
  /** 它的 Mermaid 文本里写到的条目编号。 */
  drawn: string[];
  /** 有连线连着的条目编号。只对对象关系图算，别的种类是空列表。 */
  linked: string[];
  /** 有没有判断节点。只对流程图算，别的种类是假。 */
  branches: boolean;
  /** 用户看没看过它现在的内容。 */
  viewed: boolean;
}

/** 算灯要的一个条目（总体分析以外的集合里的，含问题条目）。 */
export interface LampItem {
  item_id: string;
  collection: string;
  /** 它当前修订上种类为「条目」的来源指到的条目编号。 */
  cites: string[];
  /** 它当前修订上种类为「图」的来源指到的图的编号。 */
  citesDiagrams: string[];
  /** 待核实：自己有助手补充而用户没有确认的内容，或者因依据的那一页而待核实。 */
  pending: boolean;
}

/** 算灯要的一条问题条目。 */
export interface LampQuestion {
  item_id: string;
  /** 是不是还没解决的待澄清问题。 */
  open: boolean;
  /** 它关联的条目的编号。 */
  related: string[];
}

/** 算灯要的全部事实。助手一侧与后端各自从任务库里读出来填，算法只在这里。 */
export interface LampInput {
  /** 总体分析的全部页，含已废弃的。 */
  pages: LampPage[];
  /** 总体分析以外各集合的条目，含问题条目。 */
  items: LampItem[];
  questions: LampQuestion[];
  /** 任务定义里的集合名。 */
  collections: string[];
  /** 材料清单里不是由别的文件生成的文件，写它在任务目录里的路径（例如 inputs/需求.md）。 */
  materials: string[];
  /** 总体分析的页与问题条目当前修订上「文档原文」来源的出处，原样（可以带 # 后面的位置）。 */
  citedDocuments: string[];
  /** 任务里还在的图。 */
  diagrams: LampDiagram[];
  /** 还没有了结的规则冲突：规则表（lib/overall_views.ts 的 rulesTable）里标出的那几条问题条目的编号。 */
  ruleConflicts: string[];
  /** 评审：当前修订在当前规则下评审不合规、又没有保留写法的条目；任务里有没有过评审记录。 */
  review: { failing: string[]; any: boolean };
  /** 完成条件：是不是全部满足；没满足的各条的说明。 */
  completion: { satisfied: boolean; unmet: string[] };
}

const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && one.trim() !== "") : []);

/** 一段文字说没说到状态：有「状态」二字、有「变成」，或者有「从……变为……」（中间不跨句）。 */
const STATE_WORDS = /状态|变成|从[^。；;！？\n]{0,40}变为/;

/** 从一页的字段内容与用户看没看过，取出算灯要的几样。 */
export function lampPage(itemId: string, fields: Record<string, unknown>, viewed: boolean): LampPage {
  const title = fields[OVERALL_FIELDS.title];
  const what = fields[OVERALL_FIELDS.what];
  const settled = texts(fields[OVERALL_FIELDS.settled]);
  return {
    item_id: itemId, title: typeof title === "string" ? title.trim() : "", aliases: texts(fields[OVERALL_FIELDS.aliases]).map((one) => one.trim()),
    tags: tagsOf(fields), deprecated: isDeprecated(fields), parent: texts(fields[OVERALL_FIELDS.parent])[0] ?? null,
    examples: texts(fields[OVERALL_FIELDS.examples]), viewed, settled: settled.length,
    stateful: [typeof what === "string" ? what : "", ...settled].some((one) => STATE_WORDS.test(one)),
  };
}

/**
 * 从一条问题条目的字段内容取出算灯要的几样。statusField 是它的状态字段名（问题集合里取值含「用户决定保留」的那个字段）。
 * 还没解决的待澄清问题：状态是未解决，种类是待澄清；集合没有「种类」这个字段时只看状态。
 */
export function lampQuestion(itemId: string, fields: Record<string, unknown>, statusField: string): LampQuestion {
  const kind = fields[QUESTION_KIND_FIELD];
  return {
    item_id: itemId,
    open: fields[statusField] === QUESTION_OPEN_STATUS && (kind === undefined || kind === QUESTION_KIND_CLARIFY),
    related: texts(fields[QUESTION_RELATED_FIELD]),
  };
}

const list = (ids: readonly string[]) => ids.join("、");
const lamp = (key: string, ok: boolean | null, summary: string, items: string[] = []): Lamp => ({ key, summary, ok, items });

/** 每个阶段的几盏灯，五个阶段都算。 */
export function stageLamps(input: LampInput): Record<Stage, Lamp[]> {
  const live = input.pages.filter((one) => !one.deprecated);
  const byId = new Map(input.pages.map((one) => [one.item_id, one]));
  const tagged = (tag: string) => live.filter((one) => one.tags.includes(tag));
  const others = input.items;

  // 核读材料：每份材料都被至少一页主题或一条问题引用。
  const cited = new Set(input.citedDocuments.map((one) => one.split("#")[0]));
  const uncited = input.materials.filter((one) => !cited.has(one));
  const materialsCited = input.materials.length === 0 ? lamp("materials_cited", null, "任务里没有材料。")
    : uncited.length === 0 ? lamp("materials_cited", true, "每份材料都被至少一页主题或一条问题引用了。")
      : lamp("materials_cited", false, `有 ${uncited.length} 份材料还没有被任何一页主题或问题引用：${list(uncited)}。`, uncited);

  // 澄清：贴了标签的页没有挂着未解决的待澄清问题。
  const labelled = live.filter((one) => one.tags.length > 0);
  const open = input.questions.filter((one) => one.open);
  const asked = labelled.filter((page) => open.some((q) => q.related.includes(page.item_id)));
  const noOpenQuestions = labelled.length === 0 ? lamp("tagged_pages_no_open_questions", null, "还没有贴了标签的主题。")
    : asked.length === 0 ? lamp("tagged_pages_no_open_questions", true, "贴了标签的主题上没有挂着未解决的待澄清问题。")
      : lamp("tagged_pages_no_open_questions", false,
        `有 ${asked.length} 页贴了标签的主题还挂着未解决的待澄清问题：${asked.map((page) => `${page.item_id}（${list(open.filter((q) => q.related.includes(page.item_id)).map((q) => q.item_id))}）`).join("、")}。`,
        asked.map((one) => one.item_id));

  // 澄清：每个「决定」页有上级「目标」页。「它是什么」里写没写为什么，程序认不出，只看上级主题。
  const decisions = tagged(TAG_DECISION);
  const aimless = decisions.filter((one) => !(one.parent !== null && byId.get(one.parent)?.tags.includes(TAG_GOAL)));
  const decisionsHaveGoal = decisions.length === 0 ? lamp("decisions_have_goal", null, `还没有标签为「${TAG_DECISION}」的主题。`)
    : aimless.length === 0 ? lamp("decisions_have_goal", true, `每个标签为「${TAG_DECISION}」的主题都有一页标签为「${TAG_GOAL}」的上级主题。`)
      : lamp("decisions_have_goal", false,
        `有 ${aimless.length} 页标签为「${TAG_DECISION}」的主题没有标签为「${TAG_GOAL}」的上级主题：${list(aimless.map((one) => one.item_id))}。在「它是什么」里写了为什么的也算说清了，这一点程序认不出，要自己看。`,
        aimless.map((one) => one.item_id));

  // 整理建模：每个「角色」页都画进了系统边界图与用例图（图的 Mermaid 文本里写着它的编号）。
  const roles = tagged(TAG_ROLE);
  const drawnIn = (kind: string) => new Set(input.diagrams.filter((one) => one.kind === kind).flatMap((one) => one.drawn));
  const inContext = drawnIn(KIND_CONTEXT), inUseCase = drawnIn(KIND_USE_CASE);
  const undrawn = roles.filter((one) => !(inContext.has(one.item_id) && inUseCase.has(one.item_id)));
  const lacking = (id: string) => (!inContext.has(id) && !inUseCase.has(id) ? "两种图里都没有" : !inContext.has(id) ? "系统边界图里没有" : "用例图里没有");
  const rolesDrawn = roles.length === 0 ? lamp("roles_in_context_and_use_cases", null, `还没有标签为「${TAG_ROLE}」的主题。`)
    : undrawn.length === 0 ? lamp("roles_in_context_and_use_cases", true, `每个标签为「${TAG_ROLE}」的主题都画进了系统边界图与用例图。`)
      : lamp("roles_in_context_and_use_cases", false,
        `有 ${undrawn.length} 页标签为「${TAG_ROLE}」的主题还没有同时画进系统边界图与用例图：${undrawn.map((one) => `${one.item_id}（${lacking(one.item_id)}）`).join("、")}。`,
        undrawn.map((one) => one.item_id));

  // 整理建模：每个「概念」页在对象关系图里至少有一条连线。
  const concepts = tagged(TAG_CONCEPT);
  const classDiagrams = input.diagrams.filter((one) => one.kind === KIND_CLASS);
  const linked = new Set(classDiagrams.flatMap((one) => one.linked));
  const alone = concepts.filter((one) => !linked.has(one.item_id));
  const conceptsRelated = concepts.length === 0 ? lamp("concepts_related_in_class", null, `还没有标签为「${TAG_CONCEPT}」的主题。`)
    : alone.length === 0 ? lamp("concepts_related_in_class", true, `每个标签为「${TAG_CONCEPT}」的主题在对象关系图里都有连线。`)
      : lamp("concepts_related_in_class", false,
        `${classDiagrams.length === 0 ? "还没有画对象关系图。" : ""}有 ${alone.length} 页标签为「${TAG_CONCEPT}」的主题在对象关系图里还没有连线：${list(alone.map((one) => one.item_id))}。`,
        alone.map((one) => one.item_id));

  // 整理建模：每个「流程」页有一张以它为来源的流程图，而且图里有判断分叉。
  const flows = tagged(TAG_FLOW);
  const chartsOf = (id: string) => input.diagrams.filter((one) => one.kind === KIND_FLOWCHART && one.sources.includes(id));
  const unbranched = flows.filter((one) => !chartsOf(one.item_id).some((chart) => chart.branches));
  const flowsCharted = flows.length === 0 ? lamp("flows_have_flowchart_with_branch", null, `还没有标签为「${TAG_FLOW}」的主题。`)
    : unbranched.length === 0 ? lamp("flows_have_flowchart_with_branch", true, `每个标签为「${TAG_FLOW}」的主题都有一张带判断分叉的流程图。`)
      : lamp("flows_have_flowchart_with_branch", false,
        `有 ${unbranched.length} 页标签为「${TAG_FLOW}」的主题还没有带判断分叉的流程图：${unbranched.map((one) => `${one.item_id}（${chartsOf(one.item_id).length === 0 ? "还没有以它为来源的流程图" : "流程图里没有判断分叉"}）`).join("、")}。`,
        unbranched.map((one) => one.item_id));

  // 整理建模：说到状态的「概念」页有一张以它为来源的状态图。说没说到状态按字面认（lampPage 的 stateful）。
  const stateful = concepts.filter((one) => one.stateful);
  const stateless = stateful.filter((one) => !input.diagrams.some((chart) => chart.kind === KIND_STATE && chart.sources.includes(one.item_id)));
  const statesDrawn = stateful.length === 0 ? lamp("stateful_concepts_have_state", null, `还没有说到状态的「${TAG_CONCEPT}」主题。`)
    : stateless.length === 0 ? lamp("stateful_concepts_have_state", true, `每个说到状态的「${TAG_CONCEPT}」主题都有一张状态图。`)
      : lamp("stateful_concepts_have_state", false,
        `有 ${stateless.length} 页说到状态的「${TAG_CONCEPT}」主题还没有以它为来源的状态图：${list(stateless.map((one) => one.item_id))}。说没说到状态是按字面认的（文字里有「状态」「变成」或者「从……变为……」），认错了的不用画，向用户说明即可。`,
        stateless.map((one) => one.item_id));

  // 整理建模：没有两页标题或别名相同。
  const owners = new Map<string, string[]>();
  for (const page of live) {
    for (const word of new Set([page.title, ...page.aliases].filter(Boolean))) owners.set(word, [...(owners.get(word) ?? []), page.item_id]);
  }
  const clashes = [...owners].filter(([, ids]) => ids.length > 1);
  const clashing = [...new Set(clashes.flatMap(([, ids]) => ids))];
  const noDuplicates = live.length === 0 ? lamp("no_duplicate_titles", null, "总体分析里还没有主题。")
    : clashes.length === 0 ? lamp("no_duplicate_titles", true, "没有两页主题的标题或别名相同。")
      : lamp("no_duplicate_titles", false,
        `有 ${clashes.length} 个标题或别名被两页以上的主题用了：${clashes.map(([word, ids]) => `「${word}」（${list(ids)}）`).join("、")}。`, clashing);

  // 整理建模：没有未归类的页。用户明说先不归类的，程序认不出，只看标签。
  const loose = live.filter((one) => one.tags.length === 0);
  const noUntagged = live.length === 0 ? lamp("no_untagged_pages", null, "总体分析里还没有主题。")
    : loose.length === 0 ? lamp("no_untagged_pages", true, "每页主题都贴了标签。")
      : lamp("no_untagged_pages", false, `有 ${loose.length} 页主题还没有贴标签：${list(loose.map((one) => one.item_id))}。`, loose.map((one) => one.item_id));

  // 整理建模：各页「已经定下的」之间没有还没了结的规则冲突。
  const settledTotal = live.reduce((sum, one) => sum + one.settled, 0);
  const noRuleConflict = settledTotal === 0 ? lamp("rules_no_conflict", null, "各页主题还没有写「已经定下的」。")
    : input.ruleConflicts.length === 0 ? lamp("rules_no_conflict", true, "各页「已经定下的」之间没有还没了结的规则冲突。")
      : lamp("rules_no_conflict", false, `有 ${input.ruleConflicts.length} 处规则冲突还没有了结：${list(input.ruleConflicts)}。`, [...input.ruleConflicts]);

  // 写条目：每个「流程」与「场景」页被至少一条用例依据。用例直接依据那一页，或者依据一张以那一页为来源的图，都算。
  const toBack = live.filter((one) => one.tags.includes(TAG_FLOW) || one.tags.includes(TAG_SCENE));
  const diagramOf = new Map(input.diagrams.map((one) => [one.diagram_id, one]));
  const backedBy = new Set(others.filter((one) => one.collection === USE_CASE_COLLECTION)
    .flatMap((one) => [...one.cites, ...one.citesDiagrams.flatMap((id) => diagramOf.get(id)?.sources ?? [])]));
  const unbacked = toBack.filter((one) => !backedBy.has(one.item_id));
  const flowsBacked = !input.collections.includes(USE_CASE_COLLECTION) ? lamp("flows_backed_by_use_cases", null, `这个任务没有「${USE_CASE_COLLECTION}」这个集合。`)
    : toBack.length === 0 ? lamp("flows_backed_by_use_cases", null, `还没有标签为「${TAG_FLOW}」或「${TAG_SCENE}」的主题。`)
      : unbacked.length === 0 ? lamp("flows_backed_by_use_cases", true, `每个标签为「${TAG_FLOW}」或「${TAG_SCENE}」的主题都有用例依据它。`)
        : lamp("flows_backed_by_use_cases", false,
          `有 ${unbacked.length} 页标签为「${TAG_FLOW}」或「${TAG_SCENE}」的主题还没有用例依据它：${list(unbacked.map((one) => one.item_id))}。`, unbacked.map((one) => one.item_id));

  // 写条目：每条条目依据的页都是用户看过的。
  const basing = others.filter((one) => one.cites.some((id) => byId.has(id)));
  const blind = basing.filter((one) => one.cites.some((id) => byId.has(id) && !byId.get(id)!.viewed));
  const unseen = [...new Set(blind.flatMap((one) => one.cites.filter((id) => byId.has(id) && !byId.get(id)!.viewed)))];
  const basisViewed = basing.length === 0 ? lamp("basis_pages_viewed", null, "还没有依据主题写的条目。")
    : blind.length === 0 ? lamp("basis_pages_viewed", true, "条目依据的主题用户都看过了。")
      : lamp("basis_pages_viewed", false,
        `有 ${blind.length} 个条目依据的主题用户还没有看过：${list(blind.map((one) => one.item_id))}（没看过的主题是 ${list(unseen)}）。`, blind.map((one) => one.item_id));

  // 写条目：每条条目依据的图都是用户看过的。
  const drawing = others.filter((one) => one.citesDiagrams.some((id) => diagramOf.has(id)));
  const unseenOf = (one: LampItem) => one.citesDiagrams.filter((id) => diagramOf.has(id) && !diagramOf.get(id)!.viewed);
  const unlooked = drawing.filter((one) => unseenOf(one).length > 0);
  const basisDiagramsViewed = drawing.length === 0 ? lamp("basis_diagrams_viewed", null, "还没有依据图写的条目。")
    : unlooked.length === 0 ? lamp("basis_diagrams_viewed", true, "条目依据的图用户都看过了。")
      : lamp("basis_diagrams_viewed", false,
        `有 ${unlooked.length} 个条目依据的图用户还没有看过：${list(unlooked.map((one) => one.item_id))}（没看过的图是 ${list([...new Set(unlooked.flatMap(unseenOf))])}）。`,
        unlooked.map((one) => one.item_id));

  // 写条目：没有待核实的条目。
  const pending = others.filter((one) => one.pending);
  const noPending = others.length === 0 ? lamp("no_pending_items", null, "总体分析以外还没有条目。")
    : pending.length === 0 ? lamp("no_pending_items", true, "没有待核实的条目。")
      : lamp("no_pending_items", false, `有 ${pending.length} 个条目待核实：${list(pending.map((one) => one.item_id))}。`, pending.map((one) => one.item_id));

  // 评审确认：评审没有未处理的发现；完成条件全部满足。
  const reviews = !input.review.any ? lamp("reviews_no_open_findings", false, "还没有评审过。")
    : input.review.failing.length === 0 ? lamp("reviews_no_open_findings", true, "评审没有未处理的发现。")
      : lamp("reviews_no_open_findings", false, `有 ${input.review.failing.length} 个条目评审不合规、还没有处理：${list(input.review.failing)}。`, input.review.failing);
  const completion = input.completion.satisfied ? lamp("completion_met", true, "完成条件全部满足了。")
    : lamp("completion_met", false, `还有 ${input.completion.unmet.length} 条完成条件没有满足：${input.completion.unmet.join("；")}`);

  return {
    reading: [materialsCited],
    clarifying: [noOpenQuestions, decisionsHaveGoal],
    modeling: [rolesDrawn, conceptsRelated, flowsCharted, statesDrawn, noDuplicates, noUntagged, noRuleConflict],
    writing: [flowsBacked, basisViewed, basisDiagramsViewed, noPending],
    reviewing: [reviews, completion],
  };
}

/** 全部灯的键，按阶段的先后。 */
export const LAMP_KEYS = [
  "materials_cited", "tagged_pages_no_open_questions", "decisions_have_goal",
  "roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state",
  "no_duplicate_titles", "no_untagged_pages", "rules_no_conflict",
  "flows_backed_by_use_cases", "basis_pages_viewed", "basis_diagrams_viewed", "no_pending_items", "reviews_no_open_findings", "completion_met",
] as const;

/**
 * 「这一段还差什么」写成给助手看的一段话：不通过的灯各一句；都通过（或都不适用）时写一句「这一段的几项都齐了」。
 */
export function lampLines(stage: Stage, lamps: readonly Lamp[]): string[] {
  const missing = lamps.filter((one) => one.ok === false);
  if (missing.length === 0) return [`${STAGE_NAMES[stage]}这一段的几项都齐了。`];
  return [`${STAGE_NAMES[stage]}这一段还差 ${missing.length} 项：`, ...missing.map((one) => `  - ${one.summary}`)];
}
