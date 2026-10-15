// 业务说明的一节（总体分析的一页主题）。从上到下，块的次序固定，没有内容的块不显示：
//   面包屑（第几章 › 节号）、标题、一行小字（材料几处、澄清几条、你看过；标签与「＋ 标签」；有几处待核实）、右边「修改」与「确认待核实」。
//   说明 ── 「它是什么」，一段一段；逐字出自材料的句子用底色标出，点它在右边的材料里看原文；助手补的、用户还没有确认的字句用琥珀底标出；
//           块尾一行来源。
//   异常分支 ── 「例子」里以「例外：」开头的各条，一条一张小卡，写出处；流程节末尾有「＋ 补一种例外」。
//   示例 ── 「例子」里其余各条，一条一张卡片；以「反例：」开头的是灰色卡片，写「这种不算」。
//   适用规则 ── 「已经定下的」，一句一条，每条下面一行出处；助手补的那一条前面是琥珀点；规则表里标了冲突的那一条写明与哪一节的规则冲突。
//   待澄清事项 ── 每个问题挂一枚「阻断下游」或「不阻断」（不阻断的写何时回看），阻断下游的排在前面；已经了结的问题列在
//                 下面，写它落实到了哪里。
//   待澄清事项 ── 问题集合里挂在这一页、还没有了结的问题，带「需要它的原因」；在这里写一句回答点「记下」就发给助手，
//                「暂不处理」把这个问题标为暂不处理。
// 这几块之间与之后还有条目区交进来的几块（Figure.tsx、SectionLinks.tsx）：说明之后是这一节的图（流程步骤、状态图、与其他对象的关系），
// 待澄清事项之后是其他图、相关角色与对象、对应的需求条目与追溯行。
// 末尾一排动作：「修改」；「让助手照这条改条目」只往对话区的输入框里预填一句话；「标为已废弃」先问一句再保存；
// 「复述一遍」发一句固定的话，请助手把对这一节及其下面各节的理解讲成一段故事（故事在对话区回来）。
// 已废弃的页：标题划掉，顶上一句「这一页已废弃，改看某一节」。还没有贴标签的页：顶上一句说明它还没有归类。
// 最底下一行小字「看修订与全部来源」换成条目详情的样子看同一页（修订下拉、与上一次的比对、每条来源、删除都在那里）。
// 页的编号、修订次数这类记号不写在正文里，只在悬停时看得到。
// 这里只画；数由 model/overall.ts 与 model/chapters.ts 算，写入一律走条目区交进来的直接操作与发送。

import { useState, type ReactNode } from "react";
import type { CollectionDef, Item, Source, Task } from "../../../api/types";
import { CHAPTER_FLOWS, INTRO_NAME, UNSORTED_NAME, chapterByNo, introChapter, sectionLabel, sectionOf, type Toc } from "../../../model/chapters";
import { SOURCE_SUPPLEMENT, issueAnswerText, writeOffReason } from "../../../model/items";
import {
  DEPRECATED, TOPIC, addedQuotes, confirmAction, dependents, exampleKind, examplesOf, isBlockingQuestion, isDeprecated, isPending, labelsOf, markPassage, materialQuotes, openQuestions,
  pendingCount, questionBlockingText, questionLanded, questionReason, questionRevisit, settledQuestions, retellText, reviseDependentsText, sectionLead, seeInstead, settledOf, sourceShortText, sourcesFor, supplemented, titleOf, whatOf, wholeSources,
} from "../../../model/overall";
import { FieldEditor, type SubmitAction } from "../ItemDetail";
import { TopicEdit } from "./TopicEdit";
import { rejectedText } from "../errors";
import { useToast } from "../../Toasts";

/** 一处的出处。pending 为真是这一处还待核实：助手补充的那一条用琥珀字；确认过之后它与别的出处同色。 */
function SourceLine({ sources, pending = false, onLocate }: { sources: Source[]; pending?: boolean; onLocate?: (excerpt: string, locator: string) => void }) {
  if (sources.length === 0) return null;
  return (
    <div className="oa-src">
      {sources.map((s, i) => {
        const supplement = String(s.kind) === SOURCE_SUPPLEMENT;
        const canLocate = !supplement && String(s.kind) === "文档原文" && !!onLocate;
        return (
          <span key={i} className={`one${supplement && pending ? " v" : ""}${canLocate ? " link" : ""}`} role={canLocate ? "button" : undefined}
            title={canLocate ? "在右边的材料里看这句原文" : undefined} onClick={canLocate ? () => onLocate!(s.excerpt, s.locator) : undefined}>
            {sourceShortText(s, pending)}
          </span>
        );
      })}
    </div>
  );
}

