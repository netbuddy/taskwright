/**
 * 任务状况：任务现在做到哪里了，由程序据任务记录算出来，不经模型。任务起点页、切换工作面板与对话区的卡片用它。
 *
 * 只读，全部取自整份数据已经算好的东西（library.taskSnapshot）与工作项的清单（library.workItemRows）：有哪些工作项、总体分析的页按章归类的节数、
 * 还没有了结的待澄清问题数、图按种类的张数、各集合的条目数与用户看过的条数、需求资产六类的现状、活动目录。
 * 章的归法与页面目录用的是同一个函数（agent/src/lib/overall_chapters.ts）。
 *
 * work_items 是进行中的工作项，按启动的先后；recent_done 是已经结束的，最近结束的在前，最多 RECENT_DONE_LIMIT 个。每个工作项：
 * record_id（记录号）、kind（flow 是流程的工作项，activity 是单项活动的）、name（流程或活动的名字）、activity 与 activity_name（现在做的那项活动）、
 * node（流程的工作项现在在哪一站，单项活动的为 null）、ordinal（那一站是第几站）、flow、scope（范围说明）、status、started_at、ended_at、
 * session_ids 与 session_count（属于它的会话）、latest_session（最近有动静的那条会话：编号、名字、最近活动的时刻；一条都没有时为 null）、
 * last_active_at（最近动静的时刻）、session_name（现在给它新建一条会话时起的名字）。
 * 一个任务可以同时有几个进行中的工作项，任务一级没有「当前活动」。
 *
 * activity、missing、proposal 三项说的是一条会话：请求里给了会话编号（session）时是那条会话的，不给时按自由讨论的会话算。activity 有三种：
 * - 这条会话正在做流程的工作项：kind 是 stage，key 是所在那一站的写法，ordinal 是第几站，flow 是所属流程（initial）。
 * - 这条会话正在做单项活动的工作项：kind 是 activity，key 与 name 是那项活动的，ordinal 与 flow 为 null；missing 照那项活动的灯。
 * - 这条会话空闲（自由讨论的会话，或者它的工作项已经结束）：kind 与 key 都是 idle，name 是「空闲」，ordinal 与谁、什么时候、为什么三项为 null，
 *   missing 是空的（空闲没有自己的灯）。
 * launch 是早先任务状况卡上那一节的内容（agent/src/lib/stage.ts 的 LaunchView），留给还读它的页面，以后去掉。
 * 任务不在进行中时 launch 为 null。versions 留给已发布的文档版本，现在没有这种记录，恒为空列表。
 * assets 是需求资产六类的现状，六格，每格 { key, name, count, unit, text, note, produced_by }（agent/src/lib/activity_catalog.ts 的 AssetCell）。
 * catalog 是任务起点页的活动目录：flows 两条工作流程与 activities 七项单项活动，文字取自活动与流程的定义文件开头的头
 * （agent/prompts/stages/、agent/prompts/flows/），各带现在能不能启动（enabled）、一句状态（state）与进行中的工作项个数（active_count）；
 * 能不能启动只看数据，已经有进行中的工作项不拦。任务不在进行中、或者定义读不出来时 catalog 为 null。
 * start_page 是任务起点页与活动输入页上的几段文字（startPageTexts）：一段定位的话、「三步开始」主按钮下面的一句、三种常见起点各一张小卡、
 * 首次编制时输入页上的几段（intake）。
 * 现在都是这里给的缺省文字，照需求规格说明这一类任务写；以后由任务类型的定义给。
 * 没有阶段的任务（任务定义里没有「总体分析」集合）没有状况，返回 null。
 */

import { CHAPTERS, chapterLayout, chapterPage } from "../../agent/src/lib/overall_chapters.ts";
import { OVERALL_COLLECTION } from "../../agent/src/lib/overall_analysis.ts";
import { IDLE, IDLE_NAME, type Position, QUESTION_KEEP_STATUS, QUESTION_KIND_CLARIFY, STAGES, STAGE_NAMES } from "../../agent/src/lib/stage.ts";
import * as clock from "./clock.ts";
import * as library from "./library.ts";

/**
 * 任务起点页与活动输入页上的几段文字。lead 是任务名下面那一段定位的话；guide_note 是「三步开始」主按钮下面的一句；
 * cases 是三种常见起点，每种一个标题、一句做法，以及点了它进输入页时先看哪一块（focus：materials 是项目材料，description 是目标系统描述）。
 * intake 是首次编制时输入页上的几段：lead 是三块输入上面的一段话；material_kinds 是适合上传的几类文件；describe_note、
 * describe_placeholder、describe_examples 是目标系统描述那一块的说明、文本框里的提示与点了就填进去的示例；
 * after 是「启动后」一块里有材料与没有材料两种情形各一句。
 */
