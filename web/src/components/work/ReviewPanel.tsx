// 右侧栏「评审」页签：按批次汇总与追溯评审，保留写法与规则开关也在这里。
//   · 顶部一行：「N 次评审 · 未处理的问题 M 处」、「只看未处理」、「评审 N 条待评审的条目」；规则改了之后提示「规则改了，N 条需要重评」。
//   · 每次评审一张卡片，最新的在上：「第 N 次评审」、时刻、由谁发起、条数、合规与不合规、问题与建议各几。
//     最新一张默认展开，早先的变淡、折起，点标题展开。展开后逐条目列结果：不合规的条目逐条列发现（红点问题、琥珀点建议、
//     每条发现与条目详情里同一个两行布局（FindingLine）：第一行是发现本身与「第 N 次评审指出」，第二行是去向（未处理／已在修订 N 改／
//     已保留 · 理由）与操作链接（让助手照这条改、保留这种写法、撤销保留）；合规的条目折成一行，点开看它们的建议。
//     点条目编号或一条发现，打开条目详情并高亮那个字段。
//   · 底部规则区：按集合列规则。必选的开关锁住；可选的可以关掉，或点标签在「可选」与「升为必选」之间切换。改动只影响之后的评审。
// 保留、改规则都是用户的界面操作（waive_review、set_review_rules），界面上的变化等库事件到了才发生；被拒时报一条失败提示（全站提示条）。

import { useState } from "react";
import type { ActionRequest, Finding, Item, Review, ReviewBatch, ReviewRule, Task } from "../../api/types";
import type { ApiError } from "../../api/client";
import type { ReviewRun } from "../../state/workState";
import {
  findingStatus, isProblem, needsRereview, needsReview, openProblems, pendingReview, reviewOffReason, writeOffReason,
} from "../../model/items";
import { formatTime } from "../../model/format";
import { FindingLine } from "./FindingLine";
import { fixText } from "./ItemDetail";
import { rejectedText } from "./errors";
import { useToast } from "../Toasts";

type Submit = (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string) => Promise<ApiError | null>;

/** 规则区默认显示的条数。 */
const RULES_SHOWN = 5;

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
  const [onlyOpen, setOnlyOpen] = useState(false);
  const batches = [...(task.review_batches ?? [])].reverse();
  const toReview = pendingReview(task);
  const rereview = needsRereview(task);
  const reviewing = !!review && !review.finished;
  const reviewOff = reviewOffReason(task, { readOnly, writesOff, running: reviewing, count: toReview.length });
  const open = openProblems(task);
  return (
    <div className="sw-review" data-testid="review-panel">
      <div className="sw-rv-top">
        <span className="muted">{batches.length} 次评审 · 未处理的问题 {open} 处</span>
        <span className="spacer" />
        <span className={`filt${onlyOpen ? " on" : ""}`} role="button" onClick={() => setOnlyOpen(!onlyOpen)} data-testid="review-only-open">只看未处理</span>
        <button type="button" className="btn sm pri" disabled={!!reviewOff} title={reviewOff} data-testid="review-panel-all"
          onClick={() => onReview([], `评审 ${toReview.length} 条待评审的条目`)}>评审 {toReview.length} 条待评审的条目</button>
      </div>
      {rereview.length > 0 && <div className="banner-line amber" data-testid="rules-changed"><span>规则改了，{rereview.length} 条需要重评。</span></div>}
      {batches.length === 0 && <div className="lead">还没有评审过。点上面的按钮，评审者会按下面的规则逐条评审待评审的条目。</div>}
      {batches.map((b, i) => (
        <BatchCard key={b.batch_id} task={task} batch={b} latest={i === 0} onlyOpen={onlyOpen} readOnly={readOnly} writesOff={writesOff}
          submit={submit} onOpenFinding={onOpenFinding} onPrefill={onPrefill} />
      ))}
      <RulesArea task={task} readOnly={readOnly} writesOff={writesOff} submit={submit} />
    </div>
  );
}

/** 这次评审里某个条目的评审记录（按批次编号认）；没有（没评完）时为 undefined。 */
function reviewIn(item: Item, batch: ReviewBatch): Review | undefined {
  return item.reviews.find((r) => r.batch_id === batch.batch_id);
}

