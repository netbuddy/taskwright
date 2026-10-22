/**
 * 工作的阶段：任务定义里有「业务说明」集合的任务，工作分六个阶段——核读材料、澄清、整理建模、写条目、评审确认、编写文档。
 * 阶段由用户或助手的动作移动，每次移动留一条记录；助手每次调用写入工具时能写什么，由最近一条记录决定。
 *
 * 本文件只放不读库的东西：六个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话、
 * 提议进入写条目的那张卡片的两个选项，以及每个阶段「这一段还差什么」的几盏灯（一共二十一盏）怎样算。读写库的在 lib/stage_read.ts。
 *
 * 早先建的任务（任务定义里没有「业务说明」集合）没有阶段，这里的一切对它们都不生效；判据是 overall_analysis.ts 的 hasOverall。
 *
 * 本文件除了 overall_analysis.ts 与 overall_chapters.ts（它也只导入前者）不导入别的模块：助手的工具、后端的快照都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

import { OVERALL_FIELDS, isDeprecated, tagsOf } from "./overall_analysis.ts";
import { CHAPTERS, CHAPTER_DECISIONS, CHAPTER_RULES, chapterOfLabels } from "./overall_chapters.ts";
import { fillText, refusalText } from "./shared_texts.ts";
import type { RefusalText } from "./texts_core.ts";

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
 * 所属流程：一个工作项是哪一条工作流程的一次启动。现在只有一条流程（需求分析）；单项活动的工作项不属于流程。
 * 流程可以在各站之间来回走、反复迭代，没有终点；一个任务同一时刻至多有一个流程的工作项（不论哪条流程）。
 * 它写在活动记录表的「所属流程」一列与工作项的几种事件的内容里。早先这条流程叫首次分析、键是 initial：
 * 升级时活动记录里的键改写成 analysis，早先记下的事件里仍是 initial，读的时候用 flowKeyOf 当作同一条。
 */
export const FLOW_ANALYSIS = "analysis";
export const FLOW_NAMES: Record<string, string> = { [FLOW_ANALYSIS]: "需求分析" };
/** 事件里记的流程键换成现在的写法：早先的 initial 是需求分析；空的、不是文字的给 null。 */
export function flowKeyOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value === "initial" ? FLOW_ANALYSIS : value;
}

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
 * 空闲：一条会话现在没有在做的工作项——它是自由讨论的会话（不属于任何工作项），或者它已经归档（它的工作项被删除了）。它不是一个阶段，
 * 不排在 STAGES 的次序里，也没有自己的灯；写法 idle 与六个阶段的写法并列，出现在「这条会话现在在哪里」的那几处。它与 null 不是一回事：
 * null 是早先建的任务（任务定义里没有「业务说明」集合），那种任务没有阶段，什么都不拦；空闲的会话照下面的规矩拦。
 * 空闲时助手能写什么取空闲模板头里的「writes_allowed」（lib/activity_def_read.ts 的 allowedFor）。启动哪一项活动由用户在任务起点页上定。
 */
export const IDLE = "idle";
export const IDLE_NAME = "空闲";

/** 一条会话现在的位置：六个阶段之一，或者空闲。 */
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
 * 工作流里的转移由用户在卡片上点：助手做完这一步，发一张请选择卡片提议，用户点了生效的那一项，系统替用户把工作项移过去。
 * 卡片的键是通用的三种，不再按阶段各写一个：
 * - next_step「进入下一步：某活动」：进入工作流里的下一步（哪一步由工作流声明的 steps 推出来）；
 * - goto:<活动标识符>「回到：某活动」或「转到：某活动」：退回前面的某一步，或者跳到后面的某一步；
 * - stay「继续本步」：不移动，只把卡片标为已选，提议仍然开着。
 * 过渡期活动的标识符与阶段的键相同，所以这里按阶段写；工作流的各步与阶段的先后相同（需求分析）。
 * 早先的卡片用的是按阶段的固定键（enter_clarify、start_items、back_to_reading、continue_reading、stay_in_stage 之类），
 * 任务库里还开着的旧卡片照样认：LEGACY_CARD_MOVES 把它们换成上面三种，只读，不再用来发新卡片。
 */
export const NEXT_STEP_KEY = "next_step";
export const STAY_KEY = "stay";
export const GOTO_PREFIX = "goto:";
/** 留在这一步的那个选项的文字：所有提议卡片上都是这一句。 */
export const STAY_TEXT = "继续本步";

export interface CardOption {
  key: string;
  text: string;
}

/** 留在这一步的那个选项。 */
export const STAY_OPTION: CardOption = { key: STAY_KEY, text: STAY_TEXT };

/** 进入下一步的那个选项：文字里带下一步的名字。 */
export function nextStepOption(to: Stage): CardOption {
  return { key: NEXT_STEP_KEY, text: `进入下一步：${STAGE_NAMES[to]}` };
}

