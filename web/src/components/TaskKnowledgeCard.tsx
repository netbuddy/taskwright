// 任务页「选用的知识库」一栏：列出这个任务选用的库（通用知识库注明每个任务都会用到，不能去掉），每个库可以查看、不再选用；
// 「选用别的知识库」弹出勾选框列表，确定之后整体改选用。任务已结束时只列出，不能改。

import { useState } from "react";
import { Button, Checkbox, Popover } from "antd";
import type { KnowledgeLibrary } from "../api/types";
import { href } from "../router";
import { GENERAL, docCountText, sortedLibraries, usageText } from "../model/knowledge";

export function TaskKnowledgeCard({ libraries, selected, readOnly, onChange }: {
  libraries: KnowledgeLibrary[];
  selected: string[];
  readOnly: boolean;
  /** 改选用：给出改完之后的整个列表。 */
  onChange: (ids: string[]) => Promise<boolean>;
}) {
  const libs = sortedLibraries(libraries);
  const chosen = libs.filter((l) => selected.includes(l.id));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  const openPicker = (next: boolean) => {
    if (next) setDraft(selected);
    setOpen(next);
  };
  const confirm = async () => {
    if (await onChange([GENERAL, ...libs.filter((l) => l.id !== GENERAL && draft.includes(l.id)).map((l) => l.id)])) setOpen(false);
  };

  const picker = (
    <div className="kbpick" data-testid="kb-picker">
      <div className="ph">勾上的知识库这个任务会用到。改完之后，下一次会话开始时助手按新的选择查找。</div>
      {libs.map((l) => (
        <div key={l.id} className="kbpick-row">
          <Checkbox checked={l.id === GENERAL || draft.includes(l.id)} disabled={l.id === GENERAL}
            onChange={(e) => setDraft((d) => (e.target.checked ? [...d, l.id] : d.filter((x) => x !== l.id)))}>
            {l.name}<span className="pm">{docCountText(l)} · {l.id === GENERAL ? "每个任务都会用到，不能去掉" : usageText(l, { selected: selected.includes(l.id) })}</span>
          </Checkbox>
        </div>
      ))}
      <div className="pf"><Button size="small" onClick={() => setOpen(false)}>取消</Button><Button size="small" type="primary" onClick={confirm} data-testid="kb-pick-ok">确定</Button></div>
    </div>
  );

  return (
    <div className="card" data-testid="task-knowledge">
      {chosen.map((l) => (
        <div key={l.id} className="kbrow" data-testid={`kb-row-${l.id}`}>
          <span className="nm">{l.name}</span>
          <span className="mt">{docCountText(l)}{l.id === GENERAL ? " · 每个任务都会用到" : ""}</span>
          {l.id === GENERAL && <span className="lock">不能去掉</span>}
          <a href={href.knowledge(l.id)}>查看</a>
          {l.id !== GENERAL && !readOnly && (
            <a className="muted" role="button" onClick={() => void onChange(selected.filter((x) => x !== l.id))}>不再选用</a>
          )}
        </div>
      ))}
      {!readOnly && (
        <div style={{ marginTop: "0.6rem" }}>
          <Popover content={picker} trigger="click" open={open} onOpenChange={openPicker} placement="bottomLeft">
            <Button size="small" data-testid="kb-pick">选用别的知识库</Button>
          </Popover>
        </div>
      )}
      <div className="kbnote">助手只在这几个知识库里查找。去掉一个知识库之后，已经写进条目的来源不会消失。</div>
    </div>
  );
}