export function SectionPage({ task, item, def, contents, readOnly, writesOff = false, submit, onSend, onAnswer, onPrefill, onOpen, onBack, onPrev, onNext, onRaw, onLocate, onDirty, figures = null, links = null }: {
  /** 往对话区的输入框里预填一句话，不发送。 */
  onPrefill?: (text: string) => void;
  task: Task;
  item: Item;
  /** 总体分析这个集合的定义（字段与「标签」的取值从这里来）。 */
  def: CollectionDef;
  /** 业务说明的目录（这一页在第几章、节号是多少从这里来）。 */
  contents: Toc;
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
  /** 打开另一节或另一个条目。 */
  onOpen: (itemId: string) => void;
  onBack: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** 换成条目详情的样子看这一页。 */
  onRaw: () => void;
  onLocate?: (excerpt: string, locator: string) => void;
  /** 这一节的图（流程步骤、状态图、与其他对象的关系）：画在「说明」之后；没有时不给。 */
  figures?: ReactNode;
  /** 这一节末尾的几块（其他图、相关角色与对象、对应的需求条目、追溯）：画在「待澄清事项」之后；没有时不给。 */
  links?: ReactNode;
}) {
  const toast = useToast();
  const section = sectionOf(contents, item.item_id);
  // 导语页不是节：面包屑写它是哪一章的导语，不算没有归类。
  const introOf = introChapter(contents, item.item_id);
  const chapter = section ? chapterByNo(section.chapter) : introOf?.chapter ?? null;
  const labels = labelsOf(item);
  const lead = sectionLead(item);
  const pending = pendingCount(item);
  const marked = supplemented(item);
  const whatPending = marked.whole || marked.fields.has(TOPIC.what);
  const paragraphs = whatOf(item).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // 说明里要标出的两样：逐字出自材料的句子（底色），与助手补的、还没有确认的那几个字（琥珀底）。
  const quotes = [
    ...materialQuotes(item),
    ...(whatPending ? addedQuotes(marked.reasons).map((quote) => ({ quote, mark: "added" as const })) : []),
  ];
  const pieces = paragraphs.map((p) => markPassage(p, quotes));
  // 助手补的在「它是什么」里，但理由没有引原文、标不出是哪几个字：整块旁边画一道琥珀边，来源那一行说明。
  const whatUnmarked = whatPending && !pieces.some((one) => one.some((part) => part.mark === "added"));
  const examples = examplesOf(item).map((one, index) => ({ index, ...exampleKind(one) }));
  const exceptions = examples.filter((one) => one.kind === "exception");
  const samples = examples.filter((one) => one.kind !== "exception");
  const isFlow = section?.chapter === CHAPTER_FLOWS;
  const settled = settledOf(item);
  const questions = openQuestions(task, item);
  const closed = settledQuestions(task, item);
  const basisCount = dependents(task, item).length;
  const offTitle = writeOffReason(task, { readOnly, writesOff });
  // 规则表里把这一页的哪几条标成了冲突：第几条 → 与它冲突的那一条所在的节（找不到另一条时是 null）。
  const rules = task.overall_views?.rules.rows ?? [];
  const conflictOf = (index: number): { other: Item | null } | null => {
    const mine = rules.find((row) => row.item_id === item.item_id && row.index === index);
    if (!mine || mine.conflicts.length === 0) return null;
    const other = rules.find((row) => !(row.item_id === item.item_id && row.index === index) && row.conflicts.some((id) => mine.conflicts.includes(id)));
    return { other: other ? task.items.find((one) => one.item_id === other.item_id) ?? null : null };
  };
  // 确认：在这一页现在的修订上记一条已读。它不改内容，所以助手工作中也能点；任务结束、助手不可用时不能。
  const confirm = async () => {
    const label = `确认 ${item.item_id} 待核实的 ${pending} 处`;
    const e = await submit(confirmAction(item), label);
    if (e) toast.error(rejectedText(label, e, item.item_id));
  };
  const confirmOff = writeOffReason(task, { readOnly });
  const gone = isDeprecated(item);
  const instead = task.items.find((i) => i.item_id === seeInstead(item)) ?? null;
  // 标为已废弃：先问一句。这一页留着、划掉；依据它写的条目会显示待核实。
  const [retiring, setRetiring] = useState(false);
  const retire = async () => {
    const label = `把 ${item.item_id} 标为已废弃`;
    const e = await submit({ kind: "edit_fields", targets: [{ item_id: item.item_id, base_revision: item.revision_no }], fields: { [TOPIC.status]: DEPRECATED }, notify_executor: false }, label);
    if (e) toast.error(rejectedText(label, e, item.item_id));
    setRetiring(false);
  };
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
        <span className="back" role="button" onClick={onBack} data-testid="topic-back">‹ 回到目录</span>
        {chapter
          ? <><span className="up">{chapter.no} {chapter.name}</span>{introOf ? <><i>›</i><span className="here">{INTRO_NAME}</span></> : section!.no && <><i>›</i><span className="here">{section!.no}</span></>}</>
          : <span className="up">{UNSORTED_NAME}</span>}
        <span className="oa-nav">
          <button type="button" className="btn sm" disabled={!onPrev} onClick={onPrev ?? undefined} data-testid="topic-prev">‹ 上一条</button>
          <button type="button" className="btn sm" disabled={!onNext} onClick={onNext ?? undefined} data-testid="topic-next">下一条 ›</button>
        </span>
      </div>
      {gone && (
        <div className="oa-gone" data-testid="topic-gone">
          这一页已废弃。{instead
            ? <>改看 <span className="see" role="button" onClick={() => onOpen(instead.item_id)} data-testid="topic-see">{sectionLabel(contents, instead)}</span>。</>
            : "没有写改看哪一页。"}
        </div>
      )}
      {!chapter && !gone && <div className="oa-unsorted" data-testid="topic-unsorted">这一节还没有归类，贴上标签之后会排进相应的章。</div>}
      <div className={`oa-title${gone ? " gone" : ""}`} role="heading" aria-level={2} title={item.item_id} data-testid="topic-title">{titleOf(item)}</div>
      <div className="oa-meta" data-testid="topic-meta">
        <span data-testid="topic-lead">
          {[lead.materials > 0 ? `材料 ${lead.materials} 处` : "", lead.clarified > 0 ? `澄清 ${lead.clarified} 条` : "", lead.seen ? "你看过" : ""].filter(Boolean).join(" · ") || "还没有来源"}
        </span>
        <span className="sep" />
        {labels.length === 0 && !introOf && <span className="oa-tag none">{UNSORTED_NAME}</span>}
        {introOf && <span className="oa-tag">{INTRO_NAME}</span>}
        {labels.map((name) => <span key={name} className="oa-tag">{name}</span>)}
        {labelField && !editing && (
          <button type="button" className="oa-tag add" disabled={!!offTitle} title={offTitle ?? "给这一页加标签、换标签或者去掉标签；标签决定它排在哪一章"}
            onClick={() => setTagging(tagging ? null : labels)} data-testid="topic-add-label">＋ 标签</button>
        )}
        {isPending(item) && (
          <><span className="sep" /><span className="oa-st pending" data-testid="topic-pending"><i className="oa-dot pending" />{pending} 处待核实</span></>
        )}
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
        <h3>说明</h3>
        <div className={`oa-prose${whatUnmarked ? " pending" : ""}`}>
          {pieces.length === 0 && <p className="oa-empty">还没有写。</p>}
          {pieces.map((parts, i) => (
            <p key={i}>{parts.map((part, k) => (part.mark === "added"
              ? <span key={k} className="oa-hl" title="这几个字是助手补的，你还没有确认">{part.text}</span>
              : part.mark === "material"
                ? <span key={k} className={`oa-qt${onLocate ? " link" : ""}`} role={onLocate ? "button" : undefined} title="这一句逐字出自材料，点一下在右边的材料里看原文"
                    onClick={onLocate ? () => onLocate(part.source!.excerpt, part.source!.locator) : undefined}>{part.text}</span>
                : <span key={k}>{part.text}</span>))}</p>
          ))}
        </div>
        <SourceLine sources={[...sourcesFor(item, TOPIC.what), ...wholeSources(item)]} pending={whatPending} onLocate={onLocate} />
      </section>

      {figures}

      {(exceptions.length > 0 || isFlow) && (
        <section className="oa-blk" data-testid="topic-exceptions">
          <h3>异常分支</h3>
          <div className="oa-ex">
            {exceptions.map((one) => (
              <div key={one.index} className={`oa-card exc${marked.examples.has(one.index) ? " pending" : ""}`} data-testid={`topic-example-${one.index}`}>
                <p>{one.text}</p>
                <SourceLine sources={sourcesFor(item, TOPIC.examples, one.index)} pending={marked.examples.has(one.index)} onLocate={onLocate} />
              </div>
            ))}
            {isFlow && (
              <button type="button" className="oa-card add" disabled={!!offTitle} title={offTitle ?? "在「例子」里加一条以「例外：」开头的例子"} onClick={() => { setTagging(null); setEditing(true); }}
                data-testid="topic-add-exception">＋ 补一种例外</button>
            )}
          </div>
        </section>
      )}

      {samples.length > 0 && (
        <section className="oa-blk" data-testid="topic-examples">
          <h3>示例</h3>
          <div className="oa-ex">
            {samples.map((one) => (
              <div key={one.index} className={`oa-card${one.kind === "counter" ? " neg" : ""}${marked.examples.has(one.index) ? " pending" : ""}`} data-testid={`topic-example-${one.index}`}>
                {one.kind === "counter" && <div className="k">这种不算</div>}
                <p>{one.text}</p>
                <SourceLine sources={sourcesFor(item, TOPIC.examples, one.index)} pending={marked.examples.has(one.index)} onLocate={onLocate} />
              </div>
            ))}
          </div>
        </section>
      )}

      {settled.length > 0 && (
        <section className="oa-blk" data-testid="topic-settled">
          <h3>适用规则 <small>与第 5 章同一来源</small></h3>
          <ul className="oa-rules">
            {settled.map((one, i) => {
              const conflict = conflictOf(i);
              return (
                <li key={i} className={`${marked.settled.has(i) ? "pending" : ""}${conflict ? " conflict" : ""}`.trim() || undefined} data-testid={`topic-settled-${i}`}>
                  <span className="mk" />
                  <div className="t">
                    {one}
                    {conflict && (
                      <span className="oa-conflict" data-testid={`topic-conflict-${i}`}>
                        {conflict.other
                          ? <>与 <span className="see" role="button" onClick={() => onOpen(conflict.other!.item_id)}>{sectionLabel(contents, conflict.other)}</span> 的一条规则冲突，已记为待澄清</>
                          : "这条规则有冲突，已记为待澄清"}
                      </span>
                    )}
                    <SourceLine sources={sourcesFor(item, TOPIC.settled, i)} pending={marked.settled.has(i)} onLocate={onLocate} />
                  </div>
                  <span className="oa-ract">
                    {/* 确认是按整页记的：整页只有这一处待核实时，这一条旁边的「对」才等于确认；多于一处时统一用顶部的按钮 */}
                    {marked.settled.has(i) && pending === 1 && (
                      <button type="button" className="linkbtn" disabled={!!confirmOff} title={confirmOff ?? "这一条是对的：确认"} onClick={() => void confirm()}
                        data-testid={`topic-settled-ok-${i}`}>对</button>
                    )}
                    <button type="button" className="linkbtn" disabled={!!offTitle} title={offTitle ?? "改这一页"} onClick={() => setEditing(true)}
                      data-testid={`topic-settled-edit-${i}`}>改</button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(questions.length > 0 || closed.length > 0) && (
        <section className="oa-blk" data-testid="topic-open">
          <h3>待澄清事项 {questions.length > 0 && <small>答在这里就行，助手会把答案记进这一节</small>}</h3>
          {questions.length > 0 && <ul className="oa-open">
            {questions.map((q) => <Question key={q.item_id} task={task} question={q} off={readOnly || writesOff} offTitle={offTitle}
              onSend={onSend} onAnswer={onAnswer} onOpen={onOpen}
              onKeep={async () => {
                const label = `把 ${q.item_id} 标为暂不处理`;
                const e = await submit({ kind: "keep_pending", targets: [{ item_id: q.item_id, base_revision: q.revision_no }], notify_executor: false }, label);
                if (e) toast.error(rejectedText(label, e, q.item_id));
              }} />)}
          </ul>}
          {closed.length > 0 && (
            <ul className="oa-closed" data-testid="topic-closed">
              {closed.map((q) => {
                const landed = questionLanded(q);
                return (
                  <li key={q.item_id} data-testid={`topic-closed-${q.item_id}`}>
                    <span className="mk">已了结</span>
                    <span className="qlink" role="button" title={`打开 ${q.item_id}`} onClick={() => onOpen(q.item_id)}>{q.title}</span>
                    {landed && <span className="to" data-testid={`topic-landed-${q.item_id}`}>落实到：{landed}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {links}

      <div className="dfoot oa-foot-acts" data-testid="topic-actions">
        <button type="button" className="btn" disabled={!!offTitle} title={offTitle} onClick={() => { setTagging(null); setEditing(true); }} data-testid="topic-edit-bottom">修改</button>
        <button type="button" className="aibtn" disabled={readOnly} title="往对话区的输入框里预填一句话，由你发出"
          onClick={() => onPrefill?.(reviseDependentsText(item))} data-testid="topic-revise">让助手照这条改条目</button>
        {!gone && <button type="button" className="btn" disabled={!!offTitle} title={offTitle} onClick={() => setRetiring(true)} data-testid="topic-retire">标为已废弃</button>}
        <button type="button" className="aibtn" disabled={!!offTitle} title={offTitle ?? "请助手把对这一节及其下面各节的理解讲成一段故事，请核对这段复述"}
          onClick={() => onSend?.(retellText(titleOf(item)))} data-testid="topic-retell">复述一遍</button>
      </div>
      {retiring && (
        <div className="oa-ask" data-testid="topic-retire-ask">
          标为已废弃之后，这一页还留着、在目录里划掉；依据它写的 {basisCount} 个条目会显示待核实，要改依据到别的节。确定吗？
          <button type="button" className="btn sm pri" onClick={() => void retire()} data-testid="topic-retire-yes">标为已废弃</button>
          <button type="button" className="btn sm" onClick={() => setRetiring(false)}>取消</button>
        </div>
      )}
      <div className="oa-rawlink"><span role="button" onClick={onRaw} data-testid="topic-raw">看修订与全部来源</span></div>
      </>)}
    </div>
  );
}

/** 「待澄清事项」里的一个问题：问题、需要它的原因、回答框与「记下」、「暂不处理」。问题的编号不写在正文里，悬停时看得到。 */
function Question({ task, question, off, offTitle, onSend, onAnswer, onOpen, onKeep }: {
  task: Task; question: Item; off: boolean; offTitle?: string;
  onSend?: (text: string) => void; onAnswer?: (question: Item) => void; onOpen: (itemId: string) => void; onKeep: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const why = questionReason(task, question);
  const blocking = questionBlockingText(task, question);
  const revisit = questionRevisit(question);
  const typed = answer.trim() !== "";
  // 写了字点「记下」是直接发给助手；空着点是把开头填进对话区的输入框，让用户到那里接着写。
  const record = () => {
    if (!typed) { onAnswer?.(question); return; }
    onSend?.(issueAnswerText(question.item_id, answer.trim()));
    setAnswer("");
  };
  return (
    <li data-testid={`topic-question-${question.item_id}`}>
      <div className="q">
        {blocking && <span className={`oa-qkind${isBlockingQuestion(question) ? " block" : ""}`} data-testid={`topic-blocking-${question.item_id}`}>{blocking}</span>}
        <span className="qlink" role="button" title={`打开 ${question.item_id}`} onClick={() => onOpen(question.item_id)}>{question.title}</span>
      </div>
      {why && <div className="why">需要它的原因：{why}</div>}
      {revisit && <div className="why" data-testid={`topic-revisit-${question.item_id}`}>何时回看：{revisit}</div>}
      <div className="ans">
        <input value={answer} placeholder="在这里写你的回答…" aria-label={`回答 ${question.item_id}`} disabled={off} title={off ? offTitle : undefined}
          onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && typed && !off) record(); }} />
        <button type="button" className="btn sm pri" disabled={off} title={off ? offTitle : typed ? "发给助手" : "输入框空着时只把开头填进对话区的输入框，不发送"}
          onClick={record} data-testid={`topic-answer-${question.item_id}`}>记下</button>
        <button type="button" className="btn sm" disabled={off} title={off ? offTitle : "这个问题留着不答，不再算没定"} onClick={onKeep}
          data-testid={`topic-keep-${question.item_id}`}>暂不处理</button>
      </div>
    </li>
  );
}
