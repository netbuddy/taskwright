// 卡片答过没有：对话区里一张卡片是开着还是已经答掉、答掉之后收成哪一句。对话区画卡片时用，提交交付物的提示条（model/submit.ts）
// 判断「有没有一张还没回应的提交卡片」时也用，两处说法一致。

import type { AssistantReply, ConversationMessage, UiActionNoted, UserMessage } from "../api/types";
import { textPrefix } from "../../../agent/src/lib/shared_texts";
import { CONTINUE_STAGE_KIND, STAY_TEXT, quietChoiceText } from "./stage";

/** 卡片答过之后收成的一句：用户在这张卡片的文本框里写了回复。 */
export const TYPED_IN_CARD_TEXT = "你在卡片里回复了";
/** 卡片答过之后收成的一句：用户在卡片之外说的话，助手判断是在回答这张卡片。 */
export const ANSWERED_OUTSIDE_TEXT = "你回答了这张卡片";
/** 卡片收成的一句：用户搁下没有答，助手在后面把同一个问题重发了一遍。这一句前面不打勾。 */
export const RESENT_TEXT = "这个问题在后面重新问了";

/** 答了一张卡片的那一条消息，连同卡片上收成的那一句。 */
interface CardAnswer {
  text: string;
  /** 用户选了不发话的一项（「继续本阶段」等）时留下的那条界面操作通知。 */
  stay?: UiActionNoted;
  /** 用户点了卡片上的选项时发出的那句话。 */
  click?: UserMessage;
  /** 用户在这张卡片里写了回复（问答卡片上选好候选再按「发送」也是这一种）时发出的那句话。 */
  typed?: UserMessage;
}

/**
 * 一张卡片是怎样答掉的；还开着返回 null。卡片之后的消息从前往后看，认这几种：
 * - 带着这张卡片标识的话：点了卡片上的选项，或者在卡片的文本框里打了字；
 * - 指着这张卡片的那条「不发话」的界面操作通知（提议的卡片上选了「继续本阶段」一类）；
 * - 助手后面的一条回复写明用户的话回答了这张卡片（answers_card），或者把这张卡片重发了一遍（resends_card）；
 * - 没有带卡片标识的点击（早先的记录、任务状况卡上的按钮）与界面操作之后发给助手的那句话：只在助手还没有再回复之前算。
 * 用户在底部输入框打的字不算：它可能是在说别的事，是不是在回答这张卡片由助手判断，判断的结果在助手的下一条回复上。
 */
function answerOf(messages: ConversationMessage[], index: number): CardAnswer | null {
  const options = (messages[index] as AssistantReply).act?.options ?? [];
  const replyId = (messages[index] as AssistantReply).message_id;
  let repliedSince = false;
  for (let i = index + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === "ui_action_noted" && (m as UiActionNoted).kind === CONTINUE_STAGE_KIND && (m as UiActionNoted).reply_message_id === replyId) {
      return { text: `你选了「${quietChoiceText((m as UiActionNoted).option_key)}」`, stay: m as UiActionNoted };
    }
    if (m.type === "assistant_reply") {
      const later = m as AssistantReply;
      if ((later.answers_card ?? []).includes(replyId)) return { text: ANSWERED_OUTSIDE_TEXT };
      if (later.resends_card === replyId) return { text: RESENT_TEXT };
      repliedSince = true;
      continue;
    }
    if (m.type !== "user_message") continue;
    const u = m as UserMessage & { card?: { choice?: string } | null };
    const note = u.annotation as { reply_message_id?: string | null; option_key?: string; option_text?: string } | null;
    const tagged = note?.reply_message_id ?? null;
    if (u.origin === "card_choice") {
      // 带着别的卡片的标识：答的不是这一张。没有带标识的只认紧跟在卡片后面的。
      if (tagged ? tagged !== replyId : repliedSince) continue;
      // 先按卡片上选项的键查回选项的文字：后端对 card 写法的请求把 option_text 也填成了键（例如 deny），不能直接用；
      // 查不到再用标注里的 option_text，最后从「我选：…」里取。
      const key = u.card?.choice ?? note?.option_key;
      const byKey = options.find((o) => o.key === key)?.text;
      return { text: `你选了「${byKey ?? note?.option_text ?? u.text.replace(/^我选：/, "")}」`, click: u };
    }
    if (u.origin === "ui_request") {
      if (repliedSince) continue;
      if (u.text.startsWith(textPrefix("ui_ops.viewed_notice"))) return { text: "你在卡片上表示看过了" };
      // 早期版本的会话里是界面确认之后那句话。
      return { text: u.text.startsWith("我已经在界面上确认了") ? "你在界面上确认了" : "你在界面上操作过了" };
    }
    // 在这张卡片的文本框里打的字带着它的标识；底部输入框打的字不带，接着往后找。
    if (tagged === replyId) return { text: TYPED_IN_CARD_TEXT, typed: u };
  }
  return null;
}

/** 卡片答过没有：答过了返回卡片上收成的那一句（「你选了「…」」「你在卡片里回复了」「你回答了这张卡片」等），还开着返回 null。规则见 answerOf。 */
export function answeredText(messages: ConversationMessage[], index: number): string | null {
  return answerOf(messages, index)?.text ?? null;
}

/** 答这张卡片的那句话（在卡片里写的回复，或者点选项发出的那句）：问答卡片收起时据它写选了哪几项。还开着时返回 null。 */
export function answeredTypedText(messages: ConversationMessage[], index: number): string | null {
  const answer = answerOf(messages, index);
  return answer?.typed?.text ?? answer?.click?.text ?? null;
}

/** 用户在进入卡片上选了「继续本阶段」之后，卡片答过了的那一句。 */
export const STAYED_TEXT = `你选了「${STAY_TEXT}」`;

/** 这张卡片是不是用户点了不发话的一项答过的（「继续本阶段」「留在本段」「需要修改」「看过了，生成文档」）。 */
export function answeredByStaying(messages: ConversationMessage[], index: number): boolean {
  return answerOf(messages, index)?.stay !== undefined;
}

/** 那条通知记的是点了哪一项；早先的通知没有记，是 null。 */
export function answeredStayKey(messages: ConversationMessage[], index: number): string | null {
  return answerOf(messages, index)?.stay?.option_key ?? null;
}

/**
 * 答这张卡片的那次点击是「进入」某个阶段而阶段没有移动时，任务当时所在的阶段；别的情形是 null。
 * 与 answeredText 看的是同一条消息：答了这张卡片的那一句。
 */
export function answeredUnmoved(messages: ConversationMessage[], index: number): string | null {
  return answerOf(messages, index)?.click?.stage_unmoved?.at ?? null;
}

/**
 * 同上那次点击没有移动的原因：not_in_flow 是任务当时不在需求分析流程里（空闲，或者正在单独开展一项活动）；
 * not_ready 是要去的那一步前置条件不满足；别的情形是 null。
 */
export function answeredUnmovedWhy(messages: ConversationMessage[], index: number): string | null {
  return answerOf(messages, index)?.click?.stage_unmoved?.why ?? null;
}

/** 同上 not_ready 时缺的是什么（活动声明的前置条件的说法）；别的情形是 null。 */
export function answeredUnmovedBlocked(messages: ConversationMessage[], index: number): string | null {
  return answerOf(messages, index)?.click?.stage_unmoved?.blocked ?? null;
}
