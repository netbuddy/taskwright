/**
 * 正文逐句的出处判法：一句话算有着落，要么句末有一个括注（「（某某 p32）」「（你）」），要么以推断的起头语开头。
 * 正文里的 Markdown 表（例如步骤表）一行算一句：最后一格写的是出处，这一格不空、不是占位就算有着落；表头与分隔行不算句。
 * 保存修订在核读位置核对页的正文时用它（lib/save_revision.ts），评测脚本也调这同一段代码，两处判法一致。
 * 只用字符串处理，不用 node 模块；页面不导入它。
 */

/** 具体实例的句子以它起头：实例写在正文里，紧跟它所说明的那句，同样要带出处。 */
export const INSTANCE_HEAD = "例如";

/** 正文里有没有一句实例（以 INSTANCE_HEAD 起头的句子）。 */
export function hasInstance(text: string): boolean {
  return sentencesOf(text).some((one) => one.startsWith(INSTANCE_HEAD));
}

/** 推断的句子以这几种说法起头。 */
export const INFERENCE_HEADS = ["这意味着", "由此看"] as const;

/** 句末括注：全角括号里一到六十个字，后面只跟句末标点。 */
const CITED_TAIL = /（[^（）]{1,60}）[。！？]?$/;

/** 表的分隔行：只有竖线、横线、冒号与空白。 */
const TABLE_RULE = /^\|[\s:|-]*-[\s:|-]*$/;

/** 表行最后一格是这些写法时算没有写出处。 */
const SOURCE_PLACEHOLDER = /^(?:—+|-+|无|空|待定|？+|\?+)$/;

function isTableRow(line: string): boolean {
  return line.startsWith("|");
}

/** 表行各格的文字，去掉首尾的竖线。 */
function cellsOf(row: string): string[] {
  return row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((one) => one.trim());
}

/** 正文里第一张表的表头各格；正文里没有表时返回 null。 */
export function firstTableHeader(text: string): string[] | null {
  const row = text.split(/\n+/).map((one) => one.trim()).find(isTableRow);
  return row === undefined ? null : cellsOf(row);
}

/**
 * 正文按空行与换行分段，每段按句末标点切成句；切出来不到两个字的不算一句。
 * 表行整行算一句，格里有句号也不切；一张表的第一行是表头，与分隔行一样不算句。
 */
export function sentencesOf(text: string): string[] {
  const lines = text.split(/\n+/).map((one) => one.trim());
  return lines.flatMap((line, index) => {
    if (!isTableRow(line)) return line.split(/(?<=[。！？])/);
    if (TABLE_RULE.test(line) || !isTableRow(lines[index - 1] ?? "")) return [];
    return [line];
  }).map((one) => one.trim()).filter((one) => one.length > 1);
}

/** 这一句有没有着落：句末括注，或者推断的起头语；表行看最后一格。 */
export function sentenceGrounded(sentence: string): boolean {
  const one = sentence.trim();
  if (isTableRow(one)) {
    const last = cellsOf(one).at(-1) ?? "";
    return last !== "" && !SOURCE_PLACEHOLDER.test(last);
  }
  return CITED_TAIL.test(one) || INFERENCE_HEADS.some((head) => one.startsWith(head));
}

/** 正文里没有着落的句子，按出现的次序。 */
export function ungroundedSentences(text: string): string[] {
  return sentencesOf(text).filter((one) => !sentenceGrounded(one));
}