/** 转到工作流里某一步的那个选项：在现在这一步之前的写「回到」，之后的写「转到」。from 不是阶段（空闲、不知道）时写「转到」。 */
export function gotoOption(to: Stage, from: Position | null): CardOption {
  const back = from !== null && from !== IDLE && STAGES.indexOf(to) < STAGES.indexOf(from);
  return { key: `${GOTO_PREFIX}${to}`, text: `${back ? "回到" : "转到"}：${STAGE_NAMES[to]}` };
}

/**
 * 卡片上一个选项键的意思：进入下一步、转到某一步、留在这一步。转到某一步的，早先的固定键自己带着方向（back：back_to_ 开头的是退回，
 * 别的是往前）；新键没有，方向看它与现在所在的那一步谁前谁后。
 */
export type CardMove = { kind: "next" } | { kind: "goto"; to: Stage; back?: boolean } | { kind: "stay" };

/** 早先按阶段的固定键，只读：任务库里还开着的旧卡片照样认。 */
export const LEGACY_CARD_MOVES: Readonly<Record<string, CardMove>> = {
  enter_reading: { kind: "goto", to: "reading", back: false },
  enter_clarify: { kind: "goto", to: "clarifying", back: false },
  enter_consolidate: { kind: "goto", to: "modeling", back: false },
  start_items: { kind: "goto", to: "writing", back: false },
  enter_review: { kind: "goto", to: "reviewing", back: false },
  enter_document: { kind: "goto", to: "document", back: false },
  back_to_reading: { kind: "goto", to: "reading", back: true },
  back_to_clarify: { kind: "goto", to: "clarifying", back: true },
  back_to_consolidate: { kind: "goto", to: "modeling", back: true },
  back_to_writing: { kind: "goto", to: "writing", back: true },
  back_to_review: { kind: "goto", to: "reviewing", back: true },
  continue_reading: { kind: "stay" },
  continue_clarify: { kind: "stay" },
  continue_consolidate: { kind: "stay" },
  continue_writing: { kind: "stay" },
  continue_review: { kind: "stay" },
  stay_in_stage: { kind: "stay" },
  stay_idle: { kind: "stay" },
};

/** 一个选项键是三种里的哪一种；不是转移卡片的键时返回 null。早先的固定键照 LEGACY_CARD_MOVES 换。 */
export function cardMove(key: unknown): CardMove | null {
  if (typeof key !== "string") return null;
  if (key === NEXT_STEP_KEY) return { kind: "next" };
  if (key === STAY_KEY) return { kind: "stay" };
  if (key.startsWith(GOTO_PREFIX)) {
    const to = key.slice(GOTO_PREFIX.length);
    return isStage(to) ? { kind: "goto", to } : null;
  }
  return LEGACY_CARD_MOVES[key] ?? null;
}

/** 这个选项键是不是留在这一步的那一项（含早先的「继续本阶段」「留在本段」「先不开始」）。 */
export function isStayCardKey(key: unknown): boolean {
  return cardMove(key)?.kind === "stay";
}

/**
 * 卡片上的一个选项键是不是往前走、走到哪个阶段：进入下一步（下一步是现在这一步的下一个阶段），或者转到现在这一步之后的某一步；
 * from 不是阶段（空闲、不知道）时，转到哪一步都算往前。不是往前的键时返回 null。
 */
export function stageEnteredBy(key: unknown, from: Position | null): Stage | null {
  const move = cardMove(key);
  if (move === null || move.kind === "stay") return null;
  if (move.kind === "next") return from !== null && from !== IDLE ? nextStage(from) : null;
  if (move.back !== undefined) return move.back ? null : move.to;
  if (from === null || from === IDLE) return move.to;
  return STAGES.indexOf(move.to) > STAGES.indexOf(from) ? move.to : null;
}

/** 卡片上的一个选项键是不是往回退、退到哪个阶段：转到现在这一步之前的某一步。from 不是阶段时不算退回。 */
export function stageBackedBy(key: unknown, from: Position | null): Stage | null {
  const move = cardMove(key);
  if (move === null || move.kind !== "goto") return null;
  if (move.back !== undefined) return move.back ? move.to : null;
  if (from === null || from === IDLE) return null;
  return STAGES.indexOf(move.to) < STAGES.indexOf(from) ? move.to : null;
}

/**
 * 编写文档阶段请用户过目的那张卡片的两个选项。点「看过了，生成文档」不移动阶段、不引出助手的运行：页面把卡片点名的页记为看过，
 * 再打开生成文档；点「需要修改」只把卡片标为已选，用户接着说要改哪里。这两项不是工作流的转移，键照旧。
 */
export const DOCUMENT_REVIEWED_OPTION: CardOption = { key: "document_reviewed", text: "看过了，生成文档" };
export const DOCUMENT_REVISE_OPTION: CardOption = { key: "document_revise", text: "需要修改" };

