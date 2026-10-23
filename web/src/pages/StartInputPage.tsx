// 活动输入页：从任务起点页点了一条工作流程或一项单项活动之后的那一页，启动在这里提交。这一页没有对话区。
// 自上而下：「返回任务起点」、这一项的名称与一句（流程从哪一站开始、活动的方式）、流程的各站一行、目的与前提的摘要、
// 几块输入、「启动后」会发生什么、主按钮「启动某项」。
// 输入有四块，按这一项读哪几类资产显示（model/startInput.ts 的 inputBlocks）：项目材料（上传与清单，与任务起点页的材料卡是同一个组件）、
// 领域知识库（勾选这个任务选用的知识库）、目标系统描述（它就是会话的第一条消息）、范围说明（只有单项活动有，随启动的请求发给后端）。
// 材料上传与知识库勾选都是当场生效的，不等点主按钮。
// 点主按钮：先发启动的请求（后端新建一个工作项与一条属于它的会话，回应里带新会话的编号），成了再替用户发第一句话
// （写了目标系统描述就是那段描述，没有写是这项活动的那句固定的话），然后进那条会话的工作台。没有启动成（例如助手正在工作）在页上报后端的原话，不跳转。
// 这一页不选会话：一条会话在建立时就属于一个工作项，启动一律新建。任务里已有流程工作项时流程不能再启动，主按钮旁给「打开它的会话」。
// 澄清的输入页在范围说明之上另有「待澄清问题」勾选块：还没了结的待澄清问题（阻断下游的在前）与待决定事项（model/pendingWork.ts 的 pickRows）。
// 勾选的编号写进范围说明（「只澄清这几项：…。」在前，用户自己写的接在后面）；地址带 ?pick=编号,编号 时（从起点页「待处理事项」进来）那几项预先勾好。

import { useEffect, useState } from "react";
import { Alert, Input, Spin } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { api, ApiError, clientId } from "../api/client";
import type { KnowledgeLibrary, Material, TaskDetail, TaskStatusView } from "../api/types";
import { TaskFrame } from "../components/TaskFrame";
import { useToast } from "../components/Toasts";
import { useService } from "../components/ServiceControls";
import { KnowledgeChoice } from "../components/task/KnowledgeChoice";
import { MaterialsCard } from "../components/task/MaterialsCard";
import { useMaterialViewer } from "../components/task/MaterialViewer";
import { ownMaterials } from "../model/docx";
import {
  SCOPE_MAX_LENGTH, blockedLine, existingFlowItem, firstMessage, inputBlocks, inputSlots, missingInput, prerequisiteBody, startActivityOf, startButton, startFields, startSubtitle, startTarget, targetName,
} from "../model/startInput";
import { composeScope, pickRows, pickedScope, showsPendingWork } from "../model/pendingWork";
import { go, href } from "../router";
import "../styles/task-page.css";

