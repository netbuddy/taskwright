// 切换工作面板（顶栏点「当前活动：某项活动 ▾」或「自由讨论 · 不绑定活动」打开）与它里面的启动确认框。
// 面板三组：本会话的工作项（继续、换一条干净的会话接着、删除这个工作项；自由讨论的会话写它不绑定活动，没有按钮）、
// 辅助操作（在本会话里做，不改变本会话的工作项：都是工作视图里已有的操作）、其他活动（活动目录里的单项活动与工作流程，
// 一律新建一个工作项与一条会话；点能启动的一项进确认框）。确认框写这样启动之后各处怎样、可以写范围说明，点主按钮启动：
// 后端新建工作项与会话，替用户发那项活动的第一句话（与活动输入页相同），然后进新会话。
// 数据是打开面板时带这条会话取的一次任务状况；各句话在 model/switchWork.ts。资产六格与卡片沿用任务起点页的样式。

import { useEffect, useRef, useState } from "react";
import { Modal } from "antd";
import { api, ApiError, clientId } from "../../api/client";
import type { CatalogFlow, StageView, TaskStatusView } from "../../api/types";
import { SCOPE_MAX_LENGTH } from "../../model/startInput";
import { START_ARROW, flowInProgress, flowPositionLine } from "../../model/startPage";
import {
  type LaunchPick, confirmButton, confirmEffects, confirmFields, confirmFirstMessage, confirmPurpose, confirmTitle, continueLabel, ownItemHeading, ownItemLine, panelSubtitle,
} from "../../model/switchWork";
import { go, href } from "../../router";
import { AssetCells } from "../task/StartBlocks";
import { useToast } from "../Toasts";
import "../../styles/task-page.css";
import "../../styles/switch-work.css";

/** 「回答待澄清问题」预填进输入框的那句话：用户自己发出去，助手据此逐个提问。 */
export const ANSWER_QUESTIONS_TEXT = "请把还没有回答的待澄清问题逐个问我。";

export interface SwitchWorkActions {
  /** 预填输入框（回答待澄清问题）。 */
  onPrefill: (text: string) => void;
  /** 请助手复述当前理解：替用户发「复述一遍」那句话。 */
  onRetell: () => void;
  /** 对待评审的条目发起评审。 */
  onReview: () => void;
  /** 补充项目材料：上传一份，随下一句话交给助手。 */
  onAttach: (file: File) => void;
  /** 查看工作进展：在对话里插一张状况卡。 */
  onShowStatus: () => void;
  /** 换一条干净的会话接着做本会话的工作项。 */
  onContinue: (recordId: number) => void;
  /** 删除本会话的工作项（先确认）。 */
  onDelete: (recordId: number, name: string, sessions: number, flow: boolean) => void;
}

