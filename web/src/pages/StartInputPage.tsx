// 活动输入页：从任务起点页点了一条工作流程或一项单项活动之后的那一页，启动在这里提交。这一页没有对话区。
// 自上而下：「返回任务起点」、这一项的名称与一句（流程从哪一站开始、活动的方式）、流程的各站一行、目的与前提的摘要、
// 几块输入、「启动后」会发生什么、主按钮「启动某项」。
// 输入有四块，按这一项读哪几类资产显示（model/startInput.ts 的 inputBlocks）：项目材料（上传与清单，与任务起点页的材料卡是同一个组件）、
// 领域知识库（勾选这个任务选用的知识库）、目标系统描述（它就是会话的第一条消息）、范围说明（只有单项活动有，随启动的请求发给后端）。
// 材料上传与知识库勾选都是当场生效的，不等点主按钮。
// 点主按钮：先发启动的请求（后端新建一个工作项与一条属于它的会话，回应里带新会话的编号），成了再替用户发第一句话
// （写了目标系统描述就是那段描述，没有写是这项活动的那句固定的话），然后进那条会话的工作台。没有启动成（例如助手正在工作）在页上报后端的原话，不跳转。
// 这一页不选会话：一条会话在建立时就属于一个工作项，启动一律新建。任务里已有流程工作项时流程不能再启动，主按钮旁给「打开它的会话」。
// 地址带 ?case=序号 时是从三种常见起点里的某一种进来的：那种起点要先看的那一块描黑边并滚到眼前，块里写着那种起点的做法。
// 澄清的输入页在范围说明之上另有「待澄清问题」勾选块：还没了结的待澄清问题（阻断下游的在前）与待决定事项（model/pendingWork.ts 的 pickRows）。
// 勾选的编号写进范围说明（「只澄清这几项：…。」在前，用户自己写的接在后面）；地址带 ?pick=编号,编号 时（从起点页「待处理事项」进来）那几项预先勾好。

import { useEffect, useRef, useState } from "react";
import { Alert, Input, Spin } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { api, ApiError, clientId } from "../api/client";
import type { KnowledgeLibrary, TaskDetail, TaskStatusView } from "../api/types";
import { TaskFrame } from "../components/TaskFrame";
import { useToast } from "../components/Toasts";
import { useService } from "../components/ServiceControls";
import { KnowledgeChoice } from "../components/task/KnowledgeChoice";
import { MaterialsCard } from "../components/task/MaterialsCard";
import { useMaterialViewer } from "../components/task/MaterialViewer";
import { ownMaterials } from "../model/docx";
import {
  SCOPE_MAX_LENGTH, blockedLine, existingFlowItem, firstMessage, inputBlocks, missingInput, prerequisiteBody, startButton, startFields, startSubtitle, startTarget, targetName,
} from "../model/startInput";
import { composeScope, pickRows, pickedScope, showsPendingWork } from "../model/pendingWork";
import { go, href } from "../router";
import "../styles/task-page.css";

