// 助手没有在运行、但不拦住操作时，对话区输入框上方的那条蓝色提示。说话、点卡片、修改条目都会让服务先把助手启动起来、
// 接回这条会话，所以这几种状态下页面不设只读，只把情况说一句。助手启动不起来（failed_to_start）另算：那时整页只读，由页面写明原因。

import type { ExecutorState } from "../../api/types";

/** 助手已经退出。用固定的文字：后端报的说明里可能带着助手退出的原因，那是给维护者看的，不在页面上显示。 */
export const EXITED_HINT = "助手已经退出，下一次说话时会重新启动。";
/** 用户刚说了一句，服务正在为它启动助手。 */
export const STARTING_AFTER_SEND_HINT = "助手正在启动，启动好之后会接着处理你刚才的话。";
/** 助手正在启动（打开会话、做了一次操作等）。 */
export const STARTING_HINT = "助手正在启动，请稍候。";
/** 正在启动时发送按钮上的说明。 */
export const STARTING_SEND_TITLE = "助手正在启动，请稍候。";

/**
 * 按助手的状态给出提示；不需要提示时为空。justSent 是用户刚发出的话还在「发送中」。
 * 还没启动（not_started）时显示后端的那句话：续接会话失败之后它写明「助手没有接上这条会话，下一次说话时会重新启动。」，
 * 平常是「助手还没有启动。」，两句都不带内部说明。
 */
export function executorHint(executor: ExecutorState | null | undefined, justSent: boolean): string | null {
  switch (executor?.state) {
    case "exited":
      return EXITED_HINT;
    case "starting":
      return justSent ? STARTING_AFTER_SEND_HINT : STARTING_HINT;
    case "not_started":
      return executor.text || null;
    default:
      return null;
  }
}
