/**
 * 任务定义的读取与校验。任务定义是一份 JSON 文件，写一类任务要交付什么、什么条件下算完成、
 * 执行方法（skill）与领域规矩文档在哪里。本模块只核对它的形状，不评判里面写得好不好。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { readFileSync } from "node:fs";
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
 */
export function validateDefinition(raw: unknown, path = "（未给出路径）"): TaskDefinition {
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
        if (isNonEmptyString(name) && isNonEmptyString(prefix)) {
          collections.push({ name, prefix, fields });
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
  return { definition: validateDefinition(raw, relativePath), text, relativePath };
}
