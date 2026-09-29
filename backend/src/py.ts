/**
 * 两样小工具：Python 式的真假判断（空列表、空对象、空字符串、0 都算假），以及标量写进文字时的写法（None、True、False）。
 * 只用于拼给人看的文字与照抄原有的取值规则。这些写法来自早先的 Python 版任务服务，现在由测试的期望值
 * （tests/fixtures/expected/）与观测台读归档的写法固定下来，改动要连同它们一起改。文件名 py.ts 沿用下来，没有改。
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

/**
 * Python 的 json.dumps(value, ensure_ascii=False) 的写法：各项之间是「逗号加空格」，键与值之间是「冒号加空格」。
 * 归档里的后端补记按这个写法写；观测台读归档，期望值 tests/fixtures/expected/ 里也是这个写法。
 */
export function pyDumps(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
  if (typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`).join(", ") + "}";
  }
  if (typeof value === "number" && !Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
  return JSON.stringify(value);
}

/** 本机时间「年-月-日T时:分:秒」，不带时区（Python 的 time.strftime("%Y-%m-%dT%H:%M:%S")）。 */
export function localStamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}
