/**
 * 任务定义按会话给的视图：助手用 read 读任务定义文件时，扩展把返回换成这一份（hooks/definition_view.ts）。原文件不改，
 * 别的会话、程序的校验照旧读原文件。
 *
 * 视图仍是同样结构的 JSON，只留两类集合：
 * - 这个位置获准写入的集合（获准能力表：page 是页的那个集合（OVERALL_COLLECTION），problem 是平台的问题集合，item 是其余的条目集合），给全部字段与取值，标「可写」为真；
 * - 活动声明「读」一栏涉及而不能写的集合，只给字段的名字与类型，标「可写」为假。
 * 别的集合不出现，「完成条件」也只留列出的集合。导语页那一栏只在编写文档的视图里出现。开头加一段说明这是本会话的视图。
 */

import { type ReadKey, READ_ALL } from "./activity_def.ts";
import { PLATFORM_PROBLEM_NAME, withPlatformCollections } from "./definition.ts";
import { OVERALL_COLLECTION, OVERALL_FIELDS } from "./overall_analysis.ts";
import { type Position, type WriteKind, positionName } from "./stage.ts";
import { fillText } from "./texts.ts";

/** 视图开头那段说明的键名。 */
export const VIEW_NOTE_KEY = "本会话的视图";
/** 每个列出的集合上标的那一栏：本会话能不能新增、修改它的条目。 */
export const VIEW_WRITABLE_KEY = "可写";

/** 生成视图要的东西：会话的位置、活动声明里的「读」、这个位置获准的写入种类。 */
export interface ViewInput {
  stage: Position;
  reads: readonly ReadKey[];
  allowed: readonly WriteKind[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** 一个集合的条目属于哪一类写入。 */
function kindOf(name: unknown): WriteKind {
  if (name === OVERALL_COLLECTION) return "page";
  if (name === PLATFORM_PROBLEM_NAME) return "problem";
  return "item";
}

/** 「读」一栏涉及这一类集合没有：读全部资产的都涉及；读 description 的涉及页的那个集合；读需求条目或评审的涉及其余的条目集合。 */
function readsKind(reads: readonly ReadKey[], kind: WriteKind): boolean {
  if (reads.includes(READ_ALL)) return true;
  if (kind === "page") return reads.includes("description");
  if (kind === "item") return reads.includes("items") || reads.includes("review");
  return false;
}

/** 字段里去掉导语页那一栏（编写文档之外的位置）。 */
function withoutIntro(fields: unknown, stage: Position): unknown {
  if (stage === "document" || !Array.isArray(fields)) return fields;
  return fields.filter((field) => !(isObject(field) && field["名"] === OVERALL_FIELDS.intro));
}

/** 只供参照的集合：名称、编号前缀、字段的名字与类型。 */
function readOnly(collection: Json, stage: Position): Json {
  const fields = withoutIntro(collection["字段"], stage);
  return {
    名称: collection["名称"],
    编号前缀: collection["编号前缀"],
    [VIEW_WRITABLE_KEY]: false,
    字段: Array.isArray(fields) ? fields.filter(isObject).map((field) => ({ 名: field["名"], 类型: field["类型"] })) : [],
  };
}

/** 能写的集合：照原样，导语页那一栏按位置去留，标可写。 */
function writable(collection: Json, stage: Position): Json {
  return { ...collection, [VIEW_WRITABLE_KEY]: true, 字段: withoutIntro(collection["字段"], stage) };
}

/**
 * 由任务定义文件解析出来的内容生成本会话的视图。形状不对的（不是对象、没有条目集合）原样交回：那是任务定义本身的问题，
 * 由校验去报，这里不替它改。
 */
export function definitionView(raw: unknown, input: ViewInput): unknown {
  const expanded = withPlatformCollections(raw).raw;
  if (!isObject(expanded) || !isObject(expanded["交付物"]) || !Array.isArray(expanded["交付物"]["条目集合"])) return raw;
  const collections: Json[] = [];
  for (const one of expanded["交付物"]["条目集合"] as unknown[]) {
    if (!isObject(one)) continue;
    const kind = kindOf(one["名称"]);
    if (input.allowed.includes(kind)) collections.push(writable(one, input.stage));
    else if (readsKind(input.reads, kind)) collections.push(readOnly(one, input.stage));
  }
  const listed = new Set(collections.map((one) => one["名称"]));
  const completion = isObject(expanded["完成条件"])
    ? Object.fromEntries(Object.entries(expanded["完成条件"]).filter(([name]) => listed.has(name)))
    : expanded["完成条件"];
  const note = fillText("stage_prompt.definition_view_note", { position: positionName(input.stage) });
  return { [VIEW_NOTE_KEY]: note, ...expanded, 交付物: { ...expanded["交付物"], 条目集合: collections }, 完成条件: completion };
}