/** 怎样提议退回某个阶段：告诉助手用哪张卡片、两个选项怎样写。from 是现在所在的阶段。 */
export function backCardGuidance(to: Stage, from: Position | null = null): string {
  const back = gotoOption(to, from ?? STAGES[STAGES.length - 1]);
  return fillText("part.back_card", { back_key: back.key, back_text: back.text, stay_key: STAY_OPTION.key, stay_text: STAY_OPTION.text });
}

/**
 * 业务说明还没有一页主题时页面上的两个开头（「通读材料起草」「逐项澄清」）替用户发给助手的两句固定的话。
 * 页面点了按钮先把任务移到那个阶段、再发这一句；它们不是用户自己打的字，整理用户说过的话时要认出来。
 */
export const STAGE_START_TEXTS = {
  reading: "请通读材料，把材料里已经写明的概念、角色、流程与目标各立一页主题。",
  clarifying: "请逐项澄清：一次只问一件事，先给出候选再问。",
} as const;

/**
 * 活动输入页上点了「启动」之后，页面替用户发给助手的第一句话，每项活动一句：用户在输入页上写了目标系统描述时发的是那段描述，
 * 没有写才发这一句，助手据此开始做。核读材料与澄清沿用上面两句。它们不是用户自己打的字，整理用户说过的话时要认出来。
 */
export const ACTIVITY_START_TEXTS: Record<Stage, string> = {
  reading: STAGE_START_TEXTS.reading,
  clarifying: STAGE_START_TEXTS.clarifying,
  modeling: `请开始${STAGE_NAMES.modeling}。`,
  writing: `请开始${STAGE_NAMES.writing}。`,
  reviewing: `请开始${STAGE_NAMES.reviewing}。`,
  document: `请开始${STAGE_NAMES.document}。`,
};

/**
 * 页面上「请助手说明下一步」替用户发给助手的那句固定的话。它不是用户自己打的字，整理用户说过的话时要认出来。
 */
export const STATUS_NEXT_TEXT = "请按任务状况说明下一步该做什么。";

/** 某个阶段的下一段；编写文档之后没有。 */
export function nextStage(stage: Stage): Stage | null {
  return STAGES[STAGES.indexOf(stage) + 1] ?? null;
}

/**
 * 在某个阶段怎样提议进入下一段：告诉助手用哪张卡片、两个选项怎样写。编写文档是最后一段，没有下一段，返回空串。
 */
export function forwardCardGuidance(from: Stage): string {
  const next = nextStage(from);
  if (next === null || from === "document") return "";
  const enter = nextStepOption(next);
  return fillText("part.forward_card", { enter_key: enter.key, enter_text: enter.text, stay_key: STAY_OPTION.key, stay_text: STAY_OPTION.text });
}

/**
 * 一次移动行不行。
 * - same：目标就是现在所在的阶段，原地不动不算移动，不记。
 * - user_only：移动阶段（往前、往后都是）要由用户决定，助手只能发卡片提议。
 * 用户的移动不设限；从空闲移到哪个阶段都不是原地不动。
 */
export type MoveVerdict = { ok: true } | { ok: false; why: "same" | "user_only" };

export function judgeMove(from: Position, to: Stage, actor: StageActor): MoveVerdict {
  if (from === to) return { ok: false, why: "same" };
  if (actor === "user") return { ok: true };
  return { ok: false, why: "user_only" };
}

// ───────────── 启动一个工作项、流程换站 ─────────────

/**
 * 对话里那一行说的是哪一种事：
 * - move：流程的工作项换了一站（卡片上的进入与退回、直接移动）；
 * - launch：启动了一条工作流程，从这一站开始；
 * - alone：启动了一项单项活动，不在流程里；
 * - resume：早先的写法（会话与工作项绑定之前），流程走过一段之后从这一站接着走。现在不再记这一种，早先的对话里留着。
 */
export type StartHow = "move" | "launch" | "resume" | "alone";

/**
 * 对话里说一次启动或者换站的那一句，不带「界面操作」的前缀。from 是这之前这条会话在哪里（一个阶段或者空闲）。
 * 换站写从哪到哪。早先的对话里另有两样：接着走流程的那一种，以及启动之前任务正在做别的活动时句末注明的原来在做什么。
 * to 是活动标识符；names 给了时用给的工作流名与活动名（取自声明），没有给时是需求分析与阶段的名字，阶段的名字也取不到时是键本身。
 */
