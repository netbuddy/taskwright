/**
 * 工作的阶段：任务定义里有「总体分析」集合的任务，工作分六个阶段——核读材料、澄清、整理建模、写条目、评审确认、编写文档。
 * 阶段由用户或助手的动作移动，每次移动留一条记录；助手每次调用写入工具时能写什么，由最近一条记录决定。
 *
 * 本文件只放不读库的东西：六个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话、
 * 提议进入写条目的那张卡片的两个选项，以及每个阶段「这一段还差什么」的几盏灯（一共二十一盏）怎样算。读写库的在 lib/stage_read.ts。
 *
 * 早先建的任务（任务定义里没有「总体分析」集合）没有阶段，这里的一切对它们都不生效；判据是 overall_analysis.ts 的 hasOverall。
 *
 * 本文件除了 overall_analysis.ts 与 overall_chapters.ts（它也只导入前者）不导入别的模块：助手的工具、后端的快照都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

import { OVERALL_FIELDS, isDeprecated, tagsOf } from "./overall_analysis.ts";
import { CHAPTERS, CHAPTER_DECISIONS, CHAPTER_RULES, chapterOfLabels } from "./overall_chapters.ts";

/** 六个阶段在库里与接口里的写法，按先后排。 */
export const STAGES = ["reading", "clarifying", "modeling", "writing", "reviewing", "document"] as const;
export type Stage = (typeof STAGES)[number];

/** 六个阶段给人看的名字。助手在回复里写的、拒绝原话里说的都是这几个名字。 */
export const STAGE_NAMES: Record<Stage, string> = {
  reading: "核读材料",
  clarifying: "澄清",
  modeling: "整理建模",
  writing: "写条目",
  reviewing: "评审确认",
  document: "编写文档",
};

/**
 * 所属流程：一次阶段移动是在哪一条流程里发生的。现在只有一条流程（首次分析），值恒定；以后任务里可以单独开展一项活动、
 * 或者在别的流程里开展时，靠它区分。它写在活动记录表的「所属流程」一列与阶段移动那条事件的内容里；早先没有写它的移动，升级时补成首次分析。
 */
export const FLOW_INITIAL = "initial";
export const FLOW_NAMES: Record<string, string> = { [FLOW_INITIAL]: "首次分析" };

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

/**
 * 空闲：任务现在没有在进行的活动——刚建好还没有开展过任何活动，或者开展过的每一项都已经结束。它不是一个阶段，不排在 STAGES 的次序里，
 * 也没有自己的灯；写法 idle 与六个阶段的写法并列，出现在「任务现在在哪里」的那几处。它与 null 不是一回事：
 * null 是早先建的任务（任务定义里没有「总体分析」集合），那种任务没有阶段，什么都不拦；空闲的任务有阶段，照下面的规矩拦。
 * 空闲时助手能写什么与澄清阶段相同（见 ALLOWED）。新建的任务从空闲起：开展哪一项活动由用户在任务状况卡上定。
 */
export const IDLE = "idle";
export const IDLE_NAME = "空闲";

/** 任务现在的位置：六个阶段之一，或者空闲。 */
export type Position = Stage | typeof IDLE;

/** 一个值是不是位置的写法：六个阶段的写法或者空闲。 */
export function isPosition(value: unknown): value is Position {
  return value === IDLE || isStage(value);
}

/** 位置给人看的名字：阶段的名字，或者「空闲」。 */
export function positionName(position: Position): string {
  return position === IDLE ? IDLE_NAME : STAGE_NAMES[position];
}

