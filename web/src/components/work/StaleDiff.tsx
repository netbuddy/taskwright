// 「确认已失效」的差异：你确认过的那一版与现在这一版逐字段比，列表型字段按步骤对齐（没变的步骤也列出来对照）。
// 样式照设计原型的 .staleblock：琥珀色底，每处改动一个白格，列表型字段逐步对齐成 .steps 表。

import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { CollectionDef, Item, ItemVersion } from "../../api/types";
import { diffFields, type FieldDiff } from "../../model/diff";
import { confirmedVersion } from "../../model/items";
import { valueText } from "../../model/format";

export function StaleDiff({ taskId, item, def, disabled, onReconfirm, onOpen }: {
  taskId: string;
  item: Item;
  def: CollectionDef;
  disabled?: boolean;
  onReconfirm: () => void;
  onOpen?: () => void;
}) {
  const [versions, setVersions] = useState<ItemVersion[] | null>(null);
  useEffect(() => {
    api.itemVersions(taskId, item.item_id).then(setVersions).catch(() => setVersions([]));
  }, [taskId, item.item_id, item.version_no]);

  const confirmedNo = confirmedVersion(item);
  const before = versions?.find((v) => v.version_no === confirmedNo)?.fields ?? null;
  const diffs: FieldDiff[] = before ? diffFields(def, before, item.fields) : [];
  const between = confirmedNo != null ? item.version_no - confirmedNo - 1 : 0;

  return (
    <div className="staleblock" data-testid="stale-diff" onClick={(e) => e.stopPropagation()}>
      <div className="sbh">
        <b>你确认过的是第 {confirmedNo} 版，现在是第 {item.version_no} 版{between > 0 ? `，中间还有 ${between} 版` : ""}，有 {diffs.length} 个字段改过：</b>
      </div>
      {!versions && <div className="sbrow">正在读版本历史。</div>}
      {versions && !before && <div className="sbrow">没有读到你确认过的那一版，比较不了。</div>}
      {diffs.map((d) => <div className="sbrow" key={d.field}><FieldDiffView diff={d} /></div>)}
      <div className="sbfoot">
        <button type="button" className="btn sm pri" disabled={disabled} onClick={onReconfirm} data-testid="reconfirm">这样可以，重新确认</button>
        {onOpen && <button type="button" className="btn sm" onClick={onOpen}>打开这个条目细看</button>}
      </div>
    </div>
  );
}

/** 一个字段的改前改后：文本整体比，列表型字段逐步对齐（原型的「画列表逐步」）。 */
export function FieldDiffView({ diff }: { diff: FieldDiff }) {
  if (!diff.list) {
    return (
      <>
        <div className="fn">{diff.field}</div>
        <div>
          <span className="diff-old">{valueText(diff.before) || "（原来是空的）"}</span>
          <span className="diff-new">{valueText(diff.after) || "（现在是空的）"}</span>
        </div>
      </>
    );
  }
  const steps = diff.steps ?? [];
  const changed = steps.filter((s) => s.kind !== "same").length;
  const total = steps.filter((s) => s.kind !== "removed").length;
  return (
    <>
      <div className="fn">{diff.field}：一共 {total} 步，其中 {changed} 步有改动（逐步对齐比对，没有变的那几步也列出来对照）</div>
      <div className="steps">
        {steps.map((s, i) => {
          if (s.kind === "same") return <div key={i} className="strow same"><span className="no">第 {s.index + 1} 步</span><span className="tx">{s.text}</span><span className="tag">没有变</span></div>;
          if (s.kind === "changed") return <div key={i} className="strow changed"><span className="no">第 {s.index + 1} 步</span><span className="tx"><span className="diff-old">{s.before}</span><span className="diff-new">{s.after}</span></span><span className="tag">这一步改了</span></div>;
          if (s.kind === "added") return <div key={i} className="strow added"><span className="no">第 {s.index + 1} 步</span><span className="tx"><span className="diff-new">{s.text}</span></span><span className="tag">新加的一步</span></div>;
          return <div key={i} className="strow removed"><span className="no">（已删掉）</span><span className="tx"><span className="diff-old">{s.before}</span></span><span className="tag">删掉的一步</span></div>;
        })}
      </div>
    </>
  );
}
