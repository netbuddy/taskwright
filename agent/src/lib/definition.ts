/**
 * 任务定义的读取与校验。任务定义是一份 JSON 文件，写一类任务要交付什么、什么条件下算完成、
 * 执行方法（skill）与领域规矩文档在哪里。本模块只核对它的形状，不评判里面写得好不好。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { CONDITION_NAMES } from "./conditions.ts";

/** 字段的四种类型。 */
export const FIELD_TEXT = "文本";
export const FIELD_TEXT_LIST = "文本列表";
export const FIELD_ENUM = "枚举";
export const FIELD_ITEM_REF = "条目引用";
export const FIELD_TYPES = [FIELD_TEXT, FIELD_TEXT_LIST, FIELD_ENUM, FIELD_ITEM_REF] as const;

export interface FieldDef {
  name: string;
  type: string;
  required: boolean;
  /** 只有枚举类型才有。 */
  values?: string[];
}

export interface CollectionDef {
  name: string;
  prefix: string;
  fields: FieldDef[];
  /** 这个集合的评审规矩；没写时为 null，评审只按字段声明。 */
  reviewRules: ReviewRulesSpec | null;
}

/** 规则的两种级别：必选规则违反了即不合规；可选规则只给建议。 */
export const RULE_REQUIRED = "必选";
export const RULE_OPTIONAL = "可选";
export const RULE_LEVELS = [RULE_REQUIRED, RULE_OPTIONAL] as const;

/** 规则文件里的一条规则。 */
export interface ReviewRule {
  编号: string;
  级别: (typeof RULE_LEVELS)[number];
  条文: string;
  反例: string;
  正例: string;
}

/**
 * 任务定义里一个集合的「评审规矩」：规则文件（相对任务目录的路径）、关闭的可选规则、升为必选的可选规则。
 * 关闭与升为必选只能指可选规则；本版本界面上还没有开关，默认都为空。
 */
export interface ReviewRulesSpec {
  file: string;
  off: string[];
  promote: string[];
}

/** 「把问题条目标为先不管」写进状态字段的取值。 */
export const KEEP_PENDING_STATUS = "用户决定保留";
/** 问题条目在状态之外唯一还能由执行者改的字段：写明问题最后怎样了结。 */
export const PROBLEM_RESULT_FIELD = "处理结果";

/**
 * 问题条目的集合靠状态字段了结：有一个枚举字段的取值里含「用户决定保留」，就返回这个字段，
 * 否则返回 null。界面上认问题条目用的是同一个判据。
 */
export function keepPendingField(collection: CollectionDef): FieldDef | null {
  return collection.fields.find((f) => f.type === FIELD_ENUM && (f.values ?? []).includes(KEEP_PENDING_STATUS)) ?? null;
}

export interface TaskDefinition {
  taskName: string;
  deliverableName: string;
  templatePath: string;
  collections: CollectionDef[];
  /** 集合名 → 这个集合要满足的条件名列表。 */
  completion: Record<string, string[]>;
  skillPath: string;
  rulePaths: string[];
  /** 材料放在哪个目录，相对任务目录。可选项，任务定义里不写就是 {@link DEFAULT_MATERIALS_DIR}。 */
  materialsDir: string;
  /**
   * 领域标签：这类任务缺省属于哪个业务领域（例如「售后」）。可选项，只存不用，
   * 是给将来跨任务的只读视图「需求池」预留的；创建任务时用户给了标签就以用户给的为准。
   */
  domainTag: string | null;
}

/** 任务定义里不写「材料目录」时用的值。观测台据它把读材料的调用归到「读材料」这个阶段。 */
export const DEFAULT_MATERIALS_DIR = "inputs/";

