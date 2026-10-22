/**
 * 任务状况：任务现在做到哪里了，由程序据任务记录算出来，不经模型。任务起点页、切换工作面板与对话区的卡片用它。
 *
 * 只读，全部取自整份数据已经算好的东西（library.taskSnapshot）与工作项的清单（library.workItemRows）：有哪些工作项、业务说明的页按章归类的节数、
 * 还没有了结的待澄清问题数、图按种类的张数、各集合的条目数与用户看过的条数、需求资产六类的现状、活动目录。
 * 章的归法与页面目录用的是同一个函数（agent/src/lib/overall_chapters.ts）。
 *
 * work_items 是任务的全部工作项（工作项没有终点，不要了由用户删除），按最近有动静的时刻倒序：取属于它的会话里最近一次活动的时刻，
 * 一条会话都还没有说过话的按启动的时刻。每个工作项：
 * record_id（记录号）、kind（flow 是流程的工作项，activity 是单项活动的）、name（流程或活动的名字）、activity 与 activity_name（现在做的那项活动）、
 * node（流程的工作项现在在哪一站，单项活动的为 null）、ordinal（那一站在所属流程各站里是第几站）、flow、scope（范围说明）、started_at、
 * session_ids 与 session_count（属于它的会话）、latest_session（最近有动静的那条会话：编号、名字、最近活动的时刻；一条都没有时为 null）、
 * last_active_at（最近动静的时刻）、session_name（现在给它新建一条会话时起的名字）。
 * 会话只算还在的：归档的会话（工作项被删除时随之归档）本来就不再属于工作项；会话文件不存在的（新建之后一句话都没有说就换走了，
 * 助手运行时不保留这种会话）也略去。
 * 一个任务可以同时有几个工作项，其中流程的工作项至多一个；任务一级没有「当前活动」。
 *
 * activity、missing、proposal 三项说的是一条会话：请求里给了会话编号（session）时是那条会话的，不给时按自由讨论的会话算。activity 有三种：
 * - 这条会话正在做流程的工作项：kind 是 stage，key 是所在那一站的活动标识符，ordinal 是在所属流程各站里第几站，flow 是所属流程的键。
 * - 这条会话正在做单项活动的工作项：kind 是 activity，key 与 name 是那项活动的，ordinal 与 flow 为 null；missing 照那项活动算作的阶段的灯。
 * 名字与第几站取自任务类型的声明（活动与流程的 name、流程的 steps），声明里没有时按阶段的名字与先后。
 * - 这条会话空闲（自由讨论的会话，或者归档的会话）：kind 与 key 都是 idle，name 是「空闲」，ordinal 与谁、什么时候、为什么三项为 null，
 *   missing 是空的（空闲没有自己的灯）。
 * launch 是早先任务状况卡上那一节的内容（agent/src/lib/stage.ts 的 LaunchView），留给还读它的页面，以后去掉。
 * versions 是发布过的各版（library.versionView），没有发布过是空列表。
 * assets 是需求资产六类的现状，六格，每格 { key, name, count, unit, text, note, produced_by }（agent/src/lib/activity_catalog.ts 的 AssetCell）。
 * catalog 是任务起点页的活动目录：flows 是任务类型声明的全部工作流程（各带处境 cases），activities 是声明的全部活动，文字取自活动与流程的定义文件开头的头
 * （任务 skill 目录里的 activities/ 与 flows/，没有就读产品自带的，见 agent/src/lib/activity_def_read.ts），各带现在能不能启动（enabled）、一句状态（state）与工作项个数（active_count）；
 * 单项活动能不能启动只看数据，已经有工作项不拦；流程另带 work_item（任务里已有的流程工作项），有它时流程不能启动。
 * 定义读不出来时 catalog 为 null。
 * start_page 是任务起点页与活动输入页上的几段文字（startPageTexts）：一段定位的话、从头编制时输入页上的几段（intake）。
 * 现在都是这里给的缺省文字，照需求规格说明这一类任务写；以后由任务类型的定义给。
 * versions 是任务的版本记录，按版本号从小到大，每项见 versionView。
 * 没有阶段的任务（任务定义里没有「业务说明」集合）没有状况，返回 null。
 */

