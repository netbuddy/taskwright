// 对话区：渲染 user_message、assistant_reply（act 为空显示成文字，不为空加一张卡片）、ui_action_noted、
// system_note、过程摘要（work_summary），以及正在进行的工作（step 过程行）。
// 结构与样式照设计原型：你的话是右对齐的灰底气泡，助手的话是白底卡片，过程是左边一条细线的灰色小字，
// 系统说明是青色虚线框（其中每条会话开头写给助手看的任务状况消息默认折叠成一行要点，点开才是全文），界面操作留一行灰字；输入框在底部，Enter 发出、Shift+Enter 换行。
//
// 修订的呈现：对话区不放改动块；执行者回复底部一枚小标签「产生了修订 8、9」
// （回复的元数据，不是执行者的话），点它右侧栏切到「修订」页签并滚到那几次修订。用户直接操作的「界面操作」说明保留。
// 发送（第 2、2B 节）：执行者工作中发送键灰化，输入框照常能打字、草稿留到运行结束（对话严格轮替，一句话对应一次运行）；
// 有未保存的条目编辑时发送键与卡片按钮灰化，输入框上方提示「先保存或取消正在编辑的条目」。
// 停止：助手在这条会话里工作时，输入框右边的发送键换成同一位置、同样大小的停止键（一个实心小方块）；点了之后进入「正在停止」
// （方块变淡并脉动，不能再点），这次工作结束时换回发送键。发送与停止互斥：工作中本来就不能发送。停止不受未保存的条目编辑影响；
// 工作中按回车不会停止，只有点方块才停。停下之后会话里留一条界面操作通知（种类 stop_run），对话区画成「你停止了助手这一次的工作」。

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AssistantReply, ConversationMessage, CurrentWork, Inform, SavedFacts, SystemNote, Task, UiActionNoted, UserMessage, WorkSummary } from "../../api/types";
import type { OutgoingMessage } from "../../state/workState";
import { formatSeconds } from "../../model/format";
import { statusNoteLine } from "../../model/statusNote";
import { storyPlace } from "../../model/overall";
import { CONTINUE_STAGE_KIND, CONTINUE_STAGE_LINE, STAY_TEXT, stageMoveLine } from "../../model/stage";
import { PendingProposal } from "./PendingProposal";
import { HOLD_TEXT, ReplyCard, type CardHandlers } from "./ReplyCard";
import { Markdown, renderInline } from "./Markdown";
import { restoreOnFailure, type SendResult } from "./sendRestore";
import { useService } from "../ServiceControls";
import { uploadAccept } from "../../model/upload";
import { STARTING_SEND_TITLE } from "./executorHint";

/** 输入框平常的占位文字。 */
export const INPUT_PLACEHOLDER = "把你的想法直接告诉助手，或者在右边直接动手改…";
/**
 * 输入框整个停用时（任务已经结束、助手不可用、助手在另一条会话里工作）的占位文字。停用的原因已经写在输入框上方的提示条里，
 * 这里不再重复整句。
 */
export const DISABLED_PLACEHOLDER = "现在不能在这里输入，原因见上方。";
/** 输入框整个停用、或有没保存的条目编辑时，发送键的悬停提示：原因已经写在上方的提示条里，这里只说一句短的，不重复整句。 */
export const SEND_OFF_TITLE = "现在不能发送，原因见上方。";

/** 用户停止了助手一次工作之后，对话区那条界面操作通知的写法。会话里的原文是写给助手看的，不显示。 */
export const STOP_NOTE_TEXT = "你停止了助手这一次的工作";
/** 停止键的悬停提示，与点了之后等这次工作结束期间的提示。 */
export const STOP_TITLE = "停止助手这一次的工作";
export const STOPPING_TITLE = "正在停止";
/** 界面操作通知的种类：用户停止了助手一次工作（后端 conversation.ts 的 STOP_RUN）。 */
export const STOP_RUN_KIND = "stop_run";

/** 执行者工作中，发送键为什么不能用。 */
export const TURN_TEXT = "助手正在工作，做完这一轮才能发下一句；你可以先把话打好";