function BatchCard({ task, batch, latest, onlyOpen, readOnly, writesOff, submit, onOpenFinding, onPrefill }: {
  task: Task; batch: ReviewBatch; latest: boolean; onlyOpen: boolean; readOnly: boolean; writesOff: boolean;
  submit: Submit; onOpenFinding: (itemId: string, field: string | null) => void; onPrefill: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(latest);
  const [showPassed, setShowPassed] = useState(false);
  const rows = batch.items.map((one) => {
    const item = task.items.find((i) => i.item_id === one.item_id);
    return { one, item, review: item ? reviewIn(item, batch) : undefined };
  });
  const failed = rows.filter((r) => r.review && r.review.verdict !== "合规");
  const passed = rows.filter((r) => r.review && r.review.verdict === "合规");
  const unfinished = rows.filter((r) => r.item && !r.review);
  const allHandled = failed.every((r) => findingStatus(r.item!, r.review!).kind !== "open");
  if (onlyOpen && allHandled) return null;
  const shownFailed = onlyOpen ? failed.filter((r) => findingStatus(r.item!, r.review!).kind === "open") : failed;
  const withAdvice = passed.filter((r) => (r.review!.findings ?? []).length > 0).length;
  return (
    <div className={`sw-rcard${latest ? "" : " old"}`} data-testid={`batch-${batch.no}`}>
      <div className="h" role="button" onClick={() => setExpanded(!expanded)}>
        <b>第 {batch.no} 次评审</b>
        <span className="muted">{formatTime(batch.at)} · {batch.started_by === "user" ? "由你发起" : "由助手发起（你在对话里要求）"} · {batch.total} 条</span>
        {batch.passed > 0 && <span className="chip okc">{batch.passed} 合规</span>}
        {batch.failed > 0 && <span className="chip bad">{batch.failed} 不合规</span>}
        {batch.unfinished > 0 && <span className="chip">{batch.unfinished} 没有评完</span>}
        {(batch.problems > 0 || batch.advice > 0) && <span className="muted">问题 {batch.problems} 处 · 建议 {batch.advice} 条</span>}
        {!latest && failed.length > 0 && allHandled && <span className="muted">全部发现已在后来的修订里改或保留</span>}
      </div>
      {expanded && (
        <div className="b">
          {shownFailed.map(({ item, review }) => (
            <FailedItem key={item!.item_id} task={task} item={item!} review={review!} batch={batch} onlyOpen={onlyOpen} readOnly={readOnly}
              writesOff={writesOff} submit={submit} onOpenFinding={onOpenFinding} onPrefill={onPrefill} />
          ))}
          {!onlyOpen && passed.length > 0 && (
            <div className="sw-rv-passed">
              <span role="button" className="muted" onClick={() => setShowPassed(!showPassed)} data-testid={`batch-${batch.no}-passed`}>
                {passed.slice(0, 5).map((r) => r.one.item_id).join("、")}{passed.length > 5 ? " ……" : ""} {passed.length} 条合规
                {withAdvice ? `（其中 ${withAdvice} 条有建议）` : ""} {showPassed ? "▴ 收起" : "▸ 展开"}
              </span>
              {showPassed && passed.map(({ item, review }) => (
                <div key={item!.item_id} className="sw-rv-item">
                  <span className="lid ref" role="button" onClick={() => onOpenFinding(item!.item_id, null)}>{item!.item_id}</span>
                  <span className="chip okc">合规</span><span className="muted">修订 {review!.revision_no}</span>
                  {(review!.findings ?? []).map((f, i) => (
                    <FindingLine key={i} finding={f} rule={ruleFor(task, item!, f)} batchNo={batch.no} onOpen={() => onOpenFinding(item!.item_id, f.field)} />
                  ))}
                </div>
              ))}
            </div>
          )}
          {!onlyOpen && unfinished.map(({ one }) => <div key={one.item_id} className="muted">{one.item_id} 这次没有评完，可以再评一次。</div>)}
        </div>
      )}
    </div>
  );
}

function FailedItem({ task, item, review, batch, onlyOpen, readOnly, writesOff, submit, onOpenFinding, onPrefill }: {
  task: Task; item: Item; review: Review; batch: ReviewBatch; onlyOpen: boolean; readOnly: boolean; writesOff: boolean;
  submit: Submit; onOpenFinding: (itemId: string, field: string | null) => void; onPrefill: (text: string) => void;
}) {
  const toast = useToast();
  const status = findingStatus(item, review);
  const findings = review.findings ?? [];
  const current = review.revision_no === item.revision_no;
  const off = !!writeOffReason(task, { readOnly, writesOff });
  const act = async (kind: "waive_review" | "unwaive_review", reason?: string) => {
    const label = kind === "waive_review" ? `保留 ${item.item_id} 现在的写法` : `撤销对 ${item.item_id} 的保留`;
    const e = await submit({ kind, targets: [{ item_id: item.item_id, base_revision: item.revision_no }],
      ...(kind === "waive_review" ? { fields: { reason: (reason ?? "").trim(), source: "panel" } } : {}), notify_executor: false }, label);
    if (e) toast.error(rejectedText(label, e, item.item_id));
  };
  return (
    <div className="sw-rv-item" data-testid={`batch-${batch.no}-item-${item.item_id}`}>
      <span className="lid ref" role="button" onClick={() => onOpenFinding(item.item_id, null)}>{item.item_id}</span>
      <span className="chip bad">不合规</span><span className="muted">修订 {review.revision_no}</span>
      {findings.filter((f) => !onlyOpen || isProblem(f)).map((f, i) => (
        <FindingLine key={i} finding={f} rule={ruleFor(task, item, f)} batchNo={batch.no} status={status}
          onOpen={() => onOpenFinding(item.item_id, f.field)}
          onFix={status.kind === "open" && current ? (x) => onPrefill(fixText(item.item_id, x)) : undefined} fixOff={readOnly}
          onKeep={isProblem(f) && status.kind === "open" && current && !off ? (reason) => void act("waive_review", reason) : undefined}
          onUnwaive={isProblem(f) && status.kind === "kept" && current ? () => void act("unwaive_review") : undefined} unwaiveOff={off} />
      ))}
    </div>
  );
}

/** 发现引用的那条规则：先在全部规则里找，找不到再在生效的规则里找。 */
function ruleFor(task: Task, item: Item, finding: Finding): ReviewRule | undefined {
  const c = task.definition.collections.find((one) => one.name === item.collection);
  return c?.all_rules?.find((r) => r.id === finding.rule_id) ?? c?.review_rules?.find((r) => r.id === finding.rule_id);
}

/** 规则区：按集合列规则与开关。 */
function RulesArea({ task, readOnly, writesOff, submit }: { task: Task; readOnly: boolean; writesOff: boolean; submit: Submit }) {
  const [all, setAll] = useState(false);
  const toast = useToast();
  const collections = task.definition.collections.filter((c) => needsReview(task, c.name) && (c.all_rules?.length ?? 0) > 0);
  if (!collections.length) return null;
  const off = writeOffReason(task, { readOnly, writesOff });
  const total = collections.reduce((n, c) => n + (c.all_rules?.length ?? 0), 0);
  const change = async (collection: string, next: { off: string[]; promote: string[] }, label: string) => {
    const e = await submit({ kind: "set_review_rules", targets: [], fields: { collection, off: next.off, promote: next.promote }, notify_executor: false }, label);
    if (e) toast.error(rejectedText(label, e));
  };
  let shown = 0;
  return (
    <div className="sw-rules" data-testid="rules-area">
      <div className="sw-rv-top"><b>评审规则</b><span className="muted">必选规则不能关；可选规则可以关掉或升为必选，只对这个任务生效</span></div>
      {collections.map((c) => {
        const switches = c.rule_switches ?? { off: [], promote: [] };
        const rules = (c.all_rules ?? []).filter(() => all || shown++ < RULES_SHOWN);
        if (!rules.length) return null;
        return (
          <div key={c.name}>
            <div className="cond-group">{c.name}</div>
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} off={off} onToggle={() => {
                const offList = r.state === "off" ? switches.off.filter((x) => x !== r.id) : [...switches.off, r.id];
                const promote = switches.promote.filter((x) => x !== r.id);
                void change(c.name, { off: offList, promote }, `${r.state === "off" ? "打开" : "关闭"}规则 ${r.id}`);
              }} onLevel={() => {
                const promote = r.state === "promoted" ? switches.promote.filter((x) => x !== r.id) : [...switches.promote, r.id];
                void change(c.name, { off: switches.off, promote }, `把 ${r.id} ${r.state === "promoted" ? "改回可选" : "升为必选"}`);
              }} />
            ))}
          </div>
        );
      })}
      <div className="muted">
        共 {total} 条{total > RULES_SHOWN && <>，<span role="button" className="ref" onClick={() => setAll(!all)} data-testid="rules-all">{all ? "只看前几条 ▴" : "展开全部 ▸"}</span></>}
        {" "}· 改动只影响之后的评审，已有评审记录不变
      </div>
    </div>
  );
}