import { CHAPTERS, chapterLayout, chapterPage } from "../../agent/src/lib/overall_chapters.ts";
import { OVERALL_COLLECTION } from "../../agent/src/lib/overall_analysis.ts";
import { type Definitions, activityNameOf } from "../../agent/src/lib/activity_def_read.ts";
import { IDLE, IDLE_NAME, type Position, QUESTION_KEEP_STATUS, STAGES, clarifyKind } from "../../agent/src/lib/stage.ts";
import * as clock from "./clock.ts";
import * as library from "./library.ts";
import { fillText } from "../../agent/src/lib/texts.ts";

/**
 * 任务起点页与活动输入页上的几段文字。lead 是任务名下面那一段定位的话（常见起点已并入流程卡：处境写在流程声明的 cases 一栏）。
 * intake 是从头编制时输入页上的几段：lead 是三块输入上面的一段话；material_kinds 是适合上传的几类文件；describe_note、
 * describe_placeholder、describe_examples 是目标系统描述那一块的说明、文本框里的提示与点了就填进去的示例；
 * after 是「启动后」一块里有材料与没有材料两种情形各一句。
 */
export function startPageTexts(taskName: string) {
  return {
    lead: fillText("status_page.lead", { task: taskName }),
    intake: {
      lead: fillText("status_page.intake_lead"),
      material_kinds: [fillText("status_page.material_kind_1"), fillText("status_page.material_kind_2"), fillText("status_page.material_kind_3"), fillText("status_page.material_kind_4")],
      describe_note: fillText("status_page.describe_note"),
      describe_placeholder: fillText("status_page.describe_placeholder"),
      describe_examples: [fillText("status_page.describe_example_1"), fillText("status_page.describe_example_2"), fillText("status_page.describe_example_3")],
      after: [fillText("status_page.after_materials"), fillText("status_page.after_description")],
    },
  };
}

/** 会话清单里算工作项最近动静要的几样（executor.listSessions() 的行）。 */
export interface SessionFact {
  session_id: string;
  name?: string | null;
  last_active_at?: string | null;
}

/** 流程的一站是第几站（从 1 数）：在这条流程声明的各步里的位置；不在里面（或者没有声明）时按六个阶段的先后，也不是阶段时为 null。 */
export function stationOrdinal(defs: Definitions | null, flow: string | null, node: string): number | null {
  const steps = defs?.flows.find((one) => one.key === flow)?.steps ?? [];
  const at = steps.indexOf(node);
  if (at >= 0) return at + 1;
  const stage = (STAGES as readonly string[]).indexOf(node);
  return stage >= 0 ? stage + 1 : null;
}

/**
 * 一个工作项给页面的样子：见文件头。sessions 是任务的会话清单（会话文件还在的那些），用来找属于它的会话里最近有动静的那一条，
 * 也用来略去会话文件不存在的会话；不给（null）时不知道哪些还在，全部算上。
 */
export function workItemView(row: library.WorkItemRow, sessions: readonly SessionFact[] | null, defs: Definitions | null = null) {
  const known = sessions ?? [];
  const ids = sessions === null ? row.session_ids : row.session_ids.filter((id) => known.some((one) => one.session_id === id));
  const own = ids.map((id) => known.find((one) => one.session_id === id) ?? { session_id: id, name: null, last_active_at: null });
  // 最近有动静的那一条；都还没有说过话时取最后挂上的那一条。
  const active = own.filter((one) => one.last_active_at).sort((a, b) => String(b.last_active_at).localeCompare(String(a.last_active_at)))[0] ?? null;
  const latest = active ?? own.at(-1) ?? null;
  const node = row.kind === "flow" ? row.activity : null;
  return {
    record_id: row.record_id, kind: row.kind, name: row.name, activity: row.activity, activity_name: activityNameOf(defs, row.activity),
    node, ordinal: node === null ? null : stationOrdinal(defs, row.flow, node), flow: row.flow, scope: row.scope,
    started_at: clock.fromLocalText(row.started_at),
    session_ids: ids, session_count: ids.length,
    latest_session: latest === null ? null : { session_id: latest.session_id, name: latest.name ?? null, last_active_at: latest.last_active_at ?? null },
    last_active_at: active?.last_active_at ?? null, session_name: row.session_name,
  };
}