export function Conversation({
  messages, currentWork, outgoing, task, disabled, disabledReason, handlers, onSend, onUndo, onOpenItem,
  onAttach, hasEarlier, onLoadEarlier, revisionOf, attachments, draft: outerDraft, onDraft, onLocate, inputRef,
  hold = false, holdText = HOLD_TEXT, working = false, hint = null, starting = false, revisionsOfReply, revisionsOfWork, onRevisionTag, revisionCount, onShowReviews, onStop,
}: {
  messages: ConversationMessage[];
  currentWork: CurrentWork | null;
  outgoing: OutgoingMessage[];
  task: Task | null;
  disabled: boolean;
  disabledReason: string | null;
  handlers: CardHandlers;
  /** 发出一句话；返回假表示没有发出去，这时输入框还空着就把原文放回去。 */
  onSend: (text: string) => SendResult;
  onUndo: (revisionNo: number) => void;
  onOpenItem: (itemId: string) => void;
  onAttach: (file: File) => void;
  hasEarlier: boolean;
  onLoadEarlier: () => void;
  revisionOf: (note: UiActionNoted) => number | null;
  /** 评审结束那一行的「看评审页签」：右侧栏切到评审页签。 */
  onShowReviews?: () => void;
  attachments: string[];
  /** 输入框的内容由页面持有时传进来（「让助手改这一条」要预填它）；不传就由这里自己持有。 */
  draft?: string;
  onDraft?: (text: string) => void;
  onLocate?: (excerpt: string, locator?: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** 有未保存的条目编辑（或者对图的改动）：发送与卡片按钮灰化。 */
  hold?: boolean;
  /** hold 时输入框上方与卡片上写的原因；不给是条目的那一句。 */
  holdText?: string;
  /** 执行者正在工作：发送与卡片按钮灰化，输入框照常能打字；撤销修订也不能点。 */
  working?: boolean;
  /**
   * 停止助手正在进行的这一次工作。只在助手是在这条会话里工作时给；给了并且 working 为真，发送键就换成停止键。
   * 返回真＝停止的请求做成了；假＝没有做成（原因由页面另行提示），停止键恢复成可以再点。
   */
  onStop?: () => Promise<boolean>;
  /** 不拦住操作的提示（助手已经退出、正在启动、还没启动），显示成输入框上方的蓝色提示条；见 executorHint.ts。 */
  hint?: string | null;
  /** 助手正在启动：发送按钮暂不可用，输入框照常可以打字。 */
  starting?: boolean;
  /** 一条回复产生了哪几次修订（按工作编号从修订日志里取）。 */
  revisionsOfReply?: (reply: AssistantReply) => number[];
  /** 一次工作产生了哪几次修订（按工作编号从修订日志里取）；被停下或出错停下的那一轮在说明下面带修订小标签。 */
  revisionsOfWork?: (workId: string) => number[];
  onRevisionTag?: (revisions: number[]) => void;
  /** 修订日志里有几次修订。它变了（例如刷新之后修订日志才读回来），修订小标签随之画出或变化，对话区要跟着留在最底部。 */
  revisionCount?: number;
}) {
  // 附件按钮可选的文件类型取自服务信息；还没取到时不过滤，由后端拒绝。
  const service = useService();
  const [ownDraft, setOwnDraft] = useState("");
  const draft = outerDraft ?? ownDraft;
  const setDraft = onDraft ?? setOwnDraft;
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, currentWork?.steps.length, outgoing.length]);
  // 停止：点了之后到这次工作结束之前是「正在停止」；请求没有做成时恢复。工作结束（working 变假）时复位，下一次工作又是可以点的停止键。
  const canStop = working && !!onStop;
  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!working) setStopping(false); }, [working]);
  const stop = () => {
    if (!onStop || stopping) return;
    setStopping(true);
    void onStop().then((ok) => { if (!ok) setStopping(false); });
  };
  // 修订小标签要等修订日志读回来才画出，那时上面这一下已经滚过了，内容又长高一截，刷新之后对话区会停在最上面、最后一行被输入框挡住。
  // 所以修订日志变了时再滚一次到底，但只在用户停在最底部时滚：用户自己往上翻着看的时候不把他拽回去。
  const atBottom = useRef(true);
  const onScroll = () => {
    const el = box.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };
  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [revisionCount]);

  const sendOff = disabled || hold || working || starting;
  const sendTitle = (disabled && disabledReason) || hold ? SEND_OFF_TITLE : disabled ? undefined : working ? TURN_TEXT : starting ? STARTING_SEND_TITLE : "发送";
  // 输入框此刻的内容：发送失败时据它判断用户有没有接着打新字。
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const send = () => {
    if (!draft.trim() || sendOff) return;
    const original = draft;
    setDraft("");
    restoreOnFailure(onSend(original.trim()), original, () => latestDraft.current, setDraft);
  };
  // 提示条：任务结束、助手不可用、执行者在另一条会话里工作这几种整个输入框都停用；有未保存的条目编辑时提示先保存或取消。
  const note = disabledReason ?? (hold ? holdText : hint);
  const info = !disabledReason && !hold && !!hint;

  return (
    <>
      <div className="msgs" ref={box} onScroll={onScroll} data-testid="conversation">
        {hasEarlier && <span className="earlier" role="button" onClick={onLoadEarlier}>再往前读一段对话</span>}
        {messages.map((m, index) => (
          <MessageView key={(m as { message_id?: string }).message_id ?? `${m.type}-${index}`} message={m} task={task} handlers={handlers}
            disabled={disabled} hold={hold} holdText={holdText} working={working}
            answered={m.type === "assistant_reply" && (m as AssistantReply).act ? answeredText(messages, index) : null}
            stayed={m.type === "assistant_reply" && !!(m as AssistantReply).act && answeredByStaying(messages, index)}
            unmovedAt={m.type === "assistant_reply" && (m as AssistantReply).act ? answeredUnmoved(messages, index) : null}
            onUndo={onUndo} onOpenItem={onOpenItem} onLocate={onLocate} revisionOf={revisionOf}
            revisions={m.type === "assistant_reply" && revisionsOfReply ? revisionsOfReply(m as AssistantReply)
              : m.type === "work_summary" && revisionsOfWork ? revisionsOfWork((m as WorkSummary).work_id) : []} onRevisionTag={onRevisionTag}
            onShowReviews={onShowReviews} />
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
        <div className={`busybar${note ? " show" : ""}${info ? " info" : ""}`} data-testid={note ? (info ? "executor-hint" : "busy-note") : undefined}>{note}</div>
        <PendingProposal proposal={disabledReason ? null : task?.stage?.proposal} off={sendOff} offTitle={sendTitle} onMessage={handlers.onMessage} />
        <div className="inbox">
          <textarea ref={inputRef} value={draft} disabled={disabled} rows={2} data-testid="chat-input"
            placeholder={disabledReason ? DISABLED_PLACEHOLDER : INPUT_PLACEHOLDER}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <div className="inrow">
            <span className="chip" style={{ cursor: disabled ? "not-allowed" : "pointer" }} role="button"
              onClick={() => !disabled && fileInput.current?.click()}>📎 附一份材料</span>
            {attachments.map((a) => <span key={a} className="chip on">附件：{a.split("/").pop()}</span>)}
            {canStop ? (
              <span className={`send stop${stopping ? " stopping" : ""}`} role="button" aria-label={stopping ? STOPPING_TITLE : "停止"} aria-disabled={stopping}
                title={stopping ? STOPPING_TITLE : STOP_TITLE} onClick={stop} data-testid="stop-run"><i /></span>
            ) : (
              <span className={`send${sendOff ? " off" : ""}`} role="button" aria-label="发送" title={sendTitle} onClick={send} data-testid="send">↑</span>
            )}
          </div>
        </div>
        <input ref={fileInput} type="file" accept={uploadAccept(service.info)} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onAttach(f); e.target.value = ""; }} />
      </div>
    </>
  );
}