export function StartInputPage({ taskId, startKey, startCase, pick = [] }: {
  taskId: string;
  /** 地址里的键：一条工作流程或一项单项活动的键。 */
  startKey: string;
  /** 从三种常见起点里的第几种进来的；不是从那里进来的是 null。 */
  startCase: number | null;
  /** 预先勾好的问题与待决定事项的编号（从起点页「待处理事项」进澄清的输入页时）；没有是空的。 */
  pick?: string[];
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [status, setStatus] = useState<TaskStatusView | null>(null);
  // 任务状况读过没有：读过了而目录里没有这一项，才说没有；还没有读到时先等着。
  const [statusRead, setStatusRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState("");
  // 「待澄清问题」勾选块里勾着的编号。
  const [picked, setPicked] = useState<string[]>(pick);
  // 启动的请求发出去、还没有进工作台：主按钮点不动，免得启动两次。
  const [starting, setStarting] = useState(false);
  const toast = useToast();
  const service = useService();
  const hasKnowledge = !!service.info?.capabilities.knowledge;
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  useEffect(() => { if (hasKnowledge) api.knowledge().then(setLibraries).catch(() => setLibraries([])); }, [hasKnowledge]);
  const { view, viewer } = useMaterialViewer(taskId);

  const load = () => {
    void api.taskStatus(taskId).then((r) => setStatus(r.status)).catch(() => setStatus(null)).finally(() => setStatusRead(true));
    return api.getTask(taskId).then(setTask).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  };
  useEffect(() => { void load(); }, [taskId]);

  // 从三种常见起点进来：要先看的那一块滚到眼前；目标系统描述那一块另把光标放进文本框。只在这一块第一次画出来时做一次。
  const focusCase = startCase === null ? null : status?.start_page?.cases[startCase] ?? null;
  const materialsBlock = useRef<HTMLDivElement>(null);
  const descriptionBlock = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const ready = !!task && statusRead;
  useEffect(() => {
    if (!ready || focused.current || !focusCase?.focus) return;
    focused.current = true;
    const block = focusCase.focus === "materials" ? materialsBlock.current : descriptionBlock.current;
    block?.scrollIntoView?.({ block: "center" });
    if (focusCase.focus === "description") block?.querySelector("textarea")?.focus();
  }, [ready, focusCase]);

  const back = <div className="tp-back"><a href={href.task(taskId)} data-testid="back-to-start">‹ 返回任务起点</a></div>;
  const frame = (name: string | undefined, where: string, body: React.ReactNode) => (
    <TaskFrame taskId={taskId} taskName={name} where={where} sessions={task?.sessions ?? []} task={task} pending={!!task && showsPendingWork(task, status)}>
      <div className="tp-page" data-testid="start-input-page">{back}{body}</div>
    </TaskFrame>
  );
  if (error) return frame(undefined, "任务起点", <Alert type="error" showIcon message={error} />);
  if (!task || !statusRead) return frame(task?.task_name, "任务起点", <Spin />);

  const target = startTarget(status?.catalog, startKey);
  if (!target) {
    return frame(task.task_name, "任务起点", <Alert type="info" showIcon message="活动目录里没有这一项，请回任务起点重新选择。" data-testid="start-unknown" />);
  }

  const name = targetName(target);
  const blocks = inputBlocks(target, status?.assets, hasKnowledge);
  const intake = status?.start_page?.intake;
  const fields = startFields(target);
  const blocked = blockedLine(target);
  const missing = missingInput(target, blocks, status?.assets, description);
  const selected = task.knowledge_libraries ?? [];
  const materials = ownMaterials(task.materials);
  // 已有流程工作项时「打开它的会话」进它最近有动静的那条会话（任务状况的工作项清单里有）。
  const flowItem = existingFlowItem(target);
  const flowSession = flowItem === null ? null : status?.work_items?.find((one) => one.record_id === flowItem)?.latest_session?.session_id ?? null;
  // 从头编制：启动工作流程、业务说明还空着。这时「启动后」写有材料与没有材料两种情形，三块输入上面有一段话。
  const first = target.kind === "flow" && blocks.description;
  const startNode = target.kind === "flow" ? target.flow.nodes.find((one) => one.key === target.flow.start) : null;
  // 「待澄清问题」勾选块：只在澄清的输入页、任务里有可勾的问题或待决定事项时有。勾着的编号里只算现在还在清单上的。
  const picks = target.kind === "activity" && target.activity.key === "clarifying" ? pickRows(task) : [];
  const chosen = picks.filter((one) => picked.includes(one.id)).map((one) => one.id);
  const pickedLine = pickedScope(chosen);
  const toggle = (id: string) => setPicked((now) => (now.includes(id) ? now.filter((one) => one !== id) : [...now, id]));

  const changeKnowledge = async (ids: string[]) => {
    try {
      await api.setTaskKnowledge(taskId, ids);
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "选用的知识库没有改成。");
    }
  };

  /** 点主按钮：启动，成了再替用户发第一句话，然后进工作台。启动不成留在这一页；第一句话没有发出去照样进工作台，在那里再说。 */
  const start = async () => {
    if (!fields || starting || blocked || missing) return;
    setStarting(true);
    const note = composeScope(chosen, scope);
    const sent = { ...fields, ...(blocks.scope && note ? { scope: note } : {}) };
    let sessionId: string;
    try {
      sessionId = (await api.startInNewSession(taskId, sent)).session_id;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "没有启动成。");
      setStarting(false);
      return;
    }
    try {
      await api.sendMessage(taskId, sessionId, { text: firstMessage(fields.activity, blocks.description ? description : ""), client_id: clientId(), attachments: [] });
    } catch (e) {
      toast.error(`已经启动「${name}」，但第一句话没有发出去：${e instanceof ApiError ? e.message : String(e)} 请在对话区再说一遍。`);
    }
    go(href.work(taskId, sessionId));
  };

  const caseNote = (focus: "materials" | "description") =>
    focusCase?.focus === focus && <p className="tp-in-case" data-testid="start-case-note"><b>{focusCase.title}</b>{focusCase.text}</p>;

  return frame(task.task_name, `任务起点 › ${name}`, (
    <>
      <header className="tp-head">
        <div className="tp-head-l">
          <div className="tp-head-meta">{target.kind === "flow" ? "工作流程" : "单项活动"}</div>
          <div className="tp-head-title">
            <h1>{name}</h1>
            {startSubtitle(target) && <span className="tp-state" data-testid="start-subtitle">{startSubtitle(target)}</span>}
          </div>
        </div>
      </header>
      {target.kind === "flow" && (
        <div className="tp-stepline" data-testid="start-steps">
          <b>提供输入</b>{target.flow.nodes.map((one) => <span key={one.key}><i>›</i>{one.name}</span>)}
        </div>
      )}
      <dl className="tp-kv tp-in-sum" data-testid="start-summary">
        <dt>目的</dt><dd>{target.kind === "flow" ? target.flow.purpose : target.activity.purpose}</dd>
        {target.kind === "flow"
          ? <><dt>适用</dt><dd>{target.flow.applies}</dd></>
          : <><dt>产出</dt><dd>{target.activity.writes.map((one) => one.name).join("、")}</dd></>}
        <dt>前提</dt><dd>{prerequisiteBody(target.kind === "flow" ? target.flow.prerequisite_text : target.activity.prerequisite_text)}</dd>
      </dl>
      {first && intake && <p className="tp-lead" data-testid="start-lead">{intake.lead}</p>}

      {blocks.materials && blocks.knowledge && (
        <p className="tp-in-split" data-testid="start-split">
          <b>材料与知识库的分工</b>材料是本任务的几份一手证据，助手逐句引用；规范、接口说明、法规、旧文档等参考资料放进知识库，可供多个任务选用。
        </p>
      )}
      {(blocks.materials || blocks.knowledge) && (
        <div className={`tp-pair${blocks.materials && blocks.knowledge ? "" : " single"}`}>
          {blocks.materials && (
            <div ref={materialsBlock} className="tp-in-wrap">
              <MaterialsCard taskId={taskId} materials={materials} info={service.info} onView={view} onChanged={() => void load()}
                title="项目材料" aside={target.kind === "flow" ? "可选 · 推荐" : undefined} marked={focusCase?.focus === "materials"}
                intro={(
                  <>
                    <p className="tp-in-p">属于本项目的文件。助手核读后逐句引用，作为需求的证据。</p>
                    {intake && <ul className="tp-in-kinds">{intake.material_kinds.map((one) => <li key={one}>{one}</li>)}</ul>}
                    {caseNote("materials")}
                  </>
                )} />
            </div>
          )}
          {blocks.knowledge && <KnowledgeChoice libraries={libraries} selected={selected} onChange={(ids) => void changeKnowledge(ids)} />}
        </div>
      )}

      {blocks.description && (
        <div ref={descriptionBlock}>
          <section className={`tp-pane tp-in-block${focusCase?.focus === "description" ? " marked" : ""}`} aria-label="目标系统描述" data-testid="describe-block">
            <div className="tp-sec-h">
              <h2><EditOutlined className="tp-hic" />目标系统描述</h2>
              <span className="aside">{target.kind === "flow" ? "无材料时必填" : "可选"} · 作为会话的第一条消息发给助手</span>
            </div>
            {intake && <p className="tp-in-p">{intake.describe_note}</p>}
            {caseNote("description")}
            <Input.TextArea value={description} onChange={(e) => setDescription(e.target.value)} autoSize={{ minRows: 4, maxRows: 12 }}
              placeholder={intake?.describe_placeholder} data-testid="describe-input" />
            {intake && intake.describe_examples.length > 0 && (
              <div className="tp-in-egs" data-testid="describe-examples">
                <span className="lb">示例（点击填入）：</span>
                {intake.describe_examples.map((one) => <button key={one} type="button" className="eg" onClick={() => setDescription(one)}>{one}</button>)}
              </div>
            )}
          </section>
        </div>
      )}

      {blocks.scope && picks.length > 0 && (
        <section className="tp-pane tp-in-block" aria-label="待澄清问题" data-testid="pick-block">
          <div className="tp-sec-h"><h2>待澄清问题</h2><span className="aside">勾选后写进范围说明</span></div>
          <div className="tp-pick">
            {picks.map((one) => (
              <label key={one.id} data-testid={`pick-${one.id}`}>
                <input type="checkbox" checked={picked.includes(one.id)} onChange={() => toggle(one.id)} />
                <span><b>{one.id}</b> {one.title}<small>{one.note}</small></span>
              </label>
            ))}
          </div>
          <p className="tp-in-p" data-testid="pick-note">{pickedLine ? `范围说明的开头将写：${pickedLine}` : "没有勾选时，在下方范围说明里写明要澄清的范围。"}</p>
        </section>
      )}

      {blocks.scope && (
        <section className="tp-pane tp-in-block" aria-label="范围说明" data-testid="scope-block">
          <div className="tp-sec-h"><h2><EditOutlined className="tp-hic" />范围说明</h2><span className="aside">可选</span></div>
          <p className="tp-in-p">限定这次只做哪一部分，例如只针对某几节、某几份材料或某几条条目；不写就是全部。助手在这个工作项的各条会话里都看得到这段话。</p>
          <Input.TextArea value={scope} onChange={(e) => setScope(e.target.value)} autoSize={{ minRows: 2, maxRows: 8 }} maxLength={SCOPE_MAX_LENGTH - (pickedLine ? pickedLine.length + 1 : 0)}
            placeholder="例如：只整理「借书」「还书」两节的流程图。" data-testid="scope-input" />
        </section>
      )}

      <section className="tp-pane tp-in-block" aria-label="启动后" data-testid="start-after">
        <div className="tp-sec-h"><h2>启动后</h2></div>
        <ol className="tp-in-after">
          {first && intake ? intake.after.map((one) => <li key={one}>{one}</li>)
            : target.kind === "flow"
              ? <li>助手从「{startNode?.name ?? ""}」开始，每站完成后在对话区汇报并提议下一站，由你确认后进入。</li>
              : <li>助手进行「{name}」，完成后在对话区汇报结果，不提议下一站。</li>}
          <li>页面切换为工作台：左侧对话区，中间是六类需求资产的页签，右侧是原文定位与修订。</li>
        </ol>
      </section>

      <div className="tp-in-go">
        <button className="btn pri" disabled={!fields || !!blocked || !!missing || starting} onClick={() => void start()} data-testid="start-submit">{startButton(target)}</button>
        {blocked ? (
          <>
            <span className="tp-need" data-testid="start-blocked">{blocked}</span>
            {flowSession && <a className="tp-lnk" href={href.work(taskId, flowSession)} data-testid="start-open-flow-session">打开它的会话</a>}
          </>
        )
          : missing ? <span className="tp-need" data-testid="start-missing">{missing}</span>
            : <span className="tp-quiet" data-testid="start-where">将新建一个工作项和一条属于它的会话，并进入工作台。</span>}
      </div>
      {viewer}
    </>
  ));
}
