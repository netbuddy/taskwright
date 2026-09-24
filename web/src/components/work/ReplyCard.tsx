// 「回复」的末位主行为渲染成卡片。
//
// 按钮走哪里，判据是：结果要写进库的走 actions，需要执行者再出力的走 messages。
//   confirm 「这几条都看过了」→ actions（mark_viewed，条目与修订号取自卡片，notify_executor 为真），点一次把点名条目标为已读；「不对」→ messages
//   choose  某个选项 → messages；suggest「采纳」「换一个」→ messages；propose「就这样做」「不要」→ messages
//   ask     没有按钮，只有输入框
// 发给执行者的话只用第 7 节的固定模板。卡片里始终有「或者直接告诉我你的想法」的输入框。
// 评审没有通过的条目也可以标为看过，不拦，点的时候提示一句（第 6 节规则 4）。
// 样式与结构照设计原型的 .act 卡片：标题小字、「标签＋值」几行、深色主按钮加浅色次按钮、卡片内输入框；
// 关联条目写成一行「条目编号小标签＋标题＋修订 N」，请确认卡片再写看过与否：现在的修订看过写「修订 9（已读）」，
// 从没看过写「修订 9（未读）」，看过更早的修订写「修订 9（已读 · 你看过修订 4，之后又改过）」——已读是条目级、单向的。
// 完成前还有未读时（除了未读与这一版还没有工具的评审，完成条件都已满足），还没结掉的卡片下面提示「还有 N 条未读」，点它条目区筛出未读。
// 依据写成「依据：…」小标签。
// 单一写入者：有未保存的条目编辑时（hold），卡片上会启动执行者或写库的按钮一律灰化，
// 卡片里写明「先保存或取消正在编辑的条目」；卡片内的输入框照常能打字，发送键灰化。执行者工作中（writesOff）同样灰化。

import { useState } from "react";
import { Popconfirm } from "antd";
import type { Act, ActKind, ActionRequest, MessageRequest, Task } from "../../api/types";
import { CONFIRM_CONDITION, conditionState, isUnread, itemContext, lastViewedRevision, REVIEW_CONDITION, reviewState, unreadItems } from "../../model/items";

/** 有未保存的条目编辑时，对话区与卡片上会发话或写库的按钮为什么不能用。 */
export const HOLD_TEXT = "先保存或取消正在编辑的条目";

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
};
// 「先不管这条」发给执行者的那句「我先不管 {条目编号}，请接着往下做。」由后端在直接操作成功后发，
// 见 server/taskwright_server/service/executor.py 的 keep_pending_notice；前端只发直接操作。

const KIND_LABEL: Record<ActKind, string> = { ask: "提问", confirm: "请确认", suggest: "给建议值", choose: "请选择", propose: "提议" };
/** 卡片正文那一行左边的小标签，照原型的写法。 */
const TEXT_LABEL: Record<ActKind, string> = { ask: "问题", confirm: "", suggest: "要定的事", choose: "要定的事", propose: "我的提议" };

export interface CardHandlers {
  onAction: (req: Pick<ActionRequest, "kind" | "targets" | "notify_executor">, label: string) => void;
  onMessage: (text: string, card?: MessageRequest["card"]) => void;
  /** 条目区筛出未读的条目。 */
  onShowUnread?: () => void;
}

/** 完成前还挡着的只剩未读：未满足的完成条件里，除了「用户确认」与这一版还没有工具的「评审通过」，没有别的。 */
function onlyUnreadLeft(task: Task | null): boolean {
  const unmet = (task?.completion?.conditions ?? []).filter((c) => conditionState(c) === "unmet");
  return unmet.length > 0 && unmet.every((c) => c.name === CONFIRM_CONDITION || c.name === REVIEW_CONDITION);
}

