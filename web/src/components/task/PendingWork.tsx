// 任务起点页「待处理事项」一节：任务有需求资产时显示，在「工作项」一节之上。内容由 model/pendingWork.ts 从任务详情与任务状况算出，这里只画。
// 四张卡两列排：待澄清问题；待决定事项与待核实条目；未查看的分析模型；评审发现。有流程工作项时末尾一行「推进建议」占满一行。
// 每一行旁的动作：问题与待决定事项「启动澄清」（进澄清的输入页并预先勾好这一项，阻断下游的问题不止一条时另有一并处理的一个按钮）；
// 待核实条目「打开写条目的会话」，没有写条目的工作项时「启动写条目」；未查看的模型「查看」（进工作台打开那张图）；
// 评审发现「打开评审确认的会话」，没有评审确认的工作项时「启动评审确认」。任务已经结束时只留看图的「查看」（工作台只读，照样能看）。
// 样式在 styles/task-page.css，按钮与小标签用工作视图已有的样式（.btn、.chip）。

import type { CatalogActivity, StageKey, TaskDetail, TaskStatusView } from "../../api/types";
import { PENDING_ROWS, adviceLine, notBlockingLine, pendingWork, workItemDoing, type PendingRow } from "../../model/pendingWork";
import { latestSession } from "../../model/startPage";
import { go, href } from "../../router";

export function PendingWorkSection({ task, status, closed }: { task: TaskDetail; status: TaskStatusView | null; closed: boolean }) {
  const work = pendingWork(task);
  if (!work) return null;
  const activity = (key: StageKey): CatalogActivity | null => status?.catalog?.activities.find((one) => one.key === key) ?? null;
  const clarify = closed ? null : activity("clarifying");
  const startClarify = (ids: string[]) => go(href.start(task.task_id, "clarifying", null, ids));
  /** 打开做某项活动的工作项最近的会话；没有这样的工作项而那项活动能启动时，进它的输入页。两样都不行时没有按钮。 */
  const sessionOrStart = (key: StageKey, open: string, start: string) => {
    if (closed) return null;
    const item = workItemDoing(status, key);
    if (item?.latest_session) return { text: open, to: href.work(task.task_id, item.latest_session.session_id) };
    return activity(key)?.enabled ? { text: start, to: href.start(task.task_id, key) } : null;
  };
  const writing = sessionOrStart("writing", "打开写条目的会话", "启动写条目");
  const reviewing = sessionOrStart("reviewing", "打开评审确认的会话", "启动评审确认");
  // 看图要进某一条会话的工作台：用最近有动静的那条。
  const anySession = latestSession(task.sessions ?? []);
  const flowItem = status?.work_items?.find((one) => one.kind === "flow") ?? null;
  const advice = adviceLine(task, status, work);
  const more = (rows: PendingRow[]) => rows.length > PENDING_ROWS && <div className="tp-todo-more">还有 {rows.length - PENDING_ROWS} 条没有列出。</div>;
  const row = (one: PendingRow, action: React.ReactNode) => (
    <div key={one.id} className="tp-todo-it" data-testid={`todo-${one.id}`}>
      <span className="id">{one.id}</span>
      <div className="b"><b>{one.title}</b>{one.note && <small>{one.note}</small>}</div>
      {action}
    </div>
  );
  const link = (to: { text: string; to: string } | null) => to && <button className="btn sm" onClick={() => go(to.to)}>{to.text}</button>;
  const empty = (text: string) => <div className="tp-todo-none">{text}</div>;
  const clarifyButton = (id: string) => clarify && <button className="btn sm pri" onClick={() => startClarify([id])} data-testid="todo-clarify">启动澄清</button>;
  const notBlocking = notBlockingLine(work);
  return (
    <div className="tp-todo" data-testid="pending-work">
      <div className="tp-todo-card" data-testid="todo-questions">
        <h3>待澄清问题
          {work.blocking > 0 ? <span className="chip warn">阻断下游 {work.blocking}</span> : <span className="chip">{work.questions.length}</span>}
          {notBlocking && <span className="n">{notBlocking}</span>}
        </h3>
        {work.questions.length === 0 && empty("没有还没了结的待澄清问题。")}
        {work.questions.slice(0, PENDING_ROWS).map((one) => row(one, clarifyButton(one.id)))}
        {more(work.questions)}
        {clarify && work.blocking > 1 && (
          <div className="tp-todo-it"><span className="id" /><div className="b"><small>{work.blocking} 条一并处理</small></div>
            <button className="btn sm" onClick={() => startClarify(work.questions.map((one) => one.id))} data-testid="todo-clarify-all">启动澄清（选择 {work.blocking} 条）</button></div>
        )}
      </div>
      <div className="tp-todo-card" data-testid="todo-decisions">
        <h3>待决定事项<span className="chip">{work.decisions.length}</span></h3>
        {work.decisions.length === 0 && empty("没有待决定的事项。")}
        {work.decisions.slice(0, PENDING_ROWS).map((one) => row(one, clarifyButton(one.id)))}
        {more(work.decisions)}
        <h3 className="next" data-testid="todo-pending-items">待核实条目<span className="chip">{work.pendingItems.length}</span></h3>
        {work.pendingItems.length === 0 && empty("没有待核实的条目。")}
        {work.pendingItems.slice(0, PENDING_ROWS).map((one) => row(one, link(writing)))}
        {more(work.pendingItems)}
      </div>
      <div className="tp-todo-card" data-testid="todo-models">
        <h3>未查看的分析模型<span className="chip">{work.unviewedModels.length}</span></h3>
        {work.unviewedModels.length === 0 && empty("分析模型都看过了。")}
        {work.unviewedModels.slice(0, PENDING_ROWS).map((one) => row(one, anySession && (
          <button className="btn sm" onClick={() => go(href.diagrams(task.task_id, anySession.session_id, one.id))}>查看</button>
        )))}
        {more(work.unviewedModels)}
      </div>
      <div className="tp-todo-card" data-testid="todo-findings">
        <h3>评审发现<span className="chip">{work.findings.length}</span></h3>
        {work.findings.length === 0 && empty(work.reviewed ? "评审没有未处理的发现。" : "尚未发起评审。")}
        {work.findings.slice(0, PENDING_ROWS).map((one) => row(one, link(reviewing)))}
        {more(work.findings)}
      </div>
      {advice && (
        <div className="tp-todo-adv" data-testid="todo-advice">
          <b>推进建议</b><span>{advice}</span>
          {!closed && flowItem?.latest_session && (
            <button className="btn sm" onClick={() => go(href.work(task.task_id, flowItem.latest_session!.session_id))}>打开{flowItem.name}的会话</button>
          )}
        </div>
      )}
    </div>
  );
}