export function activityStartSentence(how: StartHow, to: string, from: Position, names: { flow?: string; activity?: string } = {}): string {
  const name = names.activity ?? (STAGE_NAMES as Record<string, string>)[to] ?? to;
  if (how === "move") return fillText("stage.start_move", { from: positionName(from), to: name });
  const was = from === IDLE ? "" : fillText("stage.start_was", { activity: STAGE_NAMES[from] });
  const flow = names.flow ?? FLOW_NAMES[FLOW_ANALYSIS];
  if (how === "launch") return fillText("stage.start_launch", { flow, to: name, was });
  if (how === "resume") return fillText("stage.start_resume", { flow, to: name, was });
  return fillText("stage.start_alone", { to: name, was });
}

/**
 * 新建一条会话接着做一个进行中的工作项时，对话里那一句（不带「界面操作」的前缀）。name 是工作项的名字，node 是流程的工作项现在在哪一站：
 * 那一站的名字（取自声明），或者阶段的键（早先的写法，按阶段的名字写）。
 */
export function workItemContinuedSentence(name: string, node: string | null): string {
  return node ? fillText("stage.continued_at", { name, node: (STAGE_NAMES as Record<string, string>)[node] ?? node }) : fillText("stage.continued", { name });
}

/** 用户删除一个工作项时，对话里那一句（不带「界面操作」的前缀）。archived 是随之归档了几条会话。 */
export function workItemDeletedSentence(name: string, archived: number): string {
  return archived > 0 ? fillText("stage.deleted_archived", { name, count: archived }) : fillText("stage.deleted", { name });
}

/** 范围说明最多多少个字：它要放进系统提示，太长的不收。 */
export const SCOPE_MAX_LENGTH = 2000;

/** 对话里那一句后面接的范围说明：「范围说明：……」，末尾没有句号时补一个。没有写范围说明时是空文字。 */
export function scopeSentence(scope: string): string {
  const said = scope.trim();
  return said ? `${fillText("stage.scope", { scope: said })}${/[。！？.!?]$/.test(said) ? "" : "。"}` : "";
}

/**
 * 用户把流程的工作项移到了别的一站、助手先前在这个工作项里开着的提议因此作废时，对话里那一句后面加的半句：输入框上方「待决定」一行随之消失，
 * 让用户与助手都知道原因。用户做的正是提议的那一步（进入或者退回提议的那个阶段）时不加。
 */
export const PROPOSAL_VOIDED_NOTE = fillText("stage.proposal_voided");

/**
 * 回复里写了 activity_done 而这条会话不在做单项活动的工作项时的拒绝：事实与怎么办。position 是这条会话现在在哪里
 * （流程的工作项的某一站，或者空闲）。流程里做完一段不由助手结束：用进入下一段的卡片提议，由用户点。
 */
export function activityDoneRefusal(position: Position): Refusal {
  if (position === IDLE) return refusalText("gate.activity_done_not_single_activity.idle");
  const forward = forwardCardGuidance(position);
  return refusalText("gate.activity_done_not_single_activity", {
    stage: STAGE_NAMES[position], next: forward ? fillText("part.done_forward", { forward }) : fillText("part.done_review"),
  });
}

/** 助手汇报单项活动的工作项做完时，对话里那条回复下面的一行。汇报只是一句话：工作项照旧留着，不改任何记录。 */
export function activityDoneSentence(activity: Stage): string {
  return fillText("stage.activity_done", { activity: STAGE_NAMES[activity] });
}

/** 需求分析从哪个节点启动：有材料从核读材料，没有材料从澄清。 */
export function flowStartNode(hasMaterials: boolean): Stage {
  return hasMaterials ? "reading" : "clarifying";
}

/** 算启动一项活动要的事实。 */
export interface LaunchFacts {
  /** 这条会话现在在哪里：一个阶段，或者空闲。 */
  position: Position;
  /** 这条会话正在做的工作项是不是流程的工作项（空闲时为假）。 */
  inFlow: boolean;
  /** 恒为 null：早先是「首次分析走到的节点」，现在流程的位置记在各个工作项上。 */
  flowNode: Stage | null;
  /** 任务里已有的那个流程的工作项（一个任务至多一个）；没有是 null。有它时不能再以流程方式启动。 */
  flowItem: FlowItemRef | null;
  /** 任务里有没有材料。 */
  hasMaterials: boolean;
  /** 六项活动各自现在缺什么前提，不缺是 null。前提都是数据条件，写在各项活动的定义里（lib/activity_def.ts），由读库的一侧算好交进来。 */
  blocked: Record<Stage, string | null>;
}

/** 任务里已有的那个流程的工作项：记录号、名字（流程的名字）、现在在哪一站。 */
export interface FlowItemRef {
  record_id: number;
  name: string;
  /** 现在在哪一步：活动标识符（早先的记录是阶段键）。 */
  node: string;
}

/** 已有流程的工作项时，流程那一项不能启动，写这一句：在进行的是哪条、在哪一站。 */
export function flowExistsText(item: FlowItemRef, nodeName: string = (STAGE_NAMES as Record<string, string>)[item.node] ?? item.node): string {
  return `已有流程工作项「${item.name}」，位于「${nodeName}」`;
}

