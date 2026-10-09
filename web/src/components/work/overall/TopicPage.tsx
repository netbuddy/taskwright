// 总体分析的一页主题。顶上是它上面各级主题（面包屑）、标题、标签、有几处待核实、有几个条目依据它、被几处提到；
// 下面四块：
//   它是什么 ── 一两段话；助手补的、用户还没有确认的字句用琥珀底标出，块尾写来源。
//   例子 ── 一条一张卡片；以「反例：」开头的是灰色卡片，写「这种不算」。
//   已经定下的 ── 一句一条，每条下面一行出处；助手补的那一条前面是琥珀点。
//   还没定的 ── 问题集合里挂在这一页、还没有了结的问题，带「助手为什么问」；在这里写一句回答点「记下」就发给助手，
//                「这件事先放着」把这个问题标为先不管。
// 四块之后是「提到它的地方」：别处的文字里出现它的标题或别名的那些句子（命中的词上色），以及依据它写的条目；
// 条目依据的是它早先的样子、它后来改过时，那一行带「依据已变」。点一行的出处打开那一页或那个条目。
// 最底下一行小字「看修订与全部来源」换成条目详情的样子看同一页（修订下拉、与上一次的比对、每条来源、删除都在那里）。
// 这里只画；数由 model/overall.ts 算，写入一律走条目区交进来的直接操作与发送。

import { useState } from "react";
import type { CollectionDef, Item, Source, Task } from "../../../api/types";
import { SOURCE_SUPPLEMENT, issueAnswerText, sourceKindNow, writeOffReason } from "../../../model/items";
import {
  TOPIC, confirmAction, dependents, exampleParts, examplesOf, isOverall, isPending, labelsOf, markSupplemented, mentionRows, openQuestions, pendingCount, questionReason, settledOf,
  sourcesFor, splitByWord, supplemented, titleOf, trail, whatOf, type OverallItem,
} from "../../../model/overall";
import { FieldEditor, type SubmitAction } from "../ItemDetail";
import { TopicEdit } from "./TopicEdit";
import { rejectedText } from "../errors";
import { useToast } from "../../Toasts";

/** 出处的一句短话：谁说的或者哪份材料，后面跟原话（长的截短）。助手补充的写理由。 */
function sourceText(source: Source): string {
  const kind = sourceKindNow(String(source.kind));
  const quote = source.excerpt.length > 36 ? `${source.excerpt.slice(0, 36)}…` : source.excerpt;
  if (kind === SOURCE_SUPPLEMENT) return `助手补的 · 理由：${source.excerpt}`;
  if (kind === "用户的话") return `你说的「${quote}」`;
  if (kind === "文档原文") return `材料 ${source.locator.split("/").pop() ?? source.locator}「${quote}」`;
  if (kind === "用户直接修改") return "你亲手改的";
  return `${kind} ${source.locator}`.trim();
}

function SourceLine({ sources, onLocate }: { sources: Source[]; onLocate?: (excerpt: string, locator: string) => void }) {
  if (sources.length === 0) return null;
  return (
    <div className="oa-src">
      {sources.map((s, i) => {
        const supplement = sourceKindNow(String(s.kind)) === SOURCE_SUPPLEMENT;
        const canLocate = !supplement && sourceKindNow(String(s.kind)) === "文档原文" && !!onLocate;
        return (
          <span key={i} className={`one${supplement ? " v" : ""}${canLocate ? " link" : ""}`} role={canLocate ? "button" : undefined}
            title={canLocate ? "在右边的材料里看这句原文" : undefined} onClick={canLocate ? () => onLocate!(s.excerpt, s.locator) : undefined}>
            {sourceText(s)}
          </span>
        );
      })}
    </div>
  );
}

