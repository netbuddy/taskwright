// 对话区：渲染 user_message、assistant_reply（act 为空显示成文字，不为空加一张卡片）、ui_action_noted、
// system_note、过程摘要（work_summary），以及正在进行的工作（step 过程行）。
// 结构与样式照设计原型：你的话是右对齐的灰底气泡，助手的话是白底卡片，过程是左边一条细线的灰色小字，
// 系统说明是青色虚线框，界面操作留一行灰字；输入框在底部，Enter 发出、Shift+Enter 换行。
//
// 修订的呈现：对话区不放改动块；执行者回复底部一枚小标签「产生了修订 8、9」
// （回复的元数据，不是执行者的话），点它右侧栏切到「修订」页签并滚到那几次修订。用户直接操作的「界面操作」说明保留。
// 发送（第 2、2B 节）：执行者工作中发送键灰化，输入框照常能打字、草稿留到运行结束（对话严格轮替，一句话对应一次运行）；
// 有未保存的条目编辑时发送键与卡片按钮灰化，输入框上方提示「先保存或取消正在编辑的条目」。

import { useEffect, useRef, useState, type RefObject } from "react";
import type { AssistantReply, ConversationMessage, CurrentWork, Task, UiActionNoted, UserMessage, WorkSummary } from "../../api/types";
import type { OutgoingMessage } from "../../state/workState";
import { formatSeconds } from "../../model/format";
import { HOLD_TEXT, ReplyCard, type CardHandlers } from "./ReplyCard";
import { Markdown, renderInline } from "./Markdown";

/** 执行者工作中，发送键为什么不能用。 */
export const TURN_TEXT = "助手正在工作，做完这一轮才能发下一句；你可以先把话打好";

