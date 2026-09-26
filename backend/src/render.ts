/**
 * 生成文档：对交付物的某一次修订整体导出，按任务目录里的文档模板渲染成 Markdown。纯读取，不写库。
 *
 * 用户选一个修订号（缺省是最新），可以只列其中的某几个条目。文档里的每个条目是它在那次修订时的样子：
 * 修订号不大于 N 的最近一次改动（记作修订 K），那时已删除的条目不在里面。
 *
 * 模板的写法（见起始文件 docs/templates/srs.md）：
 * - {{#每个 集合名}} … {{/每个}}：对这个集合里被选中的每个条目，把中间那段各渲染一遍；
 * - {{#没有 集合名}} … {{/没有}}：这个集合一个都没选中时才输出中间那段；
 * - 按字段值筛选：集合名后面可以跟一个或几个用空格隔开的条件，「字段=值」只要这个字段等于值的条目，「字段!=值」只要不等于的，
 *   几个条件同时成立才算；列表型字段按「含有这一项」比；
 * - 按字段归组：{{#按 字段 归组 集合名 条件…}} … {{/按}}：按这个字段的值把条目分组，每组把中间那段渲染一遍，
 *   {{组名}} 是这一组的值（空值写「（未填）」），{{#组内每个}} … {{/组内每个}} 对组里每个条目各渲染一遍。
 *   组的先后按每组第一个条目的编号，组内按编号排；一个条目都没有时整段不输出；
 * - 每个条目里：{{编号}}、{{修订号}}、{{评审状态}}、{{确认状态}}、{{来源}}，以及任意字段名 {{字段名}}；
 * - 模板任何地方：{{文档修订号}}（这份文档按修订 N 生成）。
 *
 * 没有评审通过或没有确认标记的条目不拦，如实写进「评审状态」「确认状态」两处。
 * 「用户的话」的出处在库里是「会话编号#消息编号」，文档里换成「会话「名称」里用户的第 N 句话」（由调用方算好传进来）；
 * Word 材料的出处只写文件路径；「用户直接修改」的出处换成「用户在界面上的第 N 次修改（时刻）」。
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "./errors.ts";
import { readTextFile } from "./files.ts";
import { type Library, actorWord } from "./library.ts";
import { or, truthy } from "./py.ts";

const EACH = /\{\{#每个 (.+?)\}\}\n?(.*?)\{\{\/每个\}\}\n?/gs;
const GROUP = /\{\{#按 (\S+) 归组 (.+?)\}\}\n?(.*?)\{\{\/按\}\}\n?/gs;
const IN_GROUP = /\{\{#组内每个\}\}\n?(.*?)\{\{\/组内每个\}\}\n?/gs;
const NONE = /\{\{#没有 (.+?)\}\}\n?(.*?)\{\{\/没有\}\}\n?/gs;
const FIELD = /\{\{([^\n]+?)\}\}/g;

type Locate = (locator: string) => string | null;
type Dict = Record<string, any>;

/** 值写成文字（字符串、数字、布尔、空）。 */
function str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function valueText(value: unknown, fieldType: string): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "（空）";
  if (fieldType === "条目引用" && Array.isArray(value)) return value.map(str).join("、");
  if (Array.isArray(value)) return value.map((v, n) => `${n + 1}. ${str(v)}`).join("；");
  return str(value).replaceAll("\n", " ");
}

/** 条目在修订 revisionNo 上的评审标记：评审通过、评审不通过、评审不通过但用户保留了写法（带理由）、未评审。 */
export function reviewState(lib: Library, itemId: string, revisionNo: number): string {
  const reviews = lib.reviewsOf(itemId, revisionNo);
  if (!reviews.length) return "未评审";
  if (reviews[reviews.length - 1].verdict === "合规") return "评审通过";
  const kept = lib.activeWaiver(itemId, revisionNo);
  if (kept) return truthy(kept.reason) ? `评审不通过，用户保留（理由：${str(kept.reason)}）` : "评审不通过，用户保留";
  return "评审不通过";
}

/** 确认标记的依据在文档里的写法：已读、用户修改，其余都是用户明确确认的。 */
const BASIS_WORDS: Record<string, string> = { viewed: "已读", ui_edit: "用户修改" };

/**
 * 条目在修订 revisionNo 上的确认标记：最近一条态度是接受就是已确认，括号里如实写依据。这次修订上没有标记、而用户看过更早的
 * 修订 N 时，写「用户最后看过修订 N，之后由助手改为修订 M」；都没有（或在这次修订上撤回了）是未确认。
 */
