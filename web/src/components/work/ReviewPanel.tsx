// 右侧栏「评审」页签。只回答三个问题，从上到下：现在有什么要我处理；哪些已经没事了；以前评审过什么。各块的内容见 model/reviewTab.ts。
//   · 顶上一行：一句话写现状，右边唯一的主按钮「评审这 N 个条目」（有还没评审的条目时才有）。评审正在进行时写已经评完几个、按钮变灰写
//     「正在评审」，下面一条细的进度线；这只对页面上发起的评审有进度，助手在对话里发起的评审没有。
//   · 要处理的：按条目分组，每个条目一张卡片，组头是编号与标题；每一处问题写位置、说明、改法，动作是「让助手照这条改」「保留这种写法」
//     与不显眼的「依据的规则」；点「保留这种写法」时这一行换成填理由的输入框（KeepWording.tsx）。条目多于三个时只摊开前三个，
//     其余每个折成一行。没有问题时整块不显示。
//   · 建议（不影响通过）、已经没事的（通过的，你决定保留的）、评审记录：默认收起，点标题展开；没有内容时不显示。
//   · 最下面一行评审规则的链接，点了从右侧滑出规则的面板：按集合列规则，每条一个开关、编号、条文；带锁的不能关。
// 颜色只用产品已有的变量，一种颜色一个意思：红是要处理的问题，琥珀是建议，绿是已经没事的，靛蓝是交给助手去做的动作。
// 保留、改规则都是用户的界面操作（waive_review、set_review_rules），界面上的变化等库事件到了才发生；被拒时报一条失败提示（全站提示条）。
// 保留记在「条目 + 修订」上：在哪一处问题上点「保留这种写法」，都是这个条目的全部问题一起按你的决定算通过。

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ActionRequest, Finding, Item, Review, ReviewRule, Task, Waiver } from "../../api/types";
import type { ApiError } from "../../api/client";
import type { ReviewRun } from "../../state/workState";
import { needsReview, passRules, reviewOffReason, writeOffReason } from "../../model/items";
import { batchSentence, findingWhere, pendingSentence, reviewOverview, type FindingGroup, type ReviewOverview } from "../../model/reviewTab";
import { formatTime } from "../../model/format";
import { fixText } from "./ItemDetail";
import { rejectedText } from "./errors";
import { useToast } from "../Toasts";
import { KeepBox, KeepLink } from "./KeepWording";

type Submit = (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string) => Promise<ApiError | null>;

/** 「要处理的」「建议」里整组摊开的条目个数，其余每个条目折成一行。 */
export const GROUPS_SHOWN = 3;