export function startPageTexts(taskName: string) {
  return {
    lead: `本任务用于编制并持续维护「${taskName}」的需求规格说明。所有工作围绕同一套需求资产进行；每启动一个工作项，资产即得到补充或修正。`,
    guide_note: "预计首轮产出：业务说明初稿与待澄清问题清单",
    cases: [
      { title: "有调研材料", text: "上传会议记录、现行制度、旧系统说明；助手核读后立章节并逐句引用。", focus: "materials" },
      { title: "只有口头想法", text: "用三句话描述建设什么系统、服务哪些用户、解决什么问题；助手复述理解后逐项提问。", focus: "description" },
      { title: "已有旧版规格说明", text: "把旧文档作为材料上传；助手按新结构重新组织，差异之处记为问题。", focus: "materials" },
    ],
    intake: {
      lead: "项目材料与目标系统描述至少提供一项。材料越完整，助手的初稿越接近实际业务；没有材料时，由目标系统描述开始，助手通过提问逐步建立业务说明。",
      material_kinds: ["需求调研记录、访谈纪要", "现行制度、业务规则、办法", "旧系统说明、旧版规格说明", "表单、报表、单据样例"],
      describe_note: "说明三点：建设什么系统、服务哪些用户、解决什么问题。助手将先复述其理解供你核对，再逐项提问。不必写功能清单，功能由助手从业务流程推导。",
      describe_placeholder: "建设什么系统、服务哪些用户、解决什么问题……",
      describe_examples: [
        "建设图书馆借阅管理系统，服务读者与管理员，覆盖借书、还书、续借、预约与逾期处理。",
        "现行借阅依靠人工登记，拟改为系统管理，并支持逾期提醒与到期前通知。",
        "系统面向高校图书馆，读者分教师与学生两类，借阅上限与借期不同；采购编目不在范围内。",
      ],
      after: [
        "有材料：助手核读材料，按角色、业务流程、业务对象立章节，列出待澄清问题，完成后在对话区汇报并提议进入「澄清」。",
        "无材料：助手依据描述复述理解，进入「澄清」逐项提问。",
      ],
    },
  };
}

/** 已经结束的工作项最多列几个。 */
export const RECENT_DONE_LIMIT = 10;

/** 会话清单里算工作项最近动静要的几样（executor.listSessions() 的行）。 */
export interface SessionFact {
  session_id: string;
  name?: string | null;
  last_active_at?: string | null;
}

/** 一个工作项给页面的样子：见文件头。sessions 是任务的会话清单，用来找属于它的会话里最近有动静的那一条。 */
export function workItemView(row: library.WorkItemRow, sessions: readonly SessionFact[]) {
  const own = row.session_ids.map((id) => sessions.find((one) => one.session_id === id) ?? { session_id: id, name: null, last_active_at: null });
  // 最近有动静的那一条；都还没有说过话时取最后挂上的那一条。
  const active = own.filter((one) => one.last_active_at).sort((a, b) => String(b.last_active_at).localeCompare(String(a.last_active_at)))[0] ?? null;
  const latest = active ?? own.at(-1) ?? null;
  const node = row.kind === "flow" ? row.activity : null;
  return {
    record_id: row.record_id, kind: row.kind, name: row.name, activity: row.activity, activity_name: STAGE_NAMES[row.activity] ?? String(row.activity),
    node, ordinal: node === null ? null : STAGES.indexOf(node) + 1, flow: row.flow, scope: row.scope, status: row.status,
    started_at: clock.fromLocalText(row.started_at), ended_at: clock.fromLocalText(row.ended_at),
    session_ids: row.session_ids, session_count: row.session_ids.length,
    latest_session: latest === null ? null : { session_id: latest.session_id, name: latest.name ?? null, last_active_at: latest.last_active_at ?? null },
    last_active_at: active?.last_active_at ?? null, session_name: row.session_name,
  };
}

/**
 * 任务状况。sessionId 是为哪条会话取 activity、missing、proposal 三项（不给按自由讨论的会话算）；sessions 是任务的会话清单，
 * 用来写每个工作项最近有动静的会话，不给时这几项为空。
 */
