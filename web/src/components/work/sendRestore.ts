// 发送失败时把原文放回输入框：对话区、回复卡片、问题卡片三处输入框共用。

/** 发送函数的返回：真＝发出去了，假＝没有发出去；不关心结果的调用方（例如测试里的空函数）什么都不返回。 */
export type SendResult = Promise<boolean> | void;

/**
 * 输入框在发送时已经清空。发送函数报告没有发出去、而且输入框此时还是空的，就把原文放回去，用户可以直接重发；
 * 用户已经接着打了新字就不放回，免得盖掉新字。current 读的是输入框此刻的内容（用 ref 取，不用发送那一刻的旧值）。
 */
export function restoreOnFailure(result: SendResult, original: string, current: () => string, setDraft: (text: string) => void): void {
  void Promise.resolve(result).then((sent) => {
    if (sent === false && current() === "") setDraft(original);
  });
}