export function ReplyCard({ act, replyMessageId, task, disabled, hold = false, writesOff = false, answered, handlers, onOpenItem, onLocate }: {
  act: Act;
  replyMessageId: string;
  task: Task | null;
  /** 任务已结束或助手不可用：卡片整个不能用。 */
  disabled?: boolean;
  /** 有未保存的条目编辑。 */
  hold?: boolean;
  /** 执行者正在工作。 */
  writesOff?: boolean;
  /** 这张卡片之后用户已经说过话时，写成「✓ 你选了…」一类的一句话，按钮与输入框收起（原型的「结掉卡片」）。 */
  answered?: string | null;
  handlers: CardHandlers;
  onOpenItem?: (itemId: string) => void;
  /** 点「依据：材料原文」小标签，文档区滚到这句原文。 */
  onLocate?: (excerpt: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);

  const card = (choice: string): MessageRequest["card"] => ({ reply_message_id: replyMessageId, kind: act.kind, choice });
  const say = (text: string, choice: string, label = choice) => {
    setChosen(label);
    handlers.onMessage(text, card(choice));
  };
  const refs = act.items ?? [];
  const contexts = refs.map((r) => itemContext(task, r.item_id));
  // 提问挂在条目上时才有两个固定按钮；scope 为 general 的提问、没有挂条目的提问只有输入框。
  const askOnItems = act.kind === "ask" && act.scope !== "general" && refs.length > 0;
  const pendingRefs = askOnItems ? refs.filter((r, i) => contexts[i].pending) : [];
  const keepPending = (ref: { item_id: string; revision_no?: number }) => {
    setChosen(`先不管 ${ref.item_id}`);
    const current = task?.items.find((i) => i.item_id === ref.item_id)?.revision_no;
    handlers.onAction(
      { kind: "keep_pending", targets: [{ item_id: ref.item_id, base_revision: ref.revision_no ?? current }], notify_executor: true },
      `把 ${ref.item_id} 标为先不管`,
    );
  };
  const failedReview = (act.items ?? []).filter((ref) => {
    const item = task?.items.find((i) => i.item_id === ref.item_id);
    return item && reviewState(item, task ?? undefined).state === "failed";
  });
  const off = disabled || !!chosen || hold || writesOff;
  const offTitle = hold ? HOLD_TEXT : undefined;
  const sendOff = disabled || hold || writesOff;
  const done = answered ?? (chosen ? `你选了「${chosen}」` : null);
  const sendDraft = () => { if (draft.trim() && !sendOff) { handlers.onMessage(draft.trim()); setDraft(""); } };
  /** 条目行末尾的修订说明：请确认卡片写上次确认的修订，其余卡片只写修订号。 */
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

  return (
    <div className="act" data-kind={act.kind} data-testid={`act-${act.kind}`}>
      <div className="tt">{KIND_LABEL[act.kind] ?? act.kind}</div>
      {contexts.length > 0 && (
        <div data-testid="card-context">
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
      <div>{TEXT_LABEL[act.kind] && <span className="fk">{TEXT_LABEL[act.kind]}</span>}<span className="val">{act.text}</span></div>

      {act.kind === "suggest" && (
        <>
          <div><span className="fk">建议值</span><span className="val">{act.value}</span></div>
          <div>
            {(act.basis ?? []).map((b, i) => (
              <span key={i} className="evi" title={b.excerpt} onClick={() => b.kind === "文档原文" && onLocate?.(b.excerpt)}>
                依据：{b.kind === "文档原文" ? "材料原文" : b.kind}{b.excerpt ? `「${b.excerpt.length > 18 ? b.excerpt.slice(0, 18) + "…" : b.excerpt}」` : ""}
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
          {hold && <div className="sw-holdhint" data-testid="card-hold-hint">{HOLD_TEXT}</div>}
          {act.kind === "choose" && (
            <div className="actions opts">
              {(act.options ?? []).map((o) => (
                <button type="button" key={o.key} className="btn sm" disabled={off} title={offTitle}
                  onClick={() => say(TEMPLATES.choose(o.text), o.key, o.text)} data-testid={`card-option-${o.key}`}>
                  {o.text}
                </button>
              ))}
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
                  {pendingRefs.length === 1 ? "先不管这条" : `先不管 ${ref.item_id}`}
                </button>
              ))}
              <button type="button" className="btn sm" disabled={off} title={offTitle} data-testid="card-dont-know"
                onClick={() => say(TEMPLATES.dontKnow(refs.map((r) => r.item_id).join("、")), "不知道", "我不知道，你按常识补")}>
                我不知道，你按常识补
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

      {done && <div className="done">✓ {done}</div>}
      {showUnread && (
        <div className="sw-unread-hint" data-testid="card-unread">
          还有 {unread.length} 条未读
          {handlers.onShowUnread && <button type="button" className="btn sm" onClick={handlers.onShowUnread} data-testid="card-show-unread">筛出来看</button>}
        </div>
      )}
    </div>
  );
}