function RuleRow({ rule, off, onToggle, onLevel }: {
  rule: ReviewRule & { state: string }; off: string | undefined; onToggle: () => void; onLevel: () => void;
}) {
  const locked = rule.state === "required";
  const on = rule.state !== "off";
  const tag = { required: ["bad", "必选"], optional: ["warn", "可选 ▾"], off: ["warn", "已关闭"], promoted: ["bad", "升为必选 ▾"] }[rule.state] ?? ["", rule.state];
  return (
    <div className="sw-rule" data-testid={`rule-${rule.id}`}>
      <span className={`sw-switch${on ? " on" : ""}${locked ? " lock" : ""}`} role="switch" aria-checked={on}
        title={locked ? "必选规则不能关" : off ?? (on ? "关掉这条规则" : "打开这条规则")}
        onClick={() => { if (!locked && !off) onToggle(); }} data-testid={`rule-switch-${rule.id}`}><i /></span>
      <span className="rid">{rule.id}</span>
      <span className="rt">{rule.text}</span>
      <span className={`chip ${tag[0]}`} role={rule.state === "optional" || rule.state === "promoted" ? "button" : undefined}
        title={rule.state === "optional" ? "点一下升为必选" : rule.state === "promoted" ? "点一下改回可选" : undefined}
        onClick={() => { if ((rule.state === "optional" || rule.state === "promoted") && !off) onLevel(); }}
        data-testid={`rule-level-${rule.id}`}>{tag[1]}</span>
    </div>
  );
}
