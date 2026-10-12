// 阶段条：只在右侧栏的「调试」页签顶上显示（DebugPane.tsx，服务开着调试模式才有这个页签），只读。上面是五个阶段的名字（已经过的填实，当前的实心加一圈，还没到的空心），
// 下面是当前阶段「做到什么算够」的几盏灯：没通过的每盏一句，可以点，点了去差的第一页、第一条或第一份材料；
// 通过的收成「其余 N 项已齐」；全部通过时只写一句。阶段由动作移动（助手退回、用户在卡片上点进入），条上没有可以移动阶段的控件。
// 任务没有阶段（早先建的任务）时不画这一行。

import type { Item, StageView } from "../../api/types";
import { lampGroups, lampShort, lampTarget, splitNumbers, stageMarks } from "../../model/stage";

export function StageBar({ stage, items, onOpenItem, onOpenMaterial }: {
  stage: StageView | null | undefined;
  items: readonly Item[];
  onOpenItem: (itemId: string) => void;
  onOpenMaterial: (path: string) => void;
}) {
  if (!stage) return null;
  const marks = stageMarks(stage.current);
  const { failing, passed, applicable } = lampGroups(stage);
  const go = (lamp: (typeof failing)[number]) => {
    const target = lampTarget(lamp, items);
    if (!target) return;
    if (target.kind === "item") onOpenItem(target.itemId);
    else onOpenMaterial(target.path);
  };
  return (
    <div className="stagebar" data-testid="stage-bar" aria-label="工作的阶段">
      <div className="sb-stages">
        {marks.map((one, index) => (
          <span key={one.key} className="sb-step">
            {index > 0 && <span className={`sb-ln${one.mark === "ahead" ? "" : " done"}`} />}
            <span className={`sb-s ${one.mark}`} aria-current={one.mark === "current" ? "step" : undefined} data-testid={`stage-${one.key}`}>
              <span className="sb-d" />{one.name}
            </span>
          </span>
        ))}
      </div>
      <div className="sb-lamps" data-testid="stage-lamps">
        {applicable === 0 ? <span className="sb-lamp none" data-testid="lamps-none">这一段还没有可以核对的内容。</span>
          : failing.length === 0 ? <span className="sb-lamp ok" data-testid="lamps-all-ok"><span className="sb-d" />这一段的几项都齐了。</span>
          : (
            <>
              <span className="sb-lb">这一段还差：</span>
              {failing.map((lamp) => {
                const target = lampTarget(lamp, items);
                return (
                  <span key={lamp.key} className={`sb-lamp no${target ? " go" : ""}`} role={target ? "button" : undefined} tabIndex={target ? 0 : undefined}
                    title={lamp.summary} data-testid={`lamp-${lamp.key}`} onClick={() => go(lamp)}
                    onKeyDown={(event) => { if (target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); go(lamp); } }}>
                    <span className="sb-d" />
                    <span>{splitNumbers(lampShort(lamp.summary)).map((part, index) => (part.number ? <b key={index}>{part.text}</b> : <span key={index}>{part.text}</span>))}</span>
                  </span>
                );
              })}
              {passed > 0 && <span className="sb-lamp ok" data-testid="lamps-rest-ok"><span className="sb-d" />其余 {passed} 项已齐</span>}
            </>
          )}
      </div>
    </div>
  );
}
