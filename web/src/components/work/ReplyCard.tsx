// 「回复」的末位主行为渲染成卡片。
//
// 按钮走哪里，判据是：结果要写进库的走 actions，需要执行者再出力的走 messages。
//   confirm 「这几条都看过了」→ actions（mark_viewed，条目与修订号取自卡片，notify_executor 为真），点一次把点名条目标为已读；「不对」→ messages
//   choose  某个选项 → messages；suggest「采纳」「换一个」→ messages；propose「就这样做」「不要」→ messages
//           例外：提议进入下一个阶段的卡片上留在这一段的那一项，一律显示成「继续本阶段」，点了走 actions（continue_stage）：
//           只把卡片标为已选，不替用户发话，不引出助手的一次运行；提议仍然开着，从输入框上方的「待决定」一行进入。
//           提议退回前面阶段的卡片上「留在本段」、编写文档阶段请用户过目的卡片上「需要修改」同样走 continue_stage，各显示自己的文字。
//           请过目的卡片上「看过了，生成文档」也不发话：先留一条 continue_stage 的通知，再把卡片点名的页标为已读，然后打开生成文档。
//   ask     挂在条目上：能标为暂不处理的条目各一个「暂不处理」→ actions（keep_pending），「我不知道，你按常识补」→ messages；
//           没挂条目（scope 为 general，或者没有写 items）：「我不知道，你按常识补」「暂不处理」→ messages
// 发给执行者的话只用第 7 节的固定模板。卡片里始终有「或者直接告诉我你的想法」的输入框。
// 评审没有通过的条目也可以标为看过，不拦，点的时候提示一句（第 6 节规则 4）。
// 样式与结构照设计原型的 .act 卡片：标题小字、「标签＋值」几行、深色主按钮加浅色次按钮、卡片内输入框；
// 关联条目写成一行「条目编号小标签＋标题＋修订 N」，请过目卡片（confirm）再写看过与否：现在的修订看过写「修订 9（已读）」，
// 从没看过写「修订 9（未读）」，看过更早的修订写「修订 9（已读 · 你看过修订 4，之后又改过）」——已读是条目级、单向的。
// 完成前还有未读时（除了未读与这一版还没有工具的评审，完成条件都已满足），还没结掉的卡片下面提示「还有 N 条未读」，点它条目区筛出未读。
// 依据写成「依据：…」小标签。
// 单一写入者：有未保存的条目编辑时（hold），卡片上会启动执行者或写库的按钮一律灰化，
// 卡片里写明「先保存或取消正在编辑的条目」；卡片内的输入框照常能打字，发送键灰化。执行者工作中（writesOff）同样灰化。

import { useRef, useState } from "react";
import { Popconfirm } from "antd";
import type { Act, ActKind, ActionRequest, MessageRequest, Task } from "../../api/types";
import { CONFIRM_CONDITION, SOURCE_ITEM, conditionState, isUnread, itemContext, lastViewedRevision, reviewState, sourceKindNow, unreadItems } from "../../model/items";
import { storyPlace } from "../../model/overall";
import {
  DOCUMENT_REVIEWED_KEY, ENTER_KEYS, REVIEWED_HINT, isActingKey, isQuietKey, proposalCardKind, quietChoiceText, quietHint, quietText, stageUnmovedLine,
  type ProposalCardKind,
} from "../../model/stage";
import { restoreOnFailure, type SendResult } from "./sendRestore";
import { isKnowledgeLocator } from "../../model/knowledge";

/** 有未保存的条目编辑时，对话区与卡片上会发话或写库的按钮为什么不能用。 */
export const HOLD_TEXT = "先保存或取消正在编辑的条目";
/** 没保存的是对一张图的改动时的说法（图表页签里改 Mermaid 文本）。 */
export const DIAGRAM_HOLD_TEXT = "先保存或放弃对图的改动";

/** 在卡片的文本框里发话时，卡片标识里 choice 写的固定值。 */
export const CARD_TYPED_CHOICE = "typed";
/** 卡片答过之后收成的一句：用户在这张卡片的文本框里写了回复。 */
export const TYPED_IN_CARD_TEXT = "你在卡片里回复了";
/** 卡片答过之后收成的一句：用户在卡片之外说的话，助手判断是在回答这张卡片。 */
export const ANSWERED_OUTSIDE_TEXT = "你回答了这张卡片";
/** 卡片收成的一句：用户搁下没有答，助手在后面把同一个问题重发了一遍。这一句前面不打勾。 */
export const RESENT_TEXT = "这个问题在后面重新问了";

