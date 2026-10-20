// 问答卡片：选项带出处或理由、或者可以多选的「请选择」画成这一种（原型「问答卡片：每问带候选答案」）。
//
// 每个候选一个方框行：左列序号圆标 A、B、C……，右列第一行选项文字、第二行理由（小字）；单选是圆形序号、多选是方形序号，
// 选中的填色、没选的空心。自由回答是同样的方框行，序号接在候选之后，框里是多行输入。点选项只是选上，按「发送」才发：
// 选的与补充的合成一句普通的话「我选：……。补充：……」，带着这张卡片的标识、choice 写 typed（与在卡片的文本框里打字同一条通道），
// 对话记录里有了这句话卡片就收起。「先跳过这一问」发一句固定的话。
// 答过之后收成一行「提问 · 标题 · 已答：选 A · 有补充」。

import { useRef, useState } from "react";
import type { Act, MessageRequest } from "../../api/types";
import { CARD_TYPED_CHOICE, HOLD_TEXT, type CardHandlers } from "./ReplyCard";
import { restoreOnFailure } from "./sendRestore";
import { RESENT_TEXT } from "../../model/cardAnswer";

/** 卡片顶上那行小字的开头。 */
export const QUESTION_LABEL = "提问";
/** 「先跳过这一问」发给助手的那句话。 */
export const SKIP_TEXT = "这一问先跳过，接着往下。";
/** 多选的卡片在问题下面写的一句提示。 */
export const MULTIPLE_HINT = "可以多选。";

/** 一张卡片是不是问答卡片：请选择，选项里有写了理由的，或者标了多选。 */
export function isQuestionCard(act: Act): boolean {
  return act.kind === "choose" && (act.multiple === true || (act.options ?? []).some((o) => !!o.reason?.trim()));
}

/** 第 index 个序号：A、B、C……。 */
export const letterOf = (index: number): string => String.fromCharCode(65 + index);

/** 选好的候选与补充的话合成的那一句。什么都没选、什么都没写时是空文字。 */
export function composeAnswer(chosen: string[], free: string): string {
  const said = free.trim();
  if (chosen.length === 0) return said;
  const picked = `我选：${chosen.join("；")}。`;
  return said ? `${picked}补充：${said}` : picked;
}

/** 卡片收起时那一行「已答」之后写什么：选了哪几项、有没有补充；跳过的写「已跳过」。answer 是用户答这张卡片的那句话。 */
export function answeredSummary(act: Act, answer: string | null): string {
  if (answer === null) return "已答";
  if (answer.trim() === SKIP_TEXT) return "已跳过";
  if (!answer.startsWith("我选：")) return "已答：自己回答";
  const body = answer.slice("我选：".length);
  const cut = body.indexOf("。补充：");
  const picked = cut >= 0 ? body.slice(0, cut) : body.replace(/。$/, "");
  const names = new Set(picked.split("；"));
  const letters = (act.options ?? []).map((o, i) => (names.has(o.text) ? letterOf(i) : null)).filter((x): x is string => x !== null);
  return `已答：选 ${letters.length > 0 ? letters.join("、") : "了候选"}${cut >= 0 ? " · 有补充" : ""}`;
}

export function QuestionCard({ act, replyMessageId, disabled, hold = false, holdText = HOLD_TEXT, writesOff = false, answered, answeredWith = null, handlers }: {
  act: Act;
  replyMessageId: string;
  disabled?: boolean;
  hold?: boolean;
  holdText?: string;
  writesOff?: boolean;
  /** 卡片答过了（或者在后面重发了）时那一句；还开着是 null。 */
  answered?: string | null;
  /** 用户在这张卡片里写的那句回复（据它写选了哪几项）；不是这样答的为 null。 */
  answeredWith?: string | null;
  handlers: CardHandlers;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [free, setFree] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const latestFree = useRef(free);
  latestFree.current = free;
  const options = act.options ?? [];
  const multiple = act.multiple === true;
  const title = act.topic?.trim() ? `${QUESTION_LABEL} · ${act.topic.trim()}` : QUESTION_LABEL;

  const done = answered ?? null;
  if (done !== null || sent !== null) {
    const line = done === RESENT_TEXT ? done : answeredSummary(act, sent ?? answeredWith);
    return (
      <div className="act qcard done-card" data-kind="choose" data-testid="question-card-done">
        <span className="tt">{title}</span><span className="qdone"> · {line}</span>
      </div>
    );
  }

  const off = disabled || hold || writesOff;
  const toggle = (key: string) => {
    if (off) return;
    setPicked((now) => (multiple ? (now.includes(key) ? now.filter((k) => k !== key) : [...now, key]) : now.includes(key) ? [] : [key]));
  };
  const card: MessageRequest["card"] = { reply_message_id: replyMessageId, kind: act.kind, choice: CARD_TYPED_CHOICE };
  const answer = composeAnswer(options.filter((o) => picked.includes(o.key)).map((o) => o.text), free);
  const send = (text: string) => {
    if (!text || off) return;
    const original = free;
    setSent(text);
    setFree("");
    // 没有发出去：卡片重新打开，补充的话放回输入框（用户已经接着打了新字就不放回）。
    const result = handlers.onMessage(text, card);
    restoreOnFailure(result, original, () => latestFree.current, setFree);
    void Promise.resolve(result).then((ok) => { if (ok === false) setSent(null); });
  };

  return (
    <div className={`act qcard${multiple ? " multi" : ""}`} data-kind="choose" data-testid="question-card">
      <div className="tt">{title}</div>
      <div className="qtext">{act.text}</div>
      {multiple && <div className="qhint">{MULTIPLE_HINT}</div>}
      {hold && <div className="sw-holdhint" data-testid="card-hold-hint">{holdText}</div>}
      {options.map((o, i) => (
        <div key={o.key} role={multiple ? "checkbox" : "radio"} aria-checked={picked.includes(o.key)} aria-disabled={off}
          className={`qopt${picked.includes(o.key) ? " on" : ""}`} onClick={() => toggle(o.key)} data-testid={`question-option-${o.key}`}>
          <i>{letterOf(i)}</i>
          <b>{o.text}</b>
          {o.reason?.trim() && <small>{o.reason}</small>}
        </div>
      ))}
      <label className="qopt free">
        <i>{letterOf(options.length)}</i>
        <textarea placeholder="或者直接写你的看法；选了上面的也可以在这里补一句" value={free} disabled={disabled}
          onChange={(e) => setFree(e.target.value)} data-testid="question-free" />
      </label>
      <div className="qbar">
        <button type="button" className="btn sm pri" disabled={off || !answer} title={hold ? holdText : undefined} onClick={() => send(answer)} data-testid="question-send">发送</button>
        <span className={`qskip${off ? " off" : ""}`} role="button" onClick={() => !off && send(SKIP_TEXT)} data-testid="question-skip">先跳过这一问</span>
      </div>
    </div>
  );
}