export function Conversation({
  messages, currentWork, outgoing, task, disabled, disabledReason, handlers, onSend, onUndo, onOpenItem,
  onAttach, hasEarlier, onLoadEarlier, revisionOf, attachments, draft: outerDraft, onDraft, onLocate, inputRef,
  hold = false, working = false, revisionsOfReply, onRevisionTag,
}: {
  messages: ConversationMessage[];
  currentWork: CurrentWork | null;
  outgoing: OutgoingMessage[];
  task: Task | null;
  disabled: boolean;
  disabledReason: string | null;
  handlers: CardHandlers;
  onSend: (text: string) => void;
  onUndo: (revisionNo: number) => void;
  onOpenItem: (itemId: string) => void;
  onAttach: (file: File) => void;
  hasEarlier: boolean;
  onLoadEarlier: () => void;
  revisionOf: (note: UiActionNoted) => number | null;
  attachments: string[];
  /** 输入框的内容由页面持有时传进来（「让助手改这一条」要预填它）；不传就由这里自己持有。 */
  draft?: string;
  onDraft?: (text: string) => void;
  onLocate?: (excerpt: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** 有未保存的条目编辑：发送与卡片按钮灰化。 */
  hold?: boolean;
  /** 执行者正在工作：发送与卡片按钮灰化，输入框照常能打字；撤销修订也不能点。 */
  working?: boolean;
  /** 一条回复产生了哪几次修订（按工作编号从修订日志里取）。 */
  revisionsOfReply?: (reply: AssistantReply) => number[];
  onRevisionTag?: (revisions: number[]) => void;
}) {
  const [ownDraft, setOwnDraft] = useState("");
  const draft = outerDraft ?? ownDraft;
  const setDraft = onDraft ?? setOwnDraft;
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, currentWork?.steps.length, outgoing.length]);

  const sendOff = disabled || hold || working;
  const sendTitle = disabled ? disabledReason ?? undefined : hold ? HOLD_TEXT : working ? TURN_TEXT : "发送";
  const send = () => { if (draft.trim() && !sendOff) { onSend(draft.trim()); setDraft(""); } };
  // 提示条：任务结束、助手不可用、执行者在另一条会话里工作这几种整个输入框都停用；有未保存的条目编辑时提示先保存或取消。
  const note = disabledReason ?? (hold ? HOLD_TEXT : null);

  return (
    <>
      <div className="msgs" ref={box} data-testid="conversation">
        {hasEarlier && <span className="earlier" role="button" onClick={onLoadEarlier}>再往前读一段对话</span>}
        {messages.map((m, index) => (
          <MessageView key={(m as { message_id?: string }).message_id ?? `${m.type}-${index}`} message={m} task={task} handlers={handlers}
            disabled={disabled} hold={hold} working={working}
            answered={m.type === "assistant_reply" && (m as AssistantReply).act ? answeredText(messages, index) : null}
            onUndo={onUndo} onOpenItem={onOpenItem} onLocate={onLocate} revisionOf={revisionOf}
            revisions={m.type === "assistant_reply" && revisionsOfReply ? revisionsOfReply(m as AssistantReply) : []} onRevisionTag={onRevisionTag} />
        ))}
        {outgoing.map((m) => (
          <div key={m.client_id} className={`m user${m.state === "sending" ? " sending" : ""}`}>
            {m.text}
            {m.state === "failed" && <span className="from-ui bad">没有发出去：{m.error}</span>}
            {m.state === "sending" && <span className="from-ui">发送中</span>}
          </div>
        ))}
        {currentWork && (
          <div className="proc" data-testid="work-live">
            {currentWork.steps.length === 0 && <div className="pline doing"><span className="ptxt">助手开始做事了</span></div>}
            {currentWork.steps.map((s) => (
              <div key={String(s.step_key)} className={`pline${s.in_progress ? " doing" : ""}`} style={s.failed ? { color: "var(--gap)" } : undefined}>
                <span className="ptxt">{s.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={`chat-in${disabledReason ? " busy" : ""}`}>
        <div className={`busybar${note ? " show" : ""}`} data-testid={note ? "busy-note" : undefined}>{note}</div>
        <div className="inbox">
          <textarea ref={inputRef} value={draft} disabled={disabled} rows={2} data-testid="chat-input"
            placeholder={disabledReason ?? "把你的想法直接告诉助手，或者在右边直接动手改…"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <div className="inrow">
            <span className="chip" style={{ cursor: disabled ? "not-allowed" : "pointer" }} role="button"
              onClick={() => !disabled && fileInput.current?.click()}>📎 附一份材料</span>
            {attachments.map((a) => <span key={a} className="chip on">附件：{a.split("/").pop()}</span>)}
            <span className={`send${sendOff ? " off" : ""}`} role="button" aria-label="发送" title={sendTitle} onClick={send} data-testid="send">↑</span>
          </div>
        </div>
        <input ref={fileInput} type="file" accept=".md,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onAttach(f); e.target.value = ""; }} />
      </div>
    </>
  );
}

/**
 * 卡片答过没有：这条回复之后用户说的第一句话。点卡片发出的写「你选了「…」」，界面操作之后发给助手的写那件事，
 * 自己打的写「你直接写了回复」。这条回复之后还没有用户的话就是还没答，返回 null。
 */
export function answeredText(messages: ConversationMessage[], index: number): string | null {
  const options = (messages[index] as AssistantReply).act?.options ?? [];
  for (let i = index + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === "assistant_reply") return null;
    if (m.type !== "user_message") continue;
    const u = m as UserMessage & { card?: { choice?: string } | null };
    if (u.origin === "card_choice") {
      const note = u.annotation as { option_text?: string } | null;
      // 先按卡片上选项的键查回选项的文字：后端对 card 写法的请求把 option_text 也填成了键（例如 deny），不能直接用；
      // 查不到再用标注里的 option_text，最后从「我选：…」里取。
      const key = u.card?.choice ?? (note as { option_key?: string } | null)?.option_key;
      const byKey = options.find((o) => o.key === key)?.text;
      return `你选了「${byKey ?? note?.option_text ?? u.text.replace(/^我选：/, "")}」`;
    }
    if (u.origin === "ui_request") {
      if (u.text.startsWith("我已经看过了")) return "你在卡片上表示看过了";
      // 早期版本的会话里是界面确认之后那句话。
      return u.text.startsWith("我已经在界面上确认了") ? "你在界面上确认了" : "你在界面上操作过了";
    }
    return "你直接写了回复";
  }
  return null;
}

function MessageView({ message, task, handlers, disabled, hold, working, answered, onUndo, onOpenItem, onLocate, revisionOf, revisions, onRevisionTag }: {
  message: ConversationMessage;
  task: Task | null;
  handlers: CardHandlers;
  disabled: boolean;
  hold: boolean;
  working: boolean;
  revisions: number[];
  onRevisionTag?: (revisions: number[]) => void;
  answered: string | null;
  onUndo: (revisionNo: number) => void;
  onOpenItem: (itemId: string) => void;
  onLocate?: (excerpt: string) => void;
  revisionOf: (note: UiActionNoted) => number | null;
}) {
  switch (message.type) {
    case "system_note":
      return (
        <div className="sysnote" data-testid="system-note">
          <div className="sh">系统说明</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div>
        </div>
      );
    case "user_message": {
      const m = message as UserMessage;
      const from = m.origin === "card_choice" ? "点卡片发出的" : m.origin === "ui_request" ? "界面操作之后发给助手的" : null;
      return <div className="m user">{m.text}{from && <span className="from-ui">{from}</span>}</div>;
    }
    case "assistant_reply": {
      const m = message as AssistantReply;
      return (
        <div className="m ai" data-testid="assistant-reply">
          {m.degraded ? (
            <>
              <div className="degraded" data-testid="degraded-note">这条回复没有按结构发出。</div>
              <p style={{ whiteSpace: "pre-wrap" }}>{m.text}</p>
            </>
          ) : (
            <>
              {m.informs.length > 0 && m.act && <ul className="informs">{m.informs.map((t, i) => <li key={i}>{renderInline(t)}</li>)}</ul>}
              <Markdown text={m.text} />
            </>
          )}
          {m.act && !m.degraded && (
            <ReplyCard act={m.act} replyMessageId={m.message_id} task={task} disabled={disabled} hold={hold} writesOff={working} answered={answered}
              handlers={handlers} onOpenItem={onOpenItem} onLocate={onLocate} />
          )}
          {revisions.length > 0 && (
            <div>
              <span className="sw-revtag" role="button" title="在右侧的「修订」页签里看这几次修订" onClick={() => onRevisionTag?.(revisions)}
                data-testid="revision-tag">产生了修订 {revisions.join("、")}</span>
            </div>
          )}
        </div>
      );
    }
    case "ui_action_noted": {
      const m = message as UiActionNoted;
      const revision = m.undoable ? revisionOf(m) : null;
      return (
        <div className="selfnote" data-testid="ui-action">
          {m.text}
          {revision != null && (
            <span className={`undo${working ? " off" : ""}`} role="button" title={working ? "助手正在工作，结束后你可以继续修改" : undefined}
              onClick={() => { if (!working) onUndo(revision); }} data-testid="undo-link">撤销修订 {revision}</span>
          )}
        </div>
      );
    }
    case "work_summary":
      return <WorkSummaryLine summary={message as WorkSummary} />;
    default:
      return null;
  }
}

/** 过程摘要：收成一行「助手做了 N 步，用了 X ▸ 展开看做了什么」，点开是合并后的阶段。 */
/** 过程摘要里的一行。保存修订被拒且原因多于一条时，这一行可以点：点开在下方逐条列出全部原因，再点收起。 */
function StageLine({ stage, index }: { stage: NonNullable<WorkSummary["stages"]>[number]; index: number }) {
  const [open, setOpen] = useState(false);
  const reasons = stage.reasons ?? [];
  if (reasons.length <= 1) return <div className="pline"><span className="ptxt">{stage.text}</span></div>;
  return (
    <>
      <div className="pline" role="button" style={{ cursor: "pointer" }} onClick={() => setOpen(!open)} data-testid={`stage-${index}`}>
        <span className="ptxt">{stage.text} {open ? "▾ 收起" : `▸ 看全部 ${reasons.length} 条原因`}</span>
      </div>
      {open && (
        <div className="proc" data-testid={`stage-${index}-reasons`}>
          {reasons.map((r, k) => <div key={k} className="pline"><span className="ptxt">{k + 1}. {r}</span></div>)}
        </div>
      )}
    </>
  );
}

export function WorkSummaryLine({ summary }: { summary: WorkSummary }) {
  const [open, setOpen] = useState(false);
  const head = `助手做了 ${summary.step_count} 步，用了 ${formatSeconds(summary.seconds)}`;
  return (
    <>
      <div className="proc-fold" role="button" onClick={() => setOpen(!open)} data-testid="work-summary">
        {head} {open ? "▾ 收起" : "▸ 展开看做了什么"}
      </div>
      {open && (
        <div className="proc" data-testid="work-summary-stages">
          {summary.stages?.length
            ? summary.stages.map((s, i) => <StageLine key={i} stage={s} index={i} />)
            : <div className="pline"><span className="ptxt">这次工作没有记下过程。</span></div>}
        </div>
      )}
    </>
  );
}
