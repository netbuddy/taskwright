/**
 * 正文逐句的出处判法：一句话算有着落，要么句末有一个括注（「（某某 p32）」「（你）」），要么以推断的起头语开头。
 * 保存修订在核读位置核对页的正文时用它（lib/save_revision.ts），评测脚本也调这同一段代码，两处判法一致。
 * 只用字符串处理，不用 node 模块；页面不导入它。
 */

/** 推断的句子以这几种说法起头。 */
export const INFERENCE_HEADS = ["这意味着", "由此看"] as const;

/** 句末括注：全角括号里一到六十个字，后面只跟句末标点。 */
const CITED_TAIL = /（[^（）]{1,60}）[。！？]?$/;

/** 正文按空行与换行分段，每段按句末标点切成句；切出来不到两个字的不算一句。 */
export function sentencesOf(text: string): string[] {
  return text.split(/\n+/).flatMap((paragraph) => paragraph.split(/(?<=[。！？])/)).map((one) => one.trim()).filter((one) => one.length > 1);
}

/** 这一句有没有着落：句末括注，或者推断的起头语。 */
export function sentenceGrounded(sentence: string): boolean {
  const one = sentence.trim();
  return CITED_TAIL.test(one) || INFERENCE_HEADS.some((head) => one.startsWith(head));
}

/** 正文里没有着落的句子，按出现的次序。 */
export function ungroundedSentences(text: string): string[] {
  return sentencesOf(text).filter((one) => !sentenceGrounded(one));
}