export function SwitchWorkPanel({ open, taskId, sessionId, stage, pendingReview, off, actions, onClose }: {
  open: boolean;
  taskId: string;
  sessionId: string;
  /** 这条会话的整份数据里的 stage：它属于的工作项、现在在哪一站。 */
  stage: StageView | null | undefined;
  /** 待评审的条目有几条（「对已写的 N 条发起评审」）。 */
  pendingReview: number;
  /** 现在不能做事（助手在工作、任务结束等）时的原因：辅助操作、换会话、删除与启动都点不动。 */
  off: string | null;
  actions: SwitchWorkActions;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<TaskStatusView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pick, setPick] = useState<LaunchPick | null>(null);
  const [scope, setScope] = useState("");
  const [starting, setStarting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // 每次打开都带这条会话重取一次任务状况，回到面板的第一屏。
  useEffect(() => {
    if (!open) return;
    setPick(null);
    setFailed(null);
    let live = true;
    api.taskStatus(taskId, sessionId).then((r) => { if (live) setStatus(r.status); })
      .catch((e) => { if (live) setFailed(e instanceof ApiError ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, taskId, sessionId]);

  const own = stage?.work_item ?? null;
  const ownView = own ? status?.work_items?.find((one) => one.record_id === own.record_id) ?? null : null;
  const catalog = status?.catalog ?? null;
  const questions = status?.description.open_questions ?? 0;
  const doAndClose = (run: () => void) => { run(); onClose(); };

  /** 另一个工作项的会话：打开它最近有动静的那一条。 */
  const openItemSession = (recordId: number) => {
    const latest = status?.work_items?.find((one) => one.record_id === recordId)?.latest_session;
    if (latest) { onClose(); go(href.work(taskId, latest.session_id)); }
  };

  const choose = (next: LaunchPick) => { setScope(""); setPick(next); };

  /** 确认框的主按钮：启动，成了替用户发第一句话，进新会话。启动不成留在确认框；第一句话没有发出去照样进新会话，在那里再说。 */
  const start = async () => {
    if (!pick || starting) return;
    const fields = confirmFields(pick, scope);
    if (!fields) return;
    setStarting(true);
    let started: string;
    try {
      started = (await api.startInNewSession(taskId, fields)).session_id;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "没有启动成。");
      setStarting(false);
      return;
    }
    const first = confirmFirstMessage(pick);
    if (first) {
      try {
        await api.sendMessage(taskId, started, { text: first, client_id: clientId(), attachments: [] });
      } catch (e) {
        toast.error(`已经启动，但第一句话没有发出去：${e instanceof ApiError ? e.message : String(e)} 请在对话区再说一遍。`);
      }
    }
    setStarting(false);
    onClose();
    go(href.work(taskId, started));
  };

  const flowCard = (flow: CatalogFlow) => {
    const running = flowInProgress(flow);
    const mine = running && own?.kind === "flow" && own.record_id === flow.work_item?.record_id;
    const can = flow.enabled && !off;
    return (
      <div key={flow.key} className={`tp-act sw-pick${can ? " go" : running ? " now" : " off"}`} data-testid={`switch-flow-${flow.key}`}
        role={can ? "button" : undefined} onClick={can ? () => choose({ kind: "flow", flow }) : undefined}>
        <div className="t">{flow.name}<small>工作流程</small>{running && <span className="chip okc">已在进行</span>}</div>
        <div className="d">{flow.purpose}</div>
        <div className="tp-go">
          {mine && <span className="tp-quiet">本会话就是它的会话。</span>}
          {running && !mine && <span className="tp-quiet">{flowPositionLine(flow)}。</span>}
          {running && !mine && (
            <button className="btn sm" onClick={(e) => { e.stopPropagation(); openItemSession(flow.work_item!.record_id); }} data-testid="switch-open-flow">打开它的会话</button>
          )}
          {!running && !flow.enabled && <span className="tp-need">{flow.state.startsWith("已有流程工作项") ? `${flow.state}。` : flow.prerequisite_text}</span>}
          {can && <span className="tp-arrow">{START_ARROW}</span>}
        </div>
      </div>
    );
  };

  const list = (
    <div className="sw-panel" data-testid="switch-panel">
      <div className="sw-sub" data-testid="switch-subtitle">{panelSubtitle(stage, status)}</div>
      {failed && <div className="tp-need">任务状况没有取到：{failed}</div>}
      {status?.assets && <AssetCells assets={status.assets} />}

      <div className="sw-group" data-testid="switch-own">
        <div className="gt"><b>本会话的工作项</b>{stage && own ? ownItemHeading(stage) : "本会话是自由讨论，不绑定活动"}</div>
        {stage && own ? (
          <div className="sw-now">
            <div className="sw-now-l">
              <div className="t">{own.name}{own.scope && <small>范围：{own.scope}</small>}</div>
              <div className="d">{ownItemLine(stage)}</div>
            </div>
            <div className="sw-now-r">
              <button className="btn pri" onClick={onClose} data-testid="switch-continue">{continueLabel(stage)}</button>
              <button className="btn" disabled={!!off} title={off ?? undefined} onClick={() => doAndClose(() => actions.onContinue(own.record_id))} data-testid="switch-fresh">换一条干净的会话接着</button>
              <button className="btn" disabled={!!off} title={off ?? undefined}
                onClick={() => doAndClose(() => actions.onDelete(own.record_id, own.name, ownView?.session_count ?? 1, own.kind === "flow"))} data-testid="switch-delete">删除这个工作项</button>
            </div>
          </div>
        ) : <div className="tp-quiet">要做哪一项活动，在下面「其他活动」里启动；本会话原地留着。</div>}
      </div>

      <div className="sw-group" data-testid="switch-basics">
        <div className="gt"><b>辅助操作</b>在本会话里做，不改变本会话的工作项</div>
        <div className="sw-basics">
          <button className="btn" disabled={!!off || questions === 0} onClick={() => doAndClose(() => actions.onPrefill(ANSWER_QUESTIONS_TEXT))} data-testid="switch-questions">回答待澄清问题（{questions}）</button>
          <button className="btn" disabled={!!off} onClick={() => doAndClose(actions.onRetell)} data-testid="switch-retell">请助手复述当前理解</button>
          <button className="btn" disabled={!!off || pendingReview === 0} onClick={() => doAndClose(actions.onReview)} data-testid="switch-review">对已写的 {pendingReview} 条发起评审</button>
          <button className="btn" disabled={!!off} onClick={() => fileInput.current?.click()} data-testid="switch-attach">补充项目材料</button>
          <button className="btn" onClick={() => doAndClose(actions.onShowStatus)} data-testid="switch-status">查看工作进展</button>
          <input ref={fileInput} type="file" hidden data-testid="switch-attach-input"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) doAndClose(() => actions.onAttach(file)); }} />
        </div>
      </div>

      {catalog && (
        <div className="sw-group" data-testid="switch-others">
          <div className="gt"><b>其他活动</b>一律新建一个工作项与一条会话；本会话原地留着，随时从会话菜单或任务起点页回来</div>
          <div className="tp-acts">
            {catalog.activities.map((one) => {
              const can = one.enabled && !off;
              const count = one.active_count ?? 0;
              return (
                <div key={one.key} className={`tp-act sw-pick${can ? " go" : " off"}`} data-testid={`switch-activity-${one.key}`}
                  role={can ? "button" : undefined} onClick={can ? () => choose({ kind: "activity", activity: one }) : undefined}>
                  <div className="t">{one.name}<small>{one.mode_name}</small>{count > 0 && <span className="chip okc">{count} 个工作项</span>}</div>
                  <div className="d">{one.purpose}</div>
                  <div className="tp-go">
                    {!one.enabled && <span className="tp-need" title={`${one.state}。`}>{one.prerequisite_text}</span>}
                    {can && <span className="tp-arrow">{START_ARROW}</span>}
                  </div>
                </div>
              );
            })}
            {catalog.flows.map(flowCard)}
          </div>
        </div>
      )}
    </div>
  );

  const confirm = pick && (
    <div className="sw-confirm" data-testid="switch-confirm">
      <div className="sw-sub">{confirmPurpose(pick)}</div>
      <h4>这样启动之后</h4>
      <dl className="sw-eff" data-testid="switch-effects">
        {confirmEffects(pick, stage, status).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}
      </dl>
      <h4>范围说明（可选，随工作项一并发给助手）</h4>
      <textarea className="sw-scope" value={scope} maxLength={SCOPE_MAX_LENGTH} onChange={(e) => setScope(e.target.value)} data-testid="switch-scope"
        placeholder="例如：只重画对象关系图，流程图不动。" />
      <div className="sw-fa">
        <button className="btn" onClick={() => setPick(null)} data-testid="switch-confirm-back">取消</button>
        <button className="btn pri" disabled={starting || !!off} onClick={() => void start()} data-testid="switch-confirm-start">{confirmButton(pick)}</button>
      </div>
    </div>
  );

  return (
    <Modal open={open} onCancel={onClose} footer={null} width="64rem" destroyOnHidden
      title={pick ? <span data-testid="switch-title">{confirmTitle(pick)}</span> : <span data-testid="switch-title">切换工作</span>}>
      {pick ? confirm : list}
    </Modal>
  );
}