export function confirmState(lib: Library, itemId: string, revisionNo: number): string {
  const records = lib.confirmationsOf(itemId, revisionNo);
  if (records.length && records[records.length - 1].accepted) return `已确认（${BASIS_WORDS[records[records.length - 1].basis] ?? "明确确认"}）`;
  if (records.length) return "未确认";
  const seen = lib.confirmationsOf(itemId).filter((c) => c.accepted && c.revision_no < revisionNo).map((c) => c.revision_no as number);
  if (!seen.length) return "未确认";
  const v = lib.contents.get(`${itemId}\u0000${revisionNo}`) ?? {};
  const by = actorWord((lib.data.event_meta?.get(v.event_seq ?? null) ?? ({} as Dict)).actor ?? "");
  return `用户最后看过修订 ${Math.max(...seen)}，之后${by === "executor" ? "由助手" : ""}改为修订 ${revisionNo}`;
}

const USER_WORDS = "用户的话";
const USER_EDIT = "用户直接修改";
/** 种类为「领域说明」的来源，出处是那条领域说明的条目编号，文档里写成「领域说明 DN-002（「摘录」）」。 */
const DOMAIN_NOTE = "领域说明";
/** 按字段归组时空值那一组的组名。 */
const EMPTY_GROUP = "（未填）";
const EXECUTOR_SUPPLEMENT = "执行者补充";
/** 来源种类在文档里的写法：库里的存储值「执行者补充」对读者写成「助手补充」，其余照存储值。 */
const KIND_WORDS: Record<string, string> = { [EXECUTOR_SUPPLEMENT]: "助手补充" };

/** 界面操作编号 → 「用户在界面上的第 N 次修改（时刻）」。编号与先后都取自库。 */
export function editLocator(lib: Library): Locate {
  const firstSeq = new Map<string, number>();
  for (const rows of (lib.data.sources ?? new Map()).values()) {
    for (const one of rows) {
      const seq = one["事件序号"];
      if (one["种类"] === USER_EDIT && truthy(one["出处"]) && Number.isInteger(seq)) {
        firstSeq.set(one["出处"], Math.min(seq, firstSeq.get(one["出处"]) ?? seq));
      }
    }
  }
  const order = new Map([...firstSeq.keys()].sort((a, b) => firstSeq.get(a)! - firstSeq.get(b)!).map((op, n) => [op, n + 1]));
  const meta = lib.data.event_meta ?? new Map();
  return (locator) => {
    const n = order.get(locator);
    if (n === undefined) return null;
    const at = String(or((meta.get(firstSeq.get(locator)!) ?? {}).at, ""));
    const when = at.slice(0, 16).replace("T", " ");
    return when ? `用户在界面上的第 ${n} 次修改（${when}）` : `用户在界面上的第 ${n} 次修改`;
  };
}

