// 任务起点页的几块：「三步开始」指引与三种常见起点、需求资产现状六格、工作流程两张卡、单项活动七张卡、「自由讨论」一行。
// 文字都从任务状况取（资产现状 assets、活动目录 catalog、起点页的几段话 start_page），这里只画。
// 起点页是目录：工作流程卡、活动卡、三种常见起点与「开始」按钮都只是进活动输入页（pages/StartInputPage.tsx），开展在那里提交；
// 只有「自由讨论」不经输入页，直接进工作台。样式在 styles/task-page.css，按钮与小标签用工作视图已有的样式（.btn、.chip）。

import type { ActivityCatalog, AssetCell, CatalogActivity, CatalogFlow, StartPageTexts } from "../../api/types";
import { FLOW_ACTIVE, flowButton, flowResumeNote, flowTag, producedLine } from "../../model/startPage";
import { go, href } from "../../router";

/** 「三步开始」：只在六类资产都空着时显示。主按钮与三种常见起点都进推荐的那条工作流程的输入页。 */
export function StartGuide({ taskId, flow, texts }: {
  taskId: string;
  /** 推荐的工作流程；没有、或者现在不能开展时主按钮是灰的，三种起点不可点。 */
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
            <li><span className="no">1</span><div><b>选择工作流程</b>首次编制请选择「{name}」。</div></li>
            <li><span className="no">2</span><div><b>提供输入</b>上传项目材料，或直接描述目标系统。</div></li>
            <li><span className="no">3</span><div><b>由助手推进</b>助手逐站完成并提议下一站，每一步由你确认。</div></li>
          </ol>
        </div>
        <div className="tp-cta">
          <button className="btn pri tp-lg" disabled={!open} onClick={() => open && go(href.start(taskId, open.key))} data-testid="guide-start">开始{name}</button>
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
 * 工作流程：每条一张卡。能开展的整张卡可点，进这条流程的输入页；正在进行的整张卡可点，回工作台；
 * 现在不能开展的变淡、不可点，卡片底部写前置条件。
 */
export function FlowCards({ taskId, flows, backHref }: {
  taskId: string;
  flows: CatalogFlow[];
  /** 流程正在进行时整张卡去的地址（最近活动的那条会话的工作台）；没有会话时不给。 */
  backHref: string | null;
}) {
  return (
    <div className="tp-flows">
      {flows.map((flow) => {
        const tag = flowTag(flow);
        const active = flow.state === FLOW_ACTIVE;
        const to = flow.enabled ? href.start(taskId, flow.key) : active ? backHref : null;
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
              {flow.enabled && flowResumeNote(flow) && <span className="tp-quiet">{flowResumeNote(flow)}</span>}
              {active && <span className="tp-quiet">现在在「{flow.nodes.find((one) => one.key === flow.at)?.name ?? ""}」这一站。</span>}
              {!flow.enabled && !active && <span className="tp-need">{flow.prerequisite_text}</span>}
              {flow.enabled && <span className="tp-arrow">{flowButton(flow)} →</span>}
              {active && to && <span className="tp-arrow">回到工作台 →</span>}
            </div>
          </>
        );
        const cls = `tp-flow${tag?.kind === "rec" ? " rec" : ""}${!flow.enabled && !active ? " off" : ""}${to ? " go" : ""}`;
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
 * 一项活动卡片底部的那一句：能开展时写定义里的前置条件（灰字）；这个版本还没有提供时写那一句状态（灰字）；
 * 缺前提时写定义里的前置条件（琥珀色），鼠标停在上面说明现在缺的是什么。正在进行的不写：状态在标题旁的小标签上。
 */
function ActivityNote({ activity }: { activity: CatalogActivity }) {
  if (activity.enabled) return <span className="tp-quiet">{activity.prerequisite_text}</span>;
  if (activity.state.startsWith("正在")) return null;
  if (activity.state === LATER) return <span className="tp-quiet">{activity.state}。</span>;
  return <span className="tp-need" title={`${activity.state}。`}>{activity.prerequisite_text}</span>;
}

/**
 * 单项活动：每项一张卡。能开展的整张卡可点，进这项活动的输入页；正在进行的整张卡可点，回工作台；
 * 缺前提的、这个版本还没有提供的变淡、不可点。
 */
export function ActivityCards({ taskId, activities, backHref = null }: {
  taskId: string;
  activities: ActivityCatalog["activities"];
  /** 正在进行的那一项整张卡去的地址；没有会话时不给。 */
  backHref?: string | null;
}) {
  return (
    <div className="tp-acts">
      {activities.map((one) => {
        const active = one.state.startsWith("正在");
        const to = one.enabled ? href.start(taskId, one.key) : active ? backHref : null;
        const body = (
          <>
            <div className="t">{one.name}<small>{one.mode_name}</small>{active && <span className="chip okc">{one.state}</span>}</div>
            <div className="d">{one.purpose}</div>
            <div className="ex">例：{one.example}</div>
            <div className="tp-rw">
              <i>输入</i><span className="l">{one.reads.map((kind) => <span key={kind.key}>{kind.name}</span>)}</span>
              <i>产出</i><span className="l">{one.writes.map((kind) => <span key={kind.key} className="w">{kind.name}</span>)}</span>
            </div>
            <div className="tp-go">
              <ActivityNote activity={one} />
              {one.enabled && <span className="tp-arrow">开展 →</span>}
              {active && to && <span className="tp-arrow">回到工作台 →</span>}
            </div>
          </>
        );
        const cls = `tp-act${one.enabled ? "" : active ? " now" : " off"}${to ? " go" : ""}`;
        return to
          ? <a key={one.key} className={cls} href={to} data-testid={`activity-${one.key}`}>{body}</a>
          : <div key={one.key} className={cls} data-testid={`activity-${one.key}`}>{body}</div>;
      })}
    </div>
  );
}

/**
 * 「自由讨论」：不开展具体活动，直接进工作台。它不是活动，不排在活动卡的网格里，在「单项活动」一节末尾单独一行，
 * 只有边线、没有底色；它是这一页上唯一不经输入页的入口。
 */
export function FreeTalk({ canEnter, busy, onEnter }: {
  /** 任务还在进行中时才能进工作台新建会话。 */
  canEnter: boolean;
  /** 新建会话的请求还没有回来：按钮点不动。 */
  busy: boolean;
  onEnter: () => void;
}) {
  return (
    <div className="tp-free" data-testid="free-talk">
      <div className="tp-free-l">
        <div className="t">自由讨论<small>对话</small></div>
        <div className="d">不开展具体活动，直接进入工作台与助手讨论。助手可解答问题、把定下的事记入业务说明，但不写需求条目，也不提议下一站。</div>
      </div>
      <button className="btn" disabled={!canEnter || busy} onClick={onEnter} data-testid="enter-workbench">进入工作台</button>
    </div>
  );
}