/**
 * 卡片答过没有：这条回复之后用户说的第一句话。点卡片发出的写「你选了「…」」，界面操作之后发给助手的写那件事，
 * 自己打的写「你直接写了回复」。这条回复之后还没有用户的话就是还没答，返回 null。
 * 提议进入下一个阶段的卡片另有一种答法：用户选了「继续本阶段」，会话里留的是一条界面操作通知（不是一句话），认它指着这条回复的那一条。
 */
export function answeredText(messages: ConversationMessage[], index: number): string | null {
  const options = (messages[index] as AssistantReply).act?.options ?? [];
  const replyId = (messages[index] as AssistantReply).message_id;
  for (let i = index + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === "assistant_reply") return null;
    if (m.type === "ui_action_noted" && (m as UiActionNoted).kind === CONTINUE_STAGE_KIND && (m as UiActionNoted).reply_message_id === replyId) return STAYED_TEXT;
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

/** 用户在进入卡片上选了「继续本阶段」之后，卡片答过了的那一句。 */
export const STAYED_TEXT = `你选了「${STAY_TEXT}」`;

/** 这张卡片是不是用户选了「继续本阶段」答过的。 */
export function answeredByStaying(messages: ConversationMessage[], index: number): boolean {
  return answeredText(messages, index) === STAYED_TEXT;
}

/**
 * 答这张卡片的那次点击是「进入」某个阶段而阶段没有移动时，任务当时所在的阶段；别的情形是 null。
 * 与 answeredText 看的是同一句话：这条回复之后用户说的第一句。
 */
export function answeredUnmoved(messages: ConversationMessage[], index: number): string | null {
  for (let i = index + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === "assistant_reply") return null;
    if (m.type === "user_message") return (m as UserMessage).origin === "card_choice" ? (m as UserMessage).stage_unmoved?.at ?? null : null;
  }
  return null;
}