/** 空闲时按哪个阶段的规矩办：澄清。任务在某个阶段时就是那个阶段。 */
export function gateStage(position: Position): Stage {
  return position === IDLE ? "clarifying" : position;
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
/** 留在这一段的那个选项的文字：五张卡片上都是这一句。 */
export const STAY_TEXT = "继续本阶段";
export const CONTINUE_CLARIFY_TEXT = STAY_TEXT;

export interface CardOption {
  key: string;
  text: string;
}

/**
 * 进入某个阶段的那个选项。核读材料是第一段，在流程里没有「进入」它的卡片；它的这一项只在任务空闲时用：
 * 用户上传了材料，助手用请选择卡片提议开始核读材料，卡片上另一项是「先不开始」（STAY_IDLE_OPTION）。
 */
export const ENTER_OPTIONS: Record<Stage, CardOption> = {
  reading: { key: "enter_reading", text: "开始核读材料" },
  clarifying: { key: "enter_clarify", text: "进入澄清" },
  modeling: { key: "enter_consolidate", text: "进入整理建模" },
  writing: { key: START_ITEMS_KEY, text: START_ITEMS_TEXT },
  reviewing: { key: "enter_review", text: "进入评审确认" },
  document: { key: "enter_document", text: "进入编写文档" },
};

/**
 * 留在某个阶段的那个选项（编写文档是最后一段，没有往前的卡片）。五张卡片上文字相同、键各不相同：页面按键认出这一项，
 * 不管助手在卡片里把它写成什么都显示成这一句；点它只把卡片标为已选，不替用户发话（lib/user_stage.ts）。
 */
export const STAY_OPTIONS: Record<Exclude<Stage, "document">, CardOption> = {
  reading: { key: "continue_reading", text: STAY_TEXT },
  clarifying: { key: CONTINUE_CLARIFY_KEY, text: STAY_TEXT },
  modeling: { key: "continue_consolidate", text: STAY_TEXT },
  writing: { key: "continue_writing", text: STAY_TEXT },
  reviewing: { key: "continue_review", text: STAY_TEXT },
};

/**
 * 任务空闲时助手提议开始核读材料的那张卡片上不生效的那一项：空闲时没有阶段可以「继续」，所以另写一句。
 * 点它只把卡片标为已选，不替用户发话，提议仍然开着。
 */
export const STAY_IDLE_OPTION: CardOption = { key: "stay_idle", text: "先不开始" };

/**
 * 退回前面的阶段也由用户决定：助手认为这一段的输入大面积不能用了（用户放进了新材料、几页的理解互相矛盾），用一张请选择卡片
 * 提议退回并写明原因，卡片上固定两个选项，「退回某段」与「留在本段」。用户点了「退回」，系统替用户记一次移动。
 * 局部不明白的地方不退回：记一条问题条目、在那一处标「待定」、接着做这一段。
 * 退回某个阶段的那个选项（编写文档是最后一段，没有「退回」到它的卡片）。
 */
export const BACK_OPTIONS: Record<Exclude<Stage, "document">, CardOption> = {
  reading: { key: "back_to_reading", text: "退回核读材料" },
  clarifying: { key: "back_to_clarify", text: "退回澄清" },
  modeling: { key: "back_to_consolidate", text: "退回整理建模" },
  writing: { key: "back_to_writing", text: "退回写条目" },
  reviewing: { key: "back_to_review", text: "退回评审确认" },
};
/** 回退卡片上留在这一段的那个选项：点它只把卡片标为已选，不替用户发话，提议仍然开着。 */
export const STAY_HERE_OPTION: CardOption = { key: "stay_in_stage", text: "留在本段" };

/**
 * 编写文档阶段请用户过目的那张卡片的两个选项。点「看过了，生成文档」不移动阶段、不引出助手的运行：页面把卡片点名的页记为看过，
 * 再打开生成文档；点「需要修改」只把卡片标为已选，用户接着说要改哪里。
 */
export const DOCUMENT_REVIEWED_OPTION: CardOption = { key: "document_reviewed", text: "看过了，生成文档" };
export const DOCUMENT_REVISE_OPTION: CardOption = { key: "document_revise", text: "需要修改" };

/** 卡片上的一个选项键是「退回」哪个阶段的；不是这样的键时返回 null。 */
export function stageBackedBy(key: unknown): Exclude<Stage, "document"> | null {
  const found = (Object.keys(BACK_OPTIONS) as Exclude<Stage, "document">[]).find((stage) => BACK_OPTIONS[stage].key === key);
  return found ?? null;
}

/** 怎样提议退回某个阶段：告诉助手用哪张卡片、两个选项怎样写。 */
export function backCardGuidance(to: Exclude<Stage, "document">): string {
  const back = BACK_OPTIONS[to];
  return `请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 ${back.key}「${back.text}」、${STAY_HERE_OPTION.key}「${STAY_HERE_OPTION.text}」`;
}

/** 回复里写了已经停用的 stage 时的拒绝：事实与怎么办。 */
export const STAGE_PARAM_RETIRED: Refusal = [
  "回复里写了 stage（或 reason），这两项已经停用：阶段不由你移动，任务还在原来的阶段",
  "往前进入下一段，用进入下一段的请选择卡片提议；这一段的输入大面积不能用、要退回前面的阶段，用请选择卡片提议退回并在问句里写明原因，" +
    `两个选项的键与文字照这样写：${Object.values(BACK_OPTIONS).map((one) => `${one.key}「${one.text}」`).join("、")}里要退到的那一个，与 ${STAY_HERE_OPTION.key}「${STAY_HERE_OPTION.text}」；都由用户在卡片上点。` +
    "只是有一处没弄明白时不要退回：记一条问题条目，在那一处标「待定」，接着做这一段",
];

/**
 * 总体分析还没有一页主题时页面上的两个开头（「通读材料起草」「逐项澄清」）替用户发给助手的两句固定的话。
 * 页面点了按钮先把任务移到那个阶段、再发这一句；它们不是用户自己打的字，整理用户说过的话时要认出来。
 */
export const STAGE_START_TEXTS = {
  reading: "请通读材料，把材料里已经写明的概念、角色、流程与目标各立一页主题。",
  clarifying: "请逐项澄清：一次只问一件事，先给出候选再问。",
} as const;

/**
 * 任务状况卡上「请助手说明下一步」替用户发给助手的那句固定的话。它不是用户自己打的字，整理用户说过的话时要认出来。
 */
export const STATUS_NEXT_TEXT = "请按任务状况说明下一步该做什么。";

/** 某个阶段的下一段；编写文档之后没有。 */
export function nextStage(stage: Stage): Stage | null {
  return STAGES[STAGES.indexOf(stage) + 1] ?? null;
}

/** 卡片上的一个选项键是「进入」哪个阶段的（「开始核读材料」算进入核读材料）；不是这样的键时返回 null。 */
export function stageEnteredBy(key: unknown): Stage | null {
  const found = (Object.keys(ENTER_OPTIONS) as Stage[]).find((stage) => ENTER_OPTIONS[stage].key === key);
  return found ?? null;
}

/** 任务空闲时怎样提议开始核读材料：告诉助手用哪张卡片、两个选项怎样写。 */
export function startReadingCardGuidance(): string {
  const enter = ENTER_OPTIONS.reading;
  return `请用请选择卡片提议，两个选项的键与文字是 ${enter.key}「${enter.text}」、${STAY_IDLE_OPTION.key}「${STAY_IDLE_OPTION.text}」`;
}

/**
 * 在某个阶段怎样提议进入下一段：告诉助手用哪张卡片、两个选项怎样写。编写文档是最后一段，没有下一段，返回空串。
 */
export function forwardCardGuidance(from: Stage): string {
  const next = nextStage(from);
  if (next === null || from === "document") return "";
  const enter = ENTER_OPTIONS[next], stay = STAY_OPTIONS[from];
  return `请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 ${enter.key}「${enter.text}」、${stay.key}「${stay.text}」`;
}

/**
 * 一次移动行不行。
 * - same：目标就是现在所在的阶段，原地不动不算移动，不记。
 * - user_only：移动阶段（往前、往后都是）要由用户决定，助手只能发卡片提议。
 * 用户的移动不设限；任务空闲时移到哪个阶段都不是原地不动。
 */
export type MoveVerdict = { ok: true } | { ok: false; why: "same" | "user_only" };

export function judgeMove(from: Position, to: Stage, actor: StageActor): MoveVerdict {
  if (from === to) return { ok: false, why: "same" };
  if (actor === "user") return { ok: true };
  return { ok: false, why: "user_only" };
}

// ───────────── 开展一项活动 ─────────────

/**
 * 一项活动是怎样开始的：
 * - move：任务本来就在首次分析流程里的某个阶段，移到了流程里的另一个阶段（卡片上的进入与退回、直接移动）；
 * - launch：任务还没有走过首次分析，从这个节点启动它；
 * - resume：首次分析走过一段，任务后来空闲了或者改做了单独的活动，现在从这个节点接着走；
 * - alone：单独开展这项活动，不在流程里。
 */
export type StartHow = "move" | "launch" | "resume" | "alone";

/**
 * 判一次开始属于哪一种。inFlow 是这次要不要在流程里开始；fromInFlow 是开始之前任务是不是正在流程里的某个阶段；
 * flowBefore 是开始之前首次分析走到的节点（最近一条带节点的活动记录），没有走过是 null。
 */
export function startHow(inFlow: boolean, fromInFlow: boolean, flowBefore: Stage | null): StartHow {
  if (!inFlow) return "alone";
  if (fromInFlow) return "move";
  return flowBefore === null ? "launch" : "resume";
}

/**
 * 对话里说一次活动开始的那一句，不带「界面操作」的前缀。from 是开始之前任务在哪里（一个阶段或者空闲）。
 * 流程里的移动照旧写从哪到哪；另外三种开始之前任务正在做别的活动时，句末注明原来在做什么。
 */
export function activityStartSentence(how: StartHow, to: Stage, from: Position): string {
  const name = STAGE_NAMES[to];
  if (how === "move") return `用户把任务从${positionName(from)}移到${name}。`;
  const was = from === IDLE ? "" : `（原来在做：${STAGE_NAMES[from]}）`;
  const flow = FLOW_NAMES[FLOW_INITIAL];
  if (how === "launch") return `用户启动${flow}，从${name}开始。${was}`;
  if (how === "resume") return `用户继续${flow}，从${name}接着。${was}`;
  return `用户单独开展${name}。${was}`;
}

/** 有活动在进行时用户改做别的活动，原来那条活动记录结束的起因。 */
export function switchedReason(to: Stage): string {
  return `用户改做${STAGE_NAMES[to]}`;
}

/** 助手汇报单独开展的活动做完了时，那条活动记录结束的起因。 */
export const ACTIVITY_DONE_REASON = "助手汇报这项活动结束";

/**
 * 回复里写了 activity_done 而任务不在单独开展的活动里时的拒绝：事实与怎么办。position 是任务现在在哪里
 * （在首次分析流程里的某个阶段，或者空闲）。在流程里做完一段不由助手结束：用进入下一段的卡片提议，由用户点。
 */
export function activityDoneRefusal(position: Position): Refusal {
  if (position === IDLE) {
    return ["回复里写了 activity_done，而任务现在空闲，没有在进行的活动可以结束", "去掉 activity_done 这一项再回复。开展哪一项活动由用户从任务状况卡决定"];
  }
  const forward = forwardCardGuidance(position);
  return [
    `回复里写了 activity_done，而任务现在在首次分析流程里的${STAGE_NAMES[position]}阶段：这一项只在用户单独开展一项活动时用，流程里的阶段不由你结束`,
    `去掉 activity_done 这一项再回复。${forward ? `这一段做完了要往前走，${forward}，由用户在卡片上点` : "这一段做完了，照这一段的说明请用户过目"}`,
  ];
}

/** 助手汇报一项单独开展的活动结束时，对话里那条回复下面的一行。 */
export function activityDoneSentence(activity: Stage): string {
  return `助手汇报这项活动结束：${STAGE_NAMES[activity]}。任务现在空闲。`;
}

/** 首次分析从哪个节点启动：有材料从核读材料，没有材料从澄清。 */
export function flowStartNode(hasMaterials: boolean): Stage {
  return hasMaterials ? "reading" : "clarifying";
}

/** 算「开展一项活动」那一节要的事实。 */
export interface LaunchFacts {
  /** 任务现在在哪里：一个阶段，或者空闲。 */
  position: Position;
  /** 现在这项活动是不是在首次分析流程里（空闲时为假）。 */
  inFlow: boolean;
  /** 首次分析走到的节点：最近一条带节点的活动记录；没有走过是 null。 */
  flowNode: Stage | null;
  /** 任务里有没有材料。 */
  hasMaterials: boolean;
  /** 业务说明里在用的主题页有几页。 */
  pages: number;
  /** 需求条目有几条（总体分析与问题之外各集合的条目）。 */
  items: number;
}

/** 可以点的一项：开展哪一项活动、在不在流程里、按钮上的字、现在能不能开展、一句状态（不能开展时写缺什么）。 */
export interface LaunchOption {
  activity: Stage;
  in_flow: boolean;
  label: string;
  enabled: boolean;
  state: string;
}

/**
 * 任务状况卡上「开展一项活动」一节的内容，三组：
 * current 是正在进行的活动（只显示一行，不是按钮；空闲时为 null）；flows 是可以启动或继续的流程（现在只有首次分析）；
 * activities 是可以单独开展的活动（六项）；later 是以后才有的（发布）。
 */
export interface LaunchView {
  current: { activity: Stage; in_flow: boolean; label: string } | null;
  flows: LaunchOption[];
  activities: LaunchOption[];
  later: { label: string; state: string }[];
}

export const LAUNCH_READY = "可以开展";
export const LAUNCH_ACTIVE = "正在进行";

/** 单独开展一项活动缺什么；不缺是 null。核读材料要有材料，整理建模与写条目要业务说明有页，评审确认与编写文档要有需求条目。 */
export function activityBlocked(activity: Stage, facts: Pick<LaunchFacts, "hasMaterials" | "pages" | "items">): string | null {
  if (activity === "reading" && !facts.hasMaterials) return "还没有材料，先上传";
  if ((activity === "modeling" || activity === "writing") && facts.pages === 0) return "业务说明还没有页";
  if ((activity === "reviewing" || activity === "document") && facts.items === 0) return "还没有需求条目";
  return null;
}

export function launchView(facts: LaunchFacts): LaunchView {
  const flow = FLOW_NAMES[FLOW_INITIAL];
  const at = facts.position === IDLE ? null : facts.position;
  const current = at === null ? null
    : { activity: at, in_flow: facts.inFlow, label: facts.inFlow ? `继续${flow}：${STAGE_NAMES[at]}` : `继续${STAGE_NAMES[at]}` };
  const node = facts.flowNode ?? flowStartNode(facts.hasMaterials);
  const inFlowNow = at !== null && facts.inFlow;
  const flows: LaunchOption[] = [{
    activity: node, in_flow: true,
    label: facts.flowNode === null ? `启动${flow}` : `继续${flow}（从${STAGE_NAMES[node]}接着）`,
    enabled: !inFlowNow,
    state: inFlowNow ? LAUNCH_ACTIVE : facts.flowNode === null ? `从${STAGE_NAMES[node]}开始` : LAUNCH_READY,
  }];
  const activities: LaunchOption[] = STAGES.map((activity) => {
    const active = at === activity && !facts.inFlow;
    const blocked = activityBlocked(activity, facts);
    return { activity, in_flow: false, label: STAGE_NAMES[activity], enabled: !active && blocked === null, state: active ? LAUNCH_ACTIVE : blocked ?? LAUNCH_READY };
  });
  return { current, flows, activities, later: [{ label: "发布", state: "0.6 后续" }] };
}

// ───────────── 每个阶段助手能写什么 ─────────────

/**
 * 助手的一次写入属于哪一类：
 * page 总体分析的页；problem 问题条目；diagram 图；item 别的集合的条目（用例、非功能需求、约束这一类）；
 * review 请求评审；complete 完成任务。
 */
export type WriteKind = "page" | "problem" | "diagram" | "item" | "review" | "complete";

/**
 * 每个阶段助手能做哪几类写入。页与问题任何阶段都可以写（评审确认阶段对页另有限制，见 pageRefusal）。
 * 编写文档排在最后，却不能写条目、不能画图、不能请求评审，所以这里一个阶段一个阶段列出来，不按先后推。
 * 空闲时与澄清相同：只能写页与问题。
 */
const ALLOWED: Record<Position, readonly WriteKind[]> = {
  idle: ["page", "problem"],
  reading: ["page", "problem"],
  clarifying: ["page", "problem"],
  modeling: ["page", "problem", "diagram"],
  writing: ["page", "problem", "diagram", "item", "review"],
  reviewing: ["page", "problem", "diagram", "item", "review", "complete"],
  document: ["page", "problem", "complete"],
};

/** 这个阶段（或者空闲时）助手能不能做这一类写入。 */
export function canWrite(stage: Position, kind: WriteKind): boolean {
  return ALLOWED[stage].includes(kind);
}

/** 拒绝的两层文字：事实（现在在哪个阶段、拦下的是什么）与怎么办（这一步要先做什么、谁能移动）。 */
export type Refusal = [fact: string, guidance: string];

const OP_WORDS: Record<string, string> = { add: "新增", update: "修改", delete: "删除" };

/**
 * 编写文档阶段被拦时怎么办：这一段只补写业务说明的文字。要动条目、图或者再评审，得先回到前面的阶段，
 * 回去要由用户决定：助手发卡片提议退回并写明原因，用户点了才退。
 */
function howToLeaveDocument(back: Exclude<Stage, "document">): string {
  return `编写文档阶段只补写主题页的文字。要做这件事，得先回到${STAGE_NAMES[back]}：${backCardGuidance(back)}，由用户在卡片上点`;
}

/** 空闲时被拦的事实开头的那半句。 */
const IDLE_FACT = "任务现在没有在进行的活动";

/**
 * 空闲时被拦怎么办：这件事要在哪一项活动里做（where），而开展哪一项活动由用户定——从任务状况卡开展一项活动。
 * 空闲时助手能做的与澄清相同：立主题页、改主题页、记问题条目。
 */
function howToLeaveIdle(where: string): string {
  return `${where}。开展哪一项活动由用户决定：请用户从任务状况卡开展一项活动。任务空闲时你可以立主题页、改主题页、记问题条目`;
}

/** 还没到写条目时，怎样才能到：这一句写在几种拒绝的「怎么办」里。 */
function howToReachWriting(): string {
  return `进入写条目要由用户在卡片上选「${START_ITEMS_TEXT}」：你可以先立页、请用户看，觉得理解够了就用请选择卡片提议`;
}

/**
 * 助手新增、修改或删除别的集合（不是总体分析、也不是问题）的条目：写条目之前的阶段都拦，空闲时也拦。
 * 可以写时返回 null。
 */
export function itemRefusal(stage: Position, op: string, collection: string): Refusal | null {
  if (canWrite(stage, "item")) return null;
  if (stage === IDLE) {
    return [`${IDLE_FACT}，这时不能${OP_WORDS[op] ?? "写"}「${collection}」的条目`, howToLeaveIdle(`「${collection}」的条目要在写条目这项活动里写`)];
  }
  if (stage === "document") {
    return [`任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能${OP_WORDS[op] ?? "写"}「${collection}」的条目`, howToLeaveDocument("reviewing")];
  }
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能${OP_WORDS[op] ?? "写"}「${collection}」的条目`,
    `「${collection}」的条目要到写条目阶段才能写。${howToReachWriting()}`,
  ];
}

/**
 * 助手新增、修改或删除总体分析的一页：前四个阶段与空闲时都可以；评审确认阶段只能改「状态」与「改看」两个字段，
 * 不能新立页、不能删页。changed 是修改时这次改动了的字段名。可以写时返回 null。
 */
export function pageRefusal(stage: Position, op: string, changed: readonly string[] = []): Refusal | null {
  if (stage !== "reviewing") return null;
  const guidance = `要动主题页的内容，得先回到澄清或整理建模：${backCardGuidance("clarifying")}，由用户在卡片上点`;
  const head = `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段`;
  if (op === "add") return [`${head}不能新立主题页`, guidance];
  if (op === "delete") return [`${head}不能删除主题页`, guidance];
  const allowed: string[] = [OVERALL_FIELDS.status, OVERALL_FIELDS.seeAlso];
  const others = changed.filter((name) => !allowed.includes(name));
  if (others.length === 0) return null;
  return [`${head}主题页只能改「${OVERALL_FIELDS.status}」与「${OVERALL_FIELDS.seeAlso}」，这次还改了${others.map((name) => `「${name}」`).join("、")}`, guidance];
}

/**
 * 助手新画、修改或删除一张图：整理建模之前的阶段都拦，空闲时也拦。可以时返回 null。
 * 「怎么办」里说的是怎样走到整理建模：往前进入下一段要由用户在卡片上点，助手只能发卡片提议（forwardCardGuidance）。
 */
export function diagramRefusal(stage: Position): Refusal | null {
  if (canWrite(stage, "diagram")) return null;
  if (stage === IDLE) return [`${IDLE_FACT}，这时不能画图、改图或删图`, howToLeaveIdle("图要在整理建模这项活动里画")];
  if (stage === "document") return [`任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能画图、改图或删图`, howToLeaveDocument("modeling")];
  const enterModeling = ENTER_OPTIONS.modeling.text;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能画图、改图或删图`,
    stage === "reading"
      ? `图要到整理建模阶段才能画。往前进入下一段要由用户在卡片上点，你只能提议：材料读完之后先提议进入澄清，${forwardCardGuidance("reading")}；澄清告一段落之后，再照同样的办法提议「${enterModeling}」`
      : `图要到整理建模阶段才能画。进入整理建模要由用户在卡片上选「${enterModeling}」，你只能提议：澄清告一段落之后，${forwardCardGuidance("clarifying")}`,
  ];
}