export function sourcesText(lib: Library, itemId: string, revisionNo: number, wordsLocator: Locate | null = null, editsLocator: Locate | null = null): string {
  const parts = [];
  for (const s of lib.sourcesOf(itemId, revisionNo)) {
    if (s.kind === DOMAIN_NOTE) {
      parts.push(`${DOMAIN_NOTE} ${str(s.locator)}（「${str(s.excerpt)}」）`);
      continue;
    }
    let where: string;
    if (s.kind === USER_WORDS) {
      const readable = wordsLocator && truthy(s.locator) ? wordsLocator(s.locator) : null;
      where = `，出处 ${readable || "对话里用户说的话"}`;
    } else if (s.kind === USER_EDIT) {
      const readable = editsLocator && truthy(s.locator) ? editsLocator(s.locator) : null;
      where = `，出处 ${readable || "用户在界面上的修改"}`;
    } else {
      // Word 材料的出处在库里带段落号（inputs/x.docx#p37），段落号对读者没有用，文档里只写文件名。
      const locator = String(or(s.locator, "")).replace(/(\.docx)#p\d+$/i, "$1");
      where = locator && s.kind !== EXECUTOR_SUPPLEMENT ? `，出处 ${locator}` : "";
    }
    parts.push(`${KIND_WORDS[s.kind] ?? s.kind}${where}（「${str(s.excerpt)}」）`);
  }
  return parts.join("；") || "（没有登记来源）";
}

/** 「集合名 字段=值 字段!=值」→ [集合名, [字段, 是否要相等, 值]]。值里不能有空格。 */
export function parseSelector(text: string): [string, [string, boolean, string][]] {
  const [head, ...rest] = text.trim().split(/\s+/);
  const conditions: [string, boolean, string][] = [];
  for (const one of rest) {
    const negate = one.includes("!=");
    const sep = negate ? "!=" : "=";
    const at = one.indexOf(sep);
    const field = at >= 0 ? one.slice(0, at) : one;
    if (!field || at < 0) throw new ApiError("bad_request", `文档模板里的筛选条件「${one}」写得不对，要写成「字段=值」或「字段!=值」。`);
    conditions.push([field, !negate, one.slice(at + sep.length)]);
  }
  return [head, conditions];
}

export function matches(fields: Dict, conditions: [string, boolean, string][]): boolean {
  for (const [field, equal, value] of conditions) {
    const got = fields[field];
    const hit = Array.isArray(got) ? got.map(str).includes(value) : str(got !== null && got !== undefined ? got : "") === value;
    if (hit !== equal) return false;
  }
  return true;
}

/** 从请求体取出 [修订号, 条目筛选]。修订号不写就是最新；条目筛选不写就是那次修订时的全部条目。 */
export function documentRequest(body: Dict): [number | null, string[] | null] {
  const revisionNo = body.revision_no ?? null;
  if (revisionNo !== null && (typeof revisionNo !== "number" || !Number.isInteger(revisionNo) || revisionNo < 1)) {
    throw new ApiError("bad_request", "revision_no 要写一个从 1 起的整数，或者不写（按最新修订生成）。");
  }
  const items = body.items ?? null;
  if (items !== null && (!Array.isArray(items) || !items.every((i) => typeof i === "string"))) {
    throw new ApiError("bad_request", "items 要写条目编号的列表，或者不写（那次修订时的全部条目）。");
  }
  return [revisionNo, items];
}

type Chosen = [string, number, Dict][];

export function render(taskDir: string, lib: Library, revisionNo: number | null = null, items: string[] | null = null, wordsLocator: Locate | null = null): string {
  const templateRel = String(or(lib.definition["文档模板"], "docs/templates/srs.md"));
  const templatePath = join(taskDir, templateRel);
  let isFile = false;
  try {
    isFile = statSync(templatePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new ApiError("bad_request", `任务目录里没有文档模板 ${templateRel}。`);
  const template = readTextFile(templatePath);
  const latest = lib.latestRevision();
  if (latest === 0) throw new ApiError("bad_request", "交付物还没有任何修订，没有东西可以生成。");
  const docRevision = revisionNo || latest;
  if (docRevision > latest) throw new ApiError("bad_request", `这个任务还没有修订 ${docRevision}，最新是修订 ${latest}。`);
  let alive = new Map(lib.aliveAt(docRevision));
  if (items !== null) {
    const missing = items.filter((i) => !alive.has(i));
    if (missing.length) throw new ApiError("bad_request", `修订 ${docRevision} 时交付物里没有这些条目：${missing.join("、")}。`, { items: missing });
    alive = new Map(items.map((i) => [i, alive.get(i)!]));
  }
  const edits = editLocator(lib);
  const chosen = new Map<string, [string, number][]>();
  for (const [itemId, contentRevision] of alive) {
    const collection = lib.items.get(itemId)!.collection;
    if (!chosen.has(collection)) chosen.set(collection, []);
    chosen.get(collection)!.push([itemId, contentRevision]);
  }
  for (const rows of chosen.values()) {
    rows.sort((a, b) => lib.items.get(a[0])!.serial - lib.items.get(b[0])!.serial);
  }

  /** 按「集合名 条件…」取出被选中、又满足条件的条目，按编号排。 */
  const selected = (selector: string): [string, Chosen] => {
    const [collection, conditions] = parseSelector(selector);
    const rows: Chosen = (chosen.get(collection) ?? []).map(([itemId, no]) => [itemId, no, or(lib.fieldsOf(itemId, no), {}) as Dict]);
    return [collection, rows.filter((row) => matches(row[2], conditions))];
  };

  const renderItems = (collection: string, rows: Chosen, body: string): string => {
    const types: Record<string, string> = {};
    for (const f of lib.collections.get(collection)?.["字段"] ?? []) types[f["名"]] = f["类型"];
    return rows.map(([itemId, no, fields]) => {
      // 「内容版本号」是旧模板里的写法，按修订号填（任务目录里拷去的旧模板照样能用）。
      const special: Record<string, string> = {
        编号: itemId, 修订号: String(no), 内容版本号: String(no), 评审状态: reviewState(lib, itemId, no),
        确认状态: confirmState(lib, itemId, no), 来源: sourcesText(lib, itemId, no, wordsLocator, edits),
      };
      return body.replace(FIELD, (_m, raw: string) => {
        const key = raw.trim();
        return key in special ? special[key] : valueText(fields[key], types[key] ?? "文本");
      });
    }).join("");
  };

  const each = (_m: string, selector: string, body: string) => {
    const [collection, rows] = selected(selector);
    return renderItems(collection, rows, body);
  };

  const group = (_m: string, fieldRaw: string, selector: string, body: string) => {
    const field = fieldRaw.trim();
    const [collection, rows] = selected(selector);
    const groups = new Map<string, Chosen>();
    for (const row of rows) {
      const value = row[2][field];
      const key = Array.isArray(value) ? value.map(str).join("、") : str(or(value, "")).trim();
      const name = key || EMPTY_GROUP;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(row);
    }
    return [...groups].map(([name, members]) =>
      body.replace(IN_GROUP, (_x, inner: string) => renderItems(collection, members, inner)).replaceAll("{{组名}}", () => name)).join("");
  };

  const none = (_m: string, selector: string, body: string) => (selected(selector)[1].length ? "" : body);

  return template.replace(GROUP, group).replace(EACH, each).replace(NONE, none).replaceAll("{{文档修订号}}", () => String(docRevision));
}