export function ReviewPanel({ task, review = null, readOnly, writesOff, onReview, submit, onOpenFinding, onPrefill }: {
  task: Task;
  /** 正在进行的一批界面发起的评审。 */
  review?: ReviewRun | null;
  readOnly: boolean;
  writesOff: boolean;
  onReview: (targets: { item_id: string; base_revision: number }[], label: string) => void;
  submit: Submit;
  /** 打开条目详情并高亮那个字段（字段为空时只打开）。 */
  onOpenFinding: (itemId: string, field: string | null) => void;
  onPrefill: (text: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const toast = useToast();
  const o = reviewOverview(task);
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const writeOff = writeOffReason(task, { readOnly, writesOff });
  const waive = async (item: Item, kind: "waive_review" | "unwaive_review", reason?: string) => {
    const label = kind === "waive_review" ? `保留 ${item.item_id} 现在的写法` : `撤销对 ${item.item_id} 的保留`;
    const e = await submit({ kind, targets: [{ item_id: item.item_id, base_revision: item.revision_no }],
      ...(kind === "waive_review" ? { fields: { reason: (reason ?? "").trim(), source: "panel" } } : {}), notify_executor: false }, label);
    if (e) toast.error(rejectedText(label, e, item.item_id));
  };
  const cards: CardProps = { task, readOnly, keepOff: writeOff, onOpenFinding, onPrefill, onKeep: (item, reason) => void waive(item, "waive_review", reason) };
  return (
    <div className="sw-review" data-testid="review-panel">
      <div className="rv-body">
        <TopLine task={task} overview={o} review={review} readOnly={readOnly} writesOff={writesOff} onReview={onReview} />
        {o.problems.length > 0 && (
          <section className="rv-sec" data-testid="review-todo">
            <div className="rv-sec-h">要处理的</div>
            <div className="rv-sec-b"><Groups groups={o.problems} kind="problem" {...cards} /></div>
          </section>
        )}
        {o.advice.length > 0 && (
          <Section id="advice" open={open} onToggle={toggle} aside="不影响通过"
            title={<>建议 <span className="n amb">{o.adviceCount}</span> 条</>}>
            <Groups groups={o.advice} kind="advice" {...cards} />
          </Section>
        )}
        {o.passed.length + o.kept.length > 0 && (
          <Section id="done" open={open} onToggle={toggle} title={<>已经没事的 <span className="n ok">{o.passed.length + o.kept.length}</span> 个条目</>}>
            {o.passed.length > 0 && <div className="rv-sub">通过的</div>}
            {o.passed.map(({ item, review: r }) => <PassRow key={item.item_id} task={task} item={item} review={r} onOpen={() => onOpenFinding(item.item_id, null)} />)}
            {o.kept.length > 0 && <div className="rv-sub">你决定保留的</div>}
            {o.kept.map(({ item, findings, waiver }) => (
              <KeptRow key={item.item_id} item={item} findings={findings} waiver={waiver} off={writeOff}
                onOpen={() => onOpenFinding(item.item_id, null)} onUnwaive={() => void waive(item, "unwaive_review")} />
            ))}
          </Section>
        )}
        {o.batches.length > 0 && (
          <Section id="log" open={open} onToggle={toggle} title="评审记录">
            <div className="rv-log">
              {o.batches.map((b) => (
                <div key={b.batch_id} data-testid={`batch-${b.no}`}>
                  <span className="tm">{formatTime(b.at)}</span>{batchSentence(b)}{b.started_by !== "user" && <span className="by">由助手发起</span>}
                </div>
              ))}
            </div>
          </Section>
        )}
        <RulesLink task={task} onOpen={() => setDrawer(true)} />
      </div>
      {drawer && <RulesDrawer task={task} off={writeOff} submit={submit} onClose={() => setDrawer(false)} />}
    </div>
  );
}

/** 可以点的一段文字：role=button，回车与空格也能点；disabled 时灰掉，悬停说明原因。 */
function Act({ className = "", disabled = false, title, onClick, testId, children }: {
  className?: string; disabled?: boolean; title?: string; onClick: () => void; testId?: string; children: ReactNode;
}) {
  const run = () => { if (!disabled) onClick(); };
  return (
    <span className={`lk ${className}`} role="button" tabIndex={0} aria-disabled={disabled || undefined} title={title} data-testid={testId}
      onClick={run} onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } }}>{children}</span>
  );
}

function TopLine({ task, overview: o, review, readOnly, writesOff, onReview }: {
  task: Task; overview: ReviewOverview; review: ReviewRun | null; readOnly: boolean; writesOff: boolean;
  onReview: (targets: { item_id: string; base_revision: number }[], label: string) => void;
}) {
  if (!o.hasItems) {
    return <div className="rv-top"><div className="rv-now" data-testid="review-now">还没有条目可以评审。</div></div>;
  }
  const running = !!review && !review.finished;
  const parts: ReactNode[] = [];
  let button: ReactNode = null;
  if (running) {
    parts.push(<span key="run">正在评审，已经评完 {review!.done} 个，共 {review!.total} 个。</span>);
    button = <button type="button" className="btn pri" disabled title="上一批评审还在进行，评完之后再发起。" data-testid="review-panel-all">正在评审</button>;
  } else {
    const pending = pendingSentence(o.pending.length, o.rereview);
    if (pending) {
      const off = reviewOffReason(task, { readOnly, writesOff, running, count: o.pending.length });
      parts.push(<span key="pending" data-testid={o.rereview ? "rules-changed" : undefined}>{pending}</span>);
      button = (
        <button type="button" className="btn pri" disabled={!!off} title={off} data-testid="review-panel-all"
          onClick={() => onReview([], `评审 ${o.pending.length} 个条目`)}>评审这 {o.pending.length} 个条目</button>
      );
    }
  }
  if (o.problemCount > 0) parts.push(<span key="todo">有 <em>{o.problemCount}</em> 处问题等你处理。</span>);
  return (
    <>
      <div className="rv-top">
        <div className="rv-now" data-testid="review-now">
          {parts.length ? parts : <><OkMark />全部条目都已经通过评审。</>}
        </div>
        {button}
      </div>
      {running && (
        <div className="rv-prog" role="progressbar" aria-label="评审进度" aria-valuemin={0} aria-valuemax={review!.total} aria-valuenow={review!.done}
          data-testid="review-progress">
          <i style={{ width: `${review!.total ? Math.round((review!.done / review!.total) * 100) : 0}%` }} />
        </div>
      )}
    </>
  );
}

