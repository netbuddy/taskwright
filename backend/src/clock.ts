/**
 * 时间一律给带时区的 ISO 8601 文字，精确到秒（多出的小数截去）。
 *
 * 库里记的是本机的挂钟时间文字（例如 2026-09-21T18:56:34.219，没有时区），pi 会话条目记的是世界时
 * （例如 2026-09-22T01:56:44.120Z），两种都换成本机时区。
 */

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** 一个时刻写成本机时区的「年-月-日T时:分:秒+时:分」。 */
export function localIso(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function now(): string {
  return localIso(new Date());
}

// 「年-月-日」加可选的「T 时:分:秒.小数」与可选的时区（Z 或 ±时:分）。
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** ISO 文字解析成时刻；没写时区的按本机时间。认不出时是 null。 */
function parseIso(text: string): Date | null {
  const m = ISO.exec(text);
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", s = "0", frac = "", zone] = m.slice(1);
  const ms = frac ? Math.floor(Number(`0.${frac}`.slice(0, 8)) * 1000) : 0;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms] as const;
  if (!zone) return new Date(...parts);
  let utc = Date.UTC(...parts);
  if (zone && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    utc -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0")) * 60000;
  }
  return new Date(utc);
}

/** 库里的本地时间文字 → 带时区的 ISO 8601；空时为 null，认不出时原样返回。 */
export function fromLocalText(text: string | null | undefined): string | null {
  if (!text) return null;
  const at = parseIso(text);
  return at && !Number.isNaN(at.getTime()) ? localIso(at) : text;
}

/** pi 会话条目的世界时 → 本机时区的 ISO 8601；空时为 null，认不出时原样返回。 */
export function fromUtcIso(text: string | null | undefined): string | null {
  if (!text) return null;
  const at = parseIso(text);
  return at && !Number.isNaN(at.getTime()) ? localIso(at) : text;
}

/** pi 会话条目的世界时 → 秒数（算一次工作用了多久）。解析不了时为 null。 */
export function parseUtcIso(text: string | null | undefined): number | null {
  if (!text) return null;
  const at = parseIso(text);
  return at && !Number.isNaN(at.getTime()) ? at.getTime() / 1000 : null;
}

/**
 * 文件的修改时刻（纳秒）→ 带时区的 ISO 8601。先按四舍六入五成双取到微秒，再截到秒，
 * 与 Python 的 datetime.fromtimestamp(秒数) 取到秒的结果一致。
 */
export function fromEpochNs(ns: bigint): string {
  const q = ns / 1000n;
  const r = ns % 1000n;
  const us = r > 500n || (r === 500n && q % 2n === 1n) ? q + 1n : q;
  return localIso(new Date(Number(us / 1000000n) * 1000));
}