/** 可以点的一项：启动哪一项活动、在不在流程里、按钮上的字、现在能不能启动、一句状态（不能启动时写缺什么）。 */
export interface LaunchOption {
  activity: Stage;
  in_flow: boolean;
  label: string;
  enabled: boolean;
  state: string;
}

/**
 * 早先任务状况卡上那一节的内容（新的页面不用它，任务起点页与切换工作面板读活动目录），三组：
 * current 是这条会话正在做的活动（只显示一行，不是按钮；空闲时为 null）；flows 是可以启动的流程（现在只有需求分析）；
 * activities 是可以启动的单项活动（六项）；later 是以后才有的（发布）。
 */
export interface LaunchView {
  current: { activity: Stage; in_flow: boolean; label: string } | null;
  flows: LaunchOption[];
  activities: LaunchOption[];
  later: { label: string; state: string }[];
}

export const LAUNCH_READY = "可以启动";
export const LAUNCH_ACTIVE = "正在进行";
/** 早先：任务正在流程里做这项活动时，单项活动里同名的那一项不能点，后面写这一句。 */
export const LAUNCH_IN_FLOW = "正在工作流程中进行";

export function launchView(facts: LaunchFacts): LaunchView {
  const flow = FLOW_NAMES[FLOW_ANALYSIS];
  const at = facts.position === IDLE ? null : facts.position;
  const current = at === null ? null
    : { activity: at, in_flow: facts.inFlow, label: facts.inFlow ? `继续${flow}：${STAGE_NAMES[at]}` : `继续${STAGE_NAMES[at]}` };
  const node = facts.flowNode ?? flowStartNode(facts.hasMaterials);
  const inFlowNow = at !== null && facts.inFlow;
  const flows: LaunchOption[] = [{
    activity: node, in_flow: true,
    label: facts.flowNode === null ? `启动${flow}` : `继续${flow}（从${STAGE_NAMES[node]}接着）`,
    enabled: !inFlowNow && (facts.flowItem ?? null) === null,
    state: inFlowNow ? LAUNCH_ACTIVE : facts.flowItem ? flowExistsText(facts.flowItem) : facts.flowNode === null ? `从${STAGE_NAMES[node]}开始` : LAUNCH_READY,
  }];
  const activities: LaunchOption[] = STAGES.map((activity) => {
    const active = at === activity && !facts.inFlow;
    // 这条会话正在流程里做这一项：这一行不能点。
    const blocked = at === activity && facts.inFlow ? LAUNCH_IN_FLOW : facts.blocked[activity];
    return { activity, in_flow: false, label: STAGE_NAMES[activity], enabled: !active && blocked === null, state: active ? LAUNCH_ACTIVE : blocked ?? LAUNCH_READY };
  });
  return { current, flows, activities, later: [{ label: "发布", state: "0.6 后续" }] };
}

// ───────────── 每个阶段助手能写什么 ─────────────

/**
 * 助手的一次写入属于哪一类：
 * page 业务说明的页；problem 问题条目；diagram 图；item 别的集合的条目（用例、非功能需求、约束这一类）；
 * review 请求评审；publish 发布版本。
 */
export type WriteKind = "page" | "problem" | "diagram" | "item" | "review" | "publish";
/** 全部写入种类，按这个次序。 */
export const WRITE_KINDS: readonly WriteKind[] = ["page", "problem", "diagram", "item", "review", "publish"];


/** 给定这个位置获准的写入种类，能不能做这一类写入。 */
export function canWrite(allowed: readonly WriteKind[], kind: WriteKind): boolean {
  return allowed.includes(kind);
}

/** 拒绝的原因码与两层文字：事实（现在在哪个阶段、拦下的是什么）与怎么办（这一步要先做什么、谁能移动）。 */
export type Refusal = RefusalText;

const OP_WORDS: Record<string, string> = { add: "新增", update: "修改", delete: "删除" };

/**
 * 编写文档阶段被拦时怎么办：这一段只补写业务说明的文字。要动条目、图或者再评审，得先回到前面的阶段，
 * 回去要由用户决定：助手发卡片提议退回并写明原因，用户点了才退。
 */
function howToLeaveDocument(back: Exclude<Stage, "document">): string {
  return fillText("part.leave_document", { stage: STAGE_NAMES[back], back_card: backCardGuidance(back) });
}

/**
 * 空闲时被拦怎么办的后半句：启动哪一项活动由用户定——从任务起点页启动一个工作项。
 * 空闲时助手能做的与澄清相同：立主题页、改主题页、记问题条目。前半句（这件事要在哪一项活动里做）在各条拒绝语的指引层里。
 */
const howToLeaveIdle = (): string => fillText("part.leave_idle");

