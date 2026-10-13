/**
 * 任务状况：任务现在做到哪里了，由程序据任务记录算出来，不经模型。页面的「任务状况」卡用它（新建会话的开头、输入框旁的入口）。
 *
 * 只读，全部取自整份数据已经算好的东西（library.taskSnapshot）：现在的阶段与最近一次移动、总体分析的页按章归类的节数、
 * 还没有了结的待澄清问题数、图按种类的张数、各集合的条目数与用户看过的条数、现在这个阶段没有通过的灯、开着的提议。
 * 章的归法与页面目录用的是同一个函数（agent/src/lib/overall_chapters.ts）。
 *
 * 字段按「当前活动」命名（activity），有三种：
 * - 任务在首次分析流程里的某个阶段：kind 是 stage，key 是阶段的写法，ordinal 是第几阶段，flow 是所属流程（initial）。
 * - 用户单独开展一项活动（不在流程里）：kind 是 activity，key 与 name 是那项活动的，ordinal 与 flow 为 null；missing 照那项活动的灯。
 * - 任务空闲（没有在进行的活动）：kind 与 key 都是 idle，name 是「空闲」，ordinal 与谁移的、什么时候、为什么三项为 null，
 *   missing 是空的（空闲没有自己的灯）。
 * launch 是「开展一项活动」一节的内容（agent/src/lib/stage.ts 的 LaunchView）：正在进行的活动（一行，不是按钮）、可以启动或继续的流程、
 * 可以单独开展的六项活动各带能不能开展与缺什么、以后才有的（发布）。前提在这里算好，页面只渲染；点一项是界面操作 start_activity。
 * 任务不在进行中时 launch 为 null。versions 留给已发布的文档版本，现在没有这种记录，恒为空列表。
 * assets 是需求资产六类的现状，六格，每格 { key, name, count, unit, text, note, produced_by }（agent/src/lib/activity_catalog.ts 的 AssetCell）。
 * catalog 是任务起点页的活动目录：flows 两条工作流程与 activities 七项单项活动，文字取自活动与流程的定义文件开头的头
 * （agent/prompts/stages/、agent/prompts/flows/），各带现在能不能开展（enabled）与一句状态（state）；能不能开展只看数据。
 * 任务不在进行中、或者定义读不出来时 catalog 为 null。launch 留给旧页面过渡，以后去掉。
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
 * after 是「开展后」一块里有材料与没有材料两种情形各一句。
 */
export function startPageTexts(taskName: string) {
  return {
    lead: `本任务用于编制并持续维护「${taskName}」的需求规格说明。所有工作围绕同一套需求资产进行；每开展一项活动，资产即得到补充或修正。`,
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

export function taskStatus(taskDir: string) {
  const [, view] = library.taskSnapshot(taskDir);
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
    launch: view.status === "进行中" ? stage.launch : null,
    assets: stage.assets,
    catalog: view.status === "进行中" ? stage.catalog : null,
    start_page: startPageTexts(view.task_name),
    versions: [] as unknown[],
  };
}

/** 七章的章号与章名，按先后：页面要列出全部的章时用。 */
export const CHAPTER_NAMES = CHAPTERS.map((one) => ({ no: one.no, name: one.name }));