/** 校验不通过时抛的错，reasons 是逐条的中文原因。 */
export class DefinitionError extends Error {
  reasons: string[];
  constructor(path: string, reasons: string[]) {
    super(
      `任务定义文件 ${path} 的形状不对，一共 ${reasons.length} 处：\n` +
        reasons.map((reason, index) => `${index + 1}. ${reason}`).join("\n"),
    );
    this.reasons = reasons;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 核对一份已经解析出来的任务定义。通过就返回结构化对象，不通过就抛 DefinitionError，
 * 里面逐条写明哪一处缺了什么、应当怎样写。
 *
 * 给了 baseDir（任务目录）时，另外核对各集合「评审规矩」指向的规则文件：文件存在、能解析、编号唯一、级别合法，
 * 关闭与升为必选的编号存在且都是可选规则。库里的任务定义快照再读时不给 baseDir，只核对形状。
 */
export function validateDefinition(raw: unknown, path = "（未给出路径）", options: { baseDir?: string } = {}): TaskDefinition {
  const reasons: string[] = [];
  if (!isObject(raw)) {
    throw new DefinitionError(path, ["整份文件应当是一个 JSON 对象，现在不是。"]);
  }
  if (!isNonEmptyString(raw["任务名"])) reasons.push("缺少「任务名」，它应当是一段不为空的文字。");

  const deliverable = raw["交付物"];
  const collections: CollectionDef[] = [];
  let deliverableName = "";
  let templatePath = "";
  if (!isObject(deliverable)) {
    reasons.push("缺少「交付物」，它应当是一个对象，里面有「名称」「文档模板」「条目集合」「每个条目附带」四项。");
  } else {
    if (isNonEmptyString(deliverable["名称"])) deliverableName = deliverable["名称"];
    else reasons.push("「交付物」里缺少「名称」，它应当是一段不为空的文字。");
    if (isNonEmptyString(deliverable["文档模板"])) templatePath = deliverable["文档模板"];
    else reasons.push("「交付物」里缺少「文档模板」，它应当是文档模板文件相对任务目录的路径。");
    if (deliverable["每个条目附带"] !== "来源") {
      reasons.push("「交付物」里的「每个条目附带」应当写「来源」，现在不是。");
    }
    const list = deliverable["条目集合"];
    if (!Array.isArray(list) || list.length === 0) {
      reasons.push("「交付物」里缺少「条目集合」，它应当是一个不为空的列表。");
    } else {
      const seenNames = new Set<string>();
      const seenPrefixes = new Set<string>();
      list.forEach((entry, index) => {
        const where = `「条目集合」的第 ${index + 1} 项`;
        if (!isObject(entry)) {
          reasons.push(`${where}应当是一个对象，现在不是。`);
          return;
        }
        const name = entry["名称"];
        const prefix = entry["编号前缀"];
        const label = isNonEmptyString(name) ? `集合「${name}」` : where;
        if (!isNonEmptyString(name)) reasons.push(`${where}缺少「名称」。`);
        else if (seenNames.has(name)) reasons.push(`集合名「${name}」重复出现，集合名必须各不相同。`);
        if (!isNonEmptyString(prefix)) reasons.push(`${label}缺少「编号前缀」。`);
        else if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) {
          reasons.push(`${label}的编号前缀「${prefix}」只能由大写英文字母与数字组成，并以字母开头。`);
        } else if (seenPrefixes.has(prefix)) {
          reasons.push(`编号前缀「${prefix}」重复出现，编号前缀必须各不相同。`);
        }
        if (isNonEmptyString(name)) seenNames.add(name);
        if (isNonEmptyString(prefix)) seenPrefixes.add(prefix);
        const fields = validateFields(entry["字段"], label, reasons);
        const reviewRules = "评审规矩" in entry ? validateReviewSpec(entry["评审规矩"], label, reasons, options.baseDir) : null;
        if (isNonEmptyString(name) && isNonEmptyString(prefix)) {
          collections.push({ name, prefix, fields, reviewRules });
        }
      });
    }
  }

  const completion: Record<string, string[]> = {};
  const rawCompletion = raw["完成条件"];
  if (!isObject(rawCompletion)) {
    reasons.push("缺少「完成条件」，它应当是一个对象，键是集合名，值是条件名的列表。");
  } else {
    const known = new Set(collections.map((one) => one.name));
    for (const [collection, names] of Object.entries(rawCompletion)) {
      if (!known.has(collection)) {
        reasons.push(`「完成条件」里的集合「${collection}」不在「条目集合」里。`);
      }
      if (!Array.isArray(names)) {
        reasons.push(`「完成条件」里集合「${collection}」的值应当是条件名的列表。`);
        continue;
      }
      const kept: string[] = [];
      for (const conditionName of names) {
        if (typeof conditionName !== "string" || !CONDITION_NAMES.includes(conditionName)) {
          reasons.push(
            `「完成条件」里集合「${collection}」的条件名「${String(conditionName)}」没有实现。` +
              `已实现的条件名是：${CONDITION_NAMES.map((one) => `「${one}」`).join("、")}。`,
          );
          continue;
        }
        kept.push(conditionName);
      }
      completion[collection] = kept;
      const target = collections.find((one) => one.name === collection);
      if (target && kept.includes("没有状态为未解决的条目")) {
        const status = target.fields.find((field) => field.name === "状态");
        if (!status || status.type !== FIELD_ENUM || !(status.values ?? []).includes("未解决")) {
          reasons.push(
            `集合「${collection}」用了条件「没有状态为未解决的条目」，那么它必须有一个名叫「状态」的枚举字段，` +
              `并且取值里有「未解决」。现在没有。`,
          );
        }
      }
    }
  }

  let skillPath = "";
  if (isNonEmptyString(raw["执行方法"])) skillPath = raw["执行方法"];
  else reasons.push("缺少「执行方法」，它应当是 skill 文件相对任务目录的路径。");

  const rulePaths: string[] = [];
  const rules = raw["领域规矩"];
  if (!Array.isArray(rules) || rules.length === 0 || !rules.every(isNonEmptyString)) {
    reasons.push("缺少「领域规矩」，它应当是一个不为空的列表，每项是一份规矩文档相对任务目录的路径。");
  } else {
    rulePaths.push(...(rules as string[]));
  }

  let materialsDir = DEFAULT_MATERIALS_DIR;
  if ("材料目录" in raw) {
    const dir = raw["材料目录"];
    if (!isNonEmptyString(dir)) {
      reasons.push("「材料目录」是可选项；写了就应当是一段不为空的文字，写材料所在目录相对任务目录的路径，例如「inputs/」。");
    } else if (isAbsolute(dir) || dir.split(/[\\/]/).includes("..")) {
      reasons.push(`「材料目录」写的是「${dir}」。它应当是相对任务目录的路径，不能是绝对路径，也不能用「..」跳出任务目录。`);
    } else {
      materialsDir = dir.endsWith("/") ? dir : `${dir}/`;
    }
  }

  let domainTag: string | null = null;
  if ("领域标签" in raw) {
    if (!isNonEmptyString(raw["领域标签"])) {
      reasons.push("「领域标签」是可选项；写了就应当是一段不为空的文字，例如「售后」。");
    } else {
      domainTag = (raw["领域标签"] as string).trim();
    }
  }

  if (reasons.length > 0) throw new DefinitionError(path, reasons);
  return {
    taskName: raw["任务名"] as string,
    deliverableName,
    templatePath,
    collections,
    completion,
    skillPath,
    rulePaths,
    materialsDir,
    domainTag,
  };
}

/** 核对一个集合的「评审规矩」一项；给了 baseDir 时连同它指向的规则文件一起核对。形状不对时返回 null。 */
function validateReviewSpec(raw: unknown, label: string, reasons: string[], baseDir?: string): ReviewRulesSpec | null {
  const where = `${label}的「评审规矩」`;
  if (!isObject(raw)) {
    reasons.push(`${where}应当是一个对象，例如 {"规则文件": "docs/review-rules/use-case.json"}。`);
    return null;
  }
  const file = raw["规则文件"];
  if (!isNonEmptyString(file)) {
    reasons.push(`${where}缺少「规则文件」，它应当是规则文件相对任务目录的路径。`);
    return null;
  }
  if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    reasons.push(`${where}的规则文件「${file}」应当是相对任务目录的路径，不能是绝对路径，也不能用「..」跳出任务目录。`);
    return null;
  }
  const list = (key: string): string[] | null => {
    if (!(key in raw)) return [];
    const value = raw[key];
    if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
      reasons.push(`${where}的「${key}」应当是可选规则编号的列表，例如 ["UC-R9"]；不需要时不写或写空列表。`);
      return null;
    }
    return value as string[];
  };
  const off = list("关闭");
  const promote = list("升为必选");
  if (off === null || promote === null) return null;
  const both = off.filter((id) => promote.includes(id));
  if (both.length) reasons.push(`${where}里 ${both.join("、")} 既写在「关闭」里又写在「升为必选」里，只能选一边。`);
  if (baseDir !== undefined) {
    const rules = readRuleFile(resolve(baseDir, file), `${where}指向的规则文件「${file}」`, reasons);
    if (rules) {
      for (const [key, ids] of [["关闭", off], ["升为必选", promote]] as const) {
        for (const id of ids) {
          const rule = rules.find((one) => one.编号 === id);
          if (!rule) reasons.push(`${where}的「${key}」里写了 ${id}，规则文件「${file}」里没有这条规则。`);
          else if (rule.级别 !== RULE_OPTIONAL) reasons.push(`${where}的「${key}」里写了 ${id}，它是必选规则；只有可选规则能${key === "关闭" ? "关闭" : "升为必选"}。`);
        }
      }
    }
  }
  return { file, off, promote };
}

