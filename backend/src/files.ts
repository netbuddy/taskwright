/** 读文本文件：按 UTF-8 解码，行尾统一成 \n（\r\n 与单独的 \r 都换成 \n），与 Python 以文本方式读文件的结果相同。 */

import { readFileSync } from "node:fs";

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 严格解码：不是合法的 UTF-8 时抛错。 */
export function readTextFile(path: string): string {
  return normalizeNewlines(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
}

/** 宽松解码：不合法的字节换成替换字符。 */
export function readTextFileLenient(path: string): string {
  return normalizeNewlines(new TextDecoder("utf-8").decode(readFileSync(path)));
}

/**
 * 按行切开，行分隔符与 Python 的 str.splitlines 相同：除了 \n、\r\n、\r，还有 \v、\f、\x1c、\x1d、\x1e、\x85、
 * \u2028、\u2029。会话文件按这个规则切行（一行里的字符串值含有这几个字符时，那一行会被切断、读不出来，与 Python 版一致）。
 */
export function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