/** 收起与展开的一块：标题行点了切换；默认收起。 */
function Section({ id, open, onToggle, title, aside, children }: {
  id: string; open: Set<string>; onToggle: (id: string) => void; title: ReactNode; aside?: string; children: ReactNode;
}) {
  const on = open.has(id);
  return (
    <section className="rv-sec" data-testid={`review-${id}`}>
      <div className={`rv-sec-h tog${on ? " open" : ""}`} role="button" tabIndex={0} aria-expanded={on} data-testid={`review-${id}-toggle`}
        onClick={() => onToggle(id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(id); } }}>
        <Chevron /><span className="tx">{title}</span>{aside && <span className="aside">{aside}</span>}
      </div>
      {on && <div className="rv-sec-b">{children}</div>}
    </section>
  );
}

type CardProps = {
  task: Task; readOnly: boolean; keepOff: string | undefined;
  onOpenFinding: (itemId: string, field: string | null) => void; onPrefill: (text: string) => void; onKeep: (item: Item, reason: string) => void;
};

/**
 * 按条目分组的发现：前 GROUPS_SHOWN 个条目整组摊开，其余每个折成一行，点了在原地摊开，组头的「收起」再折回去。
 * 组的先后：页签打开时按条目区的顺序；之后新出现的组（例如评审进行中刚评完的条目）排在已有的组后面，已有的内容不跳动。
 */
function Groups({ groups, kind, ...props }: CardProps & { groups: FindingGroup[]; kind: "problem" | "advice" }) {
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const seen = useRef<string[]>([]);
  const set = (id: string, on: boolean) => setUnfolded((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const ids = groups.map((g) => g.item.item_id);
  seen.current = [...seen.current.filter((id) => ids.includes(id)), ...ids.filter((id) => !seen.current.includes(id))];
  const ordered = seen.current.map((id) => groups.find((g) => g.item.item_id === id)!);
  return (
    <>
      {ordered.map((g, i) => {
        const foldable = groups.length > GROUPS_SHOWN && i >= GROUPS_SHOWN;
        const id = g.item.item_id;
        if (foldable && !unfolded.has(id)) {
          return (
            <div key={id} className="rv-grp-c" role="button" tabIndex={0} onClick={() => set(id, true)} data-testid={`review-folded-${id}`}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(id, true); } }}>
              <span className="id">{id}</span><span className="t">{g.item.title}</span>
              <span className="cnt"><b className={kind === "problem" ? "gap" : "amb"}>{g.findings.length}</b> 处</span>
            </div>
          );
        }
        return (
          <div key={id} className="rv-grp" data-testid={`review-group-${id}`}>
            <div className="rv-grp-h">
              <Act className="id" onClick={() => props.onOpenFinding(id, null)}>{id}</Act>
              <Act className="t" onClick={() => props.onOpenFinding(id, null)}>{g.item.title}</Act>
              {foldable && <Act className="quiet push" onClick={() => set(id, false)} testId={`review-refold-${id}`}>收起</Act>}
            </div>
            {g.findings.map((f, j) => (
              <FindingCard key={j} item={g.item} finding={f} kind={kind} problems={kind === "problem" ? g.findings.length : 0} {...props} />
            ))}
          </div>
        );
      })}
    </>
  );
}