/** 告知里点名的条目编号，按出现的先后，同一个条目只列一次。 */
function itemIds(informs: Inform[]): string[] {
  return [...new Set(informs.flatMap((one) => (one.items ?? []).map((ref) => ref.item_id)))];
}

/** 告知里点名的一个条目：点它在右侧打开这个条目。 */
function ItemLink({ id, onOpenItem }: { id: string; onOpenItem: (itemId: string) => void }) {
  return <span className="ref" role="button" title={`打开 ${id}`} onClick={() => onOpenItem(id)} data-testid={`inform-item-${id}`}>{id}</span>;
}

/**
 * 任务状况消息：默认只有一行要点（行尾 ▸），点这一行展开成「系统说明」加全文（行尾 ▾），再点收起。展开没展开只记在这个组件里，
 * 重新打开会话又是折叠的。
 */
function StatusNote({ line, text }: { line: string; text: string }) {
  // 要点里的数（「2 份」「1/3」「0 条」）单独包起来，样式给它深一级的字；整行的文字不变。
  const parts: ReactNode[] = line.split(/(\d+(?:\/\d+)?(?: [份条个])?)/).map((part, i) => (i % 2 ? <b key={i} className="n">{part}</b> : part));
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((now) => !now);
  return (
    <div className={`sysnote folding${open ? " open" : ""}`} data-testid="system-note">
      <div className="sn-line" role="button" tabIndex={0} aria-expanded={open} title={open ? "点这里收起" : "点这里看全文"} onClick={toggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }} data-testid="system-note-line">
        <span>{parts}</span><span className="sn-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="sn-full" data-testid="system-note-full">
          <div className="sh">系统说明</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>
        </div>
      )}
    </div>
  );
}