/** 第 7 节的固定模板。 */
export const TEMPLATES = {
  choose: (optionText: string) => `我选：${optionText}`,
  confirmWrong: "这个不对。",
  adopt: "我采纳这个建议。",
  another: "请换一个建议。",
  proposeYes: "就这样做。",
  proposeNo: "不要这样做。",
  /** 提问卡片「我不知道，你按常识补」。 */
  dontKnow: (itemIds: string) => `关于 ${itemIds}，我不知道，你按常识补上并标明是你补的。`,
  /** 没挂条目的提问卡片「我不知道，你按常识补」：没有条目可点名，说的是这一问。 */
  dontKnowGeneral: "这个我不知道，你按常识补上并标明是你补的。",
  /** 没挂条目的提问卡片「暂不处理」。 */
  setAside: "这个问题暂不处理，接着往下做。",
};
// 「暂不处理这条」发给执行者的那句「我先不管 {条目编号}，请接着往下做。」（后端写的话，没有跟着页面的按钮改）由后端在直接操作成功后发，
// 见 backend/src/executor.ts 的 keepPendingNotice；前端只发直接操作。

/**
 * 卡片顶上那行小字。confirm 这种卡片请用户看几个条目现在的内容，叫「请过目」，不叫「请确认」：「确认」容易被读成征求同意，
 * 而征求同意的是提议。助手一侧的说明、回复工具的返回里仍把这种行为写作「请确认」，指的是同一种。
 */
/** 助手提议进入下一个阶段的那张请选择卡片的标题。 */
export const STAGE_CARD_TITLE = "进入下一阶段 · 请决定";
/** 助手提议退回前面的阶段的卡片、编写文档阶段请用户过目补写的页的卡片的标题。 */
export const BACK_CARD_TITLE = "退回前面的阶段 · 请决定";
export const REVIEW_CARD_TITLE = "补写的内容 · 请过目";
const PROPOSAL_TITLES: Record<ProposalCardKind, string> = { enter: STAGE_CARD_TITLE, back: BACK_CARD_TITLE, review: REVIEW_CARD_TITLE };
/** 提议的卡片上点名的页前面那一行小字。 */
const PROPOSAL_LOOK: Record<ProposalCardKind, string> = { enter: "请先看：", back: "牵涉到：", review: "补写了这几页：" };

const KIND_LABEL: Record<ActKind, string> = { ask: "提问", confirm: "请过目", suggest: "给建议值", choose: "请选择", propose: "提议" };
/** 卡片正文那一行左边的小标签，照原型的写法。 */
const TEXT_LABEL: Record<ActKind, string> = { ask: "问题", confirm: "", suggest: "要定的事", choose: "要定的事", propose: "我的提议" };

export interface CardHandlers {
  onAction: (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string) => void;
  /** 发出一句话；返回假表示没有发出去（卡片里自己打的字这时放回卡片的输入框）。 */
  onMessage: (text: string, card?: MessageRequest["card"]) => SendResult;
  /** 条目区筛出未读的条目。 */
  onShowUnread?: () => void;
  /**
   * 请过目的卡片上点了「看过了，生成文档」：留一条通知、把点名的页标为已读、打开生成文档，不引出助手的一次运行。
   * 返回假表示没有做成（按钮放开，可以再点）。
   */
  onReviewed?: ReviewedHandler;
}

export type ReviewedHandler = (replyMessageId: string, items: { item_id: string; revision_no?: number | null }[]) => boolean | Promise<boolean>;

/** 一张卡片是不是助手提议进入下一个阶段的：请选择，其中一个选项的键是「进入」某个阶段的键。 */
export function stageCardOf(act: Act): boolean {
  return act.kind === "choose" && (act.options ?? []).some((o) => o.key in ENTER_KEYS);
}

/** 一张卡片是助手的哪一种提议：进入下一个阶段、退回前面的阶段、请用户过目补写的页；不是提议是 null。 */
export function proposalKindOfCard(act: Act): ProposalCardKind | null {
  return act.kind === "choose" ? proposalCardKind(act.options) : null;
}