export function StartInputPage({ taskId, startKey, pick = [] }: {
  taskId: string;
  /** 地址里的键：一条工作流程或一项单项活动的键。 */
  startKey: string;
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
  const missing = inputSlots(target).length > 0 ? null : missingInput(target, blocks, status?.assets, description);
  const selected = task.knowledge_libraries ?? [];
  const materials = ownMaterials(task.materials);
  // 声明了槽位的流程（需求再工程）按槽位分块画输入；别的流程与单项活动照旧。
  const slots = inputSlots(target);
  const slotted = slots.length > 0;
  // 每个收材料的槽位列哪些材料：放进了槽位的列在那个槽位；没有放进槽位的（起点页上传的、升级前就有的，角色是「证据」）
  // 按角色并入第一个角色相同的槽位（需求再工程里是「补充证据」）。
  const materialSlots = slots.filter((one) => one.accepts === "materials");
  const homeOf = (one: Material): string | null => one.slot ?? materialSlots.find((slot) => slot.role === (one.role ?? "证据"))?.key ?? null;
  // 已有流程工作项时「打开它的会话」进它最近有动静的那条会话（任务状况的工作项清单里有）。
  const flowItem = existingFlowItem(target);
  const flowSession = flowItem === null ? null : status?.work_items?.find((one) => one.record_id === flowItem)?.latest_session?.session_id ?? null;
  // 从头编制：启动工作流程、业务说明还空着。这时「启动后」写有材料与没有材料两种情形，三块输入上面有一段话。
  // 按槽位分块的流程不是从头编制：没有那一段话，「启动后」写从哪一站开始。
  const first = target.kind === "flow" && blocks.description && inputSlots(target).length === 0;
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
      await api.sendMessage(taskId, sessionId, { text: firstMessage(startActivityOf(target)!, slotted || blocks.description ? description : ""), client_id: clientId(), attachments: [] });
    } catch (e) {
      toast.error(`已经启动「${name}」，但第一句话没有发出去：${e instanceof ApiError ? e.message : String(e)} 请在对话区再说一遍。`);
    }
    go(href.work(taskId, sessionId));
  };

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

      {!slotted && blocks.materials && blocks.knowledge && (
        <p className="tp-in-split" data-testid="start-split">
          <b>输入资料与知识库的分工</b>输入资料是本任务实例的几份一手证据，助手逐句引用；规范、接口说明、法规、旧文档等参考资料放进知识库，可供多个任务实例选用。
        </p>
      )}
      {slotted && (
        <div className="tp-in-slots" data-testid="slot-blocks">
          {slots.map((slot) => (slot.accepts === "materials" ? (
            <div key={slot.key} className="tp-in-block">
              <MaterialsCard taskId={taskId} materials={materials.filter((one) => homeOf(one) === slot.key)} info={service.info} onView={view} onChanged={() => void load()}
                title={slot.name} aside={slot.required ? "必填" : "可选"} slot={slot.key} testId={`slot-${slot.key}`} emptyText="还没有放进这一块的输入资料。"
                replace={(one) => !!one.slot} />
            </div>
          ) : (
            <section key={slot.key} className="tp-pane tp-in-block" aria-label={slot.name} data-testid={`slot-${slot.key}`}>
              <div className="tp-sec-h">
                <h2><EditOutlined className="tp-hic" />{slot.name}</h2>
                <span className="aside">{slot.required ? "必填" : "可选"} · 作为会话的第一条消息发给助手</span>
              </div>
              <Input.TextArea value={description} onChange={(e) => setDescription(e.target.value)} autoSize={{ minRows: 4, maxRows: 12 }}
                placeholder={intake?.describe_placeholder} data-testid="describe-input" />
            </section>
          )))}
          {blocks.knowledge && <div className="tp-in-block"><KnowledgeChoice libraries={libraries} selected={selected} onChange={(ids) => void changeKnowledge(ids)} /></div>}
        </div>
      )}
      {!slotted && (blocks.materials || blocks.knowledge) && (
        <div className={`tp-pair${blocks.materials && blocks.knowledge ? "" : " single"}`}>
          {blocks.materials && (
            <div className="tp-in-wrap">
              <MaterialsCard taskId={taskId} materials={materials} info={service.info} onView={view} onChanged={() => void load()}
                title="输入资料" aside={target.kind === "flow" ? "可选 · 推荐" : undefined}
                intro={(
                  <>
                    <p className="tp-in-p">属于本项目的文件。助手核读后逐句引用，作为需求的证据。</p>
                    {intake && <ul className="tp-in-kinds">{intake.material_kinds.map((one) => <li key={one}>{one}</li>)}</ul>}
                  </>
                )} />
            </div>
          )}
          {blocks.knowledge && <KnowledgeChoice libraries={libraries} selected={selected} onChange={(ids) => void changeKnowledge(ids)} />}
        </div>
      )}

      {!slotted && blocks.description && (
        <div>
          <section className="tp-pane tp-in-block" aria-label="目标系统描述" data-testid="describe-block">
            <div className="tp-sec-h">
              <h2><EditOutlined className="tp-hic" />目标系统描述</h2>
              <span className="aside">{target.kind === "flow" ? "无输入资料时必填" : "可选"} · 作为会话的第一条消息发给助手</span>
            </div>
            {intake && <p className="tp-in-p">{intake.describe_note}</p>}
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
          <p className="tp-in-p">限定这次只做哪一部分，例如只针对某几节、某几份输入资料或某几条条目；不写就是全部。助手在这个工作项的各条会话里都看得到这段话。</p>
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
