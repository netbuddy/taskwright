// 任务起点页的几块：「三步开始」指引与三种常见起点、工作项、需求资产现状六格、工作流程两张卡、单项活动七张卡、「自由讨论」一行。
// 文字都从任务状况取（资产现状 assets、工作项 work_items、活动目录 catalog、起点页的几段话 start_page），这里只画。
// 起点页是目录：工作流程卡、活动卡、三种常见起点与主按钮都只是进活动输入页（pages/StartInputPage.tsx），启动在那里提交；
// 「自由讨论」不经输入页，直接进工作台；工作项卡上的三个按钮由页面去做（打开会话、换一条会话接着、删除）。
// 样式在 styles/task-page.css，按钮与小标签用工作视图已有的样式（.btn、.chip）。

import type { ActivityCatalog, AssetCell, CatalogActivity, CatalogFlow, StartPageTexts, WorkItemView } from "../../api/types";
import { START_ARROW, flowInProgress, flowPositionLine, flowTag, producedLine, workItemMeta, workItemPosition, workItemSessionsLine } from "../../model/startPage";
import { go, href } from "../../router";

/** 「三步开始」：只在六类资产都空着、又没有工作项时显示。主按钮与三种常见起点都进推荐的那条工作流程的输入页。 */
export function StartGuide({ taskId, flow, texts }: {
  taskId: string;
  /** 推荐的工作流程；没有、或者现在不能启动时主按钮是灰的，三种起点不可点。 */
  flow: CatalogFlow | null;
  texts: StartPageTexts | undefined;
}) {
  const name = flow?.name ?? "工作流程";
  const open = flow?.enabled ? flow : null;
  return (
    <>
      <section className="tp-guide" data-testid="start-guide">
        <div className="tp-guide-l">
          <div className="gt">三步开始</div>
          <ol className="tp-steps">
            <li><span className="no">1</span><div><b>选择工作流程</b>从头编制或整体复查请启动「{name}」流程。</div></li>
            <li><span className="no">2</span><div><b>提供输入</b>上传项目材料，或直接描述目标系统。</div></li>
            <li><span className="no">3</span><div><b>由助手推进</b>助手逐站完成并提议下一站，每一步由你确认。</div></li>
          </ol>
        </div>
        <div className="tp-cta">
          <button className="btn pri tp-lg" disabled={!open} onClick={() => open && go(href.start(taskId, open.key))} data-testid="guide-start">启动{name}</button>
          {texts?.guide_note && <small>{texts.guide_note}</small>}
        </div>
      </section>
      {texts && texts.cases.length > 0 && (
        <div className="tp-cases" data-testid="start-cases">
          {texts.cases.map((one, index) => (open
            ? <a key={one.title} className="tp-case go" href={href.start(taskId, open.key, index)} data-testid={`start-case-${index}`}><b>{one.title}</b><span>{one.text}</span></a>
            : <div key={one.title} className="tp-case"><b>{one.title}</b><span>{one.text}</span></div>))}
        </div>
      )}
    </>
  );
}