/** 完成前还挡着的只剩未读：未满足的完成条件都是「每个条目用户确认」；还有别的条件没满足（包括评审通过）时不算。 */
function onlyUnreadLeft(task: Task | null): boolean {
  const unmet = (task?.completion?.conditions ?? []).filter((c) => conditionState(c) === "unmet");
  return unmet.length > 0 && unmet.every((c) => c.name === CONFIRM_CONDITION);
}

export function ReplyCard({ act, replyMessageId, replyText = "", task, disabled, hold = false, holdText = HOLD_TEXT, writesOff = false, answered, stayed = false, stayedKey = null, unmovedAt = null, handlers, onOpenItem, onLocate }: {
  /** 这张卡片是用户选了「继续本阶段」答过的（对话记录里有那条界面操作通知）：两个选项留着，进入的那一项变淡，「继续本阶段」带勾。 */
  stayed?: boolean;
  /** 对话记录里那条界面操作通知记的是点了哪一项（「留在本段」「需要修改」「看过了，生成文档」）；早先的通知没有记，不给。 */
  stayedKey?: string | null;
  /** 这张卡片所在的那条回复的正文；复述的卡片据它判断故事写在卡片里还是写在回复里。 */
  replyText?: string;
  act: Act;
  replyMessageId: string;
  task: Task | null;
  /** 任务已结束或助手不可用：卡片整个不能用。 */
  disabled?: boolean;
  /** 有未保存的条目编辑。 */
  hold?: boolean;
  /** hold 时写的原因；不给是条目的那一句。 */
  holdText?: string;
  /** 执行者正在工作。 */
  writesOff?: boolean;
  /** 这张卡片答过了（或者在后面重发了）时，写成「✓ 你选了…」一类的一句话，按钮与输入框收起（原型的「结掉卡片」）。 */
  answered?: string | null;
  /** 答这张卡片的那次点击是「进入」某个阶段而阶段没有移动时，任务当时所在的阶段；「✓ 你选了…」下面据此多写一句小字。 */
  unmovedAt?: string | null;
  handlers: CardHandlers;
  onOpenItem?: (itemId: string) => void;
  /** 点「依据：材料原文」小标签，文档区滚到这句原文。 */
  /** 点依据看原文；locator 是那条依据的出处。 */
  onLocate?: (excerpt: string, locator?: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [quietHere, setQuietHere] = useState<string | null>(null);

  const card = (choice: string): MessageRequest["card"] => ({ reply_message_id: replyMessageId, kind: act.kind, choice });
  const say = (text: string, choice: string, label = choice) => {
    setChosen(label);
    handlers.onMessage(text, card(choice));
  };
  /** 在提议的卡片上选不生效的那一项（「继续本阶段」「留在本段」「需要修改」）：只留一条界面操作通知，不发话。 */
  const stay = (optionKey: string) => {
    setChosen(quietText(optionKey));
    setQuietHere(optionKey);
    handlers.onAction({ kind: "continue_stage", targets: [], fields: { reply_message_id: replyMessageId, option_key: optionKey }, notify_executor: false }, `选择${quietText(optionKey)}`);
  };
  /** 在请过目的卡片上选「看过了，生成文档」：不发话；没有做成时放开按钮。 */
  const reviewed = () => {
    setChosen(quietChoiceText(DOCUMENT_REVIEWED_KEY));
    setQuietHere(DOCUMENT_REVIEWED_KEY);
    void Promise.resolve(handlers.onReviewed?.(replyMessageId, act.items ?? []) ?? false).then((ok) => {
      if (ok === false) { setChosen(null); setQuietHere(null); }
    });
  };
  const refs = act.items ?? [];
  const contexts = refs.map((r) => itemContext(task, r.item_id));
  // 提问挂在条目上时是「暂不处理」与「我不知道，你按常识补」；scope 为 general 的提问、没有挂条目的提问是「我不知道，你按常识补」与「暂不处理」。
  const askOnItems = act.kind === "ask" && act.scope !== "general" && refs.length > 0;
  const askGeneral = act.kind === "ask" && !askOnItems;
  const pendingRefs = askOnItems ? refs.filter((r, i) => contexts[i].pending) : [];
  const keepPending = (ref: { item_id: string; revision_no?: number }) => {
    setChosen(`暂不处理 ${ref.item_id}`);
    const current = task?.items.find((i) => i.item_id === ref.item_id)?.revision_no;
    handlers.onAction(
      { kind: "keep_pending", targets: [{ item_id: ref.item_id, base_revision: ref.revision_no ?? current }], notify_executor: true },
      `把 ${ref.item_id} 标为暂不处理`,
    );
  };
  const failedReview = (act.items ?? []).filter((ref) => {
    const item = task?.items.find((i) => i.item_id === ref.item_id);
    return item && reviewState(item, task ?? undefined).state === "failed";
  });
  const off = disabled || !!chosen || hold || writesOff;
  const offTitle = hold ? holdText : undefined;
  const sendOff = disabled || hold || writesOff;
  const done = answered ?? (chosen ? `你选了「${chosen}」` : null);
  // 选了不生效那一项的提议卡片（刚点的，或者对话记录里有那条通知）：不收成一句，留着两个选项的样子。
  // 点的是哪一项：刚点的认本地记的；对话记录里的认通知记的键，早先的通知没有记，取卡片上不生效的那一项。
  const proposalKind = proposalKindOfCard(act);
  const quietPicked = !proposalKind ? null
    : stayed ? stayedKey ?? (act.options ?? []).find((o) => isQuietKey(o.key))?.key ?? null
    : quietHere && !answered ? quietHere : null;
  const wasStayed = quietPicked !== null && isQuietKey(quietPicked);
  const wasReviewed = quietPicked === DOCUMENT_REVIEWED_KEY;
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const sendDraft = () => {
    if (!draft.trim() || sendOff) return;
    const original = draft;
    setDraft("");
    // 带上这张卡片的标识：这句话算作对这张卡片的回答（底部输入框发的话不带，不关卡片）。对话记录里有了这句话，卡片才收起。
    restoreOnFailure(handlers.onMessage(original.trim(), card(CARD_TYPED_CHOICE)), original, () => latestDraft.current, setDraft);
  };
  /** 条目行末尾的修订说明：请过目卡片写上次看过的修订，其余卡片只写修订号。 */
  const revisionNote = (itemId: string, revision: number) => {
    if (act.kind !== "confirm") return `修订 ${revision}`;
    const item = task?.items.find((i) => i.item_id === itemId);
    const last = item ? lastViewedRevision(item) : null;
    if (!item || last == null || isUnread(item)) return `修订 ${revision}（未读）`;
    if (last >= revision) return `修订 ${revision}（已读）`;
    return `修订 ${revision}（已读 · 你看过修订 ${last}，之后又改过）`;
  };

  const confirmButton = (
    <button type="button" className="btn sm pri" disabled={off} title={offTitle} onClick={failedReview.length ? undefined : () => doConfirm()} data-testid="card-confirm">
      这几条都看过了
    </button>
  );
  function doConfirm() {
    setChosen("这几条都看过了");
    handlers.onAction(
      { kind: "mark_viewed", targets: (act.items ?? []).map((r) => ({ item_id: r.item_id, base_revision: r.revision_no })), notify_executor: true },
      `把 ${(act.items ?? []).map((r) => `${r.item_id} 修订 ${r.revision_no}`).join("、")} 标为已读`,
    );
  }
  const unread = task ? unreadItems(task) : [];
  const showUnread = !done && !disabled && unread.length > 0 && onlyUnreadLeft(task);

  // 助手复述的卡片（请选择，三个选项是「采纳为例子」「有误，需修改」「换一个例子重述」，键是 story_ok、story_fix、story_again）：
  // 故事画成故事的样子，卡片本身不要底色。
  const story = storyPlace(act, replyText);
  // 助手提议往前走的卡片（请选择，其中一个选项的键是「进入」某个阶段的四个键之一）：标题写「进入下一阶段 · 请决定」，
  // 进入的那个选项画成主按钮，点名的条目前面写「请先看：」。用户点了进入，系统替用户记移动，阶段条随库事件变。
  const stageCard = !story && stageCardOf(act);
  // 另两种提议的卡片：提议退回前面的阶段（「退回某阶段」「留在本段」）、编写文档阶段请用户过目（「看过了，生成文档」「需要修改」）。
  const proposal = story ? null : proposalKind;

  return (
    <div className={`act${story ? " retell" : ""}`} data-kind={act.kind} data-testid={`act-${act.kind}`} data-story={story ?? undefined}
      data-stage-card={stageCard ? "true" : undefined} data-proposal={proposal ?? undefined}>
      <div className="tt">{story ? "复述 · 请核对" : proposal ? PROPOSAL_TITLES[proposal] : KIND_LABEL[act.kind] ?? act.kind}</div>
      {contexts.length > 0 && (
        <div data-testid="card-context">
          {proposal && <div className="ctxh" data-testid="card-look-first">{PROPOSAL_LOOK[proposal]}</div>}
          {contexts.map((c, i) => (
            <div key={c.itemId}>
              <div className="ctx" role="button" onClick={() => onOpenItem?.(c.itemId)} data-testid={`card-context-${c.itemId}`}>
                <span className="ref">{c.itemId}</span>
                <span className="ctxname">{c.title}</span>
                {refs[i].revision_no != null && <span className="ver" data-testid={`card-revision-${c.itemId}`}>{revisionNote(c.itemId, refs[i].revision_no!)}</span>}
              </div>
              {c.extras.map((x) => <div key={x.name} className="ctxx"><span className="fk">{x.name}</span>{x.value}</div>)}
            </div>
          ))}
        </div>
      )}
      {story === "card" ? (
        <div className="story" data-testid="card-story">
          {act.text.split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      ) : (
        <div>{!story && TEXT_LABEL[act.kind] && <span className="fk">{TEXT_LABEL[act.kind]}</span>}<span className="val">{act.text}</span></div>
      )}

      {act.kind === "suggest" && (
        <>
          <div><span className="fk">建议值</span><span className="val">{act.value}</span></div>
          <div>
            {(act.basis ?? []).map((b, i) => (
              <span key={i} className="evi" title={b.excerpt} onClick={() => b.kind === "文档原文" && onLocate?.(b.excerpt, b.locator)}>
                依据：{b.kind === "文档原文" ? (isKnowledgeLocator(b.locator ?? "") ? "知识库" : "材料原文") : sourceKindNow(b.kind)}{b.kind && sourceKindNow(b.kind) === SOURCE_ITEM && b.locator ? ` ${b.locator}` : ""}{b.excerpt ? `「${b.excerpt.length > 18 ? b.excerpt.slice(0, 18) + "…" : b.excerpt}」` : ""}
              </span>
            ))}
          </div>
        </>
      )}

      {act.kind === "propose" && (act.preview ?? []).length > 0 && (
        <div className="prev">
          <div className="pvh">这样做之后会变成什么</div>
          {act.preview!.map((p, i) => (
            <div key={i} className={`pvrow ${p.effect === "remove" ? "out" : p.effect === "add" ? "inn" : ""}`}>
              <span className="mk">{p.effect === "remove" ? "−" : p.effect === "add" ? "＋" : "·"}</span><span>{p.text}</span>
            </div>
          ))}
        </div>
      )}

      {!done && (
        <>
          {hold && <div className="sw-holdhint" data-testid="card-hold-hint">{holdText}</div>}
          {act.kind === "choose" && (
            <div className="actions opts">
              {(act.options ?? []).map((o) => (proposal && isQuietKey(o.key) ? (
                <button type="button" key={o.key} className="btn sm" disabled={off} title={offTitle} onClick={() => stay(o.key)} data-testid={`card-option-${o.key}`}>
                  {quietText(o.key)}
                </button>
              ) : proposal === "review" && o.key === DOCUMENT_REVIEWED_KEY ? (
                <button type="button" key={o.key} className="btn sm pri" disabled={off} title={offTitle} onClick={reviewed} data-testid={`card-option-${o.key}`}>
                  {o.text}
                </button>
              ) : (
                <button type="button" key={o.key} className={`btn sm${proposal && isActingKey(o.key) ? " pri" : ""}`} disabled={off} title={offTitle}
                  onClick={() => say(TEMPLATES.choose(o.text), o.key, o.text)} data-testid={`card-option-${o.key}`}>
                  {o.text}
                </button>
              )))}
            </div>
          )}

          {act.kind === "confirm" && (
            <div className="actions">
              {failedReview.length ? (
                <Popconfirm
                  title={`${failedReview.map((r) => r.item_id).join("、")} 的评审没有通过，你仍然可以标为看过。`}
                  okText="仍然标为看过" cancelText="再看看" onConfirm={doConfirm}>
                  {confirmButton}
                </Popconfirm>
              ) : confirmButton}
              <button type="button" className="btn sm" disabled={off} title={offTitle} onClick={() => say(draft.trim() || TEMPLATES.confirmWrong, "不对")} data-testid="card-wrong">不对</button>
            </div>
          )}

          {act.kind === "suggest" && (
            <div className="actions">
              <button type="button" className="btn sm pri" disabled={off} title={offTitle} onClick={() => say(TEMPLATES.adopt, "采纳")} data-testid="card-adopt">采纳</button>
              <button type="button" className="btn sm" disabled={off} title={offTitle} onClick={() => say(TEMPLATES.another, "换一个")} data-testid="card-another">换一个</button>
            </div>
          )}

          {act.kind === "propose" && (
            <div className="actions">
              <button type="button" className="btn sm pri" disabled={off} title={offTitle} onClick={() => say(TEMPLATES.proposeYes, "就这样做")} data-testid="card-yes">就这样做</button>
              <button type="button" className="btn sm" disabled={off} title={offTitle} onClick={() => say(TEMPLATES.proposeNo, "不要")} data-testid="card-no">不要</button>
            </div>
          )}

          {askOnItems && (
            <div className="actions">
              {pendingRefs.map((ref) => (
                <button type="button" key={ref.item_id} className="btn sm" disabled={off} title={offTitle} onClick={() => keepPending(ref)} data-testid={`card-keep-${ref.item_id}`}>
                  {pendingRefs.length === 1 ? "暂不处理这条" : `暂不处理 ${ref.item_id}`}
                </button>
              ))}
              <button type="button" className="btn sm" disabled={off} title={offTitle} data-testid="card-dont-know"
                onClick={() => say(TEMPLATES.dontKnow(refs.map((r) => r.item_id).join("、")), "不知道", "我不知道，你按常识补")}>
                我不知道，你按常识补
              </button>
            </div>
          )}

          {askGeneral && (
            <div className="actions">
              <button type="button" className="btn sm" disabled={off} title={offTitle} data-testid="card-dont-know-general"
                onClick={() => say(TEMPLATES.dontKnowGeneral, "不知道", "我不知道，你按常识补")}>
                我不知道，你按常识补
              </button>
              <button type="button" className="btn sm" disabled={off} title={offTitle} data-testid="card-set-aside"
                onClick={() => say(TEMPLATES.setAside, "暂不处理")}>
                暂不处理
              </button>
            </div>
          )}

          <div className="quickreply">
            <input type="text" placeholder="或者直接告诉我你的想法…" value={draft} disabled={disabled}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendDraft(); }} data-testid="card-input" />
            <span className={`qr-send${sendOff ? " off" : ""}`} role="button" aria-label="发送" title={offTitle} onClick={sendDraft} data-testid="card-send">↑</span>
          </div>
        </>
      )}

      {done && wasStayed && (
        <>
          <div className="actions opts stayed" data-testid="card-stayed">
            {(act.options ?? []).map((o) => (
              <button type="button" key={o.key} disabled className={`btn sm${isActingKey(o.key) ? " pri faded" : isQuietKey(o.key) ? " picked" : ""}`}
                data-testid={`card-option-${o.key}`}>{isQuietKey(o.key) ? `${quietText(o.key)} ✓` : o.text}</button>
            ))}
          </div>
          <div className="done pale" data-testid="card-stay-hint">{quietHint(quietPicked!)}</div>
        </>
      )}
      {done && !wasStayed && <div className={`done${done === RESENT_TEXT ? " pale" : ""}`} data-testid="card-done">{done === RESENT_TEXT ? done : `✓ ${done}`}</div>}
      {done && wasReviewed && <div className="done pale" data-testid="card-reviewed-hint">{REVIEWED_HINT}</div>}
      {done && unmovedAt && <div className="done pale" data-testid="card-stage-unmoved">{stageUnmovedLine(unmovedAt)}</div>}
      {showUnread && (
        <div className="sw-unread-hint" data-testid="card-unread">
          还有 {unread.length} 条未读
          {handlers.onShowUnread && <button type="button" className="btn sm" onClick={handlers.onShowUnread} data-testid="card-show-unread">筛出来看</button>}
        </div>
      )}
    </div>
  );
}