/** 助手请求评审：写条目之前的阶段都拦，空闲时也拦。可以时返回 null。 */
export function reviewRefusal(stage: Position): Refusal | null {
  if (canWrite(stage, "review")) return null;
  if (stage === IDLE) return [`${IDLE_FACT}，这时不能请求评审`, howToLeaveIdle("评审要在写条目或评审确认这项活动里请求")];
  if (stage === "document") return [`任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能请求评审`, howToLeaveDocument("reviewing")];
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，评审要到写条目阶段才能请求`,
    `条目写出来之后再评审。${howToReachWriting()}`,
  ];
}

/** 助手完成任务：评审确认与编写文档两个阶段可以，空闲时不可以。可以时返回 null。 */
export function completeRefusal(stage: Position): Refusal | null {
  if (canWrite(stage, "complete")) return null;
  if (stage === IDLE) return [`${IDLE_FACT}，这时不能完成任务`, howToLeaveIdle("完成任务要在评审确认或编写文档这项活动里做")];
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
  /** 它是哪一章的导语页：「导语所属章」里写的章名；不是导语页是 null。 */
  intro: string | null;
  /** 「它是什么」写了没有。 */
  what: boolean;
  /** 这一页待核实：有助手补充而用户还没有确认的内容。 */
  pending: boolean;
  /** 这一页的文字里有没有「待定」标记（hasPendingMark）。 */
  marked: boolean;
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
  /** 它的 Mermaid 文本里有没有「待定：」标记。没有给当作没有。 */
  marked?: boolean;
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
  /** 它的字段里有没有「待定」标记（hasPendingMark）。没有给当作没有。 */
  marked?: boolean;
}

/** 算灯要的一条问题条目。 */
export interface LampQuestion {
  item_id: string;
  /** 是不是还没解决的待澄清问题。 */
  open: boolean;
  /** 它关联的条目的编号。 */
  related: string[];
  /** 状态是不是「未解决」（不分种类）。 */
  unresolved: boolean;
  /** 是否阻断下游：写的是「阻断下游」为真，「不阻断」或者没有写为假。 */
  blocking: boolean;
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
  /**
   * 任务定义里有没有声明这两个字段：总体分析的「导语所属章」、问题集合的「是否阻断下游」。早先建的任务的定义里没有，
   * 与它们有关的灯是不适用。没有给当作都没有。
   */
  declared?: { intro: boolean; blocking: boolean };
}

const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && one.trim() !== "") : []);

/** 一段文字说没说到状态：有「状态」二字、有「变成」，或者有「从……变为……」（中间不跨句）。 */
const STATE_WORDS = /状态|变成|从[^。；;！？\n]{0,40}变为/;

/** 从一页的字段内容与用户看没看过，取出算灯要的几样。 */
/**
 * 「待定」标记：一处还没有定下来、先这样记着的地方。约定的写法是字段的值（或列表里的一项）就是「待定」两个字，
 * 或者文字里带着「待定：」加一句说明（图的节点文字以「待定：」开头）。问题了结、内容落实之后助手把它去掉。
 */
export const PENDING_MARK = "待定";
const MARK_IN_TEXT = /待定[：:]/;
export function hasPendingMark(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === PENDING_MARK || MARK_IN_TEXT.test(value);
  if (Array.isArray(value)) return value.some(hasPendingMark);
  if (value !== null && typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasPendingMark);
  return false;
}
/** 问题条目里「是否阻断下游」这个字段与表示阻断的取值（与 lib/definition.ts 里的同名常量一致；这里不从它导入，本文件要给页面用）。 */
export const QUESTION_BLOCKING_FIELD = "是否阻断下游";
export const QUESTION_BLOCKING = "阻断下游";

export function lampPage(itemId: string, fields: Record<string, unknown>, viewed: boolean, pending = false): LampPage {
  const title = fields[OVERALL_FIELDS.title];
  const what = fields[OVERALL_FIELDS.what];
  const settled = texts(fields[OVERALL_FIELDS.settled]);
  return {
    item_id: itemId, title: typeof title === "string" ? title.trim() : "", aliases: texts(fields[OVERALL_FIELDS.aliases]).map((one) => one.trim()),
    tags: tagsOf(fields), deprecated: isDeprecated(fields), parent: texts(fields[OVERALL_FIELDS.parent])[0] ?? null,
    examples: texts(fields[OVERALL_FIELDS.examples]), viewed, settled: settled.length,
    stateful: [typeof what === "string" ? what : "", ...settled].some((one) => STATE_WORDS.test(one)),
    intro: typeof fields[OVERALL_FIELDS.intro] === "string" && (fields[OVERALL_FIELDS.intro] as string).trim() !== "" ? (fields[OVERALL_FIELDS.intro] as string).trim() : null,
    what: typeof what === "string" && what.trim() !== "", pending, marked: hasPendingMark(fields),
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
    unresolved: fields[statusField] === QUESTION_OPEN_STATUS, blocking: fields[QUESTION_BLOCKING_FIELD] === QUESTION_BLOCKING,
  };
}

const list = (ids: readonly string[]) => ids.join("、");
const lamp = (key: string, ok: boolean | null, summary: string, items: string[] = []): Lamp => ({ key, summary, ok, items });

/** 每个阶段的几盏灯，六个阶段都算。 */
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

  // 整理建模：有状态的「概念」页有一张以它为来源的状态图。两部分一起看：已经有状态图的概念页算有图（不管文字里说没说到状态）；
  // 文字说到状态（按字面认，lampPage 的 stateful）而没有状态图的概念页算差的。有差的不通过；没有差的而至少一页有图，通过；两样都没有，不适用。
  const hasStateChart = (itemId: string): boolean => input.diagrams.some((chart) => chart.kind === KIND_STATE && chart.sources.includes(itemId));
  const charted = concepts.filter((one) => hasStateChart(one.item_id));
  const stateless = concepts.filter((one) => one.stateful && !hasStateChart(one.item_id));
  const statesDrawn = stateless.length === 0 && charted.length === 0
    ? lamp("stateful_concepts_have_state", null, `还没有画了状态图的「${TAG_CONCEPT}」主题，也没有哪一页「${TAG_CONCEPT}」主题的文字说到状态。`)
    : stateless.length === 0 ? lamp("stateful_concepts_have_state", true, `有 ${charted.length} 页「${TAG_CONCEPT}」主题画了状态图；文字说到状态的「${TAG_CONCEPT}」主题都有状态图。`)
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
  // 导语页不贴标签，不算没归类。
  const loose = live.filter((one) => one.tags.length === 0 && !one.intro);
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

  // 写条目与编写文档：没有未了结的阻断下游的问题。两个阶段各一盏，键不同，判法相同。
  const blockers = input.questions.filter((one) => one.unresolved && one.blocking);
  const noBlocking = (key: string): Lamp => (!input.declared?.blocking ? lamp(key, null, "任务定义的问题集合里没有「是否阻断下游」这个字段。")
    : input.questions.length === 0 ? lamp(key, null, "还没有问题条目。")
      : blockers.length === 0 ? lamp(key, true, "没有未了结的阻断下游的问题。")
        : lamp(key, false, `有 ${blockers.length} 个阻断下游的问题还没有了结：${list(blockers.map((one) => one.item_id))}。`, blockers.map((one) => one.item_id)));

  // 写条目：图、页与条目里没有「待定」标记。
  const marked = [...live.filter((one) => one.marked).map((one) => one.item_id), ...input.diagrams.filter((one) => one.marked).map((one) => one.diagram_id),
    ...others.filter((one) => one.marked).map((one) => one.item_id)];
  const noMarks = live.length + input.diagrams.length + others.length === 0 ? lamp("no_pending_marks", null, "还没有页、图或条目。")
    : marked.length === 0 ? lamp("no_pending_marks", true, "图、页与条目里没有标为待定的地方。")
      : lamp("no_pending_marks", false, `有 ${marked.length} 处还标着待定：${list(marked)}。`, marked);

  // 编写文档：有内容的章都有一页在用、写了「它是什么」的导语页。第 5、7 章没有自己的页，看各页有没有「已经定下的」、有没有决定或没了结的问题。
  const sections = live.filter((one) => !one.intro);
  const filled = CHAPTERS.filter((chapter) => sections.some((one) => chapterOfLabels(one.tags)?.no === chapter.no)
    || (chapter.no === CHAPTER_RULES && settledTotal > 0)
    || (chapter.no === CHAPTER_DECISIONS && (tagged(TAG_DECISION).length > 0 || input.questions.some((one) => one.unresolved))));
  const bare = filled.filter((chapter) => !live.some((one) => one.intro === chapter.name && one.what));
  const chaptersIntro = !input.declared?.intro ? lamp("chapters_have_intro", null, "任务定义的总体分析里没有「导语所属章」这个字段。")
    : filled.length === 0 ? lamp("chapters_have_intro", null, "业务说明的各章都还没有内容。")
      : bare.length === 0 ? lamp("chapters_have_intro", true, "有内容的章都有导语。")
        : lamp("chapters_have_intro", false, `有 ${bare.length} 章还没有导语：${bare.map((chapter) => `「${chapter.name}」`).join("、")}。`);

  // 编写文档：术语表齐全——标签含「概念」的在用页都写了「它是什么」，而且不待核实。
  const terms = tagged(TAG_CONCEPT);
  const unclear = terms.filter((one) => !one.what || one.pending);
  const glossary = terms.length === 0 ? lamp("glossary_complete", null, `还没有标签为「${TAG_CONCEPT}」的主题。`)
    : unclear.length === 0 ? lamp("glossary_complete", true, `标签为「${TAG_CONCEPT}」的主题都写了说明，也都核实过了。`)
      : lamp("glossary_complete", false, `有 ${unclear.length} 页标签为「${TAG_CONCEPT}」的主题还没有写说明或者还待核实：${list(unclear.map((one) => one.item_id))}。`, unclear.map((one) => one.item_id));

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
    writing: [flowsBacked, basisViewed, basisDiagramsViewed, noPending, noBlocking("no_blocking_questions"), noMarks],
    reviewing: [reviews, completion],
    document: [chaptersIntro, glossary, noBlocking("document_no_blocking_questions")],
  };
}

/** 全部灯的键，按阶段的先后。 */
export const LAMP_KEYS = [
  "materials_cited", "tagged_pages_no_open_questions", "decisions_have_goal",
  "roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state",
  "no_duplicate_titles", "no_untagged_pages", "rules_no_conflict",
  "flows_backed_by_use_cases", "basis_pages_viewed", "basis_diagrams_viewed", "no_pending_items", "no_blocking_questions", "no_pending_marks",
  "reviews_no_open_findings", "completion_met",
  "chapters_have_intro", "glossary_complete", "document_no_blocking_questions",
] as const;

/**
 * 「这一段还差什么」写成给助手看的一段话：不通过的灯各一句；都通过（或都不适用）时写一句「这一段的几项都齐了」。
 */
export function lampLines(stage: Stage, lamps: readonly Lamp[]): string[] {
  const missing = lamps.filter((one) => one.ok === false);
  if (missing.length === 0) return [`${STAGE_NAMES[stage]}这一段的几项都齐了。`];
  return [`${STAGE_NAMES[stage]}这一段还差 ${missing.length} 项：`, ...missing.map((one) => `  - ${one.summary}`)];
}