export function TopicPage({ task, item, def, readOnly, writesOff = false, submit, onSend, onAnswer, onOpen, onBack, onPrev, onNext, onRaw, onLocate, onDirty }: {
  task: Task;
  item: OverallItem;
  /** 总体分析这个集合的定义（字段与「标签」的取值从这里来）。 */
  def: CollectionDef;
  /** 正在修改、有没保存的改动时告诉条目区（那时对话区的卡片先不让发）。 */
  onDirty?: (dirty: boolean) => void;
  /** 任务已结束或助手不可用：一切写入都不能做。 */
  readOnly: boolean;
  /** 助手正在工作：写入与发送都先不能做。 */
  writesOff?: boolean;
  submit: SubmitAction;
  /** 把一句话发给助手（对话区的发送）。 */
  onSend?: (text: string) => void;
  /** 回答框空着时点「记下」：把开头预填进对话区的输入框。 */
  onAnswer?: (question: Item) => void;
  /** 打开另一页主题或另一个条目。 */
  onOpen: (itemId: string) => void;
  onBack: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** 换成条目详情的样子看这一页。 */
  onRaw: () => void;
  onLocate?: (excerpt: string, locator: string) => void;
}) {
  const toast = useToast();
  const above = trail(task, item);
  const labels = labelsOf(item);
  const pending = pendingCount(item);
  const marked = supplemented(item);
  const whatPending = marked.whole || marked.fields.has(TOPIC.what);
  const paragraphs = whatOf(item).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces = paragraphs.map((p) => (whatPending ? markSupplemented(p, marked.reasons) : [{ text: p, marked: false }]));
  // 助手补的在「它是什么」里，但理由没有引原文、标不出是哪几个字：整块旁边画一道琥珀边，来源那一行说明。
  const whatUnmarked = whatPending && !pieces.some((one) => one.some((part) => part.marked));
  const examples = examplesOf(item);
  const settled = settledOf(item);
  const questions = openQuestions(task, item);
  const basisCount = dependents(task, item).length;
  const mentionCount = (item.mentioned_by ?? []).length;
  const mentions = mentionRows(task, item);
  const offTitle = writeOffReason(task, { readOnly, writesOff });
  // 确认：在这一页现在的修订上记一条已读。它不改内容，所以助手工作中也能点；任务结束、助手不可用时不能。
  const confirm = async () => {
    const label = `确认 ${item.item_id} 待核实的 ${pending} 处`;
    const e = await submit(confirmAction(item), label);
    if (e) toast.error(rejectedText(label, e, item.item_id));
  };
  const confirmOff = writeOffReason(task, { readOnly });
  // 修改整页，或者只贴标签。两样都作为用户的直接修改保存。
  const [editing, setEditing] = useState(false);
  const [tagging, setTagging] = useState<string[] | null>(null);
  const labelField = def.fields.find((f) => f.name === TOPIC.labels) ?? null;
  const saveLabels = async () => {
    if (!tagging) return;
    const label = `修改 ${item.item_id} 的${TOPIC.labels}`;
    const e = await submit({ kind: "edit_fields", targets: [{ item_id: item.item_id, base_revision: item.revision_no }], fields: { [TOPIC.labels]: tagging }, notify_executor: false }, label);
    if (e) toast.error(rejectedText(label, e, item.item_id));
    else setTagging(null);
  };

  return (
    <div className="oa-page" data-testid="topic-page">
      <div className="oa-crumb" data-testid="topic-crumb">
        <span className="back" role="button" onClick={onBack} data-testid="topic-back">‹ 回到提纲</span>
        {above.map((up) => (
          <span key={up.item_id}><span className="up" role="button" onClick={() => onOpen(up.item_id)}>{titleOf(up)}</span><i>›</i></span>
        ))}
        <span className="here">{titleOf(item)}</span>
        <span className="oa-nav">
          <button type="button" className="btn sm" disabled={!onPrev} onClick={onPrev ?? undefined} data-testid="topic-prev">‹ 上一条</button>
          <button type="button" className="btn sm" disabled={!onNext} onClick={onNext ?? undefined} data-testid="topic-next">下一条 ›</button>
        </span>
      </div>
      <div className="oa-title" role="heading" aria-level={2} data-testid="topic-title"><span className="oa-id">{item.item_id}</span>{titleOf(item)}</div>
      <div className="oa-meta" data-testid="topic-meta">
        {labels.length === 0 && <span className="oa-tag none">未归类</span>}
        {labels.map((name) => <span key={name} className="oa-tag">{name}</span>)}
        {labelField && !editing && (
          <button type="button" className="oa-tag add" disabled={!!offTitle} title={offTitle ?? "给这一页加标签、换标签或者去掉标签"}
            onClick={() => setTagging(tagging ? null : labels)} data-testid="topic-add-label">＋ 标签</button>
        )}
        {isPending(item) && (
          <><span className="sep" /><span className="oa-st pending" data-testid="topic-pending"><i className="oa-dot pending" />{pending} 处待核实</span></>
        )}
        <span className="sep" />
        <span data-testid="topic-counts">{basisCount} 个条目依据它 · 被 {mentionCount} 处提到</span>
        <span className="oa-acts">
          {!editing && (
            <button type="button" className="btn sm" disabled={!!offTitle} title={offTitle} onClick={() => { setTagging(null); setEditing(true); }} data-testid="topic-edit-open">修改</button>
          )}
          {isPending(item) && (
            <button type="button" className="btn sm pri" disabled={!!confirmOff} title={confirmOff ?? "助手补的这几处你都看过、认可了，就点这里；点了之后这一页不再待核实"}
              onClick={() => void confirm()} data-testid="topic-confirm">确认待核实的 {pending} 处</button>
          )}
        </span>
      </div>

      {tagging && labelField && (
        <div className="oa-tagpick" data-testid="topic-label-pick">
          <FieldEditor def={labelField} value={tagging} task={task} onChange={(v) => setTagging(Array.isArray(v) ? v : [])} />
          <button type="button" className="btn sm pri" disabled={!!offTitle || JSON.stringify(tagging) === JSON.stringify(labels)} onClick={() => void saveLabels()} data-testid="topic-label-save">保存</button>
          <button type="button" className="btn sm" onClick={() => setTagging(null)}>取消</button>
        </div>
      )}
      {editing ? (
        <TopicEdit task={task} item={item} def={def} readOnly={readOnly} writesOff={writesOff} submit={submit} onDone={() => setEditing(false)} onDirty={onDirty} />
      ) : (<>
      <section className="oa-blk" data-testid="topic-what">
        <h3>它是什么</h3>
        <div className={`oa-prose${whatUnmarked ? " pending" : ""}`}>
          {pieces.length === 0 && <p className="oa-empty">还没有写。</p>}
          {pieces.map((parts, i) => (
            <p key={i}>{parts.map((part, k) => (part.marked
              ? <span key={k} className="oa-hl" title="这几个字是助手补的，你还没有确认">{part.text}</span>
              : <span key={k}>{part.text}</span>))}</p>
          ))}
        </div>
        <SourceLine sources={sourcesFor(item, TOPIC.what)} onLocate={onLocate} />
      </section>

      <section className="oa-blk" data-testid="topic-examples">
        <h3>例子 <small>有名字的人、具体的东西、具体的日子</small></h3>
        {examples.length === 0 && <div className="oa-empty">还没有例子。举一个具体的例子，最容易看出说的是不是一回事。</div>}
        <div className="oa-ex">
          {examples.map((one, i) => {
            const { counter, text } = exampleParts(one);
            return (
              <div key={i} className={`oa-card${counter ? " neg" : ""}${marked.examples.has(i) ? " pending" : ""}`} data-testid={`topic-example-${i}`}>
                <div className="k">{counter ? "这种不算" : `例子 ${i + 1}`}</div>
                <p>{text}</p>
                <SourceLine sources={sourcesFor(item, TOPIC.examples, i)} onLocate={onLocate} />
              </div>
            );
          })}
        </div>
      </section>

      <section className="oa-blk" data-testid="topic-settled">
        <h3>已经定下的 <small>一句一条，每条有出处</small></h3>
        {settled.length === 0 && <div className="oa-empty">还没有定下什么。</div>}
        <ul className="oa-rules">
          {settled.map((one, i) => (
            <li key={i} className={marked.settled.has(i) ? "pending" : undefined} data-testid={`topic-settled-${i}`}>
              <span className="mk" />
              <div className="t">{one}<SourceLine sources={sourcesFor(item, TOPIC.settled, i)} onLocate={onLocate} /></div>
              <span className="act">
                {/* 确认是按整页记的：整页只有这一处待核实时，这一条旁边的「对」才等于确认；多于一处时统一用顶部的按钮 */}
                {marked.settled.has(i) && pending === 1 && (
                  <button type="button" className="linkbtn" disabled={!!confirmOff} title={confirmOff ?? "这一条是对的：确认"} onClick={() => void confirm()}
                    data-testid={`topic-settled-ok-${i}`}>对</button>
                )}
                <button type="button" className="linkbtn" disabled={!!offTitle} title={offTitle ?? "改这一页"} onClick={() => setEditing(true)}
                  data-testid={`topic-settled-edit-${i}`}>改</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="oa-blk" data-testid="topic-open">
        <h3>还没定的 <small>答在这里就行，助手会把答案记到上面</small></h3>
        {questions.length === 0 && <div className="oa-empty">现在没有挂在这一页上的问题。</div>}
        <ul className="oa-open">
          {questions.map((q) => <Question key={q.item_id} task={task} question={q} off={readOnly || writesOff} offTitle={offTitle}
            onSend={onSend} onAnswer={onAnswer} onOpen={onOpen}
            onKeep={async () => {
              const label = `把 ${q.item_id} 标为先不管`;
              const e = await submit({ kind: "keep_pending", targets: [{ item_id: q.item_id, base_revision: q.revision_no }], notify_executor: false }, label);
              if (e) toast.error(rejectedText(label, e, q.item_id));
            }} />)}
        </ul>
      </section>

      <section className="oa-blk" data-testid="topic-mentions">
        <h3>提到它的地方 <small>别处说到它的句子，与依据它写的条目</small></h3>
        {mentions.length === 0 && <div className="oa-empty">还没有别处提到它，也没有条目依据它。</div>}
        <ul className="oa-mentions">
          {mentions.map((row, i) => (
            <li key={i} data-testid={`topic-mention-${i}`} data-kind={row.kind}>
              <div className={`from${row.from ? " link" : ""}`} role={row.from ? "button" : undefined} title={row.from ? `打开 ${row.id}` : undefined}
                onClick={row.from ? () => onOpen(row.id) : undefined}>
                {row.from ? (isOverall(row.from.collection) ? titleOf(row.from) : `${row.id} ${row.from.title}`) : `${row.id}（已经不在了）`}
                <small>{row.place}</small>
              </div>
              <div>
                {row.sentence && <q>{splitByWord(row.sentence, row.word).map((part, k) => (part.hit ? <mark key={k}>{part.text}</mark> : <span key={k}>{part.text}</span>))}</q>}
                {row.stale && <span className="stale" title="这个条目依据的是这一页早先的样子，这一页后来改过" data-testid={`topic-stale-${row.id}`}>依据已变</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="oa-rawlink"><span role="button" onClick={onRaw} data-testid="topic-raw">看修订与全部来源</span></div>
      </>)}
    </div>
  );
}

/** 「还没定的」里的一个问题：问题、助手为什么问、回答框与「记下」、「这件事先放着」。 */
function Question({ task, question, off, offTitle, onSend, onAnswer, onOpen, onKeep }: {
  task: Task; question: Item; off: boolean; offTitle?: string;
  onSend?: (text: string) => void; onAnswer?: (question: Item) => void; onOpen: (itemId: string) => void; onKeep: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const why = questionReason(task, question);
  const typed = answer.trim() !== "";
  // 写了字点「记下」是直接发给助手；空着点是把开头填进对话区的输入框，让用户到那里接着写。
  const record = () => {
    if (!typed) { onAnswer?.(question); return; }
    onSend?.(issueAnswerText(question.item_id, answer.trim()));
    setAnswer("");
  };
  return (
    <li data-testid={`topic-question-${question.item_id}`}>
      <div className="q"><span className="ref" role="button" title={`打开 ${question.item_id}`} onClick={() => onOpen(question.item_id)}>{question.item_id}</span>{question.title}</div>
      {why && <div className="why">助手问的原因：{why}</div>}
      <div className="ans">
        <input value={answer} placeholder="在这里写你的回答…" aria-label={`回答 ${question.item_id}`} disabled={off} title={off ? offTitle : undefined}
          onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && typed && !off) record(); }} />
        <button type="button" className="btn sm pri" disabled={off} title={off ? offTitle : typed ? "发给助手" : "输入框空着时只把开头填进对话区的输入框，不发送"}
          onClick={record} data-testid={`topic-answer-${question.item_id}`}>记下</button>
        <button type="button" className="btn sm" disabled={off} title={off ? offTitle : "这个问题留着不答，不再算没定"} onClick={onKeep}
          data-testid={`topic-keep-${question.item_id}`}>这件事先放着</button>
      </div>
    </li>
  );
}