function MessageView({ message, task, handlers, disabled, hold, holdText, working, answered, stayed, unmovedAt, onUndo, onOpenItem, onLocate, revisionOf, revisions, onRevisionTag, onShowReviews }: {
  message: ConversationMessage;
  task: Task | null;
  handlers: CardHandlers;
  disabled: boolean;
  hold: boolean;
  holdText: string;
  working: boolean;
  revisions: number[];
  onRevisionTag?: (revisions: number[]) => void;
  onShowReviews?: () => void;
  answered: string | null;
  stayed: boolean;
  /** 答这张卡片的那次点击没有让阶段移动时，任务当时所在的阶段。 */
  unmovedAt: string | null;
  onUndo: (revisionNo: number) => void;
  onOpenItem: (itemId: string) => void;
  onLocate?: (excerpt: string, locator?: string) => void;
  revisionOf: (note: UiActionNoted) => number | null;
}) {
  switch (message.type) {
    case "system_note": {
      // 助手没有用回复工具说话时系统提醒它的那一句不画：那是助手与系统之间的纠正，不是给用户看的。只按 kind 认，没有 kind 的旧数据照旧显示。
      if ((message as SystemNote).kind === "reply_fallback") return null;
      const line = statusNoteLine(message as SystemNote);
      if (line !== null) return <StatusNote line={line} text={message.text} />;
      return (
        <div className="sysnote" data-testid="system-note">
          <div className="sh">系统说明</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div>
        </div>
      );
    }
    case "user_message": {
      const m = message as UserMessage;
      const from = m.origin === "card_choice" ? "点卡片发出的" : m.origin === "ui_request" ? "界面操作之后发给助手的" : null;
      const bubble = <div className="m user">{m.text}{from && <span className="from-ui">{from}</span>}</div>;
      // 这次点击替用户记了一次阶段移动：在那句话下面写一行，与界面操作记号同款。
      if (!m.stage_move) return bubble;
      return <>{bubble}<div className="selfnote" data-testid="stage-move-user">{stageMoveLine(m.stage_move)}</div></>;
    }
    case "assistant_reply": {
      const m = message as AssistantReply;
      return (
        <>
        {/* 助手在这条回复里把任务退回了前面的阶段：在回复上面写一行，与助手的过程行同款 */}
        {m.stage_move && <div className="proc"><div className="pline" data-testid="stage-move-assistant"><span className="ptxt">{stageMoveLine(m.stage_move)}</span></div></div>}
        <div className="m ai" data-testid="assistant-reply">
          {m.degraded ? (
            <>
              <div className="degraded" data-testid="degraded-note">这条回复没有按结构发出。</div>
              <p style={{ whiteSpace: "pre-wrap" }}>{m.text}</p>
            </>
          ) : (
            <>
              {m.informs.length > 0 && m.act && (
                <ul className="informs">
                  {m.informs.map((one, i) => (
                    <li key={i}>{renderInline(one.text)}{itemIds([one]).map((id) => (
                      <span key={id}> <ItemLink id={id} onOpenItem={onOpenItem} /></span>
                    ))}</li>
                  ))}
                </ul>
              )}
              {/* 助手复述、故事写在回复正文里时（卡片只是一句问话加三个选项），正文画成故事的样子 */}
              {m.act && storyPlace(m.act, m.text) === "reply"
                ? <div className="story" data-testid="reply-story"><Markdown text={m.text} /></div>
                : <Markdown text={m.text} />}
              {!m.act && itemIds(m.informs).length > 0 && (
                <div className="mentioned" data-testid="mentioned-items">
                  提到的条目：{itemIds(m.informs).map((id, i) => <span key={id}>{i > 0 && "、"}<ItemLink id={id} onOpenItem={onOpenItem} /></span>)}
                </div>
              )}
            </>
          )}
          {m.act && !m.degraded && (
            <ReplyCard act={m.act} replyMessageId={m.message_id} replyText={m.text} task={task} disabled={disabled} hold={hold} holdText={holdText} writesOff={working} answered={answered} stayed={stayed} unmovedAt={unmovedAt}
              handlers={handlers} onOpenItem={onOpenItem} onLocate={onLocate} />
          )}
          {revisions.length > 0 && (
            <div>
              <span className="sw-revtag" role="button" title="在右侧的「修订」页签里看这几次修订" onClick={() => onRevisionTag?.(revisions)}
                data-testid="revision-tag">产生了修订 {revisions.join("、")}</span>
            </div>
          )}
        </div>
        </>
      );
    }
    case "ui_action_noted": {
      const m = message as UiActionNoted;
      if (m.kind === "request_review" && m.review) {
        // 评审结束：只写一句结论，逐条发现在评审页签里看。
        const r = m.review;
        return (
          <div className="selfnote" data-testid="review-done">
            评审完成：{r.passed} 条合规、{r.failed} 条不合规（问题 {r.problems} 处、建议 {r.advice} 条）{r.unfinished ? `，${r.unfinished} 条没有评完` : ""}。
            {onShowReviews && <span className="undo" role="button" onClick={onShowReviews} data-testid="show-reviews">看评审页签 ›</span>}
          </div>
        );
      }
      if (m.kind === STOP_RUN_KIND) return <div className="selfnote stop" data-testid="stop-note">{STOP_NOTE_TEXT}</div>;
      // 用户在进入卡片上选了「继续本阶段」：会话里那一句是写给助手看的，页面上换成一句短的。
      if (m.kind === CONTINUE_STAGE_KIND) return <div className="selfnote" data-testid="continue-stage-note">{CONTINUE_STAGE_LINE}</div>;
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
      return <WorkSummaryLine summary={message as WorkSummary} revisions={revisions} onRevisionTag={onRevisionTag} />;
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

/**
 * 助手这一轮连续被拒到上限、由系统停下的那一轮，摘要行下面的说明。哪一步因为什么被拒写在展开的过程摘要里，这里不写原因。
 * 「已经保存的修订」的意思与出错停下那一句相同。
 */
export const LIMIT_NOTE = "这一轮助手一直没有按规矩回答，系统让它停下了。已经保存的修订保留着；你可以再说一句，让它重新来。";

/** 出错停下的那一轮，摘要行下面的说明。这一轮没有保存修订时「已经保存的修订」指此前各轮保存的，照样成立。 */
export const FAILED_NOTE = "这一轮因为出错停下了，助手没有做完。已经保存的修订保留着；你可以再说一句，让它接着做。";

/** 被用户停下的那次工作什么都没有保存时，摘要行下面的说明。 */
export const NOTHING_SAVED_NOTE = "这一次工作没有保存任何东西。";

/**
 * 被用户停下的那次工作，摘要行下面的说明，按事实写：保存了哪几次修订（连着的写成「修订 N 到 M」）、碰到几个条目、几张图，都保留着；
 * 怎样撤销。不做任何自动回滚，撤销只由用户在「修订」页签里手工做；图的改动页面上不能撤销，所以有图时另说一句。
 * saved 是后端停下之后按任务库算出的（摘要的 saved）；没有这一项时（旧数据、后端没法查）按修订日志里归到这次工作的修订写，不写个数。
 */
export function stoppedNote(saved: SavedFacts | null | undefined, logRevisions: number[] = []): string {
  const revisions = saved ? saved.revisions : logRevisions;
  const [items, diagrams] = saved ? [saved.items, saved.diagrams] : [0, 0];
  if (revisions.length === 0 && diagrams === 0) return NOTHING_SAVED_NOTE;
  const contiguous = revisions.every((r, i) => i === 0 || r === revisions[i - 1] + 1);
  const range = revisions.length === 0 ? "" : revisions.length === 1 ? `修订 ${revisions[0]}`
    : contiguous ? `修订 ${revisions[0]} 到 ${revisions[revisions.length - 1]}` : `修订 ${revisions.join("、")}`;
  const counts = [items > 0 ? `${items} 个条目` : "", range && diagrams > 0 ? `${diagrams} 张图` : ""].filter(Boolean);
  const what = range ? `${range}${counts.length ? `（${counts.join("、")}）` : ""}` : ` ${diagrams} 张图`;
  const kept = revisions.length + diagrams > 1 ? "都保留着" : "保留着";
  const undo = revisions.length > 1 ? "要撤销其中某条，到右侧「修订」页签逐条撤销。" : revisions.length === 1 ? "要撤销它，到右侧「修订」页签撤销。" : "";
  const diagramNote = diagrams > 0 ? "图的改动不能撤销，可以让助手改回去。" : "";
  return `这一次工作保存了${what}，${kept}；停下时正在做的那一步没有完成。${undo}${diagramNote}`;
}

/**
 * 过程摘要：收成一行「助手做了 N 步，用了 X ▸ 展开看做了什么」，点开是合并后的阶段。
 * 这一轮被用户停下或者出错停下时，下面加一行琥珀色的说明；这一轮保存过修订时再带「产生了修订 N」，点它在「修订」页签里看。
 */
export function WorkSummaryLine({ summary, revisions = [], onRevisionTag }: {
  summary: WorkSummary;
  /** 这一轮保存过的修订。 */
  revisions?: number[];
  onRevisionTag?: (revisions: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const head = `助手做了 ${summary.step_count} 步，用了 ${formatSeconds(summary.seconds)}`;
  const endNote = summary.outcome === "stopped_by_user" ? stoppedNote(summary.saved, revisions) : summary.outcome === "failed" ? FAILED_NOTE
    : summary.outcome === "stopped_by_limit" ? LIMIT_NOTE : null;
  return (
    <>
      {summary.understanding && (
        <div className="proc" data-testid="work-summary-understanding">
          <div className="pline"><span className="ptxt">{summary.understanding}</span></div>
        </div>
      )}
      <div className="proc-fold" role="button" onClick={() => setOpen(!open)} data-testid="work-summary">
        {head} <span className="pexp">{open ? "▾ 收起" : "▸ 展开看做了什么"}</span>
      </div>
      {open && (
        <div className="proc" data-testid="work-summary-stages">
          {summary.stages?.length
            ? summary.stages.map((s, i) => <StageLine key={i} stage={s} index={i} />)
            : <div className="pline"><span className="ptxt">这次工作没有记下过程。</span></div>}
        </div>
      )}
      {endNote && (
        <div className="proc stopnote" data-testid="work-end-note">
          <div className="pline"><span className="ptxt">{endNote}</span></div>
        </div>
      )}
      {endNote && revisions.length > 0 && (
        <div>
          <span className="sw-revtag" role="button" title="在右侧的「修订」页签里看这几次修订" onClick={() => onRevisionTag?.(revisions)}
            data-testid="work-end-revisions">产生了修订 {revisions.join("、")}</span>
        </div>
      )}
    </>
  );
}
