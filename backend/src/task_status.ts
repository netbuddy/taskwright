/**
 * 任务状况：任务现在做到哪里了，由程序据任务记录算出来，不经模型。页面的「任务状况」卡用它（新建会话的开头、输入框旁的入口）。
 *
 * 只读，全部取自整份数据已经算好的东西（library.taskSnapshot）：现在的阶段与最近一次移动、总体分析的页按章归类的节数、
 * 还没有了结的待澄清问题数、图按种类的张数、各集合的条目数与用户看过的条数、现在这个阶段没有通过的灯、开着的提议。
 * 章的归法与页面目录用的是同一个函数（agent/src/lib/overall_chapters.ts）。
 *
 * 字段按「当前活动」命名（activity）：现在任务总是处在某一个阶段，kind 恒为 stage、所属流程恒为首次分析；
 * 以后任务可以空闲、可以单独开展一项活动时，这一项可以是 null 或者别的种类。versions 留给已发布的文档版本，现在没有这种记录，恒为空列表。
 * 没有阶段的任务（任务定义里没有「总体分析」集合）没有状况，返回 null。
 */

import { CHAPTERS, chapterLayout, chapterPage } from "../../agent/src/lib/overall_chapters.ts";
import { OVERALL_COLLECTION } from "../../agent/src/lib/overall_analysis.ts";
import { QUESTION_KEEP_STATUS, QUESTION_KIND_CLARIFY, STAGES, STAGE_NAMES } from "../../agent/src/lib/stage.ts";
import * as clock from "./clock.ts";
import * as library from "./library.ts";

export function taskStatus(taskDir: string) {
  const [, view] = library.taskSnapshot(taskDir);
  if (view === null || view.stage === null) return null;
  const stage = view.stage;
  const current = stage.current as (typeof STAGES)[number];

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
    activity: {
      kind: "stage" as const, key: current, name: STAGE_NAMES[current] ?? String(current), ordinal: STAGES.indexOf(current) + 1, flow: stage.flow,
      moved_by: stage.moved_by, moved_at: stage.moved_at, reason: stage.reason,
    },
    description: { sections: chapters.reduce((sum, one) => sum + one.sections, 0) + unsorted, chapters, unsorted, open_questions: openQuestions },
    models,
    items,
    // 这一段还差什么：现在这个阶段没有通过的灯，原句照灯的整句。
    missing: (stage.lamps[current] ?? []).filter((lamp) => lamp.ok === false).map((lamp) => ({ key: lamp.key, summary: lamp.summary })),
    proposal: stage.proposal,
    versions: [] as unknown[],
  };
}

/** 七章的章号与章名，按先后：页面要列出全部的章时用。 */
export const CHAPTER_NAMES = CHAPTERS.map((one) => ({ no: one.no, name: one.name }));
