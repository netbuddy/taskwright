// 任务起点页的四块：「三步开始」指引与三种常见起点、需求资产现状六格、工作流程两张卡、单项活动七张卡加「不开展活动」。
// 文字都从任务状况取（资产现状 assets、活动目录 catalog、起点页的几段话 start_page），这里只画；点了做什么由页面给。
// 样式在 styles/task-page.css，按钮与小标签用工作视图已有的样式（.btn、.chip）。

import type { ActivityCatalog, AssetCell, CatalogActivity, CatalogFlow, StartPageTexts } from "../../api/types";
import { FLOW_ACTIVE, flowButton, flowResumeNote, flowTag, producedLine } from "../../model/startPage";

/** 「三步开始」：只在六类资产都空着时显示。主按钮开展推荐的那条工作流程。 */
export function StartGuide({ flow, texts, busy, onStart }: {
  /** 推荐的工作流程；没有、或者现在不能开展时主按钮是灰的。 */
  flow: CatalogFlow | null;
  texts: StartPageTexts | undefined;
  busy: boolean;
  onStart: (flow: CatalogFlow) => void;
}) {
  const name = flow?.name ?? "工作流程";
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
          <button className="btn pri tp-lg" disabled={!flow?.enabled || busy} onClick={() => flow && onStart(flow)} data-testid="guide-start">开始{name}</button>
          {texts?.guide_note && <small>{texts.guide_note}</small>}
        </div>
      </section>
      {texts && texts.cases.length > 0 && (
        <div className="tp-cases" data-testid="start-cases">
          {texts.cases.map((one) => <div key={one.title} className="tp-case"><b>{one.title}</b><span>{one.text}</span></div>)}
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

/** 工作流程：每条一张卡。 */
export function FlowCards({ flows, busy, onStart, backHref }: {
  flows: CatalogFlow[];
  /** 正在开展的那一项的键；有值时各按钮都点不动。 */
  busy: string | null;
  onStart: (flow: CatalogFlow) => void;
  /** 流程正在进行时「回到工作台」去的地址；没有会话时不给。 */
  backHref: string | null;
}) {
  return (
    <div className="tp-flows">
      {flows.map((flow) => {
        const tag = flowTag(flow);
        const active = flow.state === FLOW_ACTIVE;
        return (
          <div key={flow.key} className={`tp-flow${tag?.kind === "rec" ? " rec" : ""}${!flow.enabled && !active ? " off" : ""}`} data-testid={`flow-${flow.key}`}>
            <div className="t"><b>{flow.name}</b>{tag && <span className={`chip${tag.kind === "rec" ? " dark" : tag.kind === "now" ? " okc" : ""}`}>{tag.text}</span>}</div>
            <p>{flow.purpose}</p>
            <dl className="tp-kv">
              <dt>适用</dt><dd>{flow.applies}</dd>
              <dt>各站</dt><dd className="tp-nodes">{flow.nodes.map((one) => one.name).join(" › ")}</dd>
              <dt>输入</dt><dd>{flow.inputs}</dd>
            </dl>
            <div className="eg"><b>示例</b>{flow.example}</div>
            <div className="tp-go">
              {flow.enabled && (
                <>
                  <button className={`btn${flow.recommended ? " pri" : ""}`} disabled={busy !== null} onClick={() => onStart(flow)} data-testid={`flow-start-${flow.key}`}>{flowButton(flow)}</button>
                  {flowResumeNote(flow) && <span className="tp-quiet">{flowResumeNote(flow)}</span>}
                </>
              )}
              {active && (
                <>
                  <span className="tp-quiet">现在在「{flow.nodes.find((one) => one.key === flow.at)?.name ?? ""}」这一站。</span>
                  {backHref && <a className="btn" href={backHref} data-testid="flow-back">回到工作台</a>}
                </>
              )}
              {!flow.enabled && !active && <span className="tp-need">{flow.prerequisite_text}</span>}
            </div>
          </div>
        );
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
  if (activity.enabled) return <div className="tp-quiet">{activity.prerequisite_text}</div>;
  if (activity.state.startsWith("正在")) return null;
  if (activity.state === LATER) return <div className="tp-quiet">{activity.state}。</div>;
  return <div className="tp-need" title={`${activity.state}。`}>{activity.prerequisite_text}</div>;
}

/** 单项活动：每项一张卡，末尾另有一张「不开展活动」。 */
export function ActivityCards({ activities, busy, onStart, onEnter, canEnter, backHref = null }: {
  activities: ActivityCatalog["activities"];
  busy: string | null;
  onStart: (activity: CatalogActivity) => void;
  /** 「不开展活动」卡上的「进入工作台」。 */
  onEnter: () => void;
  /** 任务还在进行中时才能进入工作台新建会话。 */
  canEnter: boolean;
  /** 正在进行的那一项卡片上「回到工作台」去的地址；没有会话时不给。 */
  backHref?: string | null;
}) {
  return (
    <div className="tp-acts">
      {activities.map((one) => (
        <div key={one.key} className={`tp-act${one.enabled ? "" : one.state.startsWith("正在") ? " now" : " off"}`} data-testid={`activity-${one.key}`}>
          <div className="t">{one.name}<small>{one.mode_name}</small>{one.state.startsWith("正在") && <span className="chip okc">{one.state}</span>}</div>
          <div className="d">{one.purpose}</div>
          <div className="ex">例：{one.example}</div>
          <div className="tp-rw">
            <i>输入</i><span className="l">{one.reads.map((kind) => <span key={kind.key}>{kind.name}</span>)}</span>
            <i>产出</i><span className="l">{one.writes.map((kind) => <span key={kind.key} className="w">{kind.name}</span>)}</span>
          </div>
          <ActivityNote activity={one} />
          {one.enabled && (
            <div className="tp-go"><button className="btn" disabled={busy !== null} onClick={() => onStart(one)} data-testid={`activity-start-${one.key}`}>开展{one.name}</button></div>
          )}
          {one.state.startsWith("正在") && backHref && <div className="tp-go"><a className="btn" href={backHref} data-testid={`activity-back-${one.key}`}>回到工作台</a></div>}
        </div>
      ))}
      <div className="tp-act dash" data-testid="activity-none">
        <div className="t">不开展活动</div>
        <div className="d">直接进入工作台与助手讨论。助手可回答问题、把定下的事记入业务说明，但不写需求条目、不提议下一站。</div>
        <div className="tp-go"><button className="btn" disabled={!canEnter || busy !== null} onClick={onEnter} data-testid="enter-workbench">进入工作台</button></div>
      </div>
    </div>
  );
}