/**
 * 任务状况。sessionId 是为哪条会话取 activity、missing、proposal 三项（不给按自由讨论的会话算）；sessions 是任务的会话清单
 * （会话文件还在的那些），用来写每个工作项最近有动静的会话、略去不存在的会话；不给时这几项为空，会话一条都不略。
 */
export function taskStatus(taskDir: string, sessionId: string | null = null, sessions: readonly SessionFact[] | null = null) {
  const [, view] = library.taskSnapshot(taskDir, null, sessionId);
  if (view === null || view.stage === null) return null;
  const stage = view.stage;
  const current = stage.current as Position;
  const defs = library.taskDefinitions(taskDir);
  // 这条会话在做的那项活动的键：流程的工作项是所在的一站，单项活动的是那项活动；current 是它算作的阶段（逆向解析算作核读）。
  const key = stage.node ?? stage.work_item?.activity ?? current;

  // 业务说明：业务说明的页按标签归章；每章数在用的节，未归类的数在用的页。
  const pages = view.items.filter((one) => one.collection === OVERALL_COLLECTION);
  const layout = chapterLayout(pages.map((one) => chapterPage(one.item_id, one.fields)));
  const chapters = layout.chapters
    .map((one) => ({ no: one.chapter.no, name: one.chapter.name, sections: one.sections.filter((section) => section.no !== null).length }))
    .filter((one) => one.sections > 0);
  const unsorted = layout.unsorted.filter((one) => !one.deprecated).length;
  // 待澄清：决策记录与待澄清事项那张表里还没有了结的问题；问题集合没有「种类」字段时都算。
  const openQuestions = (view.overall_views?.decisions ?? [])
    .filter((row) => row.entry === "question" && clarifyKind(row.question_kind)).length;

  // 模型：还在的图按种类数张数，种类照它第一次出现的先后。
  const models: { kind: string; name: string; count: number }[] = [];
  for (const diagram of view.diagrams) {
    const found = models.find((one) => one.kind === diagram.kind);
    if (found) found.count += 1;
    else models.push({ kind: diagram.kind, name: diagram.kind_name, count: 1 });
  }

  // 需求条目：业务说明与问题之外的每个集合。问题集合认的是状态字段的取值里有「用户决定保留」的集合。
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
        ? { kind: "activity" as const, key, name: activityNameOf(defs, key), ordinal: null, flow: null,
          moved_by: stage.moved_by, moved_at: stage.moved_at, reason: stage.reason }
        : { kind: "stage" as const, key, name: activityNameOf(defs, key), ordinal: stationOrdinal(defs, stage.flow, key), flow: stage.flow,
          moved_by: stage.moved_by, moved_at: stage.moved_at, reason: stage.reason },
    description: { sections: chapters.reduce((sum, one) => sum + one.sections, 0) + unsorted, chapters, unsorted, open_questions: openQuestions },
    models,
    items,
    // 这一段还差什么：现在这个阶段没有通过的灯，原句照灯的整句。
    missing: (current === IDLE ? [] : stage.lamps[current] ?? []).filter((lamp) => lamp.ok === false).map((lamp) => ({ key: lamp.key, summary: lamp.summary })),
    proposal: stage.proposal,
    work_items: workItemViews(taskDir, sessions, defs),
    launch: stage.launch,
    assets: stage.assets,
    catalog: stage.catalog,
    start_page: startPageTexts(view.task_name),
    versions: library.versionRows(taskDir).map((row) => library.versionView(row, taskDir)),
  };
}


/** 任务的全部工作项给页面的样子，按最近有动静的时刻倒序（会话都没有说过话的按启动的时刻；同一时刻的按记录号倒序）。 */
function workItemViews(taskDir: string, sessions: readonly SessionFact[] | null, defs: Definitions | null) {
  const moment = (one: ReturnType<typeof workItemView>) => Date.parse(String(one.last_active_at ?? one.started_at ?? "")) || 0;
  return library.workItemRows(taskDir).map((row) => workItemView(row, sessions, defs))
    .sort((a, b) => moment(b) - moment(a) || b.record_id - a.record_id);
}

/** 七章的章号与章名，按先后：页面要列出全部的章时用。 */
export const CHAPTER_NAMES = CHAPTERS.map((one) => ({ no: one.no, name: one.name }));