/** 还没到写条目时，怎样才能到：这一句写在几种拒绝的「怎么办」里。 */
function howToReachWriting(): string {
  return fillText("part.reach_writing", { start_items: gotoOption("writing", null).text });
}

/**
 * 助手新增、修改或删除别的集合（不是业务说明、也不是问题）的条目：这个位置获准的写入（allowed）里没有 item 就拦。
 * 可以写时返回 null。
 */
export function itemRefusal(stage: Position, allowed: readonly WriteKind[], op: string, collection: string): Refusal | null {
  if (canWrite(allowed, "item")) return null;
  const words = { op: OP_WORDS[op] ?? "写", collection };
  if (stage === IDLE) return refusalText("gate.stage_item_write.idle", { ...words, leave_idle: howToLeaveIdle() });
  if (stage === "document") return refusalText("gate.stage_item_write.document", { ...words, stage: STAGE_NAMES[stage], leave_document: howToLeaveDocument("reviewing") });
  return refusalText("gate.stage_item_write", { ...words, stage: STAGE_NAMES[stage], reach_writing: howToReachWriting() });
}

/**
 * 助手新增、修改或删除业务说明的一页：前四个阶段与空闲时都可以；评审确认阶段只能改「状态」与「改看」两个字段，
 * 不能新立页、不能删页。changed 是修改时这次改动了的字段名。可以写时返回 null。
 */
export function pageRefusal(stage: Position, op: string, changed: readonly string[] = []): Refusal | null {
  if (stage !== "reviewing") return null;
  const common = { stage: STAGE_NAMES[stage], back_card: backCardGuidance("clarifying") };
  if (op === "add") return refusalText("gate.stage_page_write.add", common);
  if (op === "delete") return refusalText("gate.stage_page_write.delete", common);
  const allowed: string[] = [OVERALL_FIELDS.status, OVERALL_FIELDS.seeAlso];
  const others = changed.filter((name) => !allowed.includes(name));
  if (others.length === 0) return null;
  return refusalText("gate.stage_page_write.fields", {
    ...common, status: OVERALL_FIELDS.status, see_also: OVERALL_FIELDS.seeAlso, fields: others.map((name) => `「${name}」`).join("、"),
  });
}

/**
 * 助手新画、修改或删除一张图：整理建模之前的阶段都拦，空闲时也拦。可以时返回 null。
 * 「怎么办」里说的是怎样走到整理建模：往前进入下一段要由用户在卡片上点，助手只能发卡片提议（forwardCardGuidance）。
 */
export function diagramRefusal(stage: Position, allowed: readonly WriteKind[]): Refusal | null {
  if (canWrite(allowed, "diagram")) return null;
  if (stage === IDLE) return refusalText("gate.stage_diagram.idle", { leave_idle: howToLeaveIdle() });
  if (stage === "document") return refusalText("gate.stage_diagram.document", { stage: STAGE_NAMES[stage], leave_document: howToLeaveDocument("modeling") });
  const enterModeling = nextStepOption("modeling").text;
  return stage === "reading"
    ? refusalText("gate.stage_diagram.reading", { stage: STAGE_NAMES[stage], forward: forwardCardGuidance("reading"), enter_modeling: enterModeling })
    : refusalText("gate.stage_diagram", { stage: STAGE_NAMES[stage], forward: forwardCardGuidance("clarifying"), enter_modeling: enterModeling });
}

/** 助手请求评审：写条目之前的阶段都拦，空闲时也拦。可以时返回 null。 */
export function reviewRefusal(stage: Position, allowed: readonly WriteKind[]): Refusal | null {
  if (canWrite(allowed, "review")) return null;
  if (stage === IDLE) return refusalText("gate.stage_review.idle", { leave_idle: howToLeaveIdle() });
  if (stage === "document") return refusalText("gate.stage_review.document", { stage: STAGE_NAMES[stage], leave_document: howToLeaveDocument("reviewing") });
  return refusalText("gate.stage_review", { stage: STAGE_NAMES[stage], reach_writing: howToReachWriting() });
}