/** 一处问题或一条建议：位置、说明、改法、动作。 */
function FindingCard({ task, item, finding: f, kind, problems, readOnly, keepOff, onOpenFinding, onPrefill, onKeep }: CardProps & {
  item: Item; finding: Finding; kind: "problem" | "advice";
  /** 这个条目要处理的问题共几处（保留时一起算通过）；建议为 0。 */
  problems: number;
}) {
  const [rule, setRule] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const fixOff = readOnly ? writeOffReason(task, { readOnly }) : undefined;
  const r = ruleFor(task, item, f);
  return (
    <div className={`rv-pb${kind === "advice" ? " adv" : ""}`} data-testid={kind === "problem" ? "finding-problem" : "finding-advice"}>
      <div><Act className="where" onClick={() => onOpenFinding(item.item_id, f.field)} testId="finding-where"><i className="dot" aria-hidden="true" />{findingWhere(f)}</Act></div>
      <div className="text">{f.problem}</div>
      {f.suggestion && <div className="fix">改法：{f.suggestion}</div>}
      {keeping ? <KeepBox problems={problems} off={keepOff} onKeep={(reason) => onKeep(item, reason)} onClose={() => setKeeping(false)} /> : (
        <div className="acts">
          <Act className="ai" disabled={!!fixOff} title={fixOff} onClick={() => onPrefill(fixText(item.item_id, f))} testId="fix-finding">让助手照这条改</Act>
          {kind === "problem" && <KeepLink off={keepOff} onOpen={() => setKeeping(true)} />}
          {f.rule_id && (
            <Act className="quiet push" onClick={() => setRule(!rule)} testId={`clause-${f.rule_id}`}>{rule ? "收起规则" : "依据的规则"}</Act>
          )}
        </div>
      )}
      {rule && f.rule_id && (
        <div className="rv-rule" data-testid="clause-body">
          <span className="rid">{f.rule_id}</span><span>{r ? r.text : "这条规则的条文这次没有读到。"}</span>
        </div>
      )}
    </div>
  );
}