/** 读一份规则文件并核对：能解析、是不为空的列表、每条的编号唯一、级别合法、条文反例正例都是文字。不对时把原因加进 reasons，返回 null。 */
export function readRuleFile(fullPath: string, what: string, reasons: string[]): ReviewRule[] | null {
  if (!existsSync(fullPath)) {
    reasons.push(`${what}在任务目录里读不到。`);
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fullPath, "utf-8"));
  } catch (error) {
    reasons.push(`${what}不是合法的 JSON：${(error as Error).message}。`);
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    reasons.push(`${what}应当是一个不为空的列表，每项是一条规则 { "编号", "级别", "条文", "反例", "正例" }。`);
    return null;
  }
  const before = reasons.length;
  const seen = new Set<string>();
  raw.forEach((one, index) => {
    const at = `${what}的第 ${index + 1} 条规则`;
    if (!isObject(one)) { reasons.push(`${at}应当是一个对象。`); return; }
    const id = one["编号"];
    if (!isNonEmptyString(id)) reasons.push(`${at}缺少「编号」。`);
    else if (seen.has(id)) reasons.push(`${what}里编号 ${id} 重复出现，编号必须各不相同。`);
    else seen.add(id);
    if (!(RULE_LEVELS as readonly unknown[]).includes(one["级别"])) {
      reasons.push(`${at}的「级别」写的是「${String(one["级别"])}」，只能是「${RULE_REQUIRED}」或「${RULE_OPTIONAL}」。`);
    }
    for (const key of ["条文", "反例", "正例"]) {
      if (!isNonEmptyString(one[key])) reasons.push(`${at}缺少「${key}」，它应当是一段不为空的文字。`);
    }
  });
  return reasons.length === before ? (raw as ReviewRule[]) : null;
}