/** 助手发布版本：评审确认与编写文档两个阶段可以，空闲时不可以。可以时返回 null。 */
export function publishRefusal(stage: Position, allowed: readonly WriteKind[]): Refusal | null {
  if (canWrite(allowed, "publish")) return null;
  if (stage === IDLE) return refusalText("gate.stage_publish.idle", { leave_idle: howToLeaveIdle() });
  return stage === "writing"
    ? refusalText("gate.stage_publish.writing", { stage: STAGE_NAMES[stage], enter_reviewing: nextStepOption("reviewing").text, forward: forwardCardGuidance("writing") })
    : refusalText("gate.stage_publish", { stage: STAGE_NAMES[stage], reach_writing: howToReachWriting() });
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
/** 问题种类里的「缺失」：该有的内容材料没写、用户也答不上。按分析提纲画的目录据它分出「缺失」与还开着的缺口（web/src/model/outlineTree.ts）。 */
export const QUESTION_KIND_MISSING = "缺失";
/** 要在澄清时逐条问用户的问题种类：待澄清，以及核读时记下的冲突与缺失。 */
export const QUESTION_KINDS_TO_CLARIFY: readonly string[] = [QUESTION_KIND_CLARIFY, "冲突", QUESTION_KIND_MISSING];
/** 一条问题条目的种类算不算要澄清的：没有写种类（集合没有这个字段，或早先的条目）的也算。 */
export function clarifyKind(kind: unknown): boolean {
  return kind === undefined || kind === null || QUESTION_KINDS_TO_CLARIFY.includes(String(kind));
}
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

/** 算灯要的一个条目（业务说明以外的集合里的，含问题条目）。 */
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
  /** 用户看没看过它现在的内容。算灯不用，数需求资产的现状用（lib/activity_catalog.ts）；没有给当作没看过。 */
  viewed?: boolean;
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
  /** 「种类」写的什么；没有写（或集合没有这个字段）是 null。只用来报数。没有给当作 null。 */
  kind?: string | null;
}

/**
 * 一份材料被引用的情况（只用来报数）：Word 与 PDF 材料按分段清单的块数，几块里有被引用的段落；文本材料没有块，只有被引用几处。
 */
export interface MaterialCoverage {
  path: string;
  /** 分段清单里的块数；文本材料、或者清单读不到时是 null。 */
  blocks: number | null;
  /** 有被引用的段落（或页内的块）的块数；blocks 为 null 时也是 null。 */
  cited_blocks: number | null;
  /** 文本材料被引用的条数（「文档原文」来源的条数）；Word 与 PDF 材料是 0，看块数。 */
  citations: number;
}

/** 算灯要的全部事实。助手一侧与后端各自从任务库里读出来填，算法只在这里。 */
export interface LampInput {
  /** 业务说明的全部页，含已废弃的。 */
  pages: LampPage[];
  /** 业务说明以外各集合的条目，含问题条目。 */
  items: LampItem[];
  questions: LampQuestion[];
  /** 任务定义里的集合名。 */
  collections: string[];
  /** 材料清单里不是由别的文件生成的文件，写它在任务目录里的路径（例如 inputs/需求.md）。 */
  materials: string[];
  /** 上面这些材料按放进的槽位（工作流声明里的槽位键）各几份；不经槽位上传的不计入任何键。没有给时当作空的。 */
  materialsBySlot?: Record<string, number>;
  /** 业务说明的页与问题条目当前修订上「文档原文」来源的出处，原样（可以带 # 后面的位置）。 */
  citedDocuments: string[];
  /** 任务里还在的图。 */
  diagrams: LampDiagram[];
  /** 还没有了结的规则冲突：规则表（lib/overall_views.ts 的 rulesTable）里标出的那几条问题条目的编号。 */
  ruleConflicts: string[];
  /** 评审：当前修订在当前规则下评审不合规、又没有保留写法的条目；任务里有没有过评审记录；评审过几轮（算灯不用，没有给时有过记录当作一轮）。 */
  review: { failing: string[]; any: boolean; rounds?: number };
  /** 完成条件：是不是全部满足；没满足的各条的说明。 */
  completion: { satisfied: boolean; unmet: string[] };
  /**
   * 任务定义里有没有声明这两个字段：业务说明的「导语所属章」、问题集合的「是否阻断下游」。早先建的任务的定义里没有，
   * 与它们有关的灯是不适用。没有给当作都没有。
   */
  declared?: { intro: boolean; blocking: boolean };
  /** 发过几版（版本记录的行数）；没有给当作没有发布过。 */
  versions?: number;
  /** 每份材料被引用的情况，按 materials 的次序（核读材料那一盏只报数时用）；没有给时按 citedDocuments 只报有没有被引用。 */
  coverage?: MaterialCoverage[];
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
    open: fields[statusField] === QUESTION_OPEN_STATUS && clarifyKind(kind),
    related: texts(fields[QUESTION_RELATED_FIELD]),
    unresolved: fields[statusField] === QUESTION_OPEN_STATUS, blocking: fields[QUESTION_BLOCKING_FIELD] === QUESTION_BLOCKING,
    kind: typeof kind === "string" && kind.trim() !== "" ? kind.trim() : null,
  };
}

const list = (ids: readonly string[]) => ids.join("、");

/**
 * 只报数、不判的灯：ok 恒为 null（页面上灰色），summary 是报的数；「还差几项」不算它们，进入下一步的卡片也不看它们。
 */
export const REPORT_ONLY_LAMPS: ReadonlySet<string> = new Set(["materials_cited"]);