/** 「已经没事的」里一个通过的条目：编号、标题，行尾「核对了哪些规则」，点了在原地展开程序记下的那句说明与规则清单。 */
function PassRow({ task, item, review, onOpen }: { task: Task; item: Item; review: Review; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const basis = passRules(task, item.collection, review);
  const has = !!review.reason || basis.kind !== "none";
  return (
    <div data-testid={`review-passed-${item.item_id}`}>
      <div className="rv-okrow">
        <Act className="id" onClick={onOpen}>{item.item_id}</Act>
        <Act className="t" onClick={onOpen}>{item.title}</Act>
        {has && <Act className="quiet push" onClick={() => setOpen(!open)} testId="pass-rules-link">{open ? "收起" : "核对了哪些规则"}</Act>}
      </div>
      {open && (
        <div className="rv-okd" data-testid="pass-note">
          <div>{review.reason ?? "评审通过。"}</div>
          {basis.kind === "changed" && <div className="off" data-testid="pass-rules-changed">评审之后规则改过，这里列不出当时核对的规则。</div>}
          {basis.kind === "list" && (
            <>
              <div className="rv-rl" data-testid="pass-rules">
                {basis.rules.map((r) => <div key={r.id} className="rv-rule"><span className="rid">{r.id}</span><span>{r.text}</span></div>)}
              </div>
              {basis.off > 0 && <div className="off">另有 {basis.off} 条规则已经关闭，这次没有核对。</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 「已经没事的」里一个你保留了写法的条目：编号、标题、「撤销保留」，下面逐行写每一处问题，最后写理由。 */
function KeptRow({ item, findings, waiver, off, onOpen, onUnwaive }: {
  item: Item; findings: Finding[]; waiver: Waiver; off: string | undefined; onOpen: () => void; onUnwaive: () => void;
}) {
  return (
    <div className="rv-kp" data-testid={`review-kept-${item.item_id}`}>
      <div className="rv-okrow">
        <span className="id">{item.item_id}</span>
        <Act className="t" onClick={onOpen}>{item.title}</Act>
        <Act className="quiet push" disabled={!!off} title={off} onClick={onUnwaive} testId="unwaive-finding">撤销保留</Act>
      </div>
      {findings.map((f, i) => <div key={i} className="text">{findingWhere(f)}：{f.problem}</div>)}
      <div className="reason">{waiver.reason ? `理由：${waiver.reason}` : "没有填理由。"}</div>
    </div>
  );
}

/** 最下面一行：评审规则共几条、开着几条；点了滑出规则的面板。没有规则的任务不显示。 */
function RulesLink({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const rules = ruleCollections(task).flatMap((c) => c.all_rules ?? []);
  if (!rules.length) return null;
  return (
    <div className="rv-foot">
      <Act className="quiet" onClick={onOpen} testId="rules-link">评审规则（共 {rules.length} 条，开着 {rules.filter((r) => r.state !== "off").length} 条）</Act>
    </div>
  );
}

function ruleCollections(task: Task) {
  return task.definition.collections.filter((c) => needsReview(task, c.name) && (c.all_rules?.length ?? 0) > 0);
}

/** 发现引用的那条规则：先在全部规则里找，找不到再在生效的规则里找。 */
function ruleFor(task: Task, item: Item, finding: Finding): ReviewRule | undefined {
  const c = task.definition.collections.find((one) => one.name === item.collection);
  return c?.all_rules?.find((r) => r.id === finding.rule_id) ?? c?.review_rules?.find((r) => r.id === finding.rule_id);
}

/** 规则的面板：从右侧滑出，盖住页签的大部分，左边留一窄条；点这一窄条、「关闭」或按 Esc 收回。 */
function RulesDrawer({ task, off, submit, onClose }: { task: Task; off: string | undefined; submit: Submit; onClose: () => void }) {
  const toast = useToast();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const change = async (collection: string, next: { off: string[]; promote: string[] }, label: string) => {
    const e = await submit({ kind: "set_review_rules", targets: [], fields: { collection, off: next.off, promote: next.promote }, notify_executor: false }, label);
    if (e) toast.error(rejectedText(label, e));
  };
  return (
    <>
      <div className="rv-scrim" onClick={onClose} data-testid="rules-scrim" />
      <div className="rv-drawer" role="dialog" aria-label="评审规则" data-testid="rules-area">
        <div className="dr-h"><b>评审规则</b><Act className="push" onClick={onClose} testId="rules-close">关闭</Act></div>
        <div className="dr-lead">带锁的不能关；其余的可以关掉，只对这个任务生效。改动只影响之后的评审。</div>
        <div className="dr-b">
          {ruleCollections(task).map((c) => {
            const switches = c.rule_switches ?? { off: [], promote: [] };
            return (
              <div key={c.name}>
                <div className="dr-g">{c.name}</div>
                {(c.all_rules ?? []).map((r) => (
                  // 关掉时一并撤销升为必选：任务定义不允许同一条规则既关闭又升为必选，所以关掉再打开之后它是可选规则。
                  <RuleRow key={r.id} rule={r} off={off} onToggle={() => {
                    const offList = r.state === "off" ? switches.off.filter((x) => x !== r.id) : [...switches.off, r.id];
                    const promote = switches.promote.filter((x) => x !== r.id);
                    void change(c.name, { off: offList, promote }, `${r.state === "off" ? "打开" : "关闭"}规则 ${r.id}`);
                  }} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function RuleRow({ rule, off, onToggle }: { rule: ReviewRule & { state: string }; off: string | undefined; onToggle: () => void }) {
  const locked = rule.state === "required";
  const on = rule.state !== "off";
  const promoted = rule.state === "promoted";
  const title = locked ? "必选规则不能关"
    : `${promoted ? "这条规则已经升为必选，违反它算问题。" : ""}${off ?? (on ? (promoted ? "关掉它会同时撤销升为必选。" : "关掉这条规则") : "打开这条规则")}`;
  const label = locked ? `规则 ${rule.id}：必选，不能关` : `规则 ${rule.id}：${on ? "开着" : "关着"}${promoted ? "，已经升为必选" : ""}`;
  return (
    <div className={`sw-rule${on ? "" : " off"}`} data-testid={`rule-${rule.id}`}>
      {/* 必选规则是开着的：开关绿色、圆点在右，圆点对面的空处画一把白色的锁表示不能关。 */}
      <span className={`sw-switch${on ? " on" : ""}${locked ? " lock" : ""}`} role="switch" aria-checked={on}
        aria-disabled={locked || !!off || undefined} aria-label={label} title={title}
        onClick={() => { if (!locked && !off) onToggle(); }} data-testid={`rule-switch-${rule.id}`}>{locked && <LockIcon />}<i /></span>
      <span className="rid">{rule.id}</span>
      <span className="rt">{rule.text}</span>
    </div>
  );
}

/** 开关左半边的小锁：锁梁一笔，锁身一块。颜色随 currentColor（样式里设为白色）。 */
function LockIcon() {
  return (
    <svg className="lk" viewBox="0 0 16 16" aria-hidden="true" data-testid="rule-lock">
      <path d="M5.2 7.2V5.3a2.8 2.8 0 0 1 5.6 0v1.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <rect x="3.3" y="7" width="9.4" height="7" rx="1.6" fill="currentColor" />
    </svg>
  );
}

/** 收起与展开的小箭头：收起时朝右，展开时转成朝下。 */
function Chevron() {
  return (
    <svg className="chev" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 1.8 L6.7 5 L3.5 8.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 全部通过时顶上一行前面的小对勾。 */
function OkMark() {
  return (
    <svg className="okmark" viewBox="0 0 16 16" aria-hidden="true" data-testid="review-okmark">
      <path d="M3.2 8.4 L6.5 11.6 L12.8 4.6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
