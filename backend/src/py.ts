/**
 * 与 Python 版逐字一致所需的两样小工具：Python 的真假判断（空列表、空对象、空字符串、0 都算假），
 * 以及标量在 f-string 里的写法（None、True、False）。只用于拼给人看的文字与照抄原有的取值规则。
 */

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** 标量写进文字：null 与 undefined 写 None，布尔写 True 或 False，其余照 String。 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** Python 的 x or y。 */
export function or<T, U>(value: T, fallback: U): T | U {
  return truthy(value) ? value : fallback;
}

export const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
