/**
 * 理解格式的 JSON Schema：读进来，给出几样取自它的清单，并按它核对一份理解的形式。
 *
 * schema 文件 agent/prompts/schemas/user_intent.schema.json 是唯一的来源：用户侧九种功能、执行者回复的五种末位主行为
 * （lib/reply.ts 的 ACT_KINDS 取自这里）、三档把握、摘要的字数上限，都从它读；平台 skill 里的说明与示例由
 * scripts/render-intent-schema.mjs 从它生成。本模块只读这一个文件，不导入别的模块，免得与 reply.ts 互相导入。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 理解格式的 JSON Schema 文件。平台 skill 里的说明由 scripts/render-intent-schema.mjs 从它生成。 */
export const INTENT_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "schemas", "user_intent.schema.json");

type Json = Record<string, any>;

export const INTENT_SCHEMA: Json = JSON.parse(readFileSync(INTENT_SCHEMA_PATH, "utf-8"));

/** 用户侧九种功能。 */
export const USER_FUNCTIONS: readonly string[] = INTENT_SCHEMA.$defs.user_function.enum;
/** 执行者回复的五种末位主行为；lib/reply.ts 的 ACT_KINDS 取的就是它。 */
export const EXECUTOR_FUNCTIONS: readonly string[] = INTENT_SCHEMA.$defs.executor_function.enum;
/** 三档把握。 */
export const CONFIDENCE_LEVELS: readonly string[] = INTENT_SCHEMA.$defs.confidence.enum;
/** 每种功能的中文名（用户侧、执行者侧合在一起；inform 两侧同名「告知」）。 */
export const FUNCTION_NAMES: Record<string, string> = {
  ...INTENT_SCHEMA.$defs.user_function["x-names"],
  ...INTENT_SCHEMA.$defs.executor_function["x-names"],
};

/** 门禁拒绝的开头。lib/reply.ts 数「回复」连续被拒几次时，按它把门禁的拒绝排除在外。 */
export const INTENT_GATE_TEXT = "先按 schema 写下你对用户这句话的理解";

/** 摘要最多几个字（与 schema 里 summary 的 maxLength 一致）。 */
export const SUMMARY_LIMIT: number = INTENT_SCHEMA.properties.acts.items.properties.summary.maxLength;

/**
 * 按 schema 核对一个值，返回逐条的中文问题。只实现本 schema 用到的那几样：type（object、array、string、integer）、
 * required、properties、additionalProperties 为 false、items、minItems、enum、maxLength、minimum、同文件内的 $ref。
 */
export function schemaErrors(value: unknown, schema: Json = INTENT_SCHEMA, path = "", root: Json = INTENT_SCHEMA): string[] {
  const errors: string[] = [];
  const where = path || "整份理解";
  if (typeof schema.$ref === "string") {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((node: Json, key: string) => node?.[key], root);
    return schemaErrors(value, target, path, root);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${where} 写的是 ${JSON.stringify(value)}，只能是 ${schema.enum.join("、")} 之一`);
    return errors;
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${where} 应当是一个对象`);
        return errors;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`${path ? `${path} ` : ""}缺少 ${key}`);
      }
      for (const [key, one] of Object.entries(record)) {
        const child = schema.properties?.[key];
        if (!child) {
          if (schema.additionalProperties === false) {
            errors.push(`${path ? `${path} ` : ""}多了「${key}」这一项，只能有 ${Object.keys(schema.properties ?? {}).join("、")}`);
          }
          continue;
        }
        errors.push(...schemaErrors(one, child, path ? `${path}.${key}` : key, root));
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${where} 应当是一个列表`);
        return errors;
      }
      if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${where} 至少要有 ${schema.minItems} 项`);
      if (schema.items) value.forEach((one, index) => errors.push(...schemaErrors(one, schema.items, `${path}[${index}]`, root)));
      return errors;
    }
    case "string":
      if (typeof value !== "string") errors.push(`${where} 应当是文字`);
      else if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) errors.push(`${where} 超过了 ${schema.maxLength} 个字`);
      else if (value.trim() === "") errors.push(`${where} 是空的`);
      return errors;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${where} 应当是整数`);
      else if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${where} 不能小于 ${schema.minimum}`);
      return errors;
    default:
      return errors;
  }
}
