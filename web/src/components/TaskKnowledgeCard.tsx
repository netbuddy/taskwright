// 任务页「选用的知识库」一栏：列出这个任务选用的知识库（可以一个都没有），每个知识库可以查看、不再选用；
// 「选用别的知识库」弹出勾选框列表，确定之后整体改选用。任务已结束时只列出，不能改。

import { useState } from "react";
import { Button, Checkbox, Popover } from "antd";
import { BookOutlined } from "@ant-design/icons";
import type { KnowledgeLibrary } from "../api/types";
import { href } from "../router";
import { docCountText, usageText } from "../model/knowledge";

/**
 * 「选用别的知识库」按钮与它弹出的勾选框：确定之后整体改选用。
 * 任务起点页的知识库卡与工作台「材料与证据」页签共用。
 */
export function KnowledgePickButton({ libraries, selected, onChange, placement = "topLeft", plain = false }: {
  libraries: KnowledgeLibrary[];
  selected: string[];
  /** 改选用：给出改完之后的整个列表；改成了返回真。 */
  onChange: (ids: string[]) => Promise<boolean>;
  placement?: "topLeft" | "bottomLeft";
  /** 工作台里用工作视图的按钮样式（.btn），任务起点页用 antd 的小按钮。 */
  plain?: boolean;
}) {
  const libs = libraries;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  const openPicker = (next: boolean) => {
    if (next) setDraft(selected);
    setOpen(next);
  };
  const confirm = async () => {
    if (await onChange(libs.filter((l) => draft.includes(l.id)).map((l) => l.id))) setOpen(false);
  };
  const picker = (
    <div className="kbpick" data-testid="kb-picker">
      <div className="ph">勾上的知识库这个任务实例会用到。改完之后，下一次会话开始时助手按新的选择查找。</div>
      {libs.map((l) => (
        <div key={l.id} className="kbpick-row">
          <Checkbox checked={draft.includes(l.id)}
            onChange={(e) => setDraft((d) => (e.target.checked ? [...d, l.id] : d.filter((x) => x !== l.id)))}>
            {l.name}<span className="pm">{docCountText(l)} · {usageText(l, { selected: selected.includes(l.id) })}</span>
          </Checkbox>
        </div>
      ))}
      <div className="pf"><Button size="small" onClick={() => setOpen(false)}>取消</Button><Button size="small" type="primary" onClick={confirm} data-testid="kb-pick-ok">确定</Button></div>
    </div>
  );
  return (
    <Popover content={picker} trigger="click" open={open} onOpenChange={openPicker} placement={placement}>
      {plain ? <button type="button" className="btn sm" data-testid="kb-pick">选用别的知识库</button> : <Button size="small" data-testid="kb-pick">选用别的知识库</Button>}
    </Popover>
  );
}

export function TaskKnowledgeCard({ libraries, selected, readOnly, onChange }: {
  libraries: KnowledgeLibrary[];
  selected: string[];
  readOnly: boolean;
  /** 改选用：给出改完之后的整个列表。 */
  onChange: (ids: string[]) => Promise<boolean>;
}) {
  const chosen = libraries.filter((l) => selected.includes(l.id));

  return (
    <section className="tp-pane" aria-label="选用的知识库" data-testid="task-knowledge">
      <div className="tp-sec-h"><h2><BookOutlined className="tp-hic" />选用的知识库</h2><span className="cnt" data-testid="kb-count">{chosen.length} 个</span></div>
      {chosen.length === 0 && <div className="tp-none" data-testid="kb-none">这个任务实例还没有选用知识库，助手查不到参考资料。</div>}
      {chosen.map((l) => (
        <div key={l.id} className="tp-kbrow" data-testid={`kb-row-${l.id}`}>
          <span className="nm"><BookOutlined className="kic" />{l.name}</span>
          <span className="dc">{docCountText(l)}</span>
          <span className="ds" />
          <span className="acts">
            <a className="tp-lnk" href={href.knowledge(l.id)}>查看</a>
            {!readOnly && (
              <a className="tp-lnk quiet" role="button" onClick={() => void onChange(selected.filter((x) => x !== l.id))}>不再选用</a>
            )}
          </span>
        </div>
      ))}
      <div className="tp-kbfoot">
        {!readOnly && <KnowledgePickButton libraries={libraries} selected={selected} onChange={onChange} />}
        <span className="note">助手只在这几个知识库里查找。</span>
      </div>
    </section>
  );
}