/** 需求资产现状：六格。writing 是现在这项活动写的那几类（它们的格子着色）。 */
export function AssetCells({ assets, writing = [] }: { assets: AssetCell[]; writing?: string[] }) {
  return (
    <div className="tp-assets" data-testid="asset-cells">
      {assets.map((cell) => (
        <div key={cell.key} className={`tp-cell${writing.includes(cell.key) ? " hot" : ""}`} data-testid={`asset-${cell.key}`}>
          <div className="n">{cell.name}</div>
          <div className={`v${cell.count === 0 ? " zero" : ""}`}>{cell.text}</div>
          {cell.note && <div className="s">{cell.note}</div>}
          <div className="w">{writing.includes(cell.key) ? "正在产出" : producedLine(cell)}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * 工作项：任务有工作项时显示，一个一张卡，照任务状况给的次序（最近有动静的在前）。卡上写名字与种类、哪天启动的、流程在第几站、
 * 范围说明、几条会话与最近的那一条，三个按钮：打开最新会话、换一条干净的会话接着、删除这个工作项。工作项没有终点，没有「已做完」的卡。
 * busy 是某个按钮的请求还没有回来：这时三个按钮都点不动。
 */
export function WorkItemCards({ items, busy, onOpen, onContinue, onDelete }: {
  items: WorkItemView[];
  busy: boolean;
  onOpen: (item: WorkItemView) => void;
  onContinue: (item: WorkItemView) => void;
  onDelete: (item: WorkItemView) => void;
}) {
  return (
    <div className="tp-runs" data-testid="work-items">
      {items.map((item) => (
        <div key={item.record_id} className="tp-run" data-testid={`work-item-${item.record_id}`}>
          <div className="t"><b>{item.name}</b><span className="chip okc">{item.kind === "flow" ? "工作流程" : "单项活动"}</span><small>{workItemMeta(item)}</small></div>
          {workItemPosition(item) && <div className="pos">{workItemPosition(item)}</div>}
          {item.scope && <div className="scope"><b>范围</b>{item.scope}</div>}
          <div className="sess">{workItemSessionsLine(item)}</div>
          <div className="tp-run-act">
            <button className="btn sm pri" disabled={busy} onClick={() => onOpen(item)} data-testid="work-item-open">打开最新会话</button>
            <button className="btn sm" disabled={busy} onClick={() => onContinue(item)} data-testid="work-item-continue">换一条干净的会话接着</button>
            <button className="btn sm" disabled={busy} onClick={() => onDelete(item)} data-testid="work-item-delete">删除这个工作项</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 工作流程：每条一张卡。能启动的整张卡可点，进这条流程的输入页。任务里已有这条流程的工作项时（一个任务同一时刻至多一个流程工作项），
 * 卡片不能再启动：标「已在进行」，底部写在第几站，另有「打开它的会话」。现在不能启动的变淡、不可点，卡片底部写前置条件；
 * 因为另一条流程正在进行而不能启动的，底部写那一句原因。
 */
export function FlowCards({ taskId, flows, onOpenWorkItem }: {
  taskId: string;
  flows: CatalogFlow[];
  /** 「打开它的会话」：打开那个流程工作项最近的会话。任务已经结束时不给，不画这个按钮。 */
  onOpenWorkItem?: (recordId: number) => void;
}) {
  return (
    <div className="tp-flows">
      {flows.map((flow) => {
        const tag = flowTag(flow);
        const running = flowInProgress(flow);
        const to = flow.enabled ? href.start(taskId, flow.key) : null;
        const body = (
          <>
            <div className="t"><b>{flow.name}</b>{tag && <span className={`chip${tag.kind === "rec" ? " dark" : tag.kind === "now" ? " okc" : ""}`}>{tag.text}</span>}</div>
            <p>{flow.purpose}</p>
            <dl className="tp-kv">
              <dt>适用</dt><dd>{flow.applies}</dd>
              <dt>各站</dt><dd className="tp-nodes">{flow.nodes.map((one) => one.name).join(" › ")}</dd>
              <dt>输入</dt><dd>{flow.inputs}</dd>
            </dl>
            <div className="eg"><b>示例</b>{flow.example}</div>
            <div className="tp-go">
              {running && <span className="tp-quiet" data-testid="flow-position">{flowPositionLine(flow)}（见上）。一个任务同一时刻只有一条流程工作项。</span>}
              {running && onOpenWorkItem && (
                <button className="btn sm" onClick={() => onOpenWorkItem(flow.work_item!.record_id)} data-testid="flow-open-work-item">打开它的会话</button>
              )}
              {!running && !flow.enabled && <span className="tp-need">{flow.work_item && flow.state.startsWith("已有流程工作项") ? `${flow.state}。` : flow.prerequisite_text}</span>}
              {flow.enabled && <span className="tp-arrow">{START_ARROW}</span>}
            </div>
          </>
        );
        const cls = `tp-flow${tag?.kind === "rec" ? " rec" : ""}${running ? " now" : !flow.enabled ? " off" : ""}${to ? " go" : ""}`;
        return to
          ? <a key={flow.key} className={cls} href={to} data-testid={`flow-${flow.key}`}>{body}</a>
          : <div key={flow.key} className={cls} data-testid={`flow-${flow.key}`}>{body}</div>;
      })}
    </div>
  );
}

/** 后端给的「此版本尚未提供」那一句状态（agent/src/lib/activity_catalog.ts 的 CATALOG_LATER）。 */
const LATER = "此版本尚未提供";

/**
 * 一项活动卡片底部的那一句：能启动时写定义里的前置条件（灰字）；这个版本还没有提供时写那一句状态（灰字）；
 * 缺前提时写定义里的前置条件（琥珀色），鼠标停在上面说明现在缺的是什么。
 */
function ActivityNote({ activity }: { activity: CatalogActivity }) {
  if (activity.enabled) return <span className="tp-quiet">{activity.prerequisite_text}</span>;
  if (activity.state === LATER) return <span className="tp-quiet">{activity.state}。</span>;
  return <span className="tp-need" title={`${activity.state}。`}>{activity.prerequisite_text}</span>;
}

/**
 * 单项活动：每项一张卡。能启动的整张卡可点，进这项活动的输入页；已经有工作项的在标题旁标「N 个工作项」，照样可以再启动，
 * 那是另起一个。缺前提的、这个版本还没有提供的变淡、不可点。
 */
export function ActivityCards({ taskId, activities }: {
  taskId: string;
  activities: ActivityCatalog["activities"];
}) {
  return (
    <div className="tp-acts">
      {activities.map((one) => {
        const to = one.enabled ? href.start(taskId, one.key) : null;
        const count = one.active_count ?? 0;
        const body = (
          <>
            <div className="t">{one.name}<small>{one.mode_name}</small>{count > 0 && <span className="chip okc" data-testid="activity-count">{count} 个工作项</span>}</div>
            <div className="d">{one.purpose}</div>
            <div className="ex">例：{one.example}</div>
            <div className="tp-rw">
              <i>输入</i><span className="l">{one.reads.map((kind) => <span key={kind.key}>{kind.name}</span>)}</span>
              <i>产出</i><span className="l">{one.writes.map((kind) => <span key={kind.key} className="w">{kind.name}</span>)}</span>
            </div>
            <div className="tp-go">
              <ActivityNote activity={one} />
              {one.enabled && <span className="tp-arrow">{START_ARROW}</span>}
            </div>
          </>
        );
        const cls = `tp-act${one.enabled ? (count > 0 ? " now" : "") : " off"}${to ? " go" : ""}`;
        return to
          ? <a key={one.key} className={cls} href={to} data-testid={`activity-${one.key}`}>{body}</a>
          : <div key={one.key} className={cls} data-testid={`activity-${one.key}`}>{body}</div>;
      })}
    </div>
  );
}

/**
 * 「自由讨论」：不启动具体活动，直接进工作台。它不是活动，不排在活动卡的网格里，在「单项活动」一节末尾单独一行，
 * 只有边线、没有底色；它是这一页上唯一不经输入页的入口。
 */
export function FreeTalk({ busy, onEnter }: {
  /** 新建会话的请求还没有回来：按钮点不动。 */
  busy: boolean;
  onEnter: () => void;
}) {
  return (
    <div className="tp-free" data-testid="free-talk">
      <div className="tp-free-l">
        <div className="t">自由讨论<small>对话</small></div>
        <div className="d">新建一条不属于任何工作项的会话，直接进入工作台与助手讨论。助手可解答问题、把定下的事记入业务说明，但不写需求条目，也不提议下一站。随时可用，不影响已有的工作项。</div>
      </div>
      <button className="btn" disabled={busy} onClick={onEnter} data-testid="enter-workbench">进入工作台</button>
    </div>
  );
}