export function taskStatus(taskDir: string, sessionId: string | null = null, sessions: readonly SessionFact[] = []) {
  const [, view] = library.taskSnapshot(taskDir, null, sessionId);
  if (view === null || view.stage === null) return null;
  const stage = view.stage;
  const current = stage.current as Position;

  // 业务说明：总体分析的页按标签归章；每章数在用的节，未归类的数在用的页。
  const pages = view.items.filter((one) => one.collection === OVERALL_COLLECTION);
  const layout = chapterLayout(pages.map((one) => chapterPage(one.item_id, one.fields)));
  const chapters = layout.chapters
    .map((one) => ({ no: one.chapter.no, name: one.chapter.name, sections: one.sections.filter((section) => section.no !== null).length }))
    .filter((one) => one.sections > 0);
  const unsorted = layout.unsorted.filter((one) => !one.deprecated).length;
  // 待澄清：决策记录与待澄清事项那张表里还没有了结的问题；问题集合没有「种类」字段时都算。
  const openQuestions = (view.overall_views?.decisions ?? [])
    .filter((row) => row.entry === "question" && (row.question_kind === null || row.question_kind === QUESTION_KIND_CLARIFY)).length;

  // 模型：还在的图按种类数张数，种类照它第一次出现的先后。
  const models: { kind: string; name: string; count: number }[] = [];
  for (const diagram of view.diagrams) {
    const found = models.find((one) => one.kind === diagram.kind);
    if (found) found.count += 1;
    else models.push({ kind: diagram.kind, name: diagram.kind_name, count: 1 });
  }

  // 需求条目：总体分析与问题之外的每个集合。问题集合认的是状态字段的取值里有「用户决定保留」的集合。
  const isQuestions = (collection: { fields: { values: unknown }[] }) =>
    collection.fields.some((field) => Array.isArray(field.values) && field.values.includes(QUESTION_KEEP_STATUS));
  const items = view.definition.collections
    .filter((collection) => collection.name !== OVERALL_COLLECTION && !isQuestions(collection))
    .map((collection) => {
      const own = view.items.filter((one) => one.collection === collection.name);
      // viewed：用户看过现在这一版的条数（有过接受的标记，而且没有因为后来的改动失效）。
      return { collection: collection.name, total: own.length, viewed: own.filter((one) => one.viewed && !one.confirmation_stale).length };
    });

  return {
    generated_at: clock.now(),
    activity: current === IDLE
      ? { kind: "idle" as const, key: current, name: IDLE_NAME, ordinal: null, flow: stage.flow, moved_by: null, moved_at: null, reason: null }
      : stage.node === null
        ? { kind: "activity" as const, key: current, name: STAGE_NAMES[current] ?? String(current), ordinal: null, flow: null,
          moved_by: stage.moved_by, moved_at: stage.moved_at, reason: stage.reason }
        : { kind: "stage" as const, key: current, name: STAGE_NAMES[current] ?? String(current), ordinal: STAGES.indexOf(current) + 1, flow: stage.flow,
          moved_by: stage.moved_by, moved_at: stage.moved_at, reason: stage.reason },
    description: { sections: chapters.reduce((sum, one) => sum + one.sections, 0) + unsorted, chapters, unsorted, open_questions: openQuestions },
    models,
    items,
    // 这一段还差什么：现在这个阶段没有通过的灯，原句照灯的整句。
    missing: (current === IDLE ? [] : stage.lamps[current] ?? []).filter((lamp) => lamp.ok === false).map((lamp) => ({ key: lamp.key, summary: lamp.summary })),
    proposal: stage.proposal,
    work_items: workItemViews(taskDir, sessions).filter((one) => one.status === "active"),
    recent_done: workItemViews(taskDir, sessions).filter((one) => one.status !== "active")
      .sort((a, b) => String(b.ended_at ?? "").localeCompare(String(a.ended_at ?? ""))).slice(0, RECENT_DONE_LIMIT),
    launch: view.status === "进行中" ? stage.launch : null,
    assets: stage.assets,
    catalog: view.status === "进行中" ? stage.catalog : null,
    start_page: startPageTexts(view.task_name),
    versions: [] as unknown[],
  };
}

/** 任务的全部工作项给页面的样子，按启动的先后。 */
function workItemViews(taskDir: string, sessions: readonly SessionFact[]) {
  return library.workItemRows(taskDir).map((row) => workItemView(row, sessions));
}

/** 七章的章号与章名，按先后：页面要列出全部的章时用。 */
export const CHAPTER_NAMES = CHAPTERS.map((one) => ({ no: one.no, name: one.name }));