/**
 * 按任务定义里的选用情况，给出一个集合实际要评的规则：去掉关闭的，把升为必选的改成必选。
 * 规则文件读不到或形状不对时抛 Error，文字写明原因。
 */
export function effectiveRules(baseDir: string, spec: ReviewRulesSpec): ReviewRule[] {
  const reasons: string[] = [];
  const rules = readRuleFile(resolve(baseDir, spec.file), `规则文件「${spec.file}」`, reasons);
  if (!rules) throw new Error(reasons.join("；"));
  return rules
    .filter((rule) => !spec.off.includes(rule.编号))
    .map((rule) => (spec.promote.includes(rule.编号) ? { ...rule, 级别: RULE_REQUIRED } : rule));
}

function validateFields(raw: unknown, label: string, reasons: string[]): FieldDef[] {
  const fields: FieldDef[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    reasons.push(`${label}缺少「字段」，它应当是一个不为空的列表。`);
    return fields;
  }
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const where = `${label}的第 ${index + 1} 个字段`;
    if (!isObject(entry)) {
      reasons.push(`${where}应当是一个对象，现在不是。`);
      return;
    }
    const name = entry["名"];
    const type = entry["类型"];
    const required = entry["必填"];
    if (!isNonEmptyString(name)) {
      reasons.push(`${where}缺少「名」。`);
      return;
    }
    const fieldLabel = `${label}的字段「${name}」`;
    if (seen.has(name)) reasons.push(`${label}里字段名「${name}」重复出现。`);
    seen.add(name);
    if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type)) {
      reasons.push(
        `${fieldLabel}的类型「${String(type)}」不认识，类型只能是${FIELD_TYPES.map((one) => `「${one}」`).join("、")}四种之一。`,
      );
    }
    if (typeof required !== "boolean") reasons.push(`${fieldLabel}的「必填」应当写 true 或 false。`);
    const field: FieldDef = { name, type: String(type), required: required === true };
    if (type === FIELD_ENUM) {
      const values = entry["取值"];
      if (!Array.isArray(values) || values.length === 0 || !values.every(isNonEmptyString)) {
        reasons.push(`${fieldLabel}是枚举类型，必须有「取值」，它应当是一个不为空的文字列表。`);
      } else {
        field.values = values as string[];
      }
    }
    fields.push(field);
  });
  return fields;
}

/**
 * 读任务目录里的一份任务定义并校验。返回结构化对象、文件原文，以及规范化后的相对路径。
 * 路径必须在任务目录之内。
 */
export function loadDefinition(
  workspaceDir: string,
  definitionPath: string,
): { definition: TaskDefinition; text: string; relativePath: string } {
  const full = resolve(workspaceDir, definitionPath);
  const relativePath = relative(resolve(workspaceDir), full);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DefinitionError(definitionPath, ["任务定义文件必须在任务目录之内，请给相对任务目录的路径。"]);
  }
  let text: string;
  try {
    text = readFileSync(full, "utf-8");
  } catch {
    throw new DefinitionError(relativePath, [
      `任务目录里读不到这个文件。请确认路径写对了；任务定义文件通常放在 docs/task-definitions/ 下，扩展名是 .json。`,
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DefinitionError(relativePath, [`文件不是合法的 JSON：${(error as Error).message}。`]);
  }
  return { definition: validateDefinition(raw, relativePath, { baseDir: workspaceDir }), text, relativePath };
}