/** 按出现的先后数一组名字，写成「甲 3、乙 1」。 */
function tally(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const one of names) counts.set(one, (counts.get(one) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${name} ${n}`).join("、");
}

/** 核读材料那一盏报的数：各份材料被引用的块数与没有被引用的块数，页数按 OVERALL_FIELDS.tags 分，OVERALL_FIELDS.examples 的总项数，问题条目按种类分。 */
function readingReport(input: LampInput, live: readonly LampPage[]): string {
  const { tags, examples } = OVERALL_FIELDS;
  const cited = new Set(input.citedDocuments.map((one) => one.split("#")[0]));
  const coverage = new Map((input.coverage ?? []).map((one) => [one.path, one]));
  const materials = input.materials.length === 0 ? "任务里没有材料。" : `材料 ${input.materials.length} 份：${input.materials.map((path) => {
    const one = coverage.get(path);
    if (one && one.blocks !== null && one.cited_blocks !== null) return `${path} 共 ${one.blocks} 块，${one.cited_blocks} 块有引用、${one.blocks - one.cited_blocks} 块没有`;
    if (one) return `${path} 被引用 ${one.citations} 处`;
    return `${path} ${cited.has(path) ? "有引用" : "没有引用"}`;
  }).join("；")}。`;
  const untagged = live.filter((one) => one.tags.length === 0).length;
  const byTag = tally(live.flatMap((one) => one.tags));
  const pages = `页 ${live.length} 页${live.length > 0 ? `（按${tags}：${byTag || "无"}${untagged > 0 ? `；没贴${tags}的 ${untagged} 页` : ""}）` : ""}，${examples}共 ${live.reduce((sum, one) => sum + one.examples.length, 0)} 项。`;
  const kinds = tally(input.questions.map((one) => one.kind ?? "没写种类"));
  const questions = `问题条目 ${input.questions.length} 条${kinds ? `（${kinds}）` : ""}。`;
  return `只报数、不判：${materials}${pages}${questions}`;
}
const lamp = (key: string, ok: boolean | null, summary: string, items: string[] = []): Lamp => ({ key, summary, ok, items });

/** 每个阶段的几盏灯，六个阶段都算。 */
export function stageLamps(input: LampInput): Record<Stage, Lamp[]> {
  const live = input.pages.filter((one) => !one.deprecated);
  const byId = new Map(input.pages.map((one) => [one.item_id, one]));
  const tagged = (tag: string) => live.filter((one) => one.tags.includes(tag));
  const others = input.items;

  // 核读材料：只报数、不判（REPORT_ONLY_LAMPS），ok 恒为 null。读完没有、读透没有，程序判不了，所以只把数摆出来。
  const materialsCited = lamp("materials_cited", null, readingReport(input, live));

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
  const noDuplicates = live.length === 0 ? lamp("no_duplicate_titles", null, "业务说明里还没有主题。")
    : clashes.length === 0 ? lamp("no_duplicate_titles", true, "没有两页主题的标题或别名相同。")
      : lamp("no_duplicate_titles", false,
        `有 ${clashes.length} 个标题或别名被两页以上的主题用了：${clashes.map(([word, ids]) => `「${word}」（${list(ids)}）`).join("、")}。`, clashing);

  // 整理建模：没有未归类的页。用户明说先不归类的，程序认不出，只看标签。
  // 导语页不贴标签，不算没归类。
  const loose = live.filter((one) => one.tags.length === 0 && !one.intro);
  const noUntagged = live.length === 0 ? lamp("no_untagged_pages", null, "业务说明里还没有主题。")
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

  // 写条目：没有待核实的需求条目。问题条目不算：它记的是没定的事，助手补写的来源不让它成为待核实的需求。
  const questionIds = new Set(input.questions.map((one) => one.item_id));
  const requirements = others.filter((one) => !questionIds.has(one.item_id));
  const pending = requirements.filter((one) => one.pending);
  const noPending = requirements.length === 0 ? lamp("no_pending_items", null, "还没有需求条目。")
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
  const chaptersIntro = !input.declared?.intro ? lamp("chapters_have_intro", null, "任务定义的业务说明里没有「导语所属章」这个字段。")
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
  const reports = lamps.filter((one) => REPORT_ONLY_LAMPS.has(one.key)).map((one) => `  - ${one.summary}`);
  const judged = lamps.filter((one) => !REPORT_ONLY_LAMPS.has(one.key));
  const missing = judged.filter((one) => one.ok === false);
  const head = missing.length > 0 ? [`${STAGE_NAMES[stage]}这一段还差 ${missing.length} 项：`, ...missing.map((one) => `  - ${one.summary}`)]
    : judged.length > 0 || reports.length === 0 ? [`${STAGE_NAMES[stage]}这一段的几项都齐了。`] : [];
  return reports.length === 0 ? head : [...head, `${STAGE_NAMES[stage]}这一段只报数、不判是否做够：`, ...reports];
}
