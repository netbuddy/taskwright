/**
 * 工作的阶段：任务定义里有「总体分析」集合的任务，工作分五个阶段——核读材料、澄清、整理建模、写条目、评审确认。
 * 阶段由用户或助手的动作移动，每次移动留一条记录；助手每次调用写入工具时能写什么，由最近一条记录决定。
 *
 * 本文件只放不读库的东西：五个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话、
 * 提议进入写条目的那张卡片的两个选项。读写库的在 lib/stage_read.ts。
 *
 * 早先建的任务（任务定义里没有「总体分析」集合）没有阶段，这里的一切对它们都不生效；判据是 overall_analysis.ts 的 hasOverall。
 *
 * 本文件除了 overall_analysis.ts 不导入别的模块：助手的工具、后端的快照都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

import { OVERALL_FIELDS } from "./overall_analysis.ts";

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

/** 提议进入写条目的那张请选择卡片的两个选项：键与文字都是固定的。用户点了「开始写条目」，系统替用户记一次移动。 */
export const START_ITEMS_KEY = "start_items";
export const START_ITEMS_TEXT = "开始写条目";
export const CONTINUE_CLARIFY_KEY = "continue_clarify";
export const CONTINUE_CLARIFY_TEXT = "继续澄清";

/** 助手想进入写条目时告诉它怎么办的那一句。 */
export const PROPOSE_WRITING_GUIDANCE =
  `请用请选择卡片提议，两个选项的键与文字是 ${START_ITEMS_KEY}「${START_ITEMS_TEXT}」、${CONTINUE_CLARIFY_KEY}「${CONTINUE_CLARIFY_TEXT}」`;

/**
 * 一次移动行不行。
 * - same：目标就是现在所在的阶段，原地不动不算移动，不记。
 * - user_only：进入写条目要由用户决定，助手在前面哪个阶段都只能提议。
 * - skip：除此之外助手往后一次只能移一段（核读材料到澄清、澄清到整理建模、写条目到评审确认）；评审确认要先经过写条目。
 * 用户的移动不设限；助手可以从任何阶段退回它前面的任何阶段。
 */
export type MoveVerdict = { ok: true } | { ok: false; why: "same" | "user_only" | "skip" };

export function judgeMove(from: Stage, to: Stage, actor: StageActor): MoveVerdict {
  if (from === to) return { ok: false, why: "same" };
  if (actor === "user") return { ok: true };
  const at = STAGES.indexOf(from);
  const goal = STAGES.indexOf(to);
  if (goal < at) return { ok: true };
  if (to === "writing") return { ok: false, why: "user_only" };
  if (goal > at + 1) return { ok: false, why: "skip" };
  return { ok: true };
}

/** 助手在回复里写了 stage 之后，工具返回里说明结果的那一句（接在「回复已送达。」后面）。 */
export function moveText(from: Stage, to: Stage, verdict: MoveVerdict): string {
  if (verdict.ok) return `任务已从${STAGE_NAMES[from]}移到${STAGE_NAMES[to]}。`;
  if (verdict.why === "same") return `任务本来就在${STAGE_NAMES[from]}阶段，没有记移动。`;
  if (verdict.why === "user_only") return `阶段没有移动：进入写条目要由用户决定。${PROPOSE_WRITING_GUIDANCE}。`;
  const next = STAGES[STAGES.indexOf(from) + 1];
  if (next === "writing" || to === "reviewing") {
    return `阶段没有移动：任务现在在${STAGE_NAMES[from]}阶段，评审确认要先经过写条目，进入写条目要由用户决定。${PROPOSE_WRITING_GUIDANCE}。`;
  }
  return `阶段没有移动：任务现在在${STAGE_NAMES[from]}阶段，一次只能往后移一段，请先移到${STAGE_NAMES[next]}。`;
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
function howToReachWriting(stage: Stage): string {
  return `进入写条目要由用户在卡片上选「${START_ITEMS_TEXT}」：你可以先立页、请用户看，觉得理解够了就用请选择卡片提议` +
    (stage === "reading" ? "（现在还在核读材料，读完先在回复里移到澄清）" : "");
}

/**
 * 助手新增、修改或删除别的集合（不是总体分析、也不是问题）的条目：写条目之前的阶段都拦。
 * 可以写时返回 null。
 */
export function itemRefusal(stage: Stage, op: string, collection: string): Refusal | null {
  if (canWrite(stage, "item")) return null;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能${OP_WORDS[op] ?? "写"}「${collection}」的条目`,
    `「${collection}」的条目要到写条目阶段才能写。${howToReachWriting(stage)}`,
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

/** 助手新画、修改或删除一张图：整理建模之前的阶段都拦。可以时返回 null。 */
export function diagramRefusal(stage: Stage): Refusal | null {
  if (canWrite(stage, "diagram")) return null;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，这个阶段不能画图、改图或删图`,
    stage === "reading"
      ? "图要到整理建模阶段才能画。材料读完先在回复里把任务移到澄清，澄清告一段落之后再移到整理建模"
      : "图要到整理建模阶段才能画。澄清告一段落之后，在回复里把任务移到整理建模",
  ];
}

/** 助手请求评审：写条目之前的阶段都拦。可以时返回 null。 */
export function reviewRefusal(stage: Stage): Refusal | null {
  if (canWrite(stage, "review")) return null;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，评审要到写条目阶段才能请求`,
    `条目写出来之后再评审。${howToReachWriting(stage)}`,
  ];
}

/** 助手完成任务：只有评审确认阶段可以。可以时返回 null。 */
export function completeRefusal(stage: Stage): Refusal | null {
  if (canWrite(stage, "complete")) return null;
  return [
    `任务现在在${STAGE_NAMES[stage]}阶段，完成任务要在评审确认阶段`,
    stage === "writing"
      ? "条目写完之后，在回复里把任务移到评审确认，再完成任务"
      : `要先写条目、再移到评审确认，才能完成任务。${howToReachWriting(stage)}`,
  ];
}
